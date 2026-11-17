import { useEffect, useId, useRef, useState } from 'react';
import { Link } from '../lib/router';

export function Loading({ label = 'Loading' }) {
  return <div className="loading" role="status"><span className="pulse" aria-hidden="true" />{label}…</div>;
}

export function ErrorState({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="notice notice-error" role="alert">
      <strong>{error.message || 'Something went wrong.'}</strong>
      {error.details && typeof error.details === 'object' && !Array.isArray(error.details) && (
        <ul className="small">{Object.values(error.details).slice(0, 4).map((m) => <li key={m}>{m}</li>)}</ul>
      )}
      {onRetry && <div><button type="button" className="btn btn-sm" onClick={onRetry}>Try again</button></div>}
    </div>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <h3 className="h3">{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

export function PageHead({ title, children, actions, back }) {
  return (
    <header className="page-head">
      {back && <Link className="small back-link" to={back[0]}>← {back[1]}</Link>}
      <div className="page-head-row">
        <h1 className="h1">{title}</h1>
        {actions && <div className="row-actions">{actions}</div>}
      </div>
      {children && <p className="lede">{children}</p>}
    </header>
  );
}

/** A labelled control. Errors sit outside the <label> so they never change the field's accessible name. */
export function Field({ label, hint, error, errorId, children }) {
  const field = (
    <label className="field">
      <span>{label}{hint && <span className="hint"> — {hint}</span>}</span>
      {children}
    </label>
  );
  if (!error) return field;
  return <div className="field-group">{field}<span className="field-error" id={errorId}>{error}</span></div>;
}

export function Meter({ label, value, text }) {
  const pct = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
  return (
    <div className="meter">
      <div className="meter-label"><span>{label}</span><b>{text ?? `${pct}%`}</b></div>
      {value !== null && value !== undefined && (
        <div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="meter-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Native <dialog> so focus trapping, Escape and the backdrop come from the browser. */
export function Dialog({ open, onClose, title, children, actions, wide = false }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`dialog${wide ? ' dialog-wide' : ''}`} onClose={onClose} aria-labelledby={titleId}>
      {open && (
        <div className="dialog-body">
          <h2 id={titleId} className="h3">{title}</h2>
          {children}
          {actions && <div className="dialog-actions">{actions}</div>}
        </div>
      )}
    </dialog>
  );
}

/**
 * Confirmation for consequential actions. Names the object and the effect; optionally asks for a
 * reason (required when `reasonRequired`). The confirm button is disabled while the action runs.
 */
export function ConfirmDialog({ open, onClose, title, children, confirmLabel = 'Confirm', danger = false, reason = false,
  reasonRequired = false, reasonLabel = 'Reason', typeToConfirm = null, onConfirm }) {
  const [text, setText] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (open) { setText(''); setTyped(''); setError(null); setBusy(false); } }, [open]);
  const blocked = busy || (reasonRequired && text.trim().length < 3) || (typeToConfirm && typed !== typeToConfirm);
  async function go() {
    setBusy(true); setError(null);
    try { await onConfirm(text.trim()); onClose(); } catch (err) { setError(err); setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={onClose} title={title}
      actions={<>
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={blocked} onClick={go}>{busy ? 'Working…' : confirmLabel}</button>
      </>}>
      {children && <div className="small" style={{ display: 'grid', gap: 8 }}>{children}</div>}
      {reason && (
        <Field label={reasonLabel} hint={reasonRequired ? 'required' : 'optional'}>
          <textarea className="textarea" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}
      {typeToConfirm && (
        <Field label={`Type ${typeToConfirm} to confirm`}><input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} /></Field>
      )}
      <ErrorState error={error} />
    </Dialog>
  );
}

/** Hook for "confirm, then run": const [confirm, dialog] = useConfirm(); confirm({ title, … onConfirm }). */
export function useConfirm() {
  const [cfg, setCfg] = useState(null);
  const dialog = <ConfirmDialog open={!!cfg} onClose={() => setCfg(null)} {...(cfg || { title: '', onConfirm: async () => {} })} />;
  return [setCfg, dialog];
}

/**
 * Section switcher. Buttons with aria-current (not ARIA tabs): every option is a normal button,
 * reachable with Tab, announced as "current" when selected.
 */
export function Tabs({ value, onChange, items, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {items.map(([id, text, count]) => (
        <button key={id} type="button" aria-current={value === id ? 'true' : undefined} onClick={() => onChange(id)}>
          {text}{count ? <span className="count" aria-label={`, ${count} waiting`}>{count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage, noun = 'items' }) {
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  if (!total) return null;
  return (
    <nav className="pager" aria-label="Pages">
      <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span className="small muted">Page {page} of {pages} — {total} {noun}</span>
      <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </nav>
  );
}

const TONES = {
  APPROVED: 'ok', PUBLISHED: 'ok', RESOLVED: 'ok', ACTIVE: 'ok', CLEAN: 'ok', CLEAR: 'ok',
  PENDING: 'warn', PENDING_REVIEW: 'warn', QUARANTINED: 'warn', PROCESSING: 'warn', UPLOADING: 'warn', OPEN: 'warn', UNDER_REVIEW: 'warn',
  NEEDS_PROFILE: 'warn', HIDDEN: 'warn', UNPUBLISHED: 'warn', LOCKED: 'warn',
  REJECTED: 'danger', TAKEN_DOWN: 'danger', PROCESSING_FAILED: 'danger', INFECTED: 'danger', SUSPENDED: 'danger', DEACTIVATED: 'danger',
  WITHDRAWN: '', DISMISSED: '', CATALOGUE: '', MERGED: '', ERROR: 'danger',
};
const LABELS = { NEEDS_PROFILE: 'needs sound profile', PENDING_REVIEW: 'to review', PROCESSING_FAILED: 'failed', CATALOGUE: 'catalogue only' };

export const StatusBadge = ({ status }) => {
  const tone = TONES[status] || '';
  return <span className={`badge ${tone ? `badge-${tone}` : ''}`}>{LABELS[status] || String(status || '').replace(/_/g, ' ').toLowerCase()}</span>;
};

export function Definition({ items }) {
  return (
    <dl className="facts">
      {items.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

export { Link };
