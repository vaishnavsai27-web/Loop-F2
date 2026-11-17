import { useState } from 'react';
import { api } from '../../lib/api';
import { Link } from '../../lib/router';
import { Empty, Field, PageHead, Pager } from '../../components/ui';
import { Select, useFilters, useLoad } from './common';

const LINKS = { user: 'users', song: 'songs', artist: 'artists', album: 'albums', artist_upload: 'uploads', report: 'reports', artist_application: null };

function Change({ entry }) {
  const [open, setOpen] = useState(false);
  if (!entry.oldValues && !entry.newValues) return null;
  return (
    <>
      <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}</button>
      {open && <pre className="tiny audit-json">{JSON.stringify({ before: entry.oldValues, after: entry.newValues }, null, 2)}</pre>}
    </>
  );
}

export default function Audit() {
  const [f, set] = useFilters({ actor: '', action: '', entityType: '', entityId: '', from: '', to: '' });
  const [draft, setDraft] = useState({ actor: f.actor, entityId: f.entityId, from: f.from, to: f.to });
  const query = { actor: f.actor, action: f.action, entityType: f.entityType, entityId: f.entityId, from: f.from, to: f.to };
  const { data, guard } = useLoad(() => api.admin.audit({ ...query, page: f.page, pageSize: 50 }), [f.actor, f.action, f.entityType, f.entityId, f.from, f.to, f.page]);
  return (
    <>
      <PageHead title="Activity log" actions={<a className="btn btn-sm" href={api.admin.auditCsvUrl(query)} download>Download CSV</a>}>
        Every sign-in, access change, moderation decision, deletion and settings change, with who did it and when. Entries cannot be edited or deleted.
      </PageHead>
      <form className="filters" onSubmit={(e) => { e.preventDefault(); set(draft); }}>
        <Field label="Who"><input className="input" placeholder="Username or ID" value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} /></Field>
        {data && <Select label="Action" value={f.action} onChange={(action) => set({ action })} options={data.actions.map((a) => [a, a.replace(/_/g, ' ').toLowerCase()])} />}
        <Select label="About" value={f.entityType} onChange={(entityType) => set({ entityType })} options={[['user', 'People'], ['artist', 'Artists'], ['song', 'Songs'], ['album', 'Albums'], ['artist_upload', 'Uploads'], ['artist_application', 'Applications'], ['report', 'Reports'], ['platform_settings', 'Settings'], ['mood', 'Moods'], ['genre', 'Genres']]} />
        <Field label="ID"><input className="input" value={draft.entityId} onChange={(e) => setDraft({ ...draft, entityId: e.target.value })} style={{ width: 120 }} /></Field>
        <Field label="From"><input className="input" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></Field>
        <Field label="To"><input className="input" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
        <div style={{ alignSelf: 'end' }}><button className="btn">Apply</button></div>
      </form>
      {guard || (data.entries.length === 0 ? <Empty title="Nothing recorded for these filters" /> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>About</th><th><span className="sr-only">Details</span></th></tr></thead>
            <tbody>{data.entries.map((e) => (
              <tr key={e.id}>
                <td className="small">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="small">{e.actorId ? <Link to={`/admin/users/${e.actorId}`}>{e.actor}</Link> : e.actor || 'system'}</td>
                <td className="small">{e.action.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="small">{LINKS[e.entityType] ? <Link to={`/admin/${LINKS[e.entityType]}/${e.entityId}`}>{e.entityType.replace('_', ' ')} {e.entityId}</Link> : `${e.entityType.replace('_', ' ')} ${e.entityId}`}</td>
                <td><Change entry={e} /></td>
              </tr>
            ))}</tbody>
          </table></div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} noun="entries" onPage={(page) => set({ page })} />
        </>
      ))}
    </>
  );
}
