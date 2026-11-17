// Building blocks shared by the Admin console sections.
import { useState } from 'react';
import { useAsync } from '../../lib/useAsync';
import { useQuery, useRouter } from '../../lib/router';
import { ErrorState, Field, Loading } from '../../components/ui';

export function useLoad(fn, deps) {
  const state = useAsync(fn, deps);
  const guard = state.loading && !state.data ? <Loading /> : state.error && !state.data ? <ErrorState error={state.error} onRetry={state.reload} /> : null;
  return { ...state, guard };
}

/** List filters kept in the address bar, so a filtered list survives refresh and can be shared. */
export function useFilters(defaults) {
  const query = useQuery();
  const { path, navigate } = useRouter();
  const values = Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, query.get(k) ?? d]));
  values.page = Number(query.get('page') || 1);
  const set = (changes) => {
    const next = { ...values, ...changes, page: changes.page ?? 1 };
    const p = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined && !(k === 'page' && Number(v) === 1) && v !== defaults[k]) p.set(k, v); });
    navigate(`${path}${p.toString() ? `?${p}` : ''}`, { replace: true });
  };
  return [values, set];
}

/** Search box that applies on submit (not on every keystroke). */
export function SearchBox({ value, onSearch, label, placeholder }) {
  const [q, setQ] = useState(value || '');
  return (
    <form role="search" className="search-row" onSubmit={(e) => { e.preventDefault(); onSearch(q.trim()); }}>
      <label className="sr-only" htmlFor={`s-${label}`}>{label}</label>
      <input id={`s-${label}`} className="input" type="search" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      <button className="btn">Search</button>
    </form>
  );
}

export function Select({ label, value, onChange, options, all = 'All' }) {
  return (
    <label className="field field-inline"><span>{label}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {all !== null && <option value="">{all}</option>}
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  );
}

export const FEATURES = [['energy', 'Energy'], ['valence', 'Positivity'], ['danceability', 'Danceability'], ['acousticness', 'Acousticness'],
  ['instrumentalness', 'Instrumentalness'], ['speechiness', 'Speechiness']];
export const blankProfile = () => ({ energy: '0.5', valence: '0.5', danceability: '0.5', acousticness: '0.5', instrumentalness: '0.2', speechiness: '0.05', tempo_bpm: '110' });
export const profileFrom = (f) => (f ? Object.fromEntries([...FEATURES.map(([k]) => k), 'tempo_bpm'].map((k) => [k, String(f[k] ?? f[k === 'tempo_bpm' ? 'tempo' : k] ?? '')])) : blankProfile());
export const profileValue = (p) => Object.fromEntries([...FEATURES.map(([k]) => k), 'tempo_bpm'].map((k) => [k, Number(p[k])]));

/** The sound profile decides which moods a song gets and when it is recommended. */
export function SoundProfile({ value, onChange, legend = 'Sound profile' }) {
  return (
    <fieldset className="profile-fields">
      <legend>{legend} <span className="small muted">— each from 0 (none) to 1 (very)</span></legend>
      <div className="form-row">
        {FEATURES.map(([k, label]) => (
          <Field key={k} label={label}>
            <input className="input" type="number" min="0" max="1" step="0.01" required value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
          </Field>
        ))}
        <Field label="Tempo (BPM)"><input className="input" type="number" min="40" max="220" required value={value.tempo_bpm} onChange={(e) => onChange({ ...value, tempo_bpm: e.target.value })} /></Field>
      </div>
    </fieldset>
  );
}

export function History({ items }) {
  if (!items?.length) return <p className="small muted">No recorded changes yet.</p>;
  return (
    <ol className="timeline">
      {items.map((h) => (
        <li key={h.id}><span className="small"><strong>{h.action.replace(/_/g, ' ').toLowerCase()}</strong>{h.newValues?.reason ? ` — ${h.newValues.reason}` : h.newValues?.note ? ` — ${h.newValues.note}` : ''}</span>
          <span className="tiny muted">{h.actor} · {new Date(h.createdAt).toLocaleString()}</span></li>
      ))}
    </ol>
  );
}
