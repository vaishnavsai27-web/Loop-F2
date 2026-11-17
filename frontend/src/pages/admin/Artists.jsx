import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Link, useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { relativeDate } from '../../lib/format';
import { Definition, Dialog, Empty, ErrorState, Field, PageHead, Pager, StatusBadge, Tabs, useConfirm } from '../../components/ui';
import { History, SearchBox, useFilters, useLoad } from './common';

const TYPES = [['SOLO', 'Solo artist'], ['GROUP', 'Band or group'], ['COMPOSER', 'Composer'], ['ORCHESTRA', 'Ensemble or orchestra']];

export default function Artists({ id }) {
  return id ? <ArtistDetail id={Number(id)} /> : <ArtistList />;
}

function ArtistList() {
  const [f, set] = useFilters({ q: '', status: '' });
  const [creating, setCreating] = useState(false);
  const { data, guard, reload } = useLoad(() => (f.status === 'pending' ? api.admin.nameChanges({ status: 'PENDING', page: f.page })
    : api.admin.artists({ q: f.q, status: f.status, page: f.page })), [f.q, f.status, f.page]);
  return (
    <>
      <PageHead title="Artists" actions={<button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>Add an artist</button>}>
        Catalogue artists and the artist profiles people manage.
      </PageHead>
      <div className="filters">
        <Tabs label="Artist filter" value={f.status} onChange={(status) => set({ status })}
          items={[['', 'All'], ['linked', 'With accounts'], ['suspended', 'Suspended'], ['catalogue', 'Catalogue only'], ['duplicates', 'Same name'], ['pending', 'Name changes']]} />
        {f.status !== 'pending' && <SearchBox value={f.q} onSearch={(q) => set({ q })} label="Find an artist" placeholder="Name, alias or ID" />}
      </div>
      {guard || (f.status === 'pending' ? <NameChanges data={data} onDone={reload} /> : data.artists.length === 0 ? <Empty title="No artists match" /> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>Artist</th><th>Type</th><th>Status</th><th className="num">Songs</th><th className="num">Published</th></tr></thead>
            <tbody>{data.artists.map((a) => (
              <tr key={a.id}>
                <td><Link to={`/admin/artists/${a.id}`}><strong>{a.name}</strong></Link>{a.disambiguation && <span className="tiny muted"> ({a.disambiguation})</span>}
                  {a.pendingNameChanges > 0 && <> <span className="badge badge-warn">name change waiting</span></>}</td>
                <td className="small">{(TYPES.find(([v]) => v === a.type) || [])[1]}</td>
                <td><StatusBadge status={a.status} /></td>
                <td className="num">{a.songs}</td><td className="num">{a.publishedSongs}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} noun="artists" onPage={(page) => set({ page })} />
        </>
      ))}
      <ArtistForm open={creating} onClose={() => setCreating(false)} onSaved={reload} />
    </>
  );
}

function NameChanges({ data, onDone }) {
  const toast = useToast();
  const [confirm, dialog] = useConfirm();
  if (!data.requests.length) return <Empty title="No name changes are waiting" />;
  const decide = (r, action) => confirm({
    title: action === 'APPROVE' ? `Rename “${r.oldName}” to “${r.newName}”?` : `Reject the name “${r.newName}”?`,
    confirmLabel: action === 'APPROVE' ? 'Approve name' : 'Reject', danger: action !== 'APPROVE', reason: true, reasonRequired: action !== 'APPROVE', reasonLabel: 'Note to the artist',
    children: r.clashes.length ? <p className="notice notice-warn">Another artist is already called {r.clashes.map((c) => `“${c.name}” (#${c.id})`).join(', ')}. Approve only if this is not an impersonation.</p> : null,
    onConfirm: async (note) => { await api.admin.decideNameChange(r.id, action, note); toast(action === 'APPROVE' ? 'Name changed' : 'Name change rejected'); onDone(); },
  });
  return (
    <>
      <ul className="list">{data.requests.map((r) => (
        <li key={r.id} className="list-item">
          <div className="list-item-main">
            <span className="title"><Link to={`/admin/artists/${r.artistId}`}>{r.oldName}</Link> → “{r.newName}”</span>
            <span className="small muted">by @{r.requestedBy || 'deleted account'} — {relativeDate(r.createdAt)}{r.reason ? ` — “${r.reason}”` : ''}</span>
            {r.clashes.length > 0 && <span className="small" style={{ color: 'var(--danger)' }}>Same name as an existing artist</span>}
          </div>
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => decide(r, 'APPROVE')}>Approve</button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => decide(r, 'REJECT')}>Reject</button>
          </div>
        </li>
      ))}</ul>
      {dialog}
    </>
  );
}

function ArtistForm({ open, onClose, onSaved, artist = null }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const [form, setForm] = useState({});
  const [error, setError] = useState(null);
  useEffect(() => {
    if (open) setForm(artist ? { name: artist.name, disambiguation: artist.disambiguation, type: artist.type, countryCode: artist.countryCode, formedYear: artist.formedYear || '', bio: artist.bio || '' }
      : { name: '', disambiguation: '', type: 'SOLO', countryCode: 'IN', formedYear: '', bio: '' });
    setError(null);
  }, [open, artist]);
  async function submit(e) {
    e.preventDefault();
    const body = { name: form.name.trim(), disambiguation: form.disambiguation.trim(), type: form.type, countryCode: form.countryCode.toUpperCase(), bio: form.bio, ...(form.formedYear ? { formedYear: Number(form.formedYear) } : {}) };
    try {
      if (artist) { await api.admin.updateArtist(artist.id, body); toast('Artist saved'); onSaved(); onClose(); }
      else { const r = await api.admin.createArtist(body); toast(`${r.name} added`); onClose(); navigate(`/admin/artists/${r.id}`); }
    } catch (err) { setError(err); }
  }
  return (
    <Dialog open={open} onClose={onClose} title={artist ? `Edit ${artist.name}` : 'Add an artist'}>
      <form className="form" onSubmit={submit}>
        <Field label="Name"><input className="input" required maxLength={100} value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Disambiguation" hint="tells same-named artists apart, e.g. a country or city"><input className="input" maxLength={80} value={form.disambiguation || ''} onChange={(e) => setForm({ ...form, disambiguation: e.target.value })} /></Field>
        <div className="form-row">
          <Field label="Type"><select className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{TYPES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>
          <Field label="Country" hint="two letters"><input className="input" maxLength={2} value={form.countryCode || ''} onChange={(e) => setForm({ ...form, countryCode: e.target.value.toUpperCase() })} /></Field>
          <Field label="Since"><input className="input" inputMode="numeric" maxLength={4} value={form.formedYear || ''} onChange={(e) => setForm({ ...form, formedYear: e.target.value.replace(/\D/g, '') })} /></Field>
        </div>
        <Field label="Bio"><textarea className="textarea" maxLength={400} value={form.bio || ''} onChange={(e) => setForm({ ...form, bio: e.target.value })} /></Field>
        <ErrorState error={error} />
        <div className="dialog-actions"><button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
      </form>
    </Dialog>
  );
}

function ArtistDetail({ id }) {
  const toast = useToast();
  const [confirm, dialog] = useConfirm();
  const [editing, setEditing] = useState(false);
  const [aliases, setAliases] = useState(null);
  const { data: a, guard, reload } = useLoad(() => api.admin.artist(id), [id]);
  if (guard) return <><PageHead title="Artist" back={['/admin/artists', 'Artists']} />{guard}</>;
  const suspend = () => confirm({ title: `Suspend “${a.name}”?`, danger: true, confirmLabel: 'Suspend artist', reason: true, reasonRequired: true,
    children: <><p>The linked account(s) lose the Artist studio for this profile, pending uploads freeze, and the artist is told why.</p>
      <p>Published songs are suspended too, so they leave search and recommendations. Reinstating brings back exactly those songs.</p></>,
    onConfirm: async (reason) => { const r = await api.admin.suspendArtist(a.id, reason, true); toast(`Artist suspended; ${r.songsHidden} song(s) suspended`); reload(); } });
  const reinstate = () => confirm({ title: `Reinstate “${a.name}”?`, confirmLabel: 'Reinstate', reason: true, reasonLabel: 'Note to the artist',
    onConfirm: async (note) => { const r = await api.admin.reinstateArtist(a.id, note); toast(`Artist reinstated; ${r.songsRestored} song(s) restored`); reload(); } });
  async function saveAliases() {
    try { await api.admin.setAliases(a.id, aliases.split(',').map((x) => x.trim()).filter(Boolean)); setAliases(null); toast('Aliases saved'); reload(); } catch (err) { toast(err.message, 'error'); }
  }
  return (
    <>
      <PageHead title={a.name} back={['/admin/artists', 'Artists']} actions={<>
        <Link className="btn btn-sm" to={`/artist/${a.id}`}>Public page</Link>
        <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
        {a.status === 'ACTIVE' && <button type="button" className="btn btn-sm btn-danger" onClick={suspend}>Suspend…</button>}
        {a.status === 'SUSPENDED' && <button type="button" className="btn btn-sm" onClick={reinstate}>Reinstate…</button>}
      </>}>{a.disambiguation ? `${a.disambiguation} · ` : ''}#{a.id}</PageHead>
      <div className="row-actions"><StatusBadge status={a.status} /></div>
      {a.sameName.length > 0 && <p className="notice notice-warn">Other artists share this name: {a.sameName.map((x) => <Link key={x.id} to={`/admin/artists/${x.id}`}>{x.name}{x.disambiguation ? ` (${x.disambiguation})` : ''} #{x.id} </Link>)}. Give each a disambiguation, or merge their songs if they are the same artist.</p>}
      <section className="section split">
        <div>
          <h2 className="h3">Profile</h2>
          <Definition items={[['Type', (TYPES.find(([v]) => v === a.type) || [])[1]], ['Country', a.countryCode], ['Since', a.formedYear], ['Bio', a.bio], ['Added', relativeDate(a.createdAt)]]} />
          <h3 className="h3" style={{ marginTop: 16 }}>Also known as</h3>
          {aliases === null ? <p className="small">{a.aliases.map((x) => x.alias).join(', ') || <span className="muted">No aliases.</span>} <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAliases(a.aliases.map((x) => x.alias).join(', '))}>Edit</button></p> : (
            <div className="search-row"><input className="input" aria-label="Aliases, separated by commas" value={aliases} onChange={(e) => setAliases(e.target.value)} /><button type="button" className="btn btn-sm btn-primary" onClick={saveAliases}>Save</button><button type="button" className="btn btn-sm btn-quiet" onClick={() => setAliases(null)}>Cancel</button></div>
          )}
        </div>
        <div>
          <h2 className="h3">Accounts</h2>
          {a.accounts.length === 0 ? <p className="small muted">No LOOP account manages this artist. It exists only in the catalogue.</p> : (
            <ul className="list">{a.accounts.map((x) => <li key={x.userId} className="list-item"><Link to={`/admin/users/${x.userId}`}>@{x.username}</Link>
              <span className="row-actions">{!x.userActive && <span className="badge badge-danger">account deactivated</span>}<StatusBadge status={x.status} /></span></li>)}</ul>
          )}
          {a.accounts.some((x) => x.suspendedReason) && <p className="small">Suspended: {a.accounts.find((x) => x.suspendedReason).suspendedReason}</p>}
        </div>
      </section>
      <section className="section">
        <div className="section-head"><h2 className="h3">Songs ({a.songs.length})</h2><Link className="small" to={`/admin/songs?artistId=${a.id}`}>Manage songs</Link></div>
        {a.songs.length === 0 ? <p className="small muted">No songs.</p> : <ul className="list">{a.songs.slice(0, 30).map((s) => <li key={s.id} className="list-item"><Link to={`/admin/songs/${s.id}`}>{s.title}</Link><StatusBadge status={s.moderationState !== 'CLEAR' ? s.moderationState : s.status === 'ACTIVE' ? 'PUBLISHED' : s.status === 'PENDING_ANALYSIS' ? 'NEEDS_PROFILE' : s.status} /></li>)}</ul>}
      </section>
      <section className="section split">
        <div><h2 className="h3">Albums</h2>{a.albums.length === 0 ? <p className="small muted">None.</p> : <ul className="list">{a.albums.map((x) => <li key={x.id} className="list-item"><Link to={`/admin/albums/${x.id}`}>{x.title}</Link><StatusBadge status={x.status} /></li>)}</ul>}</div>
        <div><h2 className="h3">Uploads</h2>{a.uploads.length === 0 ? <p className="small muted">None.</p> : <ul className="list">{a.uploads.map((x) => <li key={x.id} className="list-item"><Link to={`/admin/uploads/${x.id}`}>{x.title}</Link><StatusBadge status={x.status} /></li>)}</ul>}</div>
      </section>
      <section className="section split">
        <div><h2 className="h3">Name changes</h2>{a.nameChanges.length === 0 ? <p className="small muted">None.</p> : <ul className="list">{a.nameChanges.map((x) => <li key={x.id} className="list-item"><span className="small">“{x.oldName}” → “{x.newName}” {relativeDate(x.createdAt)}</span><StatusBadge status={x.status} /></li>)}</ul>}</div>
        <div><h2 className="h3">Reports</h2>{a.reports.length === 0 ? <p className="small muted">None.</p> : <ul className="list">{a.reports.map((x) => <li key={x.id} className="list-item"><Link to={`/admin/reports/${x.id}`}>{x.reason.replace(/_/g, ' ').toLowerCase()}</Link><StatusBadge status={x.status} /></li>)}</ul>}</div>
      </section>
      <section className="section"><h2 className="h3">History</h2><History items={a.history} /></section>
      <ArtistForm open={editing} onClose={() => setEditing(false)} onSaved={reload} artist={a} />
      {dialog}
    </>
  );
}
