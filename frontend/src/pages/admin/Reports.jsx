import { useState } from 'react';
import { api } from '../../lib/api';
import { Link } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { relativeDate } from '../../lib/format';
import { Definition, Empty, ErrorState, Field, PageHead, Pager, StatusBadge, Tabs } from '../../components/ui';
import { History, Select, useFilters, useLoad } from './common';

const REASONS = [['COPYRIGHT', 'Copyright'], ['IMPERSONATION', 'Impersonation'], ['EXPLICIT_CONTENT', 'Unlabelled explicit content'], ['MISLABELLED', 'Wrong details'],
  ['SAFETY', 'Safety'], ['SPAM', 'Spam'], ['HARASSMENT', 'Harassment'], ['OTHER', 'Other']];
const ACTION_LABEL = { NONE: 'No action on the content', HIDE: 'Hide the song', SUSPEND: 'Suspend the song', TAKE_DOWN: 'Take the song down (rights)',
  MARK_EXPLICIT: 'Mark the song explicit', SUSPEND_ARTIST: 'Suspend the artist', UNPUBLISH_ALBUM: 'Unpublish the album', DEACTIVATE_USER: 'Deactivate the account', LOCK_USER: 'Lock the account' };
const targetLink = (r) => ({ SONG: `/admin/songs/${r.targetId}`, ARTIST: `/admin/artists/${r.targetId}`, ALBUM: `/admin/albums/${r.targetId}`, USER: `/admin/users/${r.targetId}` }[r.targetType]);

export default function Reports({ id }) {
  return id ? <ReportDetail id={Number(id)} /> : <ReportList />;
}

function ReportList() {
  const [f, set] = useFilters({ status: 'ACTIVE', targetType: '', reason: '' });
  const { data, guard } = useLoad(() => api.admin.reports({ status: f.status, targetType: f.targetType, reason: f.reason, page: f.page }), [f.status, f.targetType, f.reason, f.page]);
  return (
    <>
      <PageHead title="Reports">What listeners and artists reported. Open a report to look at the content, take an action and tell the reporter.</PageHead>
      <Tabs label="Report status" value={f.status} onChange={(status) => set({ status })} items={[['ACTIVE', 'Open and in review'], ['OPEN', 'New'], ['UNDER_REVIEW', 'In review'], ['RESOLVED', 'Resolved'], ['DISMISSED', 'Dismissed'], ['ALL', 'All']]} />
      <div className="filters">
        <Select label="About" value={f.targetType} onChange={(targetType) => set({ targetType })} options={[['SONG', 'Songs'], ['ARTIST', 'Artists'], ['ALBUM', 'Albums'], ['USER', 'Accounts']]} />
        <Select label="Reason" value={f.reason} onChange={(reason) => set({ reason })} options={REASONS} />
      </div>
      {guard || (data.reports.length === 0 ? <Empty title="No reports here" /> : (
        <>
          <ul className="list">{data.reports.map((r) => (
            <li key={r.id} className="list-item">
              <div className="list-item-main">
                <Link className="title" to={`/admin/reports/${r.id}`}>{(REASONS.find(([v]) => v === r.reason) || [])[1]} — {r.target || 'deleted'} <span className="small muted">({r.targetType.toLowerCase()})</span></Link>
                <span className="small muted">{r.details.slice(0, 140)}</span>
                <span className="tiny muted">from @{r.reporter || 'deleted account'} · {relativeDate(r.createdAt)}{r.assignedTo ? ` · handled by @${r.assignedTo}` : ''}{r.reportsOnTarget > 1 ? ` · ${r.reportsOnTarget} reports about this` : ''}</span>
              </div>
              <StatusBadge status={r.status} />
            </li>
          ))}</ul>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} noun="reports" onPage={(page) => set({ page })} />
        </>
      ))}
    </>
  );
}

function ReportDetail({ id }) {
  const toast = useToast();
  const { data: r, guard, setData } = useLoad(() => api.admin.report(id), [id]);
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState({ outcome: 'RESOLVED', action: 'NONE', note: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  if (guard) return <><PageHead title="Report" back={['/admin/reports', 'Reports']} />{guard}</>;
  const open = ['OPEN', 'UNDER_REVIEW'].includes(r.status);
  async function addNote(e) {
    e.preventDefault();
    try { setData(await api.admin.reportNote(id, note.trim())); setNote(''); toast('Note added'); } catch (err) { toast(err.message, 'error'); }
  }
  async function resolve(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { setData(await api.admin.resolveReport(id, { ...decision, note: decision.note.trim(), action: decision.outcome === 'DISMISSED' ? 'NONE' : decision.action })); toast('Report closed; the reporter was told'); }
    catch (err) { setError(err); } finally { setBusy(false); }
  }
  const t = r.target;
  return (
    <>
      <PageHead title={`${(REASONS.find(([v]) => v === r.reason) || [])[1]} report`} back={['/admin/reports', 'Reports']}
        actions={open && !r.assignedTo && <button type="button" className="btn btn-sm" onClick={() => api.admin.assignReport(id).then(setData).then(() => toast('Assigned to you')).catch((err) => toast(err.message, 'error'))}>I’ll handle this</button>}>
        About {r.targetType.toLowerCase()} <Link to={targetLink(r)}>{t ? (t.title || t.name || t.displayName || `#${r.targetId}`) : `#${r.targetId} (deleted)`}</Link> · from {r.reporterId ? <Link to={`/admin/users/${r.reporterId}`}>@{r.reporter}</Link> : 'a deleted account'} · {relativeDate(r.createdAt)}
      </PageHead>
      <div className="row-actions"><StatusBadge status={r.status} />{r.assignedTo && <span className="small muted">handled by @{r.assignedTo}</span>}</div>
      <section className="section split">
        <div>
          <h2 className="h3">What they said</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{r.details}</p>
          {r.evidenceRef && <p><a href={r.evidenceRef} target="_blank" rel="noreferrer noopener">Evidence link</a></p>}
          <h2 className="h3" style={{ marginTop: 16 }}>The reported {r.targetType.toLowerCase()}</h2>
          {!t ? <p className="small muted">It no longer exists.</p> : (
            <>
              {r.targetType === 'SONG' && <><Definition items={[['State', <StatusBadge key="s" status={t.state} />], ['Artist', t.artist?.name], ['Explicit', t.explicit ? 'yes' : 'no'], ['Moods', t.moods?.join(', ')]]} />
                {t.media?.filter((m) => m.availability === 'AVAILABLE').slice(0, 1).map((m) => <audio key={m.id} controls preload="none" src={api.admin.mediaAudioUrl(m.id)} style={{ width: '100%' }} aria-label="Listen to the reported song" />)}</>}
              {r.targetType === 'ARTIST' && <Definition items={[['Status', <StatusBadge key="s" status={t.status} />], ['Songs', t.songs?.length], ['Accounts', t.accounts?.map((a) => `@${a.username}`).join(', ')]]} />}
              {r.targetType === 'ALBUM' && <Definition items={[['Status', <StatusBadge key="s" status={t.status} />], ['Tracks', t.tracks?.length], ['Artists', t.artists?.map((a) => a.name).join(', ')]]} />}
              {r.targetType === 'USER' && <Definition items={[['Account', `@${t.username}`], ['Joined', relativeDate(t.createdAt)], ['Active', t.isActive ? 'yes' : 'no']]} />}
              <Link className="small" to={targetLink(r)}>Open it</Link>
            </>
          )}
          {r.related.length > 0 && <><h2 className="h3" style={{ marginTop: 16 }}>Other reports about it</h2>
            <ul className="list">{r.related.map((x) => <li key={x.id} className="list-item"><Link to={`/admin/reports/${x.id}`}>{x.reason.replace(/_/g, ' ').toLowerCase()} — {relativeDate(x.createdAt)}</Link><StatusBadge status={x.status} /></li>)}</ul></>}
        </div>
        <div>
          <h2 className="h3">Internal notes</h2>
          {r.notes.length === 0 ? <p className="small muted">No notes yet. Notes are for Admins only.</p> : (
            <ol className="timeline">{r.notes.map((n) => <li key={n.id}><span className="small">{n.body}</span><span className="tiny muted">{n.author} · {new Date(n.createdAt).toLocaleString()}</span></li>)}</ol>
          )}
          {open && (
            <form className="form" onSubmit={addNote}>
              <Field label="Add a note"><textarea className="textarea" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <div><button className="btn btn-sm" disabled={!note.trim()}>Add note</button></div>
            </form>
          )}
          {open ? (
            <form className="form panel" onSubmit={resolve} style={{ marginTop: 16 }}>
              <h2 className="h3">Decision</h2>
              <Field label="Outcome"><select className="select" value={decision.outcome} onChange={(e) => setDecision({ ...decision, outcome: e.target.value })}>
                <option value="RESOLVED">The report is valid</option><option value="DISMISSED">The report is not valid (dismiss)</option></select></Field>
              {decision.outcome === 'RESOLVED' && (
                <Field label="Action"><select className="select" value={decision.action} onChange={(e) => setDecision({ ...decision, action: e.target.value })}>
                  {r.actions.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}</select></Field>
              )}
              <Field label="What you decided" hint="the reporter sees this"><textarea className="textarea" required maxLength={500} value={decision.note} onChange={(e) => setDecision({ ...decision, note: e.target.value })} /></Field>
              <ErrorState error={error} />
              <div><button className={`btn ${decision.action !== 'NONE' && decision.outcome === 'RESOLVED' ? 'btn-danger' : 'btn-primary'}`} disabled={busy || decision.note.trim().length < 3}>
                {busy ? 'Saving…' : decision.outcome === 'DISMISSED' ? 'Dismiss report' : decision.action === 'NONE' ? 'Resolve report' : `${ACTION_LABEL[decision.action]} and resolve`}</button></div>
            </form>
          ) : <p className="notice" style={{ marginTop: 16 }}>Closed {r.resolvedAt ? relativeDate(r.resolvedAt) : ''}{r.resolutionAction && r.resolutionAction !== 'NONE' ? ` — ${ACTION_LABEL[r.resolutionAction]}` : ''}: “{r.resolutionNote}”</p>}
          <h2 className="h3" style={{ marginTop: 16 }}>History</h2><History items={r.history} />
        </div>
      </section>
    </>
  );
}
