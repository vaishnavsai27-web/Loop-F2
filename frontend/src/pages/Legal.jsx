import { Link } from '../lib/router';
import { useAuth } from '../lib/auth';
import { Mark } from '../components/Icon';

// The Terms, Privacy notice and Artist rights declaration LOOP shows and asks people to accept.
// Version strings match the server (authService.TERMS_VERSION, artistService.TERMS_VERSION).
const DOCS = {
  terms: {
    title: 'Terms of use', version: 'LOOP-TERMS-2026-11', sections: [
      ['Your account', 'You need an account to listen. Keep your password private; you are responsible for what happens in your account. You must be old enough to agree to these terms where you live.'],
      ['What LOOP offers', 'LOOP recommends music from its own catalogue based on the mood you describe, and plays only recordings it is authorised to stream. Some songs can be found but not played.'],
      ['Acceptable use', 'Do not copy, download in bulk, redistribute or scrape LOOP’s audio or catalogue; do not try to get around security, rate limits or access controls; do not upload or report content in bad faith.'],
      ['Artists', 'Artists who publish on LOOP also accept the Artist rights declaration. LOOP may remove recordings that break it.'],
      ['Reports and moderation', 'Anyone can report a song, artist, album or account. LOOP Admins review reports and may hide, suspend or take down content, or suspend accounts, and record why.'],
      ['Ending your account', 'You can delete your account in Settings. Accounts with artist uploads or rights records are anonymised instead, so legal records stay intact without your personal details.'],
      ['Changes', 'If these terms change materially, LOOP asks you to accept the new version.'],
    ],
  },
  privacy: {
    title: 'Privacy notice', version: 'LOOP-PRIVACY-2026-11', sections: [
      ['What LOOP stores', 'Your username, email, display name and password (as a one-way hash); the moods you ask for; the songs you play, like, rate, save or hide; your searches; your preferences; and, for sign-in security, a keyed hash of your IP address and your browser name.'],
      ['Why', 'To recommend music that fits your mood and taste, keep your account secure, prevent abuse, and keep the legal records needed for published recordings and reports.'],
      ['How long', 'Search history is kept for 90 days and unsaved mood mixes for 60 days by default (an Admin can shorten or lengthen these). Listening history stays until you clear it or delete your account.'],
      ['Your controls', 'In Settings → Privacy and data you can see what is stored, clear your search or listening history, download everything LOOP holds about you, and delete your account.'],
      ['Who sees it', 'Only you and LOOP Admins with a support or moderation reason. LOOP does not sell personal data or send it to music services. Email, when enabled, is sent through a transactional email provider.'],
      ['Contact', 'For privacy requests or copyright notices, use “Report” on the content concerned, or contact the LOOP team.'],
    ],
  },
  'artist-terms': {
    title: 'Artist rights declaration', version: 'LOOP-ARTIST-RIGHTS-1.0', sections: [
      ['Your rights', 'You only upload recordings you own, or are licensed to distribute, for both the composition and the sound recording, in the territories you declare.'],
      ['Licensed material', 'If the composition or recording is licensed, you give a link to the licence or written permission. A LOOP Admin checks it before approval.'],
      ['Checks before release', 'Every upload is held privately, scanned for malware and checked as valid audio. An Admin listens to it and reviews the details. Nothing is public before an Admin publishes it.'],
      ['Your profile', 'Your artist name is reviewed when you apply and whenever you change it, so nobody can present themselves as another artist.'],
      ['Withdrawal and takedown', 'You can withdraw a recording at any time; playback stops at once. LOOP can take a recording down after a rights report. Withdrawn and removed files are kept privately for dispute handling and never played.'],
      ['Records', 'LOOP keeps your rights declaration, its version, the time you accepted it and a keyed hash of your network address.'],
    ],
  },
};

export default function Legal({ doc }) {
  const { user } = useAuth();
  const d = DOCS[doc] || DOCS.terms;
  return (
    <div className="public">
      <header className="public-top"><Link className="brand" to={user ? '/discover' : '/'}><Mark /><span className="brand-word">loop</span></Link></header>
      <main className="public-main" id="main">
        <article className="legal" style={{ maxWidth: 'var(--measure)', display: 'grid', gap: 'var(--s4)' }}>
          <h1 className="h1">{d.title}</h1>
          <p className="small muted">Version {d.version}</p>
          {d.sections.map(([h, body]) => <section key={h}><h2 className="h3">{h}</h2><p>{body}</p></section>)}
          <p className="small"><Link to="/terms">Terms of use</Link> · <Link to="/privacy">Privacy notice</Link> · <Link to="/artist-terms">Artist rights declaration</Link></p>
        </article>
      </main>
    </div>
  );
}
