import { useState } from 'react';
import { api } from '../../lib/api';
import { useAuth, ROLE_LABEL } from '../../lib/auth';
import { Link } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { deviceLabel, relativeDate } from '../../lib/format';
import { Definition, Dialog, Empty, Field, PageHead, Pager, StatusBadge, useConfirm } from '../../components/ui';
import { History, SearchBox, Select, useFilters, useLoad } from './common';

const statusOf = (u) => (u.anonymisedAt ? 'ANONYMISED' : !u.isActive ? 'DEACTIVATED' : u.locked ? 'LOCKED' : 'ACTIVE');

export default function People({ id }) {
  return id ? <Person id={Number(id)} /> : <PeopleList />;
}

function PeopleList() {
  const [f, set] = useFilters({ q: '', role: '', status: '', sort: 'newest' });
  const { data, guard } = useLoad(() => api.admin.users({ q: f.q, role: f.role, status: f.status, sort: f.sort, page: f.page, pageSize: 25 }), [f.q, f.role, f.status, f.sort, f.page]);
  return (
    <>
      <PageHead title="People">Everyone with a LOOP account. Open a person to change their access, help them sign in or handle a report.</PageHead>
      <div className="filters">
        <SearchBox value={f.q} onSearch={(q) => set({ q })} label="Find a person" placeholder="Name, username, email or ID" />
        <Select label="Role" value={f.role} onChange={(role) => set({ role })} options={[['LISTENER', 'Listeners'], ['ARTIST', 'Artists'], ['ADMIN', 'Admins']]} />
        <Select label="Status" value={f.status} onChange={(status) => set({ status })} options={[['active', 'Active'], ['locked', 'Locked'], ['deactivated', 'Deactivated'], ['password_change', 'Must change password'], ['anonymised', 'Anonymised']]} />
        <Select label="Order" value={f.sort} all={null} onChange={(sort) => set({ sort })} options={[['newest', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Name'], ['last_login', 'Last sign-in']]} />
      </div>
      {guard || (data.users.length === 0 ? <Empty title="Nobody matches these filters" /> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>Person</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Last sign-in</th></tr></thead>
            <tbody>{data.users.map((u) => (
              <tr key={u.id}>
                <td><Link to={`/admin/users/${u.id}`}><strong>{u.displayName}</strong></Link><div className="tiny muted">@{u.username} · #{u.id}</div></td>
                <td className="small">{u.email}</td>
                <td>{ROLE_LABEL[u.role]}</td>
                <td><StatusBadge status={statusOf(u)} />{u.mustChangePassword && <> <span className="badge badge-warn">new password needed</span></>}</td>
                <td className="small">{relativeDate(u.createdAt)}</td>
                <td className="small">{u.lastLoginAt ? relativeDate(u.lastLoginAt) : 'never'}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} noun="people" onPage={(page) => set({ page })} />
        </>
      ))}
    </>
  );
}

function Person({ id }) {
  const { user: me } = useAuth();
  const toast = useToast();
  const [confirm, dialog] = useConfirm();
  const [link, setLink] = useState(null);
  const { data: u, guard, reload } = useLoad(() => api.admin.user(id), [id]);
  if (guard) return <><PageHead title="Person" back={['/admin/users', 'People']} />{guard}</>;
  const self = u.id === me.id;
  const done = (msg) => { toast(msg); reload(); };
  const status = statusOf(u);

  const actions = {
    deactivate: () => confirm({ title: `Deactivate @${u.username}?`, danger: true, confirmLabel: 'Deactivate', reason: true, reasonRequired: true,
      children: <p>They are signed out everywhere at once and cannot sign in until reactivated. Their music and data stay.</p>,
      onConfirm: async (reason) => { await api.admin.setActive(u.id, false, reason); done(`@${u.username} deactivated and signed out`); } }),
    reactivate: () => confirm({ title: `Reactivate @${u.username}?`, confirmLabel: 'Reactivate',
      onConfirm: async () => { await api.admin.setActive(u.id, true); done(`@${u.username} can sign in again`); } }),
    lock: () => confirm({ title: `Lock @${u.username}?`, danger: true, confirmLabel: 'Lock account', reason: true, reasonRequired: true,
      children: <p>Use this for suspicious activity: the account is signed out and cannot sign in until you unlock it.</p>,
      onConfirm: async (reason) => { await api.admin.setLock(u.id, true, reason); done('Account locked'); } }),
    unlock: () => confirm({ title: `Unlock @${u.username}?`, confirmLabel: 'Unlock', children: <p>This also clears their wrong-password count.</p>,
      onConfirm: async () => { await api.admin.setLock(u.id, false); done('Account unlocked'); } }),
    signOut: () => confirm({ title: `Sign @${u.username} out everywhere?`, confirmLabel: 'Sign out everywhere',
      onConfirm: async () => { const r = await api.admin.signOutUser(u.id); done(`${r.sessionsRevoked} sign-in(s) ended`); } }),
    reset: () => confirm({ title: `Create a password reset link for @${u.username}?`, confirmLabel: 'Create link',
      children: <p>The link works once, for 24 hours. Give it to the person through a channel you trust; it is also emailed when email is set up.</p>,
      onConfirm: async () => { const r = await api.admin.resetLink(u.id); setLink(r); reload(); } }),
    role: (role) => confirm({ title: `Make @${u.username} ${role === 'ARTIST' ? 'an Artist' : 'a Listener'}?`, confirmLabel: 'Change role',
      children: <p>{role === 'ARTIST' ? 'They get the Artist studio for the artist profile linked to their account.' : 'They lose the Artist studio. Their published music stays on LOOP; suspend the artist if it should not.'}</p>,
      onConfirm: async () => { await api.admin.setRole(u.id, role); done(`@${u.username} is now ${ROLE_LABEL[role]}`); } }),
    anonymise: () => confirm({ title: `Anonymise @${u.username}?`, danger: true, confirmLabel: 'Anonymise account', reason: true, reasonRequired: true, typeToConfirm: 'ANONYMISE',
      children: <p>Use this for a deletion request when the account has records LOOP must keep (uploads, reports). Their name, email, history, likes and playlists are removed; legal records stay under a pseudonym. This cannot be undone.</p>,
      onConfirm: async (reason) => { await api.admin.anonymise(u.id, reason); done('Account anonymised'); } }),
  };

  return (
    <>
      <PageHead title={u.displayName} back={['/admin/users', 'People']}>@{u.username} · {u.email} · #{u.id}</PageHead>
      <div className="row-actions" style={{ flexWrap: 'wrap' }}>
        <StatusBadge status={status} /> <span className="badge">{ROLE_LABEL[u.role]}</span>
        {u.mustChangePassword && <span className="badge badge-warn">must choose a new password</span>}
      </div>
      {!u.anonymisedAt && (
        <section className="section">
          <h2 className="h3">Actions</h2>
          {self ? <p className="small muted">You can’t change your own access here. Another Admin can.</p> : (
            <div className="composer-actions">
              {u.isActive ? <button type="button" className="btn btn-danger btn-sm" onClick={actions.deactivate}>Deactivate</button> : <button type="button" className="btn btn-sm" onClick={actions.reactivate}>Reactivate</button>}
              {u.locked ? <button type="button" className="btn btn-sm" onClick={actions.unlock}>Unlock</button> : <button type="button" className="btn btn-sm" onClick={actions.lock}>Lock</button>}
              <button type="button" className="btn btn-sm" onClick={actions.reset}>Password reset link</button>
              <button type="button" className="btn btn-sm" onClick={actions.signOut} disabled={!u.sessions.length}>Sign out everywhere</button>
              {u.role === 'LISTENER' && u.artists.some((a) => a.accountStatus === 'ACTIVE') && <button type="button" className="btn btn-sm" onClick={() => actions.role('ARTIST')}>Make Artist</button>}
              {u.role === 'ARTIST' && <button type="button" className="btn btn-sm" onClick={() => actions.role('LISTENER')}>Make Listener</button>}
              <button type="button" className="btn btn-sm btn-danger" onClick={actions.anonymise}>Anonymise…</button>
            </div>
          )}
          {u.role === 'ADMIN' && <p className="small muted">Admin access is granted only on the server (npm run admin:provision); it can be removed here by another Admin.</p>}
          {u.role === 'ADMIN' && !self && <div className="composer-actions"><button type="button" className="btn btn-sm" onClick={() => actions.role('LISTENER')}>Remove Admin access</button></div>}
        </section>
      )}
      <section className="section split">
        <div>
          <h2 className="h3">Account</h2>
          <Definition items={[
            ['Joined', new Date(u.createdAt).toLocaleString()], ['Last sign-in', u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'],
            ['Password changed', u.passwordChangedAt ? relativeDate(u.passwordChangedAt) : '—'], ['Email', u.emailVerifiedAt ? 'confirmed' : 'not confirmed'],
            ['Wrong passwords', u.failedLogins], ['Locked', u.locked ? `${u.lockReason || 'yes'}` : 'no'], ['Deactivated because', !u.isActive ? u.deactivationReason : null],
            ['Terms accepted', u.termsVersion ? `${u.termsVersion}, ${relativeDate(u.termsAcceptedAt)}` : 'before terms versioning'],
            ['Region', u.region], ['Content filter', u.contentFilter],
          ]} />
        </div>
        <div>
          <h2 className="h3">Activity</h2>
          <Definition items={[['Plays', u.activity.plays], ['Last played', u.activity.lastPlayedAt ? relativeDate(u.activity.lastPlayedAt) : '—'], ['Likes', u.activity.likes], ['Playlists', u.activity.playlists]]} />
          <h3 className="h3" style={{ marginTop: 16 }}>Signed in on</h3>
          {u.sessions.length === 0 ? <p className="small muted">No active sign-ins.</p> : <ul className="list">{u.sessions.map((s) => <li key={s.id} className="list-item"><span className="small">{deviceLabel(s.userAgent)}</span><span className="tiny muted">{relativeDate(s.lastSeenAt || s.createdAt)}</span></li>)}</ul>}
        </div>
      </section>
      {(u.artists.length > 0 || u.applications.length > 0 || u.uploads.length > 0) && (
        <section className="section">
          <h2 className="h3">As an artist</h2>
          <ul className="list">
            {u.artists.map((a) => <li key={`a${a.id}`} className="list-item"><Link to={`/admin/artists/${a.id}`}>{a.name}</Link><StatusBadge status={a.accountStatus} /></li>)}
            {u.applications.map((a) => <li key={`p${a.id}`} className="list-item"><span className="small">Application “{a.stageName}” — {relativeDate(a.submittedAt)}{a.reviewNote ? ` — “${a.reviewNote}”` : ''}</span><StatusBadge status={a.status} /></li>)}
            {u.uploads.map((x) => <li key={`u${x.id}`} className="list-item"><Link className="small" to={`/admin/uploads/${x.id}`}>{x.title}</Link><StatusBadge status={x.status} /></li>)}
          </ul>
        </section>
      )}
      <section className="section split">
        <div>
          <h2 className="h3">Reports about this account</h2>
          {u.reportsAgainst.length === 0 ? <p className="small muted">None.</p> : <ul className="list">{u.reportsAgainst.map((r) => <li key={r.id} className="list-item"><Link className="small" to={`/admin/reports/${r.id}`}>{r.reason.replace(/_/g, ' ').toLowerCase()}: {r.details.slice(0, 80)}</Link><StatusBadge status={r.status} /></li>)}</ul>}
        </div>
        <div>
          <h2 className="h3">Reports they sent</h2>
          {u.reportsFiled.length === 0 ? <p className="small muted">None.</p> : <ul className="list">{u.reportsFiled.map((r) => <li key={r.id} className="list-item"><Link className="small" to={`/admin/reports/${r.id}`}>{r.targetType.toLowerCase()} #{r.targetId} — {r.reason.replace(/_/g, ' ').toLowerCase()}</Link><StatusBadge status={r.status} /></li>)}</ul>}
        </div>
      </section>
      <section className="section"><h2 className="h3">Account history</h2><History items={u.history} /></section>
      {dialog}
      <Dialog open={!!link} onClose={() => setLink(null)} title="Password reset link" actions={<button type="button" className="btn" onClick={() => setLink(null)}>Done</button>}>
        {link && <>
          <p className="small">Works once, for {link.expiresInHours} hours. {link.emailed ? 'It was also emailed to the person.' : 'Email is not set up, so give it to them yourself.'}</p>
          <Field label="Link"><input className="input" readOnly value={link.url.startsWith('http') ? link.url : `${window.location.origin}${link.path}`} onFocus={(e) => e.target.select()} /></Field>
          <div><button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(link.url.startsWith('http') ? link.url : `${window.location.origin}${link.path}`).then(() => toast('Link copied'), () => toast('Copy failed; select the link and copy it yourself', 'error'))}>Copy link</button></div>
        </>}
      </Dialog>
    </>
  );
}
