import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Link, useQuery, useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { useAsync } from '../../lib/useAsync';
import { bytes, duration, relativeDate } from '../../lib/format';
import { Definition, Dialog, Empty, ErrorState, Field, PageHead, Pager, StatusBadge, Tabs, useConfirm } from '../../components/ui';
import { UploadForm } from '../artist/Studio';
import { SearchBox, Select, SoundProfile, blankProfile, profileFrom, profileValue, useFilters, useLoad } from './common';

const STATUSES = [['PENDING_REVIEW', 'To review'], ['APPROVED', 'To publish'], ['QUARANTINED', 'Waiting for scan'], ['PROCESSING_FAILED', 'Failed'],
  ['PUBLISHED', 'Published'], ['REJECTED', 'Rejected'], ['TAKEN_DOWN', 'Withdrawn or taken down'], ['UPLOADING', 'Not received'], ['ALL', 'All']];

export default function Uploads({ id }) {
  if (id === 'new') return <NewUpload />;
  return id ? <UploadDetail id={id} /> : <UploadList />;
}

function UploadList() {
  const [f, set] = useFilters({ status: 'PENDING_REVIEW', source: '', q: '', tab: 'uploads' });
  const { data, guard } = useLoad(() => (f.tab === 'library' ? Promise.resolve(null) : api.admin.uploads({ status: f.status, source: f.source, q: f.q, page: f.page })), [f.status, f.source, f.q, f.page, f.tab]);
  return (
    <>
      <PageHead title="Uploads & audio" actions={<Link className="btn btn-primary btn-sm" to="/admin/uploads/new">Upload a recording</Link>}>
        Recordings move from scan to review to publication. Nothing is playable before it is published.
      </PageHead>
      <Tabs label="View" value={f.tab} onChange={(tab) => set({ tab })} items={[['uploads', 'Uploads'], ['library', 'Media library']]} />
      {f.tab === 'library' ? <Library /> : (
        <>
          <Tabs label="Upload status" value={f.status} onChange={(status) => set({ status })} items={STATUSES} />
          <div className="filters">
            <SearchBox value={f.q} onSearch={(q) => set({ q })} label="Find an upload" placeholder="Title, artist or uploader" />
            <Select label="From" value={f.source} onChange={(source) => set({ source })} options={[['ARTIST', 'Artists'], ['ADMIN', 'LOOP (Admins)']]} />
          </div>
          {guard || (data.uploads.length === 0 ? <Empty title="No uploads here" /> : (
            <>
              <ul className="list">
                {data.uploads.map((u) => (
                  <li key={u.id} className="list-item">
                    <div className="list-item-main">
                      <Link className="title" to={`/admin/uploads/${u.id}`}>{u.title}{u.versionLabel ? ` (${u.versionLabel})` : ''}</Link>
                      <span className="small muted">{u.artistName} — {u.source === 'ADMIN' ? 'LOOP upload' : `@${u.username}`} — {u.fileSize ? bytes(u.fileSize) : 'no file yet'}{u.durationSec ? `, ${duration(u.durationSec)}` : ''} — {relativeDate(u.createdAt)}</span>
                      {u.failureReason && <span className="small">{u.failureReason}</span>}
                      {!u.uploaderActive && <span className="small" style={{ color: 'var(--danger)' }}>Uploader’s account is deactivated</span>}
                    </div>
                    <StatusBadge status={u.status} />
                  </li>
                ))}
              </ul>
              <Pager page={data.page} pageSize={data.pageSize} total={data.total} noun="uploads" onPage={(page) => set({ page })} />
            </>
          ))}
        </>
      )}
    </>
  );
}

function Library() {
  const toast = useToast();
  const { data, guard, reload } = useLoad(() => api.admin.media(), []);
  if (guard) return guard;
  async function check() {
    try { const r = await api.admin.checkMedia(); toast(`${r.available} available, ${r.unavailable} missing`); reload(); } catch (err) { toast(err.message, 'error'); }
  }
  return (
    <section className="section">
      {data.storage.state !== 'ready' ? (
        <div className="notice notice-warn"><strong>Audio storage is {data.storage.state}.</strong><span>{data.storage.detail || 'This server has no persistent media folder.'}</span></div>
      ) : <p className="notice">{data.storage.detail}</p>}
      {data.summary.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Source</th><th>Availability</th><th className="num">Recordings</th></tr></thead>
          <tbody>{data.summary.map((r) => <tr key={`${r.source}-${r.availability}`}><td>{r.source === 'ARTIST_UPLOAD' ? 'Artist uploads' : 'LOOP library'}</td><td>{r.availability.toLowerCase()}</td><td className="num">{r.n}</td></tr>)}</tbody>
        </table></div>
      )}
      {data.missing.length > 0 && (
        <>
          <h2 className="h3">Missing from storage</h2>
          <ul className="list">{data.missing.map((m) => <li key={m.id} className="list-item"><Link to={`/admin/songs/${m.songId}`}>{m.title}</Link><span className="tiny muted">{m.file}</span></li>)}</ul>
        </>
      )}
      {data.storage.state === 'ready' && <div className="composer-actions"><button type="button" className="btn btn-sm" onClick={check}>Check every recording now</button></div>}
      <p className="small muted">{data.localFiles.length} unattached library file(s). Attach one from a song’s “Audio and artwork” tab, or upload new recordings here.</p>
    </section>
  );
}

function NewUpload() {
  const query = useQuery();
  const { navigate } = useRouter();
  const refs = useAsync(() => api.admin.references(), []);
  const [targetSong, setTargetSong] = useState(query.get('song') || '');
  const artistFromQuery = query.get('artist');
  if (!refs.data) return <><PageHead title="Upload a recording" back={['/admin/uploads', 'Uploads & audio']} /><ErrorState error={refs.error} /></>;
  const artists = artistFromQuery ? [...refs.data.artists.filter((a) => String(a.id) === artistFromQuery), ...refs.data.artists.filter((a) => String(a.id) !== artistFromQuery)] : refs.data.artists;
  return (
    <>
      <PageHead title="Upload a LOOP recording" back={['/admin/uploads', 'Uploads & audio']}>For recordings LOOP owns or is licensed to stream. The file is scanned like every upload; then you add its sound profile and publish it.</PageHead>
      <UploadForm artists={artists} maxBytes={50 * 1024 * 1024} termsVersion="LOOP-ARTIST-RIGHTS-1.0" create={(body) => api.admin.createUpload({ ...body, ...(targetSong ? { targetSongId: Number(targetSong) } : {}) })}
        initial={artistFromQuery ? { artistId: artistFromQuery } : null} onDone={(intent) => navigate(`/admin/uploads/${intent.id}`)}
        adminExtras={<Field label="Replace the audio of song #" hint="optional — leave empty for a new song"><input className="input" inputMode="numeric" value={targetSong} onChange={(e) => setTargetSong(e.target.value.replace(/\D/g, ''))} /></Field>} />
    </>
  );
}

function UploadDetail({ id }) {
  const toast = useToast();
  const [confirm, dialog] = useConfirm();
  const refs = useAsync(() => api.admin.references(), []);
  const { data: u, guard, reload } = useLoad(() => api.admin.upload(id), [id]);
  const [meta, setMeta] = useState(null);
  const [profile, setProfile] = useState(blankProfile());
  const [rejecting, setRejecting] = useState(false);
  useEffect(() => {
    if (!u) return;
    setMeta({ title: u.title, versionLabel: u.versionLabel || '', genreId: String(u.genreId), languageId: u.languageId ? String(u.languageId) : '', releaseYear: String(u.releaseYear), explicit: u.explicit, description: u.description || '' });
    if (u.soundProfile) setProfile(profileFrom(u.soundProfile));
  }, [u]);
  if (guard) return <><PageHead title="Upload" back={['/admin/uploads', 'Uploads & audio']} />{guard}</>;

  const changed = meta ? Object.fromEntries(Object.entries({ title: meta.title.trim(), versionLabel: meta.versionLabel.trim(), genreId: Number(meta.genreId), languageId: meta.languageId ? Number(meta.languageId) : undefined,
    releaseYear: Number(meta.releaseYear), explicit: meta.explicit, description: meta.description }).filter(([k, v]) => v !== undefined && v !== ({ title: u.title, versionLabel: u.versionLabel || '', genreId: u.genreId, languageId: u.languageId || undefined, releaseYear: u.releaseYear, explicit: u.explicit, description: u.description || '' })[k])) : {};
  const needsProfile = !u.soundProfile;
  const approve = (publish) => confirm({
    title: publish ? `Approve and publish “${meta.title}”?` : `Approve “${meta.title}”?`, confirmLabel: publish ? 'Approve and publish' : 'Approve',
    children: <><p>{publish ? 'It goes live at once: listeners can find it in search and in mood mixes that fit its sound profile.' : 'It stays private until you publish it.'}</p>
      {Object.keys(changed).length > 0 && <p>Your corrections ({Object.keys(changed).join(', ')}) are saved with the approval.</p>}
      {u.source === 'ARTIST' && <p>The artist gets a notification.</p>}</>,
    onConfirm: async () => { await api.admin.decideUpload(id, { action: 'APPROVE', publish, metadata: changed, ...(needsProfile || u.soundProfile ? { features: profileValue(profile) } : {}) }); toast(publish ? 'Published on LOOP' : 'Approved'); reload(); },
  });
  const publish = () => confirm({ title: `Publish “${u.title}”?`, confirmLabel: 'Publish', children: <p>Listeners can find and play it immediately.</p>,
    onConfirm: async () => { await api.admin.publishUpload(id); toast('Published on LOOP'); reload(); } });
  async function scan() {
    try { const r = await api.admin.scanUpload(id); toast(r.status === 'PENDING_REVIEW' ? 'Scan passed; ready to review' : `Scan result: ${r.status.toLowerCase().replace('_', ' ')}`); } catch (err) { toast(err.message, 'error'); }
    reload();
  }
  const canDecide = u.status === 'PENDING_REVIEW' && u.scanStatus === 'CLEAN';

  return (
    <>
      <PageHead title={`${u.title}${u.versionLabel ? ` (${u.versionLabel})` : ''}`} back={['/admin/uploads', 'Uploads & audio']}>
        <Link to={`/admin/artists/${u.artistId}`}>{u.artistName}</Link> — {u.source === 'ADMIN' ? 'LOOP upload' : <>by <Link to={`/admin/users/${u.userId}`}>@{u.username}</Link></>} — {relativeDate(u.createdAt)}
      </PageHead>
      <div className="row-actions"><StatusBadge status={u.status} />{u.scanStatus !== 'NOT_SCANNED' && <StatusBadge status={u.scanStatus} />}{u.song && <Link className="small" to={`/admin/songs/${u.song.song_id}`}>Song #{u.song.song_id}</Link>}</div>
      {u.failureReason && <p className="notice notice-warn">{u.failureReason}</p>}
      {u.source === 'ARTIST' && (!u.uploaderActive || u.accountStatus !== 'ACTIVE') && <p className="notice notice-error">The uploader’s account or artist profile is not active, so this recording cannot be approved or published.</p>}
      {u.targetSongId && <p className="notice">This recording will replace the audio of song #{u.targetSongId}.</p>}

      <section className="section">
        <h2 className="h3">Listen</h2>
        {u.canPreview ? <audio controls preload="none" src={api.admin.uploadAudioUrl(u.id)} style={{ width: '100%', maxWidth: 640 }} aria-label={`Preview ${u.title}`} />
          : <p className="small muted">{u.status === 'QUARANTINED' ? 'Available after the malware scan passes.' : 'No file to play.'}</p>}
        <Definition items={[['Length', u.durationSec ? `${duration(u.durationSec)}${Math.abs(u.durationSec - u.durationClaimSec) > 10 ? ` (artist said ${duration(u.durationClaimSec)})` : ''}` : null],
          ['File', u.fileSize ? `${bytes(u.fileSize)}, ${u.mimeType}` : null], ['Scan', u.scanDetail]]} />
        {['QUARANTINED'].includes(u.status) && <div className="composer-actions"><button type="button" className="btn btn-sm" onClick={scan}>Scan now</button></div>}
      </section>

      <section className="section split">
        <div>
          <h2 className="h3">Rights</h2>
          <Definition items={[['Composition', u.compositionRights.toLowerCase()], ['Recording', u.recordingRights.toLowerCase()],
            ['Evidence', u.evidenceRef ? <a href={u.evidenceRef} target="_blank" rel="noreferrer noopener">Open licence link</a> : 'none given'],
            ['Territories', (u.territories || []).join(', ')], ['Licence', u.licenceStart || u.licenceEnd ? `${u.licenceStart || '…'} to ${u.licenceEnd || '…'}` : null],
            ['Royalty share', u.royaltySharePct ? `${u.royaltySharePct}% (${u.royaltyCurrency})` : null], ['Declaration', u.termsVersion]]} />
          {u.artworkUrl && <><h2 className="h3" style={{ marginTop: 16 }}>Cover</h2><img src={u.artworkUrl} alt="" width="140" height="140" style={{ borderRadius: 12, objectFit: 'cover' }} /></>}
        </div>
        <div>
          <h2 className="h3">History</h2>
          <ol className="timeline">{u.events.map((e, i) => <li key={i}><span className="small"><strong>{e.code.replace(/_/g, ' ').toLowerCase()}</strong>{e.note ? ` — ${e.note}` : ''}</span><span className="tiny muted">{e.actor} · {new Date(e.createdAt).toLocaleString()}</span></li>)}</ol>
        </div>
      </section>

      {canDecide && meta && refs.data && (
        <section className="section panel">
          <h2 className="h3">Review</h2>
          <p className="small muted">Correct anything wrong before approving. The sound profile decides which moods it gets and when LOOP recommends it.</p>
          <div className="form-row">
            <Field label="Title"><input className="input" maxLength={150} value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} /></Field>
            <Field label="Version"><input className="input" maxLength={40} value={meta.versionLabel} onChange={(e) => setMeta({ ...meta, versionLabel: e.target.value })} /></Field>
          </div>
          <div className="form-row">
            <Field label="Genre"><select className="select" value={meta.genreId} onChange={(e) => setMeta({ ...meta, genreId: e.target.value })}>{refs.data.genres.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
            <Field label="Language"><select className="select" value={meta.languageId} onChange={(e) => setMeta({ ...meta, languageId: e.target.value })}><option value="">Instrumental or none</option>{refs.data.languages.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
            <Field label="Year"><input className="input" inputMode="numeric" value={meta.releaseYear} onChange={(e) => setMeta({ ...meta, releaseYear: e.target.value })} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={meta.explicit} onChange={(e) => setMeta({ ...meta, explicit: e.target.checked })} />Explicit</label>
          <Field label="Description"><textarea className="textarea" maxLength={500} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></Field>
          <SoundProfile value={profile} onChange={setProfile} legend={u.soundProfile ? 'Sound profile (the song already has one; change it if needed)' : 'Sound profile (required)'} />
          <div className="composer-actions">
            <button type="button" className="btn btn-primary" onClick={() => approve(true)}>Approve and publish…</button>
            <button type="button" className="btn" onClick={() => approve(false)}>Approve only…</button>
            <button type="button" className="btn btn-danger" onClick={() => setRejecting(true)}>Reject…</button>
          </div>
        </section>
      )}
      {!canDecide && ['QUARANTINED', 'PROCESSING_FAILED', 'APPROVED'].includes(u.status) && (
        <div className="composer-actions">
          {u.status === 'APPROVED' && <button type="button" className="btn btn-primary" onClick={publish}>Publish…</button>}
          <button type="button" className="btn btn-danger" onClick={() => setRejecting(true)}>{u.status === 'PROCESSING_FAILED' ? 'Close and remove the file…' : 'Reject…'}</button>
        </div>
      )}
      <RejectDialog open={rejecting} onClose={() => setRejecting(false)} upload={u} onDone={reload} />
      {dialog}
    </>
  );
}

function RejectDialog({ open, onClose, upload, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => { if (open) { setNote(''); setError(null); } }, [open]);
  async function submit() {
    try { await api.admin.decideUpload(upload.id, { action: 'REJECT', note: note.trim() }); toast('Rejected; the file was deleted and the uploader told why'); onClose(); onDone(); }
    catch (err) { setError(err); }
  }
  const presets = ['The audio quality is too low.', 'We could not verify that you own the rights to this recording.', 'The title or artist details are wrong.', 'This recording is already on LOOP.'];
  return (
    <Dialog open={open} onClose={onClose} title={`Reject “${upload?.title}”?`}
      actions={<><button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button><button type="button" className="btn btn-danger" disabled={note.trim().length < 3} onClick={submit}>Reject</button></>}>
      <p className="small">The private file is deleted. The uploader sees your reason and can upload again.</p>
      <div className="chips">{presets.map((p) => <button key={p} type="button" className="chip" onClick={() => setNote(p)}>{p}</button>)}</div>
      <Field label="Reason (sent to the uploader)"><textarea className="textarea" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <ErrorState error={error} />
    </Dialog>
  );
}
