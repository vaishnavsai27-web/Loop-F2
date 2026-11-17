import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Dialog, Empty, Field, PageHead, Tabs, useConfirm } from '../../components/ui';
import { useFilters, useLoad } from './common';

const WEIGHT_LABELS = { w_mood: 'Mood match', w_audio: 'Sound match', w_preference: 'The listener’s taste', w_recency: 'Recent listening',
  w_trend: 'Trending on LOOP', w_context: 'Listening context', w_regional: 'Language and region', w_exploration: 'Discovery of new music' };

export default function AdminSettings() {
  const [f, set] = useFilters({ tab: 'platform' });
  return (
    <>
      <PageHead title="Settings">Platform rules, how recommendations are weighted, and LOOP’s editorial picks.</PageHead>
      <Tabs label="Settings section" value={f.tab} onChange={(tab) => set({ tab })} items={[['platform', 'Platform'], ['recommender', 'Recommendations'], ['picks', 'Editorial picks']]} />
      {f.tab === 'platform' && <Platform />}
      {f.tab === 'recommender' && <Recommender />}
      {f.tab === 'picks' && <Picks />}
    </>
  );
}

function Platform() {
  const toast = useToast();
  const { data, guard, setData } = useLoad(() => api.admin.settings(), []);
  const [form, setForm] = useState({});
  useEffect(() => { if (data) setForm(Object.fromEntries(data.map((s) => [s.key, s.value]))); }, [data]);
  if (guard) return guard;
  const changed = data.filter((s) => form[s.key] !== s.value && !(s.type === 'int' && Number(form[s.key]) === s.value));
  async function save(e) {
    e.preventDefault();
    try { setData(await api.admin.updateSettings(Object.fromEntries(changed.map((s) => [s.key, s.type === 'int' ? Number(form[s.key]) : form[s.key]])))); toast('Settings saved'); }
    catch (err) { toast(err.message, 'error'); }
  }
  return (
    <form className="form section" onSubmit={save} style={{ maxWidth: 640 }}>
      {data.map((s) => (
        s.type === 'bool' ? <label key={s.key} className="check"><input type="checkbox" checked={!!form[s.key]} onChange={(e) => setForm({ ...form, [s.key]: e.target.checked })} />{s.label}</label>
          : s.type === 'text' ? <Field key={s.key} label={s.label}><textarea className="textarea" maxLength={300} value={form[s.key] ?? ''} onChange={(e) => setForm({ ...form, [s.key]: e.target.value })} /></Field>
            : <Field key={s.key} label={s.label} hint={`${s.min}–${s.max}`}><input className="input" type="number" min={s.min} max={s.max} value={form[s.key] ?? ''} onChange={(e) => setForm({ ...form, [s.key]: e.target.value })} /></Field>
      ))}
      <p className="small muted">Secrets and server addresses are not here on purpose; they stay in the hosting provider’s settings.</p>
      <div><button className="btn btn-primary" disabled={!changed.length}>Save {changed.length ? `${changed.length} change${changed.length > 1 ? 's' : ''}` : ''}</button></div>
    </form>
  );
}

function Recommender() {
  const toast = useToast();
  const [confirm, dialog] = useConfirm();
  const { data, guard, setData } = useLoad(() => api.admin.weights(), []);
  const [form, setForm] = useState({});
  useEffect(() => { if (data) setForm(Object.fromEntries(data.map((w) => [w.code, String(Number(w.value))]))); }, [data]);
  if (guard) return guard;
  if (!data.length) return <Empty title="No active recommender" />;
  const changed = data.filter((w) => Number(form[w.code]) !== Number(w.value));
  const save = () => confirm({ title: 'Change how LOOP recommends?', confirmLabel: 'Save weights', children: <p>New mood mixes use these weights at once. Earlier mixes keep the scores they were made with.</p>,
    onConfirm: async () => { setData(await api.admin.updateWeights(Object.fromEntries(changed.map((w) => [w.code, Number(form[w.code])])))); toast('Recommender weights saved'); } });
  return (
    <div className="section" style={{ maxWidth: 640 }}>
      <p className="small muted">{data[0].model} {data[0].version}. Each signal’s share of a song’s score. Higher means it matters more.</p>
      {data.filter((w) => WEIGHT_LABELS[w.code]).map((w) => (
        <Field key={w.code} label={WEIGHT_LABELS[w.code]} hint={w.description}>
          <div className="search-row"><input type="range" min={Number(w.min)} max={Number(w.max)} step="0.01" value={form[w.code] ?? 0} onChange={(e) => setForm({ ...form, [w.code]: e.target.value })} aria-label={WEIGHT_LABELS[w.code]} />
            <span className="num small" style={{ width: 48 }}>{Number(form[w.code] ?? 0).toFixed(2)}</span></div>
        </Field>
      ))}
      <div className="composer-actions"><button type="button" className="btn btn-primary" disabled={!changed.length} onClick={save}>Save weights</button>
        <button type="button" className="btn btn-quiet" disabled={!changed.length} onClick={() => setForm(Object.fromEntries(data.map((w) => [w.code, String(Number(w.value))])))}>Undo changes</button></div>
      {dialog}
    </div>
  );
}

function Picks() {
  const toast = useToast();
  const { data, guard, setData } = useLoad(() => api.admin.picks(), []);
  const [edit, setEdit] = useState(null);
  const [songs, setSongs] = useState([]);
  const [q, setQ] = useState('');
  async function find(e) { e.preventDefault(); const r = await api.admin.songs({ q, state: 'PUBLISHED', pageSize: 20 }); setSongs(r.songs); }
  if (guard) return guard;
  async function save(e) {
    e.preventDefault();
    const body = { songId: Number(edit.songId), headline: edit.headline.trim(), note: edit.note, sortOrder: Number(edit.sortOrder || 0), ...(edit.startsAt ? { startsAt: edit.startsAt } : {}), ...(edit.endsAt ? { endsAt: edit.endsAt } : {}) };
    try { setData(edit.id ? await api.admin.updatePick(edit.id, body) : await api.admin.createPick(body)); setEdit(null); toast('Pick saved'); } catch (err) { toast(err.message, 'error'); }
  }
  return (
    <div className="section">
      <p className="small muted">Picks appear on Discover for every listener, in order, between their start and end dates.</p>
      <div className="composer-actions"><button type="button" className="btn btn-primary btn-sm" onClick={() => setEdit({ songId: '', headline: '', note: '', sortOrder: data.length, startsAt: '', endsAt: '' })}>Add a pick</button></div>
      {data.length === 0 ? <Empty title="No picks yet" /> : (
        <ul className="list">{data.map((p) => (
          <li key={p.id} className="list-item"><div className="list-item-main"><span className="title">{p.headline}: {p.title} — {p.artist}</span>
            <span className="small muted">{p.startsAt ? `from ${String(p.startsAt).slice(0, 10)}` : 'from now'}{p.endsAt ? ` to ${String(p.endsAt).slice(0, 10)}` : ''}{p.status !== 'ACTIVE' ? ' — song not published, so hidden' : ''}</span></div>
            <span className="row-actions"><button type="button" className="btn btn-sm" onClick={() => setEdit({ ...p, startsAt: p.startsAt ? String(p.startsAt).slice(0, 10) : '', endsAt: p.endsAt ? String(p.endsAt).slice(0, 10) : '', note: p.note || '' })}>Edit</button>
              <button type="button" className="btn btn-sm btn-quiet" onClick={async () => { setData(await api.admin.deletePick(p.id)); toast('Pick removed'); }}>Remove</button></span></li>
        ))}</ul>
      )}
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit pick' : 'Add a pick'}>
        {edit && (
          <>
            <form className="search-row" onSubmit={find}><input className="input" aria-label="Find a published song" placeholder="Find a published song" value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn btn-sm">Find</button></form>
            <form className="form" onSubmit={save}>
              <Field label="Song"><select className="select" required value={edit.songId} onChange={(e) => setEdit({ ...edit, songId: e.target.value })}>
                <option value="">{songs.length ? 'Choose…' : 'Search first'}</option>{edit.id && <option value={edit.songId}>{edit.title}</option>}
                {songs.map((s) => <option key={s.id} value={s.id}>{s.title} — {s.artist.name}</option>)}</select></Field>
              <Field label="Headline"><input className="input" required maxLength={80} value={edit.headline} onChange={(e) => setEdit({ ...edit, headline: e.target.value })} placeholder="New this week" /></Field>
              <Field label="Note" hint="optional"><input className="input" maxLength={200} value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></Field>
              <div className="form-row">
                <Field label="From"><input className="input" type="date" value={edit.startsAt} onChange={(e) => setEdit({ ...edit, startsAt: e.target.value })} /></Field>
                <Field label="Until"><input className="input" type="date" value={edit.endsAt} onChange={(e) => setEdit({ ...edit, endsAt: e.target.value })} /></Field>
                <Field label="Order"><input className="input" type="number" min="0" max="999" value={edit.sortOrder} onChange={(e) => setEdit({ ...edit, sortOrder: e.target.value })} /></Field>
              </div>
              <div className="dialog-actions"><button type="button" className="btn btn-quiet" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary">Save</button></div>
            </form>
          </>
        )}
      </Dialog>
    </div>
  );
}
