import { api } from '../../lib/api';
import { Link } from '../../lib/router';
import { relativeDate } from '../../lib/format';
import { PageHead, StatusBadge } from '../../components/ui';
import { useLoad } from './common';

const n = (v) => Number(v || 0).toLocaleString();

export default function Overview() {
  const { data, guard, reload } = useLoad(() => api.admin.overview(), []);
  if (guard) return <><PageHead title="Admin" />{guard}</>;
  const c = data.counts;
  const h = data.health;
  const todo = [
    [c.applications_pending, 'artist applications to decide', '/admin/applications'],
    [c.name_changes_pending, 'artist name changes to review', '/admin/artists?status=pending'],
    [c.uploads_to_review, 'recordings to review', '/admin/uploads'],
    [c.uploads_to_publish, 'approved recordings to publish', '/admin/uploads?status=APPROVED'],
    [c.reports_open, 'open reports', '/admin/reports'],
    [c.songs_need_profile, 'songs waiting for a sound profile', '/admin/songs?state=NEEDS_PROFILE'],
    [c.audio_missing, 'recordings missing from storage', '/admin/uploads?tab=library'],
  ].filter(([v]) => Number(v) > 0);
  return (
    <>
      <PageHead title="Admin" actions={<button type="button" className="btn btn-sm" onClick={reload}>Refresh</button>}>What needs attention on LOOP right now.</PageHead>
      <section className="section" aria-labelledby="todo">
        <h2 id="todo" className="h3">To do</h2>
        {todo.length === 0 ? <p className="notice notice-ok">Nothing is waiting. 🎧</p> : (
          <ul className="list">{todo.map(([v, label, to]) => <li key={label} className="list-item"><Link className="title" to={to}>{n(v)} {label}</Link><span aria-hidden="true">→</span></li>)}</ul>
        )}
        {Number(c.uploads_in_quarantine) > 0 && (
          <p className={`notice ${h.scanner.state === 'ready' ? '' : 'notice-warn'}`}>
            {n(c.uploads_in_quarantine)} upload(s) waiting for the malware scanner{c.oldest_quarantine ? `, the oldest since ${relativeDate(c.oldest_quarantine)}` : ''}.
            {h.scanner.state !== 'ready' && <> Scanner: {h.scanner.detail}</>}
          </p>
        )}
      </section>
      <section className="section" aria-labelledby="numbers">
        <h2 id="numbers" className="h3">LOOP in numbers</h2>
        <div className="stats">
          <Link className="stat" to="/admin/users"><b>{n(c.users_total)}</b><span>Accounts ({n(c.users_active)} active, {n(c.registrations_7d)} new this week)</span></Link>
          <div className="stat"><b>{n(c.listeners_30d)}</b><span>People who listened in the last 30 days</span></div>
          <Link className="stat" to="/admin/artists"><b>{n(c.artists_total)}</b><span>Artists ({n(c.artists_linked)} with accounts, {n(c.artists_suspended)} suspended)</span></Link>
          <Link className="stat" to="/admin/songs?state=PUBLISHED"><b>{n(c.songs_published)}</b><span>Published songs ({n(c.songs_playable)} playable)</span></Link>
          <Link className="stat" to="/admin/songs?state=HIDDEN"><b>{n(c.songs_hidden)}</b><span>Hidden songs</span></Link>
          <Link className="stat" to="/admin/songs?state=SUSPENDED"><b>{n(c.songs_moderated)}</b><span>Suspended or taken down</span></Link>
          <Link className="stat" to="/admin/uploads?status=REJECTED"><b>{n(c.uploads_rejected_30d)}</b><span>Uploads rejected, 30 days</span></Link>
          <Link className="stat" to="/admin/albums"><b>{n(c.albums_total)}</b><span>Albums</span></Link>
          <div className="stat"><b>{n(c.plays_7d)}</b><span>Plays this week ({n(c.plays_total)} in total)</span></div>
          <div className="stat"><b>{n(c.mood_requests_7d)}</b><span>Mood requests this week</span></div>
        </div>
      </section>
      <section className="section split-3">
        <div>
          <div className="section-head"><h2 className="h3">New accounts</h2><Link className="small" to="/admin/users">All people</Link></div>
          <ul className="list">{data.recentRegistrations.map((u) => <li key={u.id} className="list-item"><Link to={`/admin/users/${u.id}`}>{u.displayName}</Link><span className="tiny muted">@{u.username} · {relativeDate(u.createdAt)}</span></li>)}</ul>
        </div>
        <div>
          <div className="section-head"><h2 className="h3">Recent uploads</h2><Link className="small" to="/admin/uploads?status=ALL">All uploads</Link></div>
          <ul className="list">{data.recentUploads.map((u) => <li key={u.id} className="list-item"><Link to={`/admin/uploads/${u.id}`}>{u.title}</Link><span className="row-actions"><span className="tiny muted">{u.artistName}</span><StatusBadge status={u.status} /></span></li>)}</ul>
        </div>
        <div>
          <div className="section-head"><h2 className="h3">Admin activity</h2><Link className="small" to="/admin/audit">Activity log</Link></div>
          <ul className="list">{data.recentAdminActivity.map((a) => <li key={a.id} className="list-item"><span className="small">{a.action.replace(/_/g, ' ').toLowerCase()} — {a.entityType} {a.entityId}</span><span className="tiny muted">{a.actor} · {relativeDate(a.createdAt)}</span></li>)}</ul>
        </div>
      </section>
      <section className="section" aria-labelledby="health">
        <div className="section-head"><h2 id="health" className="h3">System</h2><Link className="small" to="/admin/health">Details</Link></div>
        <ul className="list">
          <li className="list-item"><span>Database</span><span className="badge badge-ok">up, schema {h.schema}</span></li>
          <li className="list-item"><span>Audio storage</span><span className={`badge ${h.storage.state === 'ready' ? 'badge-ok' : 'badge-warn'}`}>{h.storage.state}{h.storage.persistence ? `, ${h.storage.persistence}` : ''}</span></li>
          <li className="list-item"><span>Malware scanner</span><span className={`badge ${h.scanner.state === 'ready' ? 'badge-ok' : 'badge-warn'}`}>{h.scanner.state.replace('_', ' ')}</span></li>
          <li className="list-item"><span>Failed background jobs (7 days)</span><span className={`badge ${Number(c.jobs_failed_7d) ? 'badge-danger' : 'badge-ok'}`}>{n(c.jobs_failed_7d)}</span></li>
        </ul>
      </section>
    </>
  );
}
