import { useEffect, useState } from 'react';
import { useAuth, ROLE_LABEL } from '../lib/auth';
import { usePlayer, useProgress } from '../lib/player';
import { cover } from '../lib/mood';
import { Link, useRouter } from '../lib/router';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { duration, relativeDate } from '../lib/format';
import Icon, { Mark } from './Icon';

export const NAV = {
  listen: [
    ['/discover', 'Discover', 'discover'],
    ['/search', 'Search', 'search'],
    ['/library', 'Library', 'library'],
    ['/settings', 'Settings', 'settings'],
  ],
  studio: [
    ['/studio', 'Overview', 'home'],
    ['/studio/profile', 'Artist profile', 'studio'],
    ['/studio/upload', 'Upload recording', 'upload'],
    ['/studio/submissions', 'My submissions', 'inbox'],
    ['/studio/listeners', 'Listeners', 'chart'],
    ['/studio/rights', 'Rights', 'shield'],
  ],
  admin: [
    ['/admin', 'Overview', 'home'],
    ['/admin/users', 'People', 'users', null],
    ['/admin/applications', 'Artist applications', 'inbox', 'applications'],
    ['/admin/artists', 'Artists', 'studio', 'artists'],
    ['/admin/songs', 'Songs', 'disc'],
    ['/admin/albums', 'Albums', 'layers'],
    ['/admin/uploads', 'Uploads & audio', 'upload', 'uploads'],
    ['/admin/reports', 'Reports', 'flag', 'reports'],
    ['/admin/library', 'Moods & genres', 'tag'],
    ['/admin/audit', 'Activity log', 'file'],
    ['/admin/settings', 'Settings', 'settings'],
    ['/admin/health', 'System health', 'pulse'],
  ],
};
const AREA_NAME = { listen: null, studio: 'Studio', admin: 'Admin' };

/** Exact match for area roots, prefix match for the rest. */
export function isActive(href, path) {
  if (['/studio', '/admin'].includes(href)) return path === href;
  return path === href || path.startsWith(`${href}/`);
}

function Seek() {
  const { seek, current } = usePlayer();
  const { position, duration: total } = useProgress();
  return (
    <div className="seek">
      <span className="tiny num">{duration(position)}</span>
      <input type="range" min="0" max={Math.max(1, Math.round(total))} step="1" value={Math.round(position)} disabled={!total}
        aria-label={`Position in ${current?.title || 'song'}`} aria-valuetext={`${duration(position)} of ${duration(total)}`}
        onChange={(e) => seek(Number(e.target.value))} />
      <span className="tiny num">{duration(total)}</span>
    </div>
  );
}

function QueuePanel({ onClose }) {
  const { queue, index, playAt, removeAt, move } = usePlayer();
  return (
    <div className="queue" role="dialog" aria-label="Play queue">
      <div className="section-head"><h2 className="h3">Up next</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="Close queue"><Icon name="x" /></button></div>
      {queue.length === 0 ? <p className="small muted">The queue is empty. Use “Play all” on a mix, playlist or album.</p> : (
        <ol className="queue-list">
          {queue.map((item, i) => (
            <li key={item.key} aria-current={i === index ? 'true' : undefined}>
              <button type="button" className="queue-title" onClick={() => playAt(i)}>{item.song.title}<span className="tiny muted"> — {item.song.artist?.name}</span></button>
              <span className="row-actions">
                <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${item.song.title} up`}><Icon name="up" size={16} /></button>
                <button type="button" className="icon-btn" disabled={i === queue.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${item.song.title} down`}><Icon name="down" size={16} /></button>
                <button type="button" className="icon-btn" disabled={i === index} onClick={() => removeAt(i)} aria-label={`Remove ${item.song.title} from the queue`}><Icon name="x" size={16} /></button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function PlayerBar() {
  const { current, playing, loading, toggle, stop, next, previous, queue, index, volume, muted, setVolume, toggleMute } = usePlayer();
  const [showQueue, setShowQueue] = useState(false);
  if (!current) return null;
  return (
    <div className="playerbar" role="region" aria-label="Now playing">
      {showQueue && <QueuePanel onClose={() => setShowQueue(false)} />}
      <div className="cover" style={{ background: current.artworkUrl ? `center/cover url(${current.artworkUrl})` : cover(current.cover) }} />
      <div style={{ minWidth: 0, display: 'grid', gap: 2 }}>
        <Link to={`/song/${current.id}`} className="small" style={{ fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'inherit' }}>{current.title}</Link>
        <span className="tiny" style={{ opacity: 0.75 }}>{current.artist?.name}{current.album ? ` — ${current.album.title}` : ''}</span>
        <Seek />
      </div>
      <div className="player-controls">
        <button type="button" className="icon-btn" onClick={previous} aria-label="Previous song"><Icon name="prev" /></button>
        <button type="button" className="icon-btn play-main" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} disabled={loading}><Icon name={playing ? 'pause' : 'play'} /></button>
        <button type="button" className="icon-btn" onClick={next} disabled={index >= queue.length - 1} aria-label="Next song"><Icon name="next" /></button>
        <span className="volume">
          <button type="button" className="icon-btn" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}><Icon name={muted || volume === 0 ? 'mute' : 'volume'} /></button>
          <input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume" />
        </span>
        <button type="button" className="icon-btn" onClick={() => setShowQueue((v) => !v)} aria-expanded={showQueue} aria-label={`Queue, ${queue.length} songs`}><Icon name="queue" /></button>
        <button type="button" className="icon-btn" onClick={stop} aria-label="Stop and close player"><Icon name="x" /></button>
      </div>
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ unread: 0, items: [] });
  const { navigate, path } = useRouter();
  const toast = useToast();
  // Background refresh: a failed poll keeps the last list and is retried on the next tick.
  const load = () => api.notifications().then(setData).catch((err) => console.warn('LOOP: notifications not refreshed —', err.message));
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [path]);
  async function openItem(n) {
    setOpen(false);
    await api.readNotifications([n.id]).then(setData).catch((err) => toast(`Could not mark it read: ${err.message}`, 'error'));
    if (n.link) navigate(n.link);
  }
  return (
    <div className="notif">
      <button type="button" className="icon-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Notifications${data.unread ? `, ${data.unread} unread` : ''}`}>
        <Icon name="bell" />{data.unread > 0 && <span className="dot-count" aria-hidden="true">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="section-head"><strong>Notifications</strong>{data.unread > 0 && <button type="button" className="btn btn-quiet btn-sm" onClick={() => api.readNotifications().then(setData).catch((err) => toast(err.message, 'error'))}>Mark all read</button>}</div>
          {data.items.length === 0 ? <p className="small muted">Nothing new.</p> : (
            <ul className="list">
              {data.items.map((n) => (
                <li key={n.id} className="list-item" data-unread={!n.readAt}>
                  <button type="button" className="notif-item" onClick={() => openItem(n)}>
                    <span className="small" style={{ fontWeight: n.readAt ? 400 : 650 }}>{n.title}</span>
                    {n.body && <span className="tiny muted">{n.body}</span>}
                    <span className="tiny muted">{relativeDate(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function useBadges(area) {
  const [badges, setBadges] = useState({});
  const { path } = useRouter();
  useEffect(() => {
    if (area !== 'admin') return undefined;
    let live = true;
    api.admin.badges().then((b) => live && setBadges(b)).catch((err) => console.warn('LOOP: admin counts not refreshed —', err.message));
    return () => { live = false; };
  }, [area, path]);
  return badges;
}

export default function Shell({ area = 'listen', children }) {
  const { user, logout, platform } = useAuth();
  const { path, navigate } = useRouter();
  const items = NAV[area];
  const badges = useBadges(area);
  const switches = [];
  // [href, label, short label for the phone top bar]
  if (area !== 'listen' && user.role !== 'ADMIN') switches.push(['/discover', 'Back to listening', 'Listen']);
  if (area === 'admin') switches.push(['/discover', 'Open the listener view', 'Listen']);
  if (area !== 'studio' && user.role === 'ARTIST') switches.push(['/studio', 'Artist studio', 'Studio']);
  if (area !== 'admin' && user.role === 'ADMIN') switches.push(['/admin', 'Admin console', 'Admin']);

  async function signOut() {
    await logout();
    navigate('/login?signedOut=1', { replace: true });
  }
  const badge = (key) => (key && Number(badges[key]) > 0 ? <span className="count" aria-label={`, ${badges[key]} waiting`}>{badges[key]}</span> : null);

  const nav = (
    <nav aria-label={AREA_NAME[area] ? `${AREA_NAME[area]} navigation` : 'Main navigation'}>
      <ul className="nav">
        {items.map(([href, label, icon, key]) => (
          <li key={href}><Link to={href} aria-current={isActive(href, path) ? 'page' : undefined}><Icon name={icon} />{label}{badge(key)}</Link></li>
        ))}
      </ul>
    </nav>
  );

  return (
    <div className="shell" data-area={area}>
      <a className="skip" href="#main">Skip to content</a>
      <aside className="rail">
        <Link className="brand" to={area === 'admin' ? '/admin' : area === 'studio' ? '/studio' : '/discover'}>
          <Mark /><span className="brand-word">loop</span>{AREA_NAME[area] && <span className="brand-area">{AREA_NAME[area]}</span>}
        </Link>
        <div className="rail-notif"><Notifications /></div>
        {nav}
        <div className="rail-foot">
          {switches.length > 0 && (
            <div className="area-switch">{switches.map(([href, label]) => <Link key={label} to={href}>{label}</Link>)}</div>
          )}
          <div className="who">
            <strong>{user.displayName}</strong>
            <span className="tiny muted">@{user.username}</span>
            <span><span className="badge">{ROLE_LABEL[user.role] || user.role}</span></span>
            <button type="button" className="btn btn-quiet btn-sm" style={{ justifyContent: 'flex-start', paddingLeft: 0 }} onClick={signOut}>
              <Icon name="out" size={18} />Sign out
            </button>
          </div>
          <div className="tiny muted legal-links"><Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link></div>
        </div>
      </aside>

      <div style={{ minWidth: 0 }}>
        <header className="topbar">
          <Link className="brand" to={area === 'admin' ? '/admin' : area === 'studio' ? '/studio' : '/discover'}>
            <Mark size={22} /><span className="brand-word" style={{ fontSize: '1.35rem' }}>loop</span>
            {AREA_NAME[area] && <span className="brand-area">{AREA_NAME[area]}</span>}
          </Link>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {switches.slice(0, 1).map(([href, label, short]) => <Link key={label} className="btn btn-quiet btn-sm" to={href} aria-label={label}>{short}</Link>)}
            <Notifications />
            <button type="button" className="icon-btn" onClick={signOut} aria-label="Sign out"><Icon name="out" /></button>
          </div>
        </header>
        {platform?.maintenanceMessage && <p className="notice notice-warn banner" role="status">{platform.maintenanceMessage}</p>}
        {area !== 'listen' && (
          <nav className="subnav" aria-label={`${AREA_NAME[area]} sections`}>
            {items.map(([href, label, , key]) => <Link key={href} to={href} aria-current={isActive(href, path) ? 'page' : undefined}>{label}{badge(key)}</Link>)}
          </nav>
        )}
        <main id="main" className="main" tabIndex={-1}>{children}</main>
      </div>

      {area === 'listen' && (
        <nav className="tabbar" aria-label="Main navigation (mobile)">
          {items.map(([href, label, icon]) => (
            <Link key={href} to={href} aria-current={isActive(href, path) ? 'page' : undefined}><Icon name={icon} />{label}</Link>
          ))}
        </nav>
      )}
      <PlayerBar />
    </div>
  );
}
