// Account recovery and security pages: forgot password, reset password, confirm email, and the
// forced password change for accounts that still use a published password.
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth, homeFor } from '../lib/auth';
import { Link, useQuery, useRouter } from '../lib/router';
import { Mark } from '../components/Icon';
import { ErrorState, Field } from '../components/ui';

function PublicFrame({ title, children }) {
  return (
    <div className="public">
      <header className="public-top"><Link className="brand" to="/"><Mark /><span className="brand-word">loop</span></Link></header>
      <main className="public-main" id="main"><div className="auth"><h1 className="h1" style={{ fontSize: 'var(--t-2xl)' }}>{title}</h1>{children}</div></main>
    </div>
  );
}

const strongEnough = (p) => p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);

export function ForgotPassword() {
  const [login, setLogin] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { setResult(await api.requestReset(login.trim())); } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <PublicFrame title="Reset your password">
      {result ? <p className={`notice ${result.emailEnabled ? 'notice-ok' : 'notice-warn'}`} role="status">{result.message}</p> : (
        <form className="form" onSubmit={submit}>
          <p className="small muted">Enter the email or username of your account. If email is set up on this LOOP, we send you a link that works for 30 minutes.</p>
          <Field label="Email or username"><input className="input" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} /></Field>
          <ErrorState error={error} />
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || login.trim().length < 3}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}
      <p className="small muted">Remembered it? <Link to="/login">Sign in</Link></p>
    </PublicFrame>
  );
}

export function ResetPassword() {
  const query = useQuery();
  const token = query.get('token') || '';
  const [pw, setPw] = useState({ next: '', confirm: '' });
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const problem = pw.next && !strongEnough(pw.next) ? 'Use 8 or more characters with a letter and a number.' : pw.confirm && pw.confirm !== pw.next ? 'The passwords don’t match.' : null;
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { setDone(await api.confirmReset(token, pw.next)); } catch (err) { setError(err); } finally { setBusy(false); }
  }
  if (!token) return <PublicFrame title="Reset your password"><p className="notice notice-error">This link is incomplete. <Link to="/forgot-password">Ask for a new one</Link>.</p></PublicFrame>;
  return (
    <PublicFrame title="Choose a new password">
      {done ? <><p className="notice notice-ok" role="status">{done.message}</p><Link className="btn btn-primary" to="/login">Sign in</Link></> : (
        <form className="form" onSubmit={submit}>
          <Field label="New password" hint="8+ characters with a letter and a number"><input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          <Field label="Confirm new password"><input className="input" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          {problem && <p className="field-error">{problem}</p>}
          <ErrorState error={error} />
          {error?.code === 'RESET_LINK_INVALID' && <Link to="/forgot-password">Ask for a new link</Link>}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !!problem || !pw.next || pw.next !== pw.confirm}>{busy ? 'Saving…' : 'Save new password'}</button>
        </form>
      )}
    </PublicFrame>
  );
}

export function VerifyEmail() {
  const query = useQuery();
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    api.verifyEmail(query.get('token') || '').then(() => setState({ ok: true })).catch((error) => setState({ error }));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <PublicFrame title="Confirm your email">
      {state.loading && <p className="small muted">Checking your link…</p>}
      {state.ok && <p className="notice notice-ok" role="status">Your email address is confirmed. <Link to="/discover">Go to LOOP</Link></p>}
      <ErrorState error={state.error} />
    </PublicFrame>
  );
}

/** Shown instead of everything else while the server requires a new password (published or reset passwords). */
export function ChangePassword() {
  const { user, refresh } = useAuth();
  const { navigate } = useRouter();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const problem = pw.next && !strongEnough(pw.next) ? 'Use 8 or more characters with a letter and a number.' : pw.confirm && pw.confirm !== pw.next ? 'The passwords don’t match.' : null;
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.changePassword(pw.current, pw.next);
      const u = await refresh();
      navigate(homeFor(u), { replace: true });
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <PublicFrame title="Choose a new password">
      <p className="notice notice-warn" role="status">
        {user?.mustChangePassword ? 'Your current password is publicly known or was reset, so LOOP needs you to choose a new one before you continue.' : 'Change your password.'}
      </p>
      <form className="form" onSubmit={submit}>
        <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
        <Field label="New password" hint="8+ characters with a letter and a number"><input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
        <Field label="Confirm new password"><input className="input" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
        {problem && <p className="field-error">{problem}</p>}
        <ErrorState error={error} />
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !!problem || !pw.current || !pw.next || pw.next !== pw.confirm}>{busy ? 'Saving…' : 'Save and continue'}</button>
      </form>
    </PublicFrame>
  );
}
