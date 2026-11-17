import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import SongRow from '../components/SongRow';
import { Empty, ErrorState, Loading, PageHead } from '../components/ui';
import ReportButton from '../components/ReportButton';
import { usePlayer } from '../lib/player';

/** Artist and album pages: a heading and the songs LOOP holds for them. */
export default function Collection({ kind, id }) {
  const { data, error, loading, reload } = useAsync(() => (kind === 'artist' ? api.artist(id) : api.album(id)), [kind, id]);
  const player = usePlayer();
  if (loading && !data) return <Loading label={`Loading ${kind}`} />;
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  if (!data) return null;
  const title = kind === 'artist' ? data.name : data.title;
  const sub = kind === 'artist'
    ? [data.language, data.region, data.formedYear && `since ${data.formedYear}`].filter(Boolean).join(', ')
    : [data.artists?.map((a) => a.name).join(', '), data.releaseYear, data.language].filter(Boolean).join(', ');
  return (
    <div className="page page-narrow">
      <PageHead title={title} actions={<>
        {data.songs.some((s) => s.playback?.playable) && <button type="button" className="btn btn-primary btn-sm" onClick={() => player.playAll(data.songs, { origin: 'SEARCH' })}>Play all</button>}
        <ReportButton targetType={kind === 'artist' ? 'ARTIST' : 'ALBUM'} targetId={id} name={title} />
      </>}>{sub}</PageHead>
      {kind === 'album' && data.artworkUrl && <img src={data.artworkUrl} alt={`Cover of ${title}`} width="180" height="180" style={{ borderRadius: 14, objectFit: 'cover' }} />}
      {kind === 'album' && data.description && <p style={{ maxWidth: 'var(--measure)' }}>{data.description}</p>}
      {kind === 'artist' && data.bio && <p style={{ maxWidth: 'var(--measure)' }}>{data.bio}</p>}
      {data.songs.length === 0 ? <Empty title="No songs in LOOP yet" /> : (
        <ul className="songs">{data.songs.map((s, i) => <SongRow key={s.id} song={s} origin="SEARCH" showWhy={false} onPlay={() => player.playAll(data.songs, { origin: 'SEARCH', from: i })} />)}</ul>
      )}
    </div>
  );
}
