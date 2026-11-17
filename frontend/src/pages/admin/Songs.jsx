import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Link, useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { useAsync } from '../../lib/useAsync';
import { duration, relativeDate } from '../../lib/format';
import { Definition, Empty, ErrorState, Field, PageHead, Pager, StatusBadge, Tabs, useConfirm } from '../../components/ui';
import { History, SearchBox, Select, SoundProfile, blankProfile, profileFrom, profileValue, useFilters, useLoad } from './common';

const STATES = [['', 'All'], ['PUBLISHED', 'Published'], ['NEEDS_PROFILE', 'Needs sound profile'], ['HIDDEN', 'Hidden'], ['SUSPENDED', 'Suspended'],
  ['TAKEN_DOWN', 'Taken down'], ['WITHDRAWN', 'Withdrawn'], ['MERGED', 'Merged']];
const ACTION_TEXT = {
  HIDE: ['Hide', 'Hide from listeners. You can unhide it any time; use this for editorial reasons.', false],
  UNHIDE: ['Unhide', 'Publish it again (it needs a sound profile to be published).', false],
  SUSPEND: ['Suspend', 'Remove it for a safety or policy reason. It only comes back with an explicit restore and a reason.', true],
  TAKE_DOWN: ['Take down', 'Remove it for a rights reason. Playback stops and the artist is told why.', true],
  RESTORE: ['Restore', 'Bring it back after a suspension or takedown. Record why the problem is solved.', true],
};

export default function Songs({ id }) {
  if (id === 'new') return <NewSong />;
  return id ? <SongDetail id={Number(id)} /> : <SongList />;
}

function SongList() {
  const [f, set] = useFilters({ q: '', state: '', artistId: '', albumId: '', genreId: '', playable: '', sort: 'newest' });
  const refs = useAsync(() => api.admin.references(), []);
  const { data, guard } = useLoad(() => api.admin.songs({ ...f, pageSize: 25 }), [f.q, f.state, f.artistId, f.albumId, f.genreId, f.playable, f.sort, f.page]);
  return (
    <>
      <PageHead title="Songs" actions={<Link className="btn btn-primary btn-sm" to="/admin/songs/new">Add a song</Link>}>
        Every song in LOOP’s catalogue. Open a song to edit its details, sound, moods and audio, or to change whether listeners can find it.
      </PageHead>
      <Tabs label="Song state" value={f.state} onChange={(state) => set({ state })} items={STATES} />
      <div className="filters">
        <SearchBox value={f.q} onSearch={(q) => set({ q })} label="Find a song" placeholder="Title, artist, album, ISRC or ID" />
        {refs.data && <Select label="Genre" value={f.genreId} onChange={(genreId) => set({ genreId })} options={refs.data.genres.map((g) => [g.id, g.name])} />}
        <Select label="Audio" value={f.playable} onChange={(playable) => set({ playable })} options={[['yes', 'Has LOOP audio'], ['no', 'No audio']]} />
        <Select label="Order" value={f.sort} all={null} onChange={(sort) => set({ sort })} options={[['newest', 'Newest'], ['oldest', 'Oldest'], ['title', 'Title'], ['artist', 'Artist'], ['popular', 'Popular']]} />
      </div>
      {(f.artistId || f.albumId) && <p className="small">Showing songs of one {f.artistId ? 'artist' : 'album'}. <button type="button" className="btn btn-quiet btn-sm" onClick={() => set({ artistId: '', albumId: '' })}>Show all</button></p>}
      {guard || (data.songs.length === 0 ? <Empty title="No songs match" /> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>Song</th><th>Moods</th><th>Audio</th><th>State</th></tr></thead>
            <tbody>{data.songs.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/admin/songs/${s.id}`}><strong>{s.title}</strong>{s.version ? ` (${s.version})` : ''}</Link><div className="tiny muted">{s.artist.name}{s.album ? ` — ${s.album.title}` : ''} · #{s.id}</div></td>
                <td className="small">{s.moods.join(', ') || <span className="muted">none</span>}</td>
                <td className="small">{s.playback?.playable ? 'LOOP audio' : <span className="muted">none</span>}</td>
                <td><StatusBadge status={s.state} /></td>
              </tr>
            ))}</tbody>
          </table></div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} noun="songs" onPage={(page) => set({ page })} />
        </>
      ))}
    </>
  );
}

function MetadataFields({ form, setForm, refs }) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <>
      <div className="form-row">
        <Field label="Title"><input className="input" required maxLength={150} value={form.title} onChange={set('title')} /></Field>
        <Field label="Version" hint="optional"><input className="input" maxLength={40} value={form.versionLabel} onChange={set('versionLabel')} /></Field>
      </div>
      <div className="form-row">
        <Field label="Artist"><select className="select" required value={form.artistId} onChange={set('artistId')}><option value="">Choose…</option>
          {refs.artists.map((a) => <option key={a.id} value={a.id}>{a.name}{a.disambiguation ? ` (${a.disambiguation})` : ''}</option>)}</select></Field>
        <Field label="Album" hint="optional"><select className="select" value={form.albumId} onChange={set('albumId')}><option value="">No album (single)</option>
          {refs.albums.map((a) => <option key={a.id} value={a.id}>{a.title}{a.artist ? ` — ${a.artist}` : ''}</option>)}</select></Field>
        <Field label="Track number"><input className="input" inputMode="numeric" maxLength={2} value={form.trackNumber} onChange={set('trackNumber')} /></Field>
      </div>
      <div className="form-row">
        <Field label="Genre"><select className="select" required value={form.genreId} onChange={set('genreId')}><option value="">Choose…</option>{refs.genres.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
        <Field label="Language"><select className="select" value={form.languageId} onChange={set('languageId')}><option value="">Instrumental or none</option>{refs.languages.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="Duration (seconds)"><input className="input" required inputMode="numeric" value={form.durationSec} onChange={set('durationSec')} /></Field>
        <Field label="Year"><input className="input" required inputMode="numeric" value={form.releaseYear} onChange={set('releaseYear')} /></Field>
      </div>
      <div className="form-row">
        <Field label="ISRC" hint="optional, 12 characters"><input className="input" maxLength={12} value={form.isrc} onChange={(e) => setForm({ ...form, isrc: e.target.value.toUpperCase() })} /></Field>
        <Field label="Content rating"><select className="select" value={form.contentRating} onChange={set('contentRating')}><option value="ALL">Everyone</option><option value="TEEN">Teen</option><option value="MATURE">Mature</option></select></Field>
        <Field label="Popularity" hint="0–100, used before listening data exists"><input className="input" type="number" min="0" max="100" value={form.popularity} onChange={set('popularity')} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={form.explicit} onChange={set('explicit')} />Explicit</label>
      <Field label="Description" hint="optional, shown on the song page"><textarea className="textarea" maxLength={500} value={form.description} onChange={set('description')} /></Field>
    </>
  );
}

const toBody = (f) => ({
  title: f.title.trim(), versionLabel: f.versionLabel.trim(), artistId: Number(f.artistId), genreId: Number(f.genreId), durationSec: Number(f.durationSec),
  releaseYear: Number(f.releaseYear), explicit: !!f.explicit, contentRating: f.contentRating, popularity: Number(f.popularity),
  ...(f.albumId ? { albumId: Number(f.albumId) } : {}), ...(f.trackNumber ? { trackNumber: Number(f.trackNumber) } : {}),
  ...(f.languageId ? { languageId: Number(f.languageId) } : {}), ...(f.isrc ? { isrc: f.isrc } : {}), description: f.description || '',
});

function NewSong() {
  const toast = useToast();
  const { navigate } = useRouter();
  const refs = useAsync(() => api.admin.references(), []);
  const [form, setForm] = useState({ title: '', versionLabel: '', artistId: '', albumId: '', trackNumber: '', genreId: '', languageId: '', durationSec: '',
    releaseYear: String(new Date().getFullYear()), isrc: '', contentRating: 'ALL', popularity: '50', explicit: false, description: '' });
  const [profile, setProfile] = useState(blankProfile());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const s = await api.admin.createSong({ ...toBody(form), features: profileValue(profile) });
      toast(`“${s.title}” added and tagged with moods`);
      navigate(`/admin/songs/${s.id}`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHead title="Add a song" back={['/admin/songs', 'Songs']}>Adds the song to the catalogue. Give it LOOP audio afterwards on the song page, or upload a recording in Uploads & audio.</PageHead>
      {refs.data ? (
        <form className="form" onSubmit={submit} style={{ maxWidth: 820 }}>
          <MetadataFields form={form} setForm={setForm} refs={refs.data} />
          <SoundProfile value={profile} onChange={setProfile} />
          <ErrorState error={error} />
          <div><button className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add song'}</button></div>
        </form>
      ) : <ErrorState error={refs.error} />}
    </>
  );
}

function SongDetail({ id }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const [confirm, dialog] = useConfirm();
  const refs = useAsync(() => api.admin.references(), []);
  const { data: s, guard, reload, setData } = useLoad(() => api.admin.song(id), [id]);
  const [form, setForm] = useState(null);
  const [profile, setProfile] = useState(null);
  const [tab, setTab] = useState('details');
  useEffect(() => {
    if (!s) return;
    setForm({ title: s.title, versionLabel: s.version || '', artistId: String(s.artist.id), albumId: s.albumId ? String(s.albumId) : '', trackNumber: s.trackNumber ? String(s.trackNumber) : '',
      genreId: s.genreId ? String(s.genreId) : '', languageId: s.languageId ? String(s.languageId) : '', durationSec: String(s.durationSec), releaseYear: String(s.releaseYear),
      isrc: s.isrc || '', contentRating: s.contentRating, popularity: String(s.popularity), explicit: s.explicit, description: s.description || '' });
    setProfile(profileFrom(s.features));
  }, [s]);
  if (guard) return <><PageHead title="Song" back={['/admin/songs', 'Songs']} />{guard}</>;

  async function save(e) {
    e.preventDefault();
    try { setData(await api.admin.updateSong(id, toBody(form))); toast('Song saved'); } catch (err) { toast(err.message, 'error'); }
  }
  async function saveProfile(e) {
    e.preventDefault();
    try { setData(await api.admin.updateSong(id, { features: profileValue(profile) })); toast('Sound profile saved; moods recalculated'); } catch (err) { toast(err.message, 'error'); }
  }
  const act = (action) => {
    const [label, text, needsReason] = ACTION_TEXT[action];
    confirm({ title: `${label} “${s.title}”?`, confirmLabel: label, danger: ['SUSPEND', 'TAKE_DOWN'].includes(action), reason: needsReason, reasonRequired: needsReason,
      children: <p>{text}</p>, onConfirm: async (reason) => { setData(await api.admin.songState(id, action, reason)); toast(`${label}: done`); } });
  };
  const remove = () => confirm({ title: `Delete “${s.title}” permanently?`, danger: true, confirmLabel: 'Delete permanently', typeToConfirm: 'DELETE',
    children: <p>Only songs nobody has played can be deleted. Otherwise hide or take it down; that keeps listeners’ history intact.</p>,
    onConfirm: async () => { await api.admin.deleteSong(id); toast('Song deleted'); navigate('/admin/songs'); } });
  const merge = () => confirm({ title: `Merge “${s.title}” into another song`, danger: true, confirmLabel: 'Merge', reason: true, reasonRequired: true, reasonLabel: 'ID of the song to keep',
    children: <p>Likes, ratings and playlist entries move to the song you keep; this one is retired. Use it for duplicates.</p>,
    onConfirm: async (keep) => { const n = Number(keep.replace(/\D/g, '')); if (!n) throw new Error('Enter the number of the song to keep.'); await api.admin.mergeSong(id, n); toast('Merged'); navigate(`/admin/songs/${n}`); } });
  async function artwork(file) {
    if (!file) return;
    try { await api.admin.songArtwork(id, file); toast('Artwork saved'); reload(); } catch (err) { toast(err.message, 'error'); }
  }

  return (
    <>
      <PageHead title={`${s.title}${s.version ? ` (${s.version})` : ''}`} back={['/admin/songs', 'Songs']}
        actions={<>{s.state === 'PUBLISHED' && <Link className="btn btn-sm" to={`/song/${s.id}`}>Public page</Link>}
          {s.allowedActions.map((a) => <button key={a} type="button" className={`btn btn-sm ${['SUSPEND', 'TAKE_DOWN'].includes(a) ? 'btn-danger' : ''}`} onClick={() => act(a)}>{ACTION_TEXT[a][0]}…</button>)}</>}>
        <Link to={`/admin/artists/${s.artist.id}`}>{s.artist.name}</Link>{s.album ? <> — <Link to={`/admin/albums/${s.album.id}`}>{s.album.title}</Link></> : ''} · #{s.id}
      </PageHead>
      <div className="row-actions"><StatusBadge status={s.state} />{s.playback?.playable ? <span className="badge badge-ok">LOOP audio</span> : <span className="badge">no audio</span>}</div>
      {s.moderationReason && <p className="notice notice-warn">{s.state.replace('_', ' ').toLowerCase()}: {s.moderationReason}</p>}
      {s.state === 'NEEDS_PROFILE' && <p className="notice notice-warn">This song is not public until it has a sound profile. Add one in “Sound and moods”.</p>}
      {s.state === 'WITHDRAWN' && <p className="notice">The artist withdrew this recording. Only a new upload from them can bring it back.</p>}
      <Tabs label="Song sections" value={tab} onChange={setTab} items={[['details', 'Details'], ['sound', 'Sound and moods'], ['audio', 'Audio and artwork'], ['history', 'History and reports']]} />

      {tab === 'details' && form && refs.data && (
        <form className="form section" onSubmit={save} style={{ maxWidth: 820 }}>
          <MetadataFields form={form} setForm={setForm} refs={refs.data} />
          <div className="composer-actions"><button className="btn btn-primary">Save details</button></div>
          <div className="composer-actions"><button type="button" className="btn btn-sm" onClick={merge}>Merge into another song…</button><button type="button" className="btn btn-sm btn-danger" onClick={remove}>Delete permanently…</button></div>
        </form>
      )}
      {tab === 'sound' && profile && <SoundTab s={s} profile={profile} setProfile={setProfile} saveProfile={saveProfile} setData={setData} />}
      {tab === 'audio' && <AudioTab s={s} reload={reload} setData={setData} artwork={artwork} />}
      {tab === 'history' && (
        <section className="section split">
          <div><h2 className="h3">History</h2><History items={s.history} /></div>
          <div>
            <h2 className="h3">Reports</h2>
            {s.reports.length === 0 ? <p className="small muted">None.</p> : <ul className="list">{s.reports.map((r) => <li key={r.id} className="list-item"><Link to={`/admin/reports/${r.id}`}>{r.reason.replace(/_/g, ' ').toLowerCase()} — {relativeDate(r.createdAt)}</Link><StatusBadge status={r.status} /></li>)}</ul>}
            <h2 className="h3" style={{ marginTop: 16 }}>Uploads</h2>
            {s.uploads.length === 0 ? <p className="small muted">Not from an upload.</p> : <ul className="list">{s.uploads.map((u) => <li key={u.id} className="list-item"><Link to={`/admin/uploads/${u.id}`}>{u.source === 'ADMIN' ? 'LOOP upload' : 'Artist upload'} — {relativeDate(u.createdAt)}</Link><StatusBadge status={u.status} /></li>)}</ul>}
            {s.stats && <Definition items={[['Plays', s.stats.plays], ['Listeners', s.stats.listeners], ['Likes', s.stats.likes], ['Average rating', s.stats.avgRating]]} />}
          </div>
        </section>
      )}
      {dialog}
    </>
  );
}

function SoundTab({ s, profile, setProfile, saveProfile, setData }) {
  const toast = useToast();
  const moods = useAsync(() => api.moods(), []);
  const [add, setAdd] = useState({ moodId: '', confidence: '0.8' });
  async function curate(moodId, action, confidence) {
    try { setData(await api.admin.curateMood(s.id, moodId, { action, ...(action === 'ADD' ? { confidence: Number(confidence) } : {}) })); toast(action === 'ADD' ? 'Mood added' : 'Mood removed'); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function clear(moodId) {
    try { setData(await api.admin.clearCuration(s.id, moodId)); toast('Back to the automatic decision'); } catch (err) { toast(err.message, 'error'); }
  }
  return (
    <div className="section split">
      <form className="form" onSubmit={saveProfile}>
        <SoundProfile value={profile} onChange={setProfile} />
        <p className="small muted">Saving recalculates the song’s moods{s.state === 'NEEDS_PROFILE' ? '. Then unhide it to publish' : ''}.</p>
        <div><button className="btn btn-primary">Save sound profile</button></div>
      </form>
      <div>
        <h2 className="h3">Moods</h2>
        {s.moodsDetailed.length === 0 ? <p className="small muted">No moods yet.</p> : (
          <ul className="list">{s.moodsDetailed.map((m) => (
            <li key={m.id} className="list-item"><span>{m.emoji} {m.name} <span className="tiny muted">{Math.round(m.confidence * 100)}%</span></span>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => curate(m.id, 'REMOVE')}>Remove</button></li>
          ))}</ul>
        )}
        {s.curations.length > 0 && (
          <>
            <h3 className="h3" style={{ marginTop: 12 }}>Your decisions</h3>
            <ul className="list">{s.curations.map((c) => <li key={c.id} className="list-item"><span className="small">{c.action === 'ADD' ? 'Always' : 'Never'} {c.name}{c.confidence ? ` (${Math.round(c.confidence * 100)}%)` : ''} — {c.curatedBy || 'Admin'}</span>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => clear(c.id)}>Undo</button></li>)}</ul>
          </>
        )}
        <div className="search-row" style={{ marginTop: 12 }}>
          <select className="select" aria-label="Mood to add" value={add.moodId} onChange={(e) => setAdd({ ...add, moodId: e.target.value })}><option value="">Add a mood…</option>{(moods.data || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          <input className="input" type="number" min="0.05" max="1" step="0.05" aria-label="How strongly" value={add.confidence} onChange={(e) => setAdd({ ...add, confidence: e.target.value })} style={{ width: 90 }} />
          <button type="button" className="btn btn-sm" disabled={!add.moodId} onClick={() => curate(Number(add.moodId), 'ADD', add.confidence)}>Add</button>
        </div>
      </div>
    </div>
  );
}

function AudioTab({ s, reload, setData, artwork }) {
  const toast = useToast();
  const [confirm, dialog] = useConfirm();
  const lib = useAsync(() => api.admin.media(), []);
  const [form, setForm] = useState({ fileName: '', rights: 'PERMITTED', attribution: '' });
  async function register(e) {
    e.preventDefault();
    try { await api.admin.registerMedia(s.id, { fileName: form.fileName, rights: form.rights, ...(form.attribution ? { attribution: form.attribution } : {}) }); toast('Recording attached'); reload(); }
    catch (err) { toast(err.message, 'error'); }
  }
  const remove = (m) => confirm({ title: 'Remove this recording from the song?', danger: true, confirmLabel: 'Remove audio',
    children: <p>The song stays in the catalogue but can’t be played. The file is kept privately, not deleted.</p>,
    onConfirm: async () => { setData(await api.admin.removeMedia(s.id, m.id)); toast('Audio removed'); } });
  return (
    <div className="section split">
      <div>
        <h2 className="h3">Recordings</h2>
        {s.media.length === 0 ? <p className="small muted">No LOOP audio. Upload one in <Link to={`/admin/uploads/new?song=${s.id}&artist=${s.artist.id}`}>Uploads & audio</Link>.</p> : (
          <ul className="list">{s.media.map((m) => (
            <li key={m.id} className="list-item" style={{ flexWrap: 'wrap' }}>
              <div className="list-item-main"><span className="small">{m.source === 'ARTIST_UPLOAD' ? 'Artist upload' : 'LOOP library'} — {m.rights.toLowerCase()} — {m.availability.toLowerCase()}</span>
                {m.availability === 'AVAILABLE' && <audio controls preload="none" src={api.admin.mediaAudioUrl(m.id)} style={{ width: '100%' }} aria-label={`Preview ${s.title}`} />}</div>
              {m.rights !== 'RESTRICTED' && <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(m)}>Remove…</button>}
            </li>
          ))}</ul>
        )}
        <p className="small"><Link to={`/admin/uploads/new?song=${s.id}&artist=${s.artist.id}`}>Upload a new recording for this song</Link> — replaces the current LOOP audio after review.</p>
        {lib.data && lib.data.storage.writable && lib.data.localFiles.length > 0 && (
          <form className="form panel" onSubmit={register}>
            <h3 className="h3">Attach a file from the media library</h3>
            <div className="form-row">
              <Field label="File"><select className="select" required value={form.fileName} onChange={(e) => setForm({ ...form, fileName: e.target.value })}><option value="">Choose…</option>{lib.data.localFiles.map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
              <Field label="Rights"><select className="select" value={form.rights} onChange={(e) => setForm({ ...form, rights: e.target.value })}><option value="PERMITTED">Owned or licensed</option><option value="ATTRIBUTION_REQUIRED">Licensed with attribution</option></select></Field>
            </div>
            {form.rights === 'ATTRIBUTION_REQUIRED' && <Field label="Attribution"><input className="input" maxLength={200} value={form.attribution} onChange={(e) => setForm({ ...form, attribution: e.target.value })} /></Field>}
            <div><button className="btn btn-sm btn-primary">Attach</button></div>
          </form>
        )}
      </div>
      <div>
        <h2 className="h3">Artwork</h2>
        {s.artworkUrl ? <img src={s.artworkUrl} alt={`Artwork of ${s.title}`} width="180" height="180" style={{ borderRadius: 12, objectFit: 'cover' }} /> : <p className="small muted">Uses the album’s artwork or colours.</p>}
        <Field label="Upload artwork" hint="JPEG, PNG or WebP, up to 2 MB"><input className="input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => artwork(e.target.files?.[0])} /></Field>
        <p className="small muted">{duration(s.durationSec)} · {s.releaseYear}</p>
      </div>
      {dialog}
    </div>
  );
}
