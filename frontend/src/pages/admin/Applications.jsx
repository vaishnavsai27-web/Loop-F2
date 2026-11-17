import { useState } from 'react';
import { api } from '../../lib/api';
import { Link } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { relativeDate } from '../../lib/format';
import { Dialog, Empty, ErrorState, Field, PageHead, Pager, StatusBadge, Tabs } from '../../components/ui';
import { SearchBox, useFilters, useLoad } from './common';

export default function Applications() {
  const [f, set] = useFilters({ status: 'PENDING', q: '' });
  const [deciding, setDeciding] = useState(null);   // { app, action }
  const { data, guard, reload } = useLoad(() => api.admin.applications({ status: f.status, q: f.q, page: f.page }), [f.status, f.q, f.page]);
  return (
    <>
      <PageHead title="Artist applications">Approving gives the person Artist access with a new artist profile, or links them to an artist already in the catalogue.</PageHead>
      <div className="filters">
        <Tabs label="Application status" value={f.status} onChange={(status) => set({ status })} items={[['PENDING', 'Waiting'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['WITHDRAWN', 'Withdrawn'], ['ALL', 'All']]} />
        <SearchBox value={f.q} onSearch={(q) => set({ q })} label="Find an application" placeholder="Stage name, username or email" />
      </div>
      {guard || (data.applications.length === 0 ? <Empty title="No applications here" /> : (
        <>
          <ul className="list">
            {data.applications.map((a) => (
              <li key={a.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div className="list-item-main">
                  <span className="title">{a.stageName} <span className="small muted">({a.artistType.toLowerCase()}, {a.countryCode})</span></span>
                  <span className="small muted"><Link to={`/admin/users/${a.userId}`}>{a.displayName} @{a.username}</Link> — sent {relativeDate(a.submittedAt)}
                    {a.previousApplications > 0 && ` — ${a.previousApplications} earlier application(s), ${a.previousRejections} rejected`}{!a.userActive && ' — account deactivated'}</span>
                  {a.bio && <span className="small">{a.bio}</span>}
                  <span className="small">
                    {a.websiteUrl && <a href={a.websiteUrl} target="_blank" rel="noreferrer noopener">Website</a>}
                    {a.websiteUrl && a.proofUrl && ' — '}
                    {a.proofUrl && <a href={a.proofUrl} target="_blank" rel="noreferrer noopener">Proof of identity link</a>}
                    {!a.websiteUrl && !a.proofUrl && <span className="muted">No links given — ask for proof before approving a well-known name.</span>}
                  </span>
                  {a.sameNameArtists.length > 0 && (
                    <span className="notice notice-warn small">LOOP already has {a.sameNameArtists.map((x) => `“${x.name}${x.disambiguation ? ` (${x.disambiguation})` : ''}”${x.linked ? ' — claimed by an account' : ''}`).join(', ')}. Link to it if this is the same artist; otherwise make sure it is not an impersonation.</span>
                  )}
                  {a.reviewNote && <span className="small">Note: “{a.reviewNote}”</span>}
                  {a.artistId && <Link className="small" to={`/admin/artists/${a.artistId}`}>Artist profile</Link>}
                </div>
                {a.status === 'PENDING' ? (
                  <div className="row-actions">
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => setDeciding({ app: a, action: 'APPROVE' })}>Approve…</button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeciding({ app: a, action: 'REJECT' })}>Reject…</button>
                  </div>
                ) : <StatusBadge status={a.status} />}
              </li>
            ))}
          </ul>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} noun="applications" onPage={(page) => set({ page })} />
        </>
      ))}
      <Decide state={deciding} onClose={() => setDeciding(null)} onDone={reload} />
    </>
  );
}

function Decide({ state, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ note: '', stageName: '', link: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const app = state?.app;
  const approve = state?.action === 'APPROVE';
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.admin.decideApplication(app.id, { action: state.action, ...(form.note.trim() ? { note: form.note.trim() } : {}),
        ...(approve && form.stageName.trim() && form.stageName.trim() !== app.stageName ? { stageName: form.stageName.trim() } : {}),
        ...(approve && form.link ? { linkArtistId: Number(form.link) } : {}) });
      toast(approve ? `${app.stageName} now has Artist access` : 'Application rejected; the applicant was told why');
      onClose(); onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!state} onClose={onClose} title={app ? `${approve ? 'Approve' : 'Reject'} “${app.stageName}”` : ''}>
      {app && (
        <form className="form" onSubmit={(e) => { submit(e); }} onReset={() => setForm({ note: '', stageName: '', link: '' })}>
          {approve && (
            <>
              <Field label="Artist name listeners will see" hint="correct it if needed"><input className="input" maxLength={100} placeholder={app.stageName} value={form.stageName} onChange={(e) => setForm({ ...form, stageName: e.target.value })} /></Field>
              {app.sameNameArtists.length > 0 && (
                <Field label="Profile">
                  <select className="select" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })}>
                    <option value="">Create a new artist profile</option>
                    {app.sameNameArtists.filter((x) => !x.linked).map((x) => <option key={x.id} value={x.id}>Link to existing “{x.name}{x.disambiguation ? ` (${x.disambiguation})` : ''}” #{x.id}</option>)}
                  </select>
                </Field>
              )}
            </>
          )}
          <Field label={approve ? 'Note to the applicant' : 'Reason (sent to the applicant)'} hint={approve ? 'optional' : 'required'}>
            <textarea className="textarea" maxLength={500} required={!approve} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <ErrorState error={error} />
          <div className="dialog-actions">
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className={`btn ${approve ? 'btn-primary' : 'btn-danger'}`} disabled={busy || (!approve && form.note.trim().length < 3)}>{busy ? 'Saving…' : approve ? 'Approve' : 'Reject'}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
