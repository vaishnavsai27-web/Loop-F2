import { useCallback } from 'react';
import { useAuth, homeFor, ROLE_LABEL } from './lib/auth';
import { Redirect, Routes, Link, useRouter } from './lib/router';
import { PlayerProvider } from './lib/player';
import { useToast } from './lib/toast';
import Shell from './components/Shell';
import { Loading } from './components/ui';
import Landing from './pages/Landing';
import Auth from './pages/Auth';
import Discover from './pages/Discover';
import Search from './pages/Search';
import Library from './pages/Library';
import Playlist, { SharedPlaylist } from './pages/Playlist';
import Browse from './pages/Browse';
import Legal from './pages/Legal';
import { ChangePassword, ForgotPassword, ResetPassword, VerifyEmail } from './pages/Account';
import Song from './pages/Song';
import Collection from './pages/Collection';
import Settings from './pages/Settings';
import Studio from './pages/artist/Studio';
import Admin from './pages/admin/Admin';

const AREA_ROLES = { listen: null, studio: ['ARTIST'], admin: ['ADMIN'] };

function Forbidden({ need }) {
  const { user } = useAuth();
  return (
    <div className="page page-narrow">
      <div className="empty">
        <h1 className="h1" style={{ fontSize: 'var(--t-2xl)' }}>This area is for {need}s</h1>
        <p className="muted">You’re signed in as a {ROLE_LABEL[user.role]}, so LOOP won’t open it for you.
          {need === 'Artist' && user.role === 'LISTENER' && ' You can apply for Artist access in Settings.'}</p>
        <div className="composer-actions">
          <Link className="btn btn-primary" to={homeFor(user)}>Go to your home</Link>
          {need === 'Artist' && user.role === 'LISTENER' && <Link className="btn" to="/settings/artist">Apply for Artist access</Link>}
        </div>
      </div>
    </div>
  );
}

function NotFound() {
  const { user } = useAuth();
  return (
    <div className="page page-narrow">
      <div className="empty">
        <h1 className="h1" style={{ fontSize: 'var(--t-2xl)' }}>There’s nothing at this address</h1>
        <p className="muted">The link may be old, or the page was moved.</p>
        <Link className="btn btn-primary" to={homeFor(user)}>Go to your home</Link>
      </div>
    </div>
  );
}

/** Signed-in pages: redirect to sign-in when there is no session; deny other roles in place. */
function Area({ area, children }) {
  const { user } = useAuth();
  const { path, search } = useRouter();
  if (!user) return <Redirect to={`/login?next=${encodeURIComponent(path + search)}`} />;
  if (user.mustChangePassword) return <Redirect to="/change-password" />;
  const roles = AREA_ROLES[area];
  const allowed = !roles || roles.includes(user.role);
  return <Shell area={allowed ? area : 'listen'}>{allowed ? children : <Forbidden need={area === 'admin' ? 'Admin' : 'Artist'} />}</Shell>;
}

const routes = [
  { path: '/', render: () => <Home /> },
  { path: '/login', render: () => <PublicOnly><Auth mode="login" /></PublicOnly> },
  { path: '/register', render: () => <PublicOnly><Auth mode="register" /></PublicOnly> },
  { path: '/forgot-password', render: () => <PublicOnly><ForgotPassword /></PublicOnly> },
  { path: '/reset-password', render: () => <ResetPassword /> },
  { path: '/verify-email', render: () => <VerifyEmail /> },
  { path: '/change-password', render: () => <SignedIn><ChangePassword /></SignedIn> },
  { path: '/terms', render: () => <Legal doc="terms" /> },
  { path: '/privacy', render: () => <Legal doc="privacy" /> },
  { path: '/artist-terms', render: () => <Legal doc="artist-terms" /> },
  { path: '/p/:token', render: ({ token }) => <SharedPlaylist token={token} /> },
  { path: '/discover', render: () => <Area area="listen"><Discover /></Area> },
  { path: '/browse', render: () => <Area area="listen"><Browse /></Area> },
  { path: '/search', render: () => <Area area="listen"><Search /></Area> },
  { path: '/library', render: () => <Area area="listen"><Library /></Area> },
  { path: '/playlist/:id', render: ({ id }) => <Area area="listen"><Playlist key={id} id={id} /></Area> },
  { path: '/song/:id', render: ({ id }) => <Area area="listen"><Song key={id} id={id} /></Area> },
  { path: '/artist/:id', render: ({ id }) => <Area area="listen"><Collection key={`a${id}`} kind="artist" id={id} /></Area> },
  { path: '/album/:id', render: ({ id }) => <Area area="listen"><Collection key={`b${id}`} kind="album" id={id} /></Area> },
  { path: '/settings', render: () => <Area area="listen"><Settings /></Area> },
  { path: '/settings/:section', render: ({ section }) => <Area area="listen"><Settings section={section} /></Area> },
  { path: '/studio', render: () => <Area area="studio"><Studio /></Area> },
  { path: '/studio/:section', render: ({ section }) => <Area area="studio"><Studio key={section} section={section} /></Area> },
  { path: '/admin', render: () => <Area area="admin"><Admin /></Area> },
  { path: '/admin/:section', render: ({ section }) => <Area area="admin"><Admin key={section} section={section} /></Area> },
  { path: '/admin/:section/:id', render: ({ section, id }) => <Area area="admin"><Admin key={`${section}/${id}`} section={section} id={id} /></Area> },
  { path: '*', render: () => <Fallback /> },
];

function Home() {
  const { user } = useAuth();
  return user ? <Redirect to={homeFor(user)} /> : <Landing />;
}
function SignedIn({ children }) {
  const { user } = useAuth();
  return user ? children : <Redirect to="/login" />;
}
function PublicOnly({ children }) {
  const { user } = useAuth();
  return user ? <Redirect to={homeFor(user)} /> : children;
}
function Fallback() {
  const { user } = useAuth();
  if (!user) return <Landing />;
  return <Shell area="listen"><NotFound /></Shell>;
}

export default function App() {
  const { ready } = useAuth();
  const toast = useToast();
  const onError = useCallback((message) => toast(message, 'error'), [toast]);
  if (!ready) return <div style={{ padding: 40 }}><Loading label="Opening LOOP" /></div>;
  return (
    <PlayerProvider onError={onError}>
      <Routes routes={routes} />
    </PlayerProvider>
  );
}
