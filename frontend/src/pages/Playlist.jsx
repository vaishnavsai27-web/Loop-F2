import { useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Link, useRouter } from '../lib/router';
import { useToast } from '../lib/toast';
import { usePlayer } from '../lib/player';
import { useAuth } from '../lib/auth';
import { totalDuration, plural } from '../lib/format';
import SongRow from '../components/SongRow';
import { Dialog, Empty, ErrorState, Field, Loading, PageHead } from '../components/ui';
import Icon, { Mark } from '../components/Icon';

export default function Playlist({ id }) {
  const { data, error, loading, reload, setData } = useAsync(() => api.playlist(id), [id]);
  const { navigate } = useRouter();
  const toast = useToast();
  const player = usePlayer();
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [name, setName] = useState('');

  if (loading && !data) return <Loading label="Loading playlist" />;
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  if (!data) return null;

  async function rename(e) {
    e.preventDefault();
    try { const p = await api.renamePlaylist(id, { name: name.trim() }); setData((d) => ({ ...d, name: p.name ?? name.trim() })); setRenaming(false); toast('Playlist renamed'); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function remove() {
    try { await api.deletePlaylist(id); toast('Playlist deleted'); navigate('/library'); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function removeSong(songId) {
    try { await api.removeFromPlaylist(id, songId); setData((d) => ({ ...d, songs: d.songs.filter((s) => s.id !== songId), songCount: d.songCount - 1 })); toast('Removed from playlist'); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function move(i, dir) {
    const order = data.songs.map((s) => s.id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    try { setData(await api.reorderPlaylist(id, order)); } catch (err) { toast(err.message, 'error'); }
  }
  async function toggleShare(enabled) {
    try { const r = await api.sharePlaylist(id, enabled); setData((d) => ({ ...d, shareToken: r.shareToken })); toast(enabled ? 'Share link created' : 'Share link turned off'); }
    catch (err) { toast(err.message, 'error'); }
  }
  const shareUrl = data.shareToken ? `${window.location.origin}/p/${data.shareToken}` : null;
  const playableCount = data.songs.filter((s) => s.playback?.playable && s.status === 'ACTIVE').length;

  return (
    <div className="page page-narrow">
      <PageHead title={data.name} back={['/library', 'Library']}
        actions={<>
          <button type="button" className="btn btn-primary btn-sm" disabled={!playableCount} onClick={() => player.playAll(data.songs.filter((s) => s.status === 'ACTIVE'), { origin: 'PLAYLIST' })}><Icon name="play" size={16} />Play all</button>
          <button type="button" className="btn btn-sm" onClick={() => setSharing(true)}><Icon name="share" size={16} />Share</button>
          <button type="button" className="btn btn-sm" onClick={() => { setName(data.name); setRenaming(true); }}>Rename</button>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(true)}>Delete</button>
        </>}>
        {data.kind === 'SAVED_MIX' ? 'Saved mix' : 'Playlist'} — {plural(data.songCount, 'song')}, {totalDuration(data.totalDurationSec)}{playableCount < data.songs.length ? ` — ${playableCount} playable` : ''}
      </PageHead>
      {data.songs.length === 0 ? <Empty title="This playlist is empty" action={<Link className="btn btn-primary" to="/discover">Find music</Link>}>Add songs with the + button on any song.</Empty> : (
        <ol className="songs">
          {data.songs.map((s, i) => (
            <SongRow key={s.id} song={s} rank={i + 1} origin="PLAYLIST" showWhy={false}
              onPlay={() => player.playAll(data.songs.filter((x) => x.status === 'ACTIVE'), { origin: 'PLAYLIST', from: data.songs.filter((x) => x.status === 'ACTIVE').findIndex((x) => x.id === s.id) })}
              extra={<>
                <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${s.title} up`}><Icon name="up" size={18} /></button>
                <button type="button" className="icon-btn" disabled={i === data.songs.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${s.title} down`}><Icon name="down" size={18} /></button>
                <button type="button" className="icon-btn" onClick={() => removeSong(s.id)} aria-label={`Remove ${s.title} from this playlist`}><Icon name="x" size={18} /></button>
              </>} />
          ))}
        </ol>
      )}
      <Dialog open={renaming} onClose={() => setRenaming(false)} title="Rename playlist">
        <form className="form" onSubmit={rename}>
          <Field label="Name"><input className="input" maxLength={80} required value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="dialog-actions"><button type="button" className="btn btn-quiet" onClick={() => setRenaming(false)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={!name.trim()}>Save</button></div>
        </form>
      </Dialog>
      <Dialog open={sharing} onClose={() => setSharing(false)} title="Share this playlist"
        actions={<button type="button" className="btn" onClick={() => setSharing(false)}>Done</button>}>
        <p className="small muted">Anyone with the link can see the songs in this playlist. Only published songs are shown, and listening needs a LOOP account.</p>
        {shareUrl ? (
          <>
            <Field label="Link"><input className="input" readOnly value={shareUrl} onFocus={(e) => e.target.select()} /></Field>
            <div className="composer-actions">
              <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(shareUrl).then(() => toast('Link copied'), () => toast('Copy failed; select the link and copy it yourself', 'error'))}>Copy link</button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => toggleShare(false)}>Turn off sharing</button>
            </div>
          </>
        ) : <button type="button" className="btn btn-primary" onClick={() => toggleShare(true)}>Create a share link</button>}
      </Dialog>
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete “${data.name}”?`}
        actions={<><button type="button" className="btn btn-quiet" onClick={() => setConfirmDelete(false)}>Keep it</button><button type="button" className="btn btn-danger" onClick={remove}>Delete playlist</button></>}>
        <p className="small">The songs stay on LOOP; only this list is removed.</p>
      </Dialog>
    </div>
  );
}

/** A playlist someone shared with a link. Readable without an account; playing needs one. */
export function SharedPlaylist({ token }) {
  const { user } = useAuth();
  const player = usePlayer();
  const { data, error, loading } = useAsync(() => api.sharedPlaylist(token), [token]);
  return (
    <div className="public">
      <header className="public-top"><Link className="brand" to={user ? '/discover' : '/'}><Mark /><span className="brand-word">loop</span></Link></header>
      <main className="public-main" id="main">
        <div className="page-narrow" style={{ width: '100%' }}>
          {loading && <Loading label="Loading playlist" />}
          <ErrorState error={error} />
          {data && (
            <>
              <PageHead title={data.name} actions={user && <button type="button" className="btn btn-primary btn-sm" onClick={() => player.playAll(data.songs, { origin: 'PLAYLIST' })}>Play all</button>}>
                Shared by {data.owner} — {plural(data.songs.length, 'song')}
              </PageHead>
              {!user && <p className="notice">Listening needs a LOOP account. <Link to="/register">Create one</Link> or <Link to="/login">sign in</Link>.</p>}
              <ul className="songs">{data.songs.map((s) => (
                <li key={s.id} className="song"><span className="song-rank" /><div className="cover" style={{ background: `linear-gradient(135deg, ${s.cover?.[0] || '#B9BFD3'}, ${s.cover?.[1] || '#2A2F48'})` }} />
                  <div className="song-main"><span className="song-title">{s.title}</span><div className="song-meta"><span>{s.artist.name}</span></div></div></li>
              ))}</ul>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
