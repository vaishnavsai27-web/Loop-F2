// The LOOP player: a play queue over LOOP-owned audio (/api/media/:id).
// Songs without an authorised recording are never queued. Every play is recorded once on the
// server (start), and finished with the seconds actually listened, so statistics are not inflated
// by skips, seeks or pauses.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';

const PlayerContext = createContext(null);
const ProgressContext = createContext({ position: 0, duration: 0 });

const playable = (s) => !!s?.playback?.playable;

/** Pure queue operations (tested in lib.test.js). `index` is the playing position. */
export const queueOps = {
  insert: (list, at, item) => { const l = list.slice(); l.splice(Math.max(0, Math.min(at, l.length)), 0, item); return l; },
  remove: (list, index, i) => {
    if (i === index || i < 0 || i >= list.length) return { list, index };
    return { list: list.filter((_, j) => j !== i), index: i < index ? index - 1 : index };
  },
  move: (list, index, i, dir) => {
    const j = i + dir;
    if (i < 0 || i >= list.length || j < 0 || j >= list.length) return { list, index };
    const l = list.slice(); [l[i], l[j]] = [l[j], l[i]];
    return { list: l, index: index === i ? j : index === j ? i : index };
  },
  /** Only playable songs go in; start at the chosen song, or the first playable one after it. */
  fromSongs: (songs, from = 0, extra = {}) => {
    const items = songs.filter(playable).map((song, i) => ({ key: `${song.id}-${Date.now()}-${i}`, song, ...extra }));
    const later = songs.slice(from).find(playable);
    return { items, at: Math.max(0, items.findIndex((x) => x.song.id === later?.id)) };
  },
};

export function PlayerProvider({ children, onError }) {
  const audio = useRef(null);
  const play = useRef(null);          // { playId, listened, lastTime }
  const queueRef = useRef([]);
  const [queue, setQueue] = useState([]);   // [{ key, song, origin, batchId }]
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [volume, setVolumeState] = useState(() => Number(safeGet('loop.volume') ?? 1));
  const [muted, setMuted] = useState(false);
  const [progress, setProgress] = useState({ position: 0, duration: 0 });
  const current = index >= 0 ? queue[index]?.song || null : null;

  useEffect(() => { queueRef.current = queue; }, [queue]);

  /** Close the open play on the server with the seconds really listened. */
  const finish = useCallback(async () => {
    const p = play.current;
    play.current = null;
    if (!p) return;
    const listened = Math.min(1800, Math.round(p.listened));
    try { await api.finishPlay(p.playId, listened, Math.round(audio.current?.currentTime || 0)); } catch (err) {
      console.warn('LOOP: play not closed now; the server closes idle plays itself —', err.message);
    }
  }, []);

  const startAt = useCallback(async (i, list = queueRef.current) => {
    const item = list[i];
    if (!item) return false;
    await finish();
    setIndex(i);
    setLoading(true);
    try {
      const r = await api.startPlay(item.song.id, item.origin, item.batchId);
      play.current = { playId: r.playId, listened: 0, lastTime: 0 };
      const el = audio.current;
      el.src = r.media.uri;
      el.volume = volume;
      await el.play();
      return true;
    } catch (err) {
      await finish();
      setPlaying(false);
      onError?.(err.name === 'NotAllowedError' ? 'Press play to start listening.' : err.message || 'This song could not be played.');
      return false;
    } finally {
      setLoading(false);
    }
  }, [finish, onError, volume]);

  /** Play one song now (keeps the rest of the queue after it). */
  const start = useCallback(async (song, { origin = 'MOOD', batchId } = {}) => {
    if (!playable(song)) return false;
    const at = Math.max(0, index + 1);
    const list = queueOps.insert(queueRef.current, at, { key: `${song.id}-${Date.now()}`, song, origin, batchId });
    setQueue(list); queueRef.current = list;
    return startAt(at, list);
  }, [index, startAt]);

  /** Replace the queue with these songs (only the playable ones) and start at `from`. */
  const playAll = useCallback(async (songs, { origin = 'MOOD', batchId, from = 0 } = {}) => {
    const { items, at } = queueOps.fromSongs(songs, from, { origin, batchId });
    if (!items.length) { onError?.('None of these songs has a LOOP recording to play yet.'); return false; }
    setQueue(items); queueRef.current = items;
    return startAt(at, items);
  }, [onError, startAt]);

  const enqueue = useCallback((song, { origin = 'LIBRARY', next = false } = {}) => {
    if (!playable(song)) return false;
    const item = { key: `${song.id}-${Date.now()}`, song, origin };
    const list = queueOps.insert(queueRef.current, next ? index + 1 : queueRef.current.length, item);
    setQueue(list); queueRef.current = list;
    return true;
  }, [index]);

  const removeAt = useCallback((i) => {
    const r = queueOps.remove(queueRef.current, index, i);
    setQueue(r.list); queueRef.current = r.list; setIndex(r.index);
  }, [index]);

  const move = useCallback((i, dir) => {
    const r = queueOps.move(queueRef.current, index, i, dir);
    setQueue(r.list); queueRef.current = r.list; setIndex(r.index);
  }, [index]);

  const next = useCallback(async () => {
    const q = queueRef.current;
    if (index + 1 < q.length) return startAt(index + 1);
    await finish();
    audio.current?.pause();
    setPlaying(false);
    return false;
  }, [finish, index, startAt]);

  const previous = useCallback(() => {
    const el = audio.current;
    if (el && el.currentTime > 4) { el.currentTime = 0; return; }
    if (index > 0) startAt(index - 1);
  }, [index, startAt]);

  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el || !current) return;
    if (el.paused) el.play().catch(() => onError?.('Playback could not resume. Try again.')); else el.pause();
  }, [current, onError]);

  const seek = useCallback((seconds) => {
    const el = audio.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(el.duration - 0.25, seconds));
    if (play.current) play.current.lastTime = el.currentTime;   // a seek is not listening time
  }, []);

  const setVolume = useCallback((v) => {
    const x = Math.max(0, Math.min(1, v));
    setVolumeState(x); setMuted(x === 0);
    if (audio.current) audio.current.volume = x;
    safeSet('loop.volume', String(x));
  }, []);
  const toggleMute = useCallback(() => {
    setMuted((m) => { if (audio.current) audio.current.muted = !m; return !m; });
  }, []);

  const stop = useCallback(async () => {
    audio.current?.pause();
    await finish();
    setQueue([]); queueRef.current = []; setIndex(-1);
    setProgress({ position: 0, duration: 0 });
  }, [finish]);

  useEffect(() => {
    const el = audio.current;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => {
      const p = play.current;
      if (p) {
        const delta = el.currentTime - p.lastTime;
        if (delta > 0 && delta < 2) p.listened += delta;   // only continuous listening counts
        p.lastTime = el.currentTime;
      }
      setProgress({ position: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : 0 });
    };
    const onEnded = () => { next(); };
    const onFail = () => {
      if (!play.current) return;
      setPlaying(false);
      finish();
      onError?.('This recording stopped playing. If your session ended, sign in again; otherwise try the next song.');
    };
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onFail);
    const onSignout = () => { el.pause(); finish(); setQueue([]); queueRef.current = []; setIndex(-1); };
    window.addEventListener('loop:signout', onSignout);
    const onHide = () => { if (document.visibilityState === 'hidden' && el.paused) finish(); };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onFail);
      window.removeEventListener('loop:signout', onSignout);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [finish, next, onError]);

  // Lock-screen and hardware media keys.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !current) return;
    navigator.mediaSession.metadata = new window.MediaMetadata({ title: current.title, artist: current.artist?.name || '', album: current.album?.title || 'LOOP',
      artwork: current.artworkUrl ? [{ src: current.artworkUrl, sizes: '512x512' }] : [] });
    navigator.mediaSession.setActionHandler('play', toggle);
    navigator.mediaSession.setActionHandler('pause', toggle);
    navigator.mediaSession.setActionHandler('nexttrack', next);
    navigator.mediaSession.setActionHandler('previoustrack', previous);
  }, [current, next, previous, toggle]);

  const value = useMemo(() => ({ current, queue, index, playing, loading, volume, muted, start, playAll, enqueue, removeAt, move, next, previous, toggle, seek, setVolume, toggleMute, stop, playAt: startAt }),
    [current, queue, index, playing, loading, volume, muted, start, playAll, enqueue, removeAt, move, next, previous, toggle, seek, setVolume, toggleMute, stop, startAt]);
  return (
    <PlayerContext.Provider value={value}>
      <ProgressContext.Provider value={progress}>
        {children}
      </ProgressContext.Provider>
      <audio ref={audio} preload="none" />
    </PlayerContext.Provider>
  );
}

function safeGet(k) { try { return window.localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { window.localStorage.setItem(k, v); } catch { /* storage unavailable */ } }

export const usePlayer = () => useContext(PlayerContext);
/** Playback position, in its own context so song lists do not re-render while audio plays. */
export const useProgress = () => useContext(ProgressContext);
