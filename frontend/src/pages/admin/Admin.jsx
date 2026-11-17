import Overview from './Overview';
import People from './People';
import Applications from './Applications';
import Artists from './Artists';
import Songs from './Songs';
import Albums from './Albums';
import Uploads from './Uploads';
import Reports from './Reports';
import LibraryAdmin from './LibraryAdmin';
import Audit from './Audit';
import AdminSettings from './AdminSettings';
import Health from './Health';

/** Admin console. Every request is re-authorised on the server by permission; the interface only follows it. */
const SECTIONS = { overview: Overview, users: People, applications: Applications, artists: Artists, songs: Songs, albums: Albums,
  uploads: Uploads, reports: Reports, library: LibraryAdmin, audit: Audit, settings: AdminSettings, health: Health,
  // older links
  catalogue: Songs, media: Uploads, permissions: Health };

export default function Admin({ section = 'overview', id = null }) {
  const View = SECTIONS[section] || Overview;
  return <div className="page admin-page"><View id={id} section={section} /></div>;
}
