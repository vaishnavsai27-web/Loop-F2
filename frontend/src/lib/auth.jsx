// Signed-in state. The role always comes from the server session (/auth/session);
// the browser never decides who is an Artist or an Admin.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, setPasswordChangeHandler, setReauthHandler, setUnauthorizedHandler } from './api';
import { Dialog, ErrorState, Field } from '../components/ui';

const AuthContext = createContext(null);

export const ROLE_LABEL = { LISTENER: 'Listener', ARTIST: 'Artist', ADMIN: 'Admin' };
export const homeFor = (user) => (!user ? '/' : user.mustChangePassword ? '/change-password' : user.role === 'ADMIN' ? '/admin' : '/discover');

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [expired, setExpired] = useState(null);
  const [platform, setPlatform] = useState({ registrationOpen: true, maintenanceMessage: null, applicationsOpen: true });
  const [reauth, setReauth] = useState(null);   // { resolve } while the password dialog is open

  const refresh = useCallback(async () => {
    try {
      const s = await api.session();
      setUser(s && s.authenticated ? s : null);
      return s && s.authenticated ? s : null;
    } catch {
      setUser(null);
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { refresh(); api.platform().then(setPlatform).catch((err) => console.warn('LOOP: platform notice unavailable —', err.message)); }, [refresh]);
  // Role changes (an approved Artist application, a demotion) show up when the person comes back to the tab.
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [refresh]);
  useEffect(() => {
    setUnauthorizedHandler((e) => {
      setUser(null);
      setExpired(e?.message || 'Your session has ended. Sign in again.');
    });
    setPasswordChangeHandler(() => setUser((u) => (u ? { ...u, mustChangePassword: true } : u)));
    setReauthHandler(() => new Promise((resolve) => setReauth({ resolve })));
  }, []);

  const login = useCallback(async (login, password) => {
    await api.login(login, password);
    setExpired(null);
    return refresh();
  }, [refresh]);
  const register = useCallback(async (body) => {
    await api.register(body);
    setExpired(null);
    return refresh();
  }, [refresh]);
  const logout = useCallback(async () => {
    window.dispatchEvent(new Event('loop:signout'));   // the player stops and records the play
    try { await api.logout(); } finally { setUser(null); }
  }, []);

  const value = useMemo(() => ({ user, ready, expired, platform, login, register, logout, refresh, setUser, clearExpired: () => setExpired(null) }),
    [user, ready, expired, platform, login, register, logout, refresh]);
  return (
    <AuthContext.Provider value={value}>
      {children}
      <ReauthDialog state={reauth} onDone={(ok) => { reauth?.resolve(ok); setReauth(null); }} />
    </AuthContext.Provider>
  );
}

/** Step-up authentication: shown when the server asks the Admin to confirm their password. */
function ReauthDialog({ state, onDone }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  useEffect(() => { if (state) { setPassword(''); setError(null); setTimeout(() => input.current?.focus(), 30); } }, [state]);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.reauth(password); onDone(true); } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!state} onClose={() => onDone(false)} title="Confirm it’s you">
      <form className="form" onSubmit={submit}>
        <p className="small muted">This action changes access or deletes data. Enter your password to continue.</p>
        <Field label="Your password"><input ref={input} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorState error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={() => onDone(false)}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!password || busy}>{busy ? 'Checking…' : 'Confirm'}</button>
        </div>
      </form>
    </Dialog>
  );
}

export const useAuth = () => useContext(AuthContext);
