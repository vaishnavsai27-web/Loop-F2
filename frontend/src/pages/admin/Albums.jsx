import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Link, useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { useAsync } from '../../lib/useAsync';
import { duration } from '../../lib/format';
import { Empty, ErrorState, Field, PageHead, Pager, StatusBadge, Tabs, useConfirm } from '../../components/ui';
import { History, SearchBox, useFilters, useLoad } from './common';
import Icon from '../../components/Icon';

const TYPES = [['ALBUM', 'Album'], ['EP', 'EP'], ['SINGLE', 'Single'], ['SOUNDTRACK', 'Soundtrack'], ['COMPILATION', 'Compilation']];

export default function Albums({ id }) {
  if (id === 'new') return <AlbumEditor />;
  return id ? <AlbumEditor id={Number(id)} /> : <AlbumList />;
}

function AlbumList() {
  const [f, set] = useFilters({ q: '', status: '' });
  const { data, guard } = useLoad(() => api.admin.albums({ q: f.q, status: f.status, page: f.page }), [f.q, f.status, f.page]);
  return (
    <>
      <PageHead title="Albums" actions={<Link className="btn btn-primary btn-sm" to="/admin/albums/new">Create an album</Link>}>Albums group songs in order. Unpublished albums are hidden from listeners; their songs stay available.</PageHead>
      <div className="filters">
        <Tabs label="Album status" value={f.status} onChange={(status) => set({ status })} items={[['', 'All'], ['PUBLISHED', 'Published'], ['UNPUBLISHED', 'Unpublished']]} />
        <SearchBox value={f.q} onSearch={(q) => set({ q })} label="Find an album" placeholder="Title or ID" />
      </div>
      {guard || (data.albums.length === 0 ? <Empty title="No albums match" /> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>Album</th><th>Artists</th><th>Type</th><th className="num">Tracks</th><th>Status</th></tr></thead>
            <tbody>{data.albums.map((a) => (
              <tr key={a.id}><td><Link to={`/admin/albums/${a.id}`}><strong>{a.title}</strong></Link><div className="tiny muted">{a.releaseYear} · #{a.id}</div></td>
                <td className="small">{a.artists}</td><td className="small">{(TYPES.find(([v]) => v === a.type) || [])[1]}</td><td className="num">{a.tracks}</td><td><StatusBadge status={a.status} /></td></tr>
            ))}</tbody>
          </table></div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} noun="albums" onPage={(page) => set({ page })} />
        </>
      ))}
    </>
  );
}

function AlbumEditor({ id = null }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const [confirm, dialog] = useConfirm();
  const refs = useAsync(() => api.admin.references(), []);
  const album = useLoad(() => (id ? api.admin.album(id) : Promise.resolve(null)), [id]);
  const a = album.data;
  const [form, setForm] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [add, setAdd] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => {
    if (id && !a) return;
    setForm(a ? { title: a.title, albumType: a.type, releaseYear: String(a.releaseYear), languageId: a.languageId ? String(a.languageId) : '', status: a.status,
      description: a.description || '', coverColor1: a.coverColor1, coverColor2: a.coverColor2, artistIds: a.artists.map((x) => String(x.id)) }
      : { title: '', albumType: 'ALBUM', releaseYear: String(new Date().getFullYear()), languageId: '', status: 'PUBLISHED', description: '', coverColor1: '#3B47D6', coverColor2: '#191B2B', artistIds: [''] });
    setTracks(a ? a.tracks : []);
  }, [a, id]);
  const songsOfArtist = useAsync(() => (form?.artistIds?.[0] ? api.admin.songs({ artistId: form.artistIds[0], pageSize: 100 }) : Promise.resolve(null)), [form?.artistIds?.[0]]);
  if (id && album.guard) return <><PageHead title="Album" back={['/admin/albums', 'Albums']} />{album.guard}</>;
  if (!form || !refs.data) return <ErrorState error={refs.error} />;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    setError(null);
    const body = { title: form.title.trim(), albumType: form.albumType, releaseYear: Number(form.releaseYear), coverColor1: form.coverColor1.toUpperCase(), coverColor2: form.coverColor2.toUpperCase(),
      artistIds: form.artistIds.filter(Boolean).map(Number), description: form.description, status: form.status, ...(form.languageId ? { languageId: Number(form.languageId) } : {}) };
    try {
      if (id) { album.setData(await api.admin.updateAlbum(id, body)); toast('Album saved'); }
      else { const r = await api.admin.createAlbum(body); toast('Album created'); navigate(`/admin/albums/${r.id}`); }
    } catch (err) { setError(err); }
  }
  async function saveTracks(list) {
    try { album.setData(await api.admin.setTracks(id, list.map((t) => t.id))); toast('Track list saved'); } catch (err) { toast(err.message, 'error'); }
  }
  const move = (i, d) => { const l = tracks.slice(); const j = i + d; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; setTracks(l); saveTracks(l); };
  const drop = (i) => { const l = tracks.filter((_, k) => k !== i); setTracks(l); saveTracks(l); };
  const addTrack = () => { const s = songsOfArtist.data?.songs.find((x) => x.id === Number(add)); if (!s) return; const l = [...tracks, { id: s.id, title: s.title, durationSec: s.durationSec, status: s.status }]; setTracks(l); setAdd(''); saveTracks(l); };
  const remove = () => confirm({ title: `Delete “${a.title}”?`, danger: true, confirmLabel: 'Delete album', children: <p>Only an empty album can be deleted. To hide an album with songs, unpublish it.</p>,
    onConfirm: async () => { await api.admin.deleteAlbum(id); toast('Album deleted'); navigate('/admin/albums'); } });
  async function artwork(file) {
    if (!file) return;
    try { await api.admin.albumArtwork(id, file); toast('Artwork saved'); album.reload(); } catch (err) { toast(err.message, 'error'); }
  }

  return (
    <>
      <PageHead title={a ? a.title : 'Create an album'} back={['/admin/albums', 'Albums']} actions={a && <><Link className="btn btn-sm" to={`/album/${a.id}`}>Public page</Link><button type="button" className="btn btn-sm btn-danger" onClick={remove}>Delete…</button></>} />
      <div className="section split">
        <form className="form" onSubmit={save}>
          <Field label="Title"><input className="input" required maxLength={150} value={form.title} onChange={set('title')} /></Field>
          <div className="form-row">
            <Field label="Type"><select className="select" value={form.albumType} onChange={set('albumType')}>{TYPES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>
            <Field label="Year"><input className="input" required inputMode="numeric" value={form.releaseYear} onChange={set('releaseYear')} /></Field>
            <Field label="Language"><select className="select" value={form.languageId} onChange={set('languageId')}><option value="">Mixed or none</option>{refs.data.languages.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
          </div>
          <fieldset className="profile-fields"><legend>Artists <span className="small muted">— in credit order</span></legend>
            {form.artistIds.map((v, i) => (
              <div key={i} className="search-row">
                <select className="select" aria-label={`Artist ${i + 1}`} required={i === 0} value={v} onChange={(e) => setForm({ ...form, artistIds: form.artistIds.map((x, j) => (j === i ? e.target.value : x)) })}>
                  <option value="">Choose…</option>{refs.data.artists.map((x) => <option key={x.id} value={x.id}>{x.name}{x.disambiguation ? ` (${x.disambiguation})` : ''}</option>)}</select>
                {i > 0 && <button type="button" className="icon-btn" aria-label={`Remove artist ${i + 1}`} onClick={() => setForm({ ...form, artistIds: form.artistIds.filter((_, j) => j !== i) })}><Icon name="x" size={16} /></button>}
              </div>
            ))}
            {form.artistIds.length < 6 && <button type="button" className="btn btn-quiet btn-sm" onClick={() => setForm({ ...form, artistIds: [...form.artistIds, ''] })}>Add another artist</button>}
          </fieldset>
          <div className="form-row">
            <Field label="Cover colour 1"><input className="input" type="color" value={form.coverColor1} onChange={set('coverColor1')} /></Field>
            <Field label="Cover colour 2"><input className="input" type="color" value={form.coverColor2} onChange={set('coverColor2')} /></Field>
            <Field label="Visible to listeners"><select className="select" value={form.status} onChange={set('status')}><option value="PUBLISHED">Published</option><option value="UNPUBLISHED">Unpublished</option></select></Field>
          </div>
          <Field label="Description" hint="optional"><textarea className="textarea" maxLength={500} value={form.description} onChange={set('description')} /></Field>
          <ErrorState error={error} />
          <div><button className="btn btn-primary">{a ? 'Save album' : 'Create album'}</button></div>
        </form>
        {a && (
          <div>
            <h2 className="h3">Artwork</h2>
            {a.artworkUrl ? <img src={a.artworkUrl} alt={`Cover of ${a.title}`} width="180" height="180" style={{ borderRadius: 12, objectFit: 'cover' }} /> : <div className="cover" style={{ width: 120, height: 120, background: `linear-gradient(135deg, ${a.coverColor1}, ${a.coverColor2})` }} />}
            <Field label="Upload artwork" hint="JPEG, PNG or WebP, up to 2 MB"><input className="input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => artwork(e.target.files?.[0])} /></Field>
            <h2 className="h3" style={{ marginTop: 16 }}>Tracks</h2>
            {tracks.length === 0 ? <p className="small muted">No tracks yet.</p> : (
              <ol className="list">{tracks.map((t, i) => (
                <li key={t.id} className="list-item"><span className="small">{i + 1}. <Link to={`/admin/songs/${t.id}`}>{t.title}</Link> <span className="muted">{duration(t.durationSec)}</span></span>
                  <span className="row-actions">
                    <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${t.title} up`}><Icon name="up" size={16} /></button>
                    <button type="button" className="icon-btn" disabled={i === tracks.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${t.title} down`}><Icon name="down" size={16} /></button>
                    <button type="button" className="icon-btn" onClick={() => drop(i)} aria-label={`Remove ${t.title} from the album`}><Icon name="x" size={16} /></button>
                  </span></li>
              ))}</ol>
            )}
            <div className="search-row">
              <select className="select" aria-label="Song to add" value={add} onChange={(e) => setAdd(e.target.value)}><option value="">Add a song by the first artist…</option>
                {(songsOfArtist.data?.songs || []).filter((s) => !tracks.some((t) => t.id === s.id)).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
              <button type="button" className="btn btn-sm" disabled={!add} onClick={addTrack}>Add</button>
            </div>
            <h2 className="h3" style={{ marginTop: 16 }}>History</h2><History items={a.history} />
          </div>
        )}
      </div>
      {dialog}
    </>
  );
}
