import { useEffect, useMemo, useState } from 'react';
import { api, uploadFile } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { Link, useQuery, useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { bytes, duration, relativeDate, plural } from '../../lib/format';
import { Empty, ErrorState, Field, Loading, PageHead, StatusBadge, useConfirm } from '../../components/ui';

const OPEN = ['UPLOADING', 'QUARANTINED', 'PROCESSING', 'PENDING_REVIEW', 'APPROVED'];
const STATUS_HELP = {
  UPLOADING: 'Waiting for the audio file.',
  QUARANTINED: 'Received. Waiting for LOOP’s malware and audio check.',
  PROCESSING: 'Being checked for malware and audio format right now.',
  PENDING_REVIEW: 'Passed the checks. An Admin will listen to it and review the details.',
  APPROVED: 'Approved. It goes live when an Admin publishes it.',
  PUBLISHED: 'Live on LOOP.',
  REJECTED: 'Not accepted. See the reason below.',
  TAKEN_DOWN: 'Withdrawn or taken down. Nobody can play it.',
  PROCESSING_FAILED: 'The file could not be used. See the reason below and upload it again.',
};

/** The Artist studio. Every action is checked again on the server (artist.studio / artist.upload). */
export default function Studio({ section = 'overview' }) {
  const studio = useAsync(() => api.artistMe(), []);
  if (studio.loading && !studio.data) return <Loading label="Loading your studio" />;
  if (studio.error) return <div className="page"><ErrorState error={studio.error} onRetry={studio.reload} /></div>;
  const data = studio.data;
  const props = { data, reload: studio.reload };
  const suspended = data.artists.filter((a) => a.accountStatus === 'SUSPENDED');
  return (
    <div className="page">
      {suspended.map((a) => (
        <div key={a.id} className="notice notice-error" role="alert"><strong>“{a.name}” is suspended.</strong><span>{a.suspendedReason || 'Contact LOOP for details.'} You can’t upload or edit this profile until an Admin reinstates it.</span></div>
      ))}
      {section === 'overview' && <Overview {...props} />}
      {section === 'profile' && <ArtistProfile {...props} />}
      {section === 'upload' && <Upload {...props} />}
      {section === 'submissions' && <Submissions {...props} />}
      {section === 'listeners' && <Listeners />}
      {section === 'rights' && <Rights {...props} />}
    </div>
  );
}

function Overview({ data }) {
  const open = data.uploads.filter((u) => OPEN.includes(u.status)).length;
  const live = data.uploads.filter((u) => u.status === 'PUBLISHED').length;
  const attention = data.uploads.filter((u) => ['REJECTED', 'PROCESSING_FAILED'].includes(u.status) && new Date(u.updatedAt) > Date.now() - 14 * 86400000);
  return (
    <>
      <PageHead title={data.artists[0]?.name || 'Your studio'}>
        Publish your own or properly licensed recordings. Every upload is checked and reviewed by an Admin before anyone can hear it.
      </PageHead>
      <div className="stats">
        <Link className="stat" to="/studio/submissions"><b>{live}</b><span>Published recordings</span></Link>
        <Link className="stat" to="/studio/submissions"><b>{open}</b><span>In progress</span></Link>
        <Link className="stat" to="/studio/listeners"><b>Listeners</b><span>Plays and saves</span></Link>
      </div>
      {!data.uploadsEnabled && <div className="notice notice-warn"><strong>Uploads are paused.</strong><span>{data.uploadsDisabledReason}</span></div>}
      {attention.length > 0 && (
        <div className="notice notice-warn"><strong>{plural(attention.length, 'recording')} need your attention.</strong>
          <span>{attention.map((u) => u.title).join(', ')} — see <Link to="/studio/submissions">My submissions</Link>.</span></div>
      )}
      <div className="composer-actions">
        <Link className="btn btn-primary" to="/studio/upload">Upload a recording</Link>
        <Link className="btn" to="/studio/profile">Edit artist profile</Link>
      </div>
    </>
  );
}

function ArtistProfile({ data, reload }) {
  const toast = useToast();
  const [artistId, setArtistId] = useState(data.artists[0]?.id);
  const artist = data.artists.find((a) => a.id === artistId);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (artist) setForm({ name: artist.name, nameReason: '', artistType: artist.type, bio: artist.bio || '', formedYear: artist.formedYear || '' }); }, [artist]);
  if (!artist) return <Empty title="No artist profile is linked to your account">An Admin links a profile when your application is approved.</Empty>;
  const pendingName = data.nameChanges.find((n) => n.artistId === artist.id && n.status === 'PENDING');
  const lastDecided = data.nameChanges.find((n) => n.artistId === artist.id && ['APPROVED', 'REJECTED'].includes(n.status));
  const renaming = form && form.name.trim() !== artist.name;
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.updateArtistProfile(artist.id, { ...(renaming ? { name: form.name.trim(), nameReason: form.nameReason.trim() || undefined } : {}),
        artistType: form.artistType, bio: form.bio, ...(form.formedYear ? { formedYear: Number(form.formedYear) } : {}) });
      toast(r.nameChange ? 'Saved. Your new name will appear once an Admin approves it.' : 'Artist profile saved');
      reload();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  const disabled = artist.accountStatus !== 'ACTIVE';
  return (
    <>
      <PageHead title="Artist profile">This is what listeners see on your artist page.</PageHead>
      {data.artists.length > 1 && (
        <Field label="Profile"><select className="select" value={artistId} onChange={(e) => setArtistId(Number(e.target.value))}>{data.artists.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      )}
      {pendingName && <p className="notice">Name change to “{pendingName.newName}” is waiting for an Admin. Listeners still see “{artist.name}”.</p>}
      {!pendingName && lastDecided?.status === 'REJECTED' && <p className="notice notice-warn">Your request to be called “{lastDecided.newName}” was not approved{lastDecided.reviewNote ? `: ${lastDecided.reviewNote}` : '.'}</p>}
      {form && (
        <form className="form" onSubmit={save} style={{ maxWidth: 560 }}>
          <fieldset disabled={disabled || busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--s4)' }}>
            <Field label="Artist name" hint="changes are reviewed by an Admin"><input className="input" required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            {renaming && <Field label="Why the change?" hint="helps the Admin approve it"><input className="input" maxLength={300} value={form.nameReason} onChange={(e) => setForm({ ...form, nameReason: e.target.value })} /></Field>}
            <Field label="Type">
              <select className="select" value={form.artistType} onChange={(e) => setForm({ ...form, artistType: e.target.value })}>
                <option value="SOLO">Solo artist</option><option value="GROUP">Band or group</option><option value="COMPOSER">Composer</option><option value="ORCHESTRA">Ensemble or orchestra</option>
              </select>
            </Field>
            <Field label="Active since" hint="optional"><input className="input" inputMode="numeric" maxLength={4} value={form.formedYear} onChange={(e) => setForm({ ...form, formedYear: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label="Bio" hint="up to 400 characters"><textarea className="textarea" maxLength={400} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} /></Field>
            <div className="composer-actions">
              <button className="btn btn-primary" disabled={!form.name.trim()}>{renaming ? 'Save and request name change' : 'Save profile'}</button>
              <Link to={`/artist/${artist.id}`} className="small">View public page</Link>
            </div>
          </fieldset>
        </form>
      )}
    </>
  );
}

const BLANK = { title: '', versionLabel: '', genreId: '', languageId: '', durationSec: '', releaseYear: String(new Date().getFullYear()),
  explicit: false, description: '', compositionRights: 'OWNED', recordingRights: 'OWNED', rightsEvidenceRef: '', rightsAccepted: false };

export function validateUpload(form, file, maxBytes) {
  const e = {};
  if (!form.title.trim()) e.title = 'Enter the recording title.';
  if (!form.genreId) e.genreId = 'Choose a genre.';
  const d = Number(form.durationSec);
  if (!Number.isInteger(d) || d < 30 || d > 1800) e.durationSec = 'Duration must be between 30 and 1800 seconds.';
  const y = Number(form.releaseYear);
  if (!Number.isInteger(y) || y < 1900 || y > 2100) e.releaseYear = 'Enter a year between 1900 and 2100.';
  if (!file) e.file = 'Choose an audio file.';
  else if (file.size > maxBytes) e.file = `The file is larger than ${bytes(maxBytes)}.`;
  else if (file.type && !file.type.startsWith('audio/')) e.file = 'Choose an audio file (MP3, WAV, FLAC, OGG or M4A).';
  const licensed = form.compositionRights === 'LICENSED' || form.recordingRights === 'LICENSED';
  if (licensed && !/^https:\/\/.{5,}/i.test(form.rightsEvidenceRef)) e.rightsEvidenceRef = 'Licensed material needs an https:// link to the licence or permission.';
  if (!form.rightsAccepted) e.rightsAccepted = 'Confirm that you have the rights to publish this recording.';
  return e;
}

/** Read the duration from the file itself, so nobody has to type it. */
export function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration) : null);
    a.onerror = () => done(null);
    a.src = url;
  });
}

/**
 * Upload form, shared by the Artist studio and the Admin console (Admins upload LOOP-owned recordings
 * for any artist). `create(body)` starts the upload; the file then goes up with progress.
 */
export function UploadForm({ artists, maxBytes, termsVersion, disabled, create, initial = null, onDone, adminExtras = null }) {
  const toast = useToast();
  const genres = useAsync(() => api.genres(), []);
  const languages = useAsync(() => api.languages(), []);
  const [form, setForm] = useState(() => ({ ...BLANK, artistId: artists[0]?.id || '', ...(initial || {}) }));
  const [file, setFile] = useState(null);
  const [artwork, setArtwork] = useState(null);
  const [errors, setErrors] = useState({});
  const [progress, setProgress] = useState(null);
  const [failed, setFailed] = useState(null);   // { intent } when the file transfer failed — retry sends it again
  const [drag, setDrag] = useState(false);
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function pick(f) {
    if (!f) return;
    setFile(f);
    const d = await readDuration(f);
    if (d) setForm((x) => ({ ...x, durationSec: String(d) }));
    if (!form.title.trim()) setForm((x) => ({ ...x, title: x.title || f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 150) }));
  }

  async function send(intent) {
    setProgress(0); setFailed(null);
    try {
      await uploadFile(intent.uploadUrl, file, { token: intent.uploadToken, onProgress: setProgress });
      if (artwork && intent.id && !adminExtras) await api.uploadArtwork(intent.id, artwork).catch((err) => toast(`Recording received, but the artwork failed: ${err.message}`, 'error'));
      toast('Recording received. It stays private while LOOP checks it.');
      setProgress(null);
      onDone?.(intent);
    } catch (err) {
      setProgress(null);
      setFailed({ intent, error: err });
    }
  }

  async function submit(e) {
    e.preventDefault();
    const v = validateUpload(form, file, maxBytes);
    if (!form.artistId) v.artistId = 'Choose the artist.';
    setErrors(v);
    if (Object.keys(v).length) return;
    try {
      const intent = await create({
        artistId: Number(form.artistId), title: form.title.trim(), versionLabel: form.versionLabel.trim(), genreId: Number(form.genreId),
        ...(form.languageId ? { languageId: Number(form.languageId) } : {}), durationSec: Number(form.durationSec), releaseYear: Number(form.releaseYear),
        explicit: form.explicit, ...(form.description.trim() ? { description: form.description.trim() } : {}),
        fileSize: file.size, mimeType: file.type || 'application/octet-stream',
        compositionRights: form.compositionRights, recordingRights: form.recordingRights,
        ...(form.rightsEvidenceRef ? { rightsEvidenceRef: form.rightsEvidenceRef } : {}), rightsAccepted: true,
        ...(form.targetSongId ? { targetSongId: Number(form.targetSongId) } : {}),
      });
      await send(intent);
    } catch (err) { toast(err.message, 'error'); }
  }
  const fe = (k) => ({ error: errors[k], errorId: `upload-${k}-error` });
  const busy = progress !== null;

  return (
    <form className="form" onSubmit={submit} noValidate style={{ maxWidth: 680 }}>
      <fieldset disabled={disabled || busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--s4)' }}>
        <div className={`dropzone${drag ? ' is-over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}>
          <Field label="Audio file" hint={`MP3, WAV, FLAC, OGG, AAC or M4A, up to ${bytes(maxBytes)} — or drop it here`} {...fe('file')}>
            <input className="input" type="file" accept="audio/*" onChange={(e) => pick(e.target.files?.[0] || null)} aria-invalid={!!errors.file || undefined} />
          </Field>
          {file && <p className="small muted">{file.name} — {bytes(file.size)}{form.durationSec ? ` — ${duration(Number(form.durationSec))}` : ''}</p>}
          {previewUrl && <audio controls preload="metadata" src={previewUrl} style={{ width: '100%' }} aria-label="Preview your recording" />}
        </div>
        {artists.length > 1 || adminExtras ? (
          <Field label="Artist" {...fe('artistId')}><select className="select" value={form.artistId} onChange={set('artistId')}>
            <option value="">Choose…</option>{artists.map((a) => <option key={a.id} value={a.id}>{a.name}{a.disambiguation ? ` (${a.disambiguation})` : ''}</option>)}</select></Field>
        ) : null}
        {adminExtras}
        <div className="form-row">
          <Field label="Title" {...fe('title')}><input className="input" maxLength={150} value={form.title} onChange={set('title')} aria-invalid={!!errors.title || undefined} /></Field>
          <Field label="Version" hint="optional, e.g. Acoustic"><input className="input" maxLength={40} value={form.versionLabel} onChange={set('versionLabel')} /></Field>
        </div>
        <div className="form-row">
          <Field label="Genre" {...fe('genreId')}>
            <select className="select" value={form.genreId} onChange={set('genreId')} aria-invalid={!!errors.genreId || undefined}>
              <option value="">Choose…</option>{(genres.data || []).map((g) => <option key={g.id} value={g.id}>{g.path || g.name}</option>)}
            </select></Field>
          <Field label="Language" hint="optional">
            <select className="select" value={form.languageId} onChange={set('languageId')}>
              <option value="">Instrumental or none</option>{(languages.data || []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Duration in seconds" hint="read from the file" {...fe('durationSec')}><input className="input" inputMode="numeric" value={form.durationSec} onChange={set('durationSec')} aria-invalid={!!errors.durationSec || undefined} /></Field>
          <Field label="Release year" {...fe('releaseYear')}><input className="input" inputMode="numeric" value={form.releaseYear} onChange={set('releaseYear')} /></Field>
        </div>
        <Field label="About this recording" hint="optional"><textarea className="textarea" maxLength={500} value={form.description} onChange={set('description')} /></Field>
        <label className="check"><input type="checkbox" checked={form.explicit} onChange={set('explicit')} />Contains explicit content</label>
        {!adminExtras && <Field label="Cover image" hint="optional, JPEG, PNG or WebP up to 2 MB"><input className="input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setArtwork(e.target.files?.[0] || null)} /></Field>}
        <div className="form-row">
          <Field label="Composition rights">
            <select className="select" value={form.compositionRights} onChange={set('compositionRights')}>
              <option value="OWNED">Written / owned by {adminExtras ? 'LOOP or the artist' : 'me'}</option><option value="LICENSED">Licensed</option><option value="PUBLIC_DOMAIN">Public domain</option>
            </select>
          </Field>
          <Field label="Recording rights">
            <select className="select" value={form.recordingRights} onChange={set('recordingRights')}>
              <option value="OWNED">Recorded / owned by {adminExtras ? 'LOOP or the artist' : 'me'}</option><option value="LICENSED">Licensed</option><option value="PUBLIC_DOMAIN">Public domain</option>
            </select>
          </Field>
        </div>
        <Field label="Licence or permission link" hint="required for licensed material" {...fe('rightsEvidenceRef')}><input className="input" type="url" value={form.rightsEvidenceRef} onChange={set('rightsEvidenceRef')} /></Field>
        <label className="check"><input type="checkbox" checked={form.rightsAccepted} onChange={set('rightsAccepted')} />
          <span>{adminExtras ? 'LOOP owns or is licensed to stream' : 'I own or am licensed to publish'} this recording and its composition, under the <Link to="/artist-terms">Artist rights declaration</Link> ({termsVersion}).</span></label>
        {errors.rightsAccepted && <span className="field-error" id="upload-rightsAccepted-error">{errors.rightsAccepted}</span>}
        {busy && (
          <div role="status" aria-live="polite">
            <progress max="1" value={progress} style={{ width: '100%' }} aria-label="Upload progress" />
            <span className="small muted">Uploading… {Math.round(progress * 100)}%</span>
          </div>
        )}
        <div><button className="btn btn-primary" type="submit">{busy ? 'Uploading…' : 'Upload recording'}</button></div>
      </fieldset>
      {failed && (
        <div className="notice notice-error" role="alert"><strong>{failed.error.message}</strong>
          <div className="composer-actions"><button type="button" className="btn btn-sm" onClick={() => send(failed.intent)}>Retry the upload</button></div></div>
      )}
    </form>
  );
}

function Upload({ data, reload }) {
  const { navigate } = useRouter();
  const query = useQuery();
  const from = query.get('from');
  const previous = from ? data.uploads.find((u) => u.id === from) : null;
  const active = data.artists.filter((a) => a.accountStatus === 'ACTIVE');
  const initial = previous ? { artistId: previous.artistId, title: previous.title, versionLabel: previous.versionLabel || '', genreId: String(previous.genreId || ''),
    languageId: previous.languageId ? String(previous.languageId) : '', releaseYear: String(previous.releaseYear || ''), explicit: !!previous.explicit, description: previous.description || '' } : null;
  return (
    <>
      <PageHead title={previous ? 'Upload again' : 'Upload a recording'}>Only upload music you own or are licensed to publish. It stays private until an Admin approves and publishes it.</PageHead>
      {previous && <p className="notice">Starting from “{previous.title}”. Fix what the reviewer asked for and choose the file again.</p>}
      {!data.uploadsEnabled && <div className="notice notice-warn" role="status"><strong>Uploads are paused.</strong><span>{data.uploadsDisabledReason}</span></div>}
      {active.length === 0 ? <Empty title="No active artist profile">Your profile must be active to upload.</Empty> : (
        <UploadForm artists={active} maxBytes={data.maxUploadBytes} termsVersion={data.termsVersion} disabled={!data.uploadsEnabled}
          create={api.createUpload} initial={initial} onDone={() => { reload(); navigate('/studio/submissions'); }} />
      )}
    </>
  );
}

function Timeline({ id }) {
  const { data, error, loading } = useAsync(() => api.artistUpload(id), [id]);
  if (loading && !data) return <Loading label="Loading history" />;
  if (error) return <ErrorState error={error} />;
  return (
    <ol className="timeline">
      {data.events.map((e, i) => <li key={i}><span className="small">{e.note || e.code.replace(/_/g, ' ').toLowerCase()}</span><span className="tiny muted">{relativeDate(e.createdAt)}</span></li>)}
    </ol>
  );
}

function Submissions({ data, reload }) {
  const toast = useToast();
  const [confirm, dialog] = useConfirm();
  const [openId, setOpenId] = useState(null);
  function withdraw(u) {
    confirm({
      title: `Withdraw “${u.title}”?`, danger: true, confirmLabel: 'Withdraw', reason: true, reasonLabel: 'Reason (optional)',
      children: <p>{u.status === 'PUBLISHED' ? 'Listeners lose it immediately and it leaves every playlist and mix. ' : ''}You can’t undo this; to bring it back you upload it again.</p>,
      onConfirm: async (reason) => { await api.withdrawUpload(u.id, reason || undefined); toast('Recording withdrawn. Nobody can play it now.'); reload(); },
    });
  }
  return (
    <>
      <PageHead title="My submissions">{plural(data.uploads.length, 'recording')} sent to LOOP.</PageHead>
      {data.uploads.length === 0 ? <Empty title="Nothing uploaded yet" action={<Link className="btn btn-primary" to="/studio/upload">Upload a recording</Link>} /> : (
        <ul className="list">
          {data.uploads.map((u) => (
            <li key={u.id} className="list-item" style={{ flexWrap: 'wrap' }}>
              <div className="list-item-main">
                <span className="title">{u.status === 'PUBLISHED' && u.songId ? <Link to={`/song/${u.songId}`}>{u.title}</Link> : u.title}{u.versionLabel ? ` (${u.versionLabel})` : ''}</span>
                <span className="small muted">{STATUS_HELP[u.status] || ''} Sent {relativeDate(u.createdAt)}{u.fileSize ? `, ${bytes(u.fileSize)}` : ''}.</span>
                {u.failureReason && ['PROCESSING_FAILED', 'QUARANTINED', 'REJECTED'].includes(u.status) && <span className="small">{u.failureReason}</span>}
                {u.reviewNote && <span className="small">Reviewer: “{u.reviewNote}”</span>}
                <button type="button" className="btn btn-quiet btn-sm" style={{ justifySelf: 'start', paddingLeft: 0 }} aria-expanded={openId === u.id} onClick={() => setOpenId(openId === u.id ? null : u.id)}>{openId === u.id ? 'Hide history' : 'Show history'}</button>
                {openId === u.id && <Timeline id={u.id} />}
              </div>
              <div className="row-actions">
                <StatusBadge status={u.status} />
                {['REJECTED', 'PROCESSING_FAILED'].includes(u.status) && <Link className="btn btn-sm" to={`/studio/upload?from=${u.id}`}>Upload again</Link>}
                {!['REJECTED', 'TAKEN_DOWN', 'PROCESSING_FAILED'].includes(u.status) && <button type="button" className="btn btn-sm btn-danger" onClick={() => withdraw(u)}>Withdraw</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </>
  );
}

function Listeners() {
  const { data, error, loading, reload } = useAsync(() => api.artistStats(), []);
  return (
    <>
      <PageHead title="Listeners">How your recordings are doing. Plays count only when someone actually listened.</PageHead>
      {loading && !data && <Loading label="Loading statistics" />}
      <ErrorState error={error} onRetry={reload} />
      {data && data.length === 0 && <Empty title="No recordings yet" action={<Link className="btn btn-primary" to="/studio/upload">Upload a recording</Link>} />}
      {data && data.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Recording</th><th className="num">Plays, 7 days</th><th className="num">Plays, 30 days</th><th className="num">Listeners, 30 days</th><th className="num">All plays</th><th className="num">Likes</th><th className="num">Saves</th></tr></thead>
          <tbody>{data.map((s) => (
            <tr key={s.id}><td><Link to={`/song/${s.id}`}>{s.title}</Link>{s.status !== 'ACTIVE' && <> <StatusBadge status={s.moderationState !== 'CLEAR' ? s.moderationState : s.status === 'PENDING_ANALYSIS' ? 'NEEDS_PROFILE' : s.status} /></>}</td>
              <td className="num">{s.plays7d}</td><td className="num">{s.plays30d}</td><td className="num">{s.listeners30d}</td><td className="num">{s.playsAll}</td><td className="num">{s.likes}</td><td className="num">{s.saves}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

function Rights({ data }) {
  return (
    <div className="page-narrow" style={{ display: 'grid', gap: 'var(--s5)' }}>
      <PageHead title="Rights">What you agree to when you publish on LOOP (terms {data.termsVersion}).</PageHead>
      <ul style={{ display: 'grid', gap: 'var(--s3)', listStyle: 'disc', paddingLeft: '1.2em', maxWidth: 'var(--measure)' }}>
        <li>You only upload recordings you own, or are licensed to distribute, for both the composition and the recording.</li>
        <li>Licensed material needs a link to the licence or written permission. An Admin checks it before approval.</li>
        <li>Uploads are held privately, scanned for malware and checked as valid audio. An Admin listens before approving.</li>
        <li>You can’t approve or publish your own recordings, and your artist name changes are reviewed.</li>
        <li>You can withdraw a recording at any time. Playback stops immediately.</li>
        <li>Anyone can report a recording with the Report button on its page. An Admin reviews it and may take it down.</li>
      </ul>
      <p><Link to="/artist-terms">Read the full Artist rights declaration</Link></p>
    </div>
  );
}
