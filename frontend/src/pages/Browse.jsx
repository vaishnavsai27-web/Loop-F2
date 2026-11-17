import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useQuery, useRouter } from '../lib/router';
import { useMoods } from '../lib/moods';
import { usePlayer } from '../lib/player';
import SongRow from '../components/SongRow';
import { Empty, ErrorState, Loading, PageHead, Pager } from '../components/ui';

/** Browse the catalogue by mood, genre or language — for when you would rather pick than describe. */
export default function Browse() {
  const query = useQuery();
  const { navigate } = useRouter();
  const { moods } = useMoods();
  const player = usePlayer();
  const [genres, setGenres] = useState([]);
  const [languages, setLanguages] = useState([]);
  const [state, setState] = useState({ data: null, error: null, loading: false });
  const f = { moodId: query.get('mood') || '', genreId: query.get('genre') || '', languageId: query.get('language') || '', sort: query.get('sort') || 'popular', page: Number(query.get('page') || 1) };

  const [filterError, setFilterError] = useState(null);
  useEffect(() => { api.genres().then(setGenres).catch(setFilterError); api.languages().then(setLanguages).catch(setFilterError); }, []);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.browse({ moodId: f.moodId, genreId: f.genreId, languageId: f.languageId, sort: f.sort, page: f.page, pageSize: 24 })
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((error) => live && setState({ data: null, error, loading: false }));
    return () => { live = false; };
  }, [f.moodId, f.genreId, f.languageId, f.sort, f.page]);   // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k, v) => {
    const p = new URLSearchParams({ mood: f.moodId, genre: f.genreId, language: f.languageId, sort: f.sort, [k]: v, page: k === 'page' ? v : 1 });
    [...p.keys()].forEach((key) => { if (!p.get(key)) p.delete(key); });
    navigate(`/browse?${p.toString()}`, { replace: true });
  };
  const songs = state.data?.songs || [];
  return (
    <div className="page page-narrow">
      <PageHead title="Browse" back={['/search', 'Search']}>Pick a mood, genre or language to see what LOOP has.</PageHead>
      <div className="form-row">
        <label className="field"><span>Mood</span><select className="select" value={f.moodId} onChange={(e) => set('mood', e.target.value)}>
          <option value="">Any mood</option>{moods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label className="field"><span>Genre</span><select className="select" value={f.genreId} onChange={(e) => set('genre', e.target.value)}>
          <option value="">Any genre</option>{genres.map((g) => <option key={g.id} value={g.id}>{g.path || g.name}</option>)}</select></label>
        <label className="field"><span>Language</span><select className="select" value={f.languageId} onChange={(e) => set('language', e.target.value)}>
          <option value="">Any language</option><option value="0">Instrumental</option>{languages.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label className="field"><span>Order</span><select className="select" value={f.sort} onChange={(e) => set('sort', e.target.value)}>
          <option value="popular">Most popular</option><option value="newest">Newest</option><option value="title">Title A–Z</option></select></label>
      </div>
      {filterError && <p className="notice notice-warn">Some filters could not load ({filterError.message}). Reload to try again.</p>}
      {state.loading && <Loading label="Loading songs" />}
      <ErrorState error={state.error} />
      {state.data && songs.length === 0 && <Empty title="Nothing here yet">Try another mood, genre or language.</Empty>}
      {songs.length > 0 && (
        <>
          <div className="composer-actions"><button type="button" className="btn btn-sm btn-primary" onClick={() => player.playAll(songs, { origin: 'SEARCH' })}>Play all</button></div>
          <ul className="songs">{songs.map((s) => <SongRow key={s.id} song={s} origin="SEARCH" showWhy={false} onPlay={() => player.playAll(songs, { origin: 'SEARCH', from: songs.indexOf(s) })} />)}</ul>
          <Pager page={state.data.page} pageSize={state.data.pageSize} total={state.data.total} noun="songs" onPage={(p) => set('page', p)} />
        </>
      )}
    </div>
  );
}
