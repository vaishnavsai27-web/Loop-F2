import { api } from '../../lib/api';
import { ROLE_LABEL } from '../../lib/auth';
import { Link } from '../../lib/router';
import { relativeDate } from '../../lib/format';
import { Empty, PageHead, Tabs } from '../../components/ui';
import { useFilters, useLoad } from './common';

export default function Health({ section }) {
  const [f, set] = useFilters({ tab: section === 'permissions' ? 'permissions' : 'system' });
  return (
    <>
      <PageHead title="System health">Database, storage, scanner, data checks, security and duplicates.</PageHead>
      <Tabs label="Section" value={f.tab} onChange={(tab) => set({ tab })} items={[['system', 'System'], ['security', 'Security'], ['duplicates', 'Duplicates'], ['permissions', 'Permissions']]} />
      {f.tab === 'system' && <System />}
      {f.tab === 'security' && <Security />}
      {f.tab === 'duplicates' && <Duplicates />}
      {f.tab === 'permissions' && <Permissions />}
    </>
  );
}

function System() {
  const { data: h, guard, reload } = useLoad(() => api.admin.health(), []);
  if (guard) return guard;
  const privateIp = /^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|::ffff:(10|127|192\.168)\.)/.test(h.clientIp.seen || '');
  return (
    <>
      <div className="composer-actions"><button type="button" className="btn btn-sm" onClick={reload}>Refresh</button></div>
      <div className="stats">
        <div className="stat"><b>MySQL {String(h.server.version).split('-')[0]}</b><span>{h.server.tables} tables, {Math.round(h.server.sizeKb / 1024)} MB</span></div>
        <div className="stat"><b>{h.catalogue.activeSongs}</b><span>Published songs ({h.catalogue.playableSongs} playable)</span></div>
        <div className="stat"><b>{h.sessions.activeSignIns}</b><span>Active sign-ins</span></div>
        <div className="stat"><b>{h.mediaStorage.state}</b><span>Audio storage ({h.mediaStorage.persistence})</span></div>
        <div className="stat"><b>{h.scanner.state.replace('_', ' ')}</b><span>Malware scanner</span></div>
      </div>
      {h.mediaStorage.state !== 'ready' && <p className="notice notice-warn">{h.mediaStorage.detail || 'Audio storage is not available on this server.'}</p>}
      {h.scanner.state !== 'ready' && <p className="notice notice-warn">Scanner: {h.scanner.detail}</p>}
      <p className={`notice ${privateIp ? 'notice-warn' : ''}`}>The server sees your address as {h.clientIp.seen}{privateIp ? ' — a private address, so the proxy setting (TRUST_PROXY) is probably wrong and rate limits would treat everyone as one visitor.' : ', a public address: proxy settings look right.'}</p>
      <section className="section">
        <h2 className="h3">Data checks</h2>
        <ul className="list">{h.integrity.map((c) => <li key={c.label} className="list-item"><span>{c.label}</span>{c.ok ? <span className="badge badge-ok">ok</span> : <span className="badge badge-danger">{c.violations} rows</span>}</li>)}</ul>
      </section>
      {h.failedJobs.length > 0 && (
        <section className="section"><h2 className="h3">Failed background jobs</h2>
          <ul className="list">{h.failedJobs.map((j) => <li key={j.id} className="list-item"><span>{j.type} #{j.id}</span><span className="small muted">{j.error}</span></li>)}</ul></section>
      )}
      <section className="section"><div className="section-head"><h2 className="h3">Recent activity</h2><Link className="small" to="/admin/audit">Activity log</Link></div>
        <ul className="list">{h.recentAudit.map((a) => <li key={a.id} className="list-item"><span className="small">{a.action.replace(/_/g, ' ').toLowerCase()} — {a.entityType} {a.entityId}</span><span className="tiny muted">{a.actor || 'system'}, {relativeDate(a.createdAt)}</span></li>)}</ul></section>
    </>
  );
}

function Security() {
  const { data, guard } = useLoad(() => api.admin.publishedPasswords(), []);
  if (guard) return guard;
  return (
    <section className="section">
      <h2 className="h3">Accounts with a publicly known password</h2>
      <p className="small muted">These accounts came from the development seed, whose passwords are in the public code. In production they must choose a new password at their next sign-in before doing anything else.</p>
      {data.length === 0 ? <p className="notice notice-ok">None. 🔒</p> : (
        <ul className="list">{data.map((u) => (
          <li key={u.id} className="list-item"><Link to={`/admin/users/${u.id}`}>@{u.username}</Link>
            <span className="row-actions"><span className="badge">{ROLE_LABEL[u.role]}</span>{!u.isActive ? <span className="badge">deactivated</span> : u.mustChange ? <span className="badge badge-ok">blocked until changed</span> : <span className="badge badge-danger">usable</span>}</span></li>
        ))}</ul>
      )}
      <p className="small muted">To be safe, deactivate any seeded account nobody uses (open it and choose Deactivate).</p>
    </section>
  );
}

function Duplicates() {
  const { data, guard } = useLoad(() => api.admin.duplicates(), []);
  if (guard) return guard;
  const empty = !data.sameFile.length && !data.sameSong.length && !data.sameArtistName.length;
  if (empty) return <Empty title="No likely duplicates found" />;
  return (
    <div className="section">
      {data.sameFile.length > 0 && <><h2 className="h3">The same audio file uploaded more than once</h2>
        <ul className="list">{data.sameFile.map((g) => <li key={g.hash} className="list-item"><span className="small">{g.items.map((i) => <Link key={i.upload} to={`/admin/uploads/${i.upload}`}>“{i.title}” by {i.artist} ({i.status.toLowerCase()}) </Link>)}</span></li>)}</ul></>}
      {data.sameSong.length > 0 && <><h2 className="h3">Songs with the same title and length</h2>
        <p className="small muted">Open one and use “Merge into another song” if they are the same recording.</p>
        <ul className="list">{data.sameSong.map((g, i) => <li key={i} className="list-item"><span className="small">{g.items.map((s) => <Link key={s.id} to={`/admin/songs/${s.id}`}>#{s.id} “{s.title}”{s.version ? ` (${s.version})` : ''} by {s.artist} </Link>)}</span></li>)}</ul></>}
      {data.sameArtistName.length > 0 && <><h2 className="h3">Artists with the same name</h2>
        <ul className="list">{data.sameArtistName.map((g) => <li key={g.name} className="list-item"><span className="small">{g.items.map((a) => <Link key={a.id} to={`/admin/artists/${a.id}`}>#{a.id} {a.name}{a.disambiguation ? ` (${a.disambiguation})` : ''} </Link>)}</span></li>)}</ul></>}
    </div>
  );
}

function Permissions() {
  const { data, guard } = useLoad(() => api.admin.permissions(), []);
  if (guard) return guard;
  return (
    <section className="section">
      <p className="small muted">What each role can do. The server checks these on every request; the interface only follows them. Admin access is granted only on the server with npm run admin:provision.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Permission</th>{data.roles.map((r) => <th key={r.code}>{ROLE_LABEL[r.code] || r.name}</th>)}</tr></thead>
        <tbody>{data.permissions.map((p) => (
          <tr key={p.code}><td><strong>{p.description}</strong><div className="tiny muted">{p.code}</div></td>
            {data.roles.map((r) => <td key={r.code}>{r.permissions.includes(p.code) ? <span className="badge badge-ok">yes</span> : <span className="muted">—</span>}</td>)}</tr>
        ))}</tbody>
      </table></div>
    </section>
  );
}
