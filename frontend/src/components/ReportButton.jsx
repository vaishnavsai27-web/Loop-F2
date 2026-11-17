import { useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { Dialog, ErrorState, Field } from './ui';
import Icon from './Icon';

const REASONS = [
  ['COPYRIGHT', 'It uses my work without permission'],
  ['IMPERSONATION', 'It pretends to be someone else'],
  ['EXPLICIT_CONTENT', 'Explicit content is not labelled'],
  ['MISLABELLED', 'Wrong title, artist or details'],
  ['SAFETY', 'Harmful or dangerous content'],
  ['SPAM', 'Spam or junk'],
  ['HARASSMENT', 'Harassment or hate'],
  ['OTHER', 'Something else'],
];

/** "Report" for a song, artist, album or account. A LOOP Admin reviews it and the reporter is told the outcome. */
export default function ReportButton({ targetType, targetId, name, compact = false }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ reason: 'MISLABELLED', details: '', evidenceRef: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.report({ targetType, targetId: Number(targetId), reason: form.reason, details: form.details.trim(),
        ...(form.evidenceRef.trim() ? { evidenceRef: form.evidenceRef.trim() } : {}) });
      toast(r.message);
      setOpen(false);
      setForm({ reason: 'MISLABELLED', details: '', evidenceRef: '' });
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  const label = { SONG: 'song', ARTIST: 'artist', ALBUM: 'album', USER: 'account' }[targetType];
  return (
    <>
      <button type="button" className={compact ? 'icon-btn' : 'btn btn-quiet btn-sm'} onClick={() => setOpen(true)} aria-label={`Report ${name}`} title="Report">
        <Icon name="flag" size={18} />{!compact && 'Report'}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Report this ${label}`}>
        <form className="form" onSubmit={submit}>
          <p className="small muted">Tell LOOP what is wrong with “{name}”. An Admin reviews every report and lets you know what happened.</p>
          <Field label="What’s the problem?">
            <select className="select" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              {REASONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
          </Field>
          <Field label="Details" hint="at least 10 characters">
            <textarea className="textarea" required minLength={10} maxLength={2000} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} />
          </Field>
          {form.reason === 'COPYRIGHT' && (
            <Field label="Link to proof" hint="optional, https://"><input className="input" type="url" value={form.evidenceRef} onChange={(e) => setForm({ ...form, evidenceRef: e.target.value })} /></Field>
          )}
          <ErrorState error={error} />
          <div className="dialog-actions">
            <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || form.details.trim().length < 10}>{busy ? 'Sending…' : 'Send report'}</button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
