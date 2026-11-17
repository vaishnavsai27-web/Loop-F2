import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Dialog, Field, PageHead, Tabs, useConfirm } from '../../components/ui';
import { useFilters, useLoad } from './common';
import Icon from '../../components/Icon';

/** Moods, the words that map to them, genres, languages and listening contexts — all editable without SQL. */
export default function LibraryAdmin() {
  const [f, set] = useFilters({ tab: 'moods' });
  const { data, guard, setData } = useLoad(() => api.admin.taxonomy(), []);
  return (
    <>
      <PageHead title="Moods & genres">The vocabulary LOOP uses to understand moods and to organise music. Changes apply to new requests immediately.</PageHead>
      <Tabs label="Section" value={f.tab} onChange={(tab) => set({ tab })} items={[['moods', 'Moods'], ['words', 'Mood words'], ['genres', 'Genres'], ['languages', 'Languages'], ['contexts', 'Listening contexts']]} />
      {guard || (
        <>
          {f.tab === 'moods' && <Moods data={data} setData={setData} />}
          {f.tab === 'words' && <Words data={data} setData={setData} />}
          {f.tab === 'genres' && <Genres data={data} setData={setData} />}
          {f.tab === 'languages' && <Languages data={data} setData={setData} />}
          {f.tab === 'contexts' && <Contexts data={data} setData={setData} />}
        </>
      )}
    </>
  );
}

function useSave(setData) {
  const toast = useToast();
  return async (fn, msg) => { try { setData(await fn()); toast(msg); return true; } catch (err) { toast(err.message, 'error'); return false; } };
}

function Moods({ data, setData }) {
  const save = useSave(setData);
  const [edit, setEdit] = useState(null);
  const fields = [['energy', 'Energy'], ['valence', 'Positivity'], ['danceability', 'Danceability'], ['acousticness', 'Acousticness'], ['instrumentalness', 'Instrumentalness']];
  return (
    <>
      <div className="table-wrap"><table>
        <thead><tr><th>Mood</th><th>Description</th><th className="num">Songs</th><th><span className="sr-only">Edit</span></th></tr></thead>
        <tbody>{data.moods.map((m) => (
          <tr key={m.id}><td><span className="dot-swatch" style={{ background: m.color }} /> {m.emoji} <strong>{m.name}</strong></td><td className="small">{m.description}</td><td className="num">{m.songs}</td>
            <td><button type="button" className="btn btn-sm" onClick={() => setEdit({ ...m })}>Edit</button></td></tr>
        ))}</tbody>
      </table></div>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={`Edit ${edit?.name}`} wide>
        {edit && (
          <form className="form" onSubmit={async (e) => { e.preventDefault();
            if (await save(() => api.admin.updateMood(edit.id, { name: edit.name, emoji: edit.emoji, color: edit.color.toUpperCase(), description: edit.description,
              ...Object.fromEntries(fields.map(([k]) => [k, Number(edit[k])])), tempoMin: Number(edit.tempoMin), tempoMax: Number(edit.tempoMax) }), 'Mood saved')) setEdit(null); }}>
            <div className="form-row">
              <Field label="Name"><input className="input" required maxLength={30} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Emoji"><input className="input" required maxLength={8} value={edit.emoji} onChange={(e) => setEdit({ ...edit, emoji: e.target.value })} /></Field>
              <Field label="Colour"><input className="input" type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} /></Field>
            </div>
            <Field label="Description"><input className="input" required maxLength={200} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <p className="small muted">The ideal sound of this mood (0–1). Songs close to it are tagged with the mood.</p>
            <div className="form-row">{fields.map(([k, label]) => <Field key={k} label={label}><input className="input" type="number" min="0" max="1" step="0.01" value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>)}</div>
            <div className="form-row">
              <Field label="Slowest tempo (BPM)"><input className="input" type="number" min="40" max="220" value={edit.tempoMin} onChange={(e) => setEdit({ ...edit, tempoMin: e.target.value })} /></Field>
              <Field label="Fastest tempo (BPM)"><input className="input" type="number" min="40" max="220" value={edit.tempoMax} onChange={(e) => setEdit({ ...edit, tempoMax: e.target.value })} /></Field>
            </div>
            <div className="dialog-actions"><button type="button" className="btn btn-quiet" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary">Save</button></div>
          </form>
        )}
      </Dialog>
    </>
  );
}

function Words({ data, setData }) {
  const save = useSave(setData);
  const [form, setForm] = useState({ phrase: '', moodId: '', weight: '0.8' });
  const [filter, setFilter] = useState('');
  const [trial, setTrial] = useState('');
  const [heard, setHeard] = useState(null);
  useEffect(() => {
    if (trial.trim().length < 3) { setHeard(null); return undefined; }
    const t = setTimeout(() => api.parseMood(trial.trim()).then(setHeard).catch(() => setHeard(null)), 300);
    return () => clearTimeout(t);
  }, [trial]);
  const moodName = (id) => data.moods.find((m) => m.id === id)?.name;
  const list = data.keywords.filter((k) => (!filter || String(k.moodId) === filter));
  return (
    <div className="section split">
      <div>
        <form className="form panel" onSubmit={async (e) => { e.preventDefault(); if (await save(() => api.admin.addPhrase({ phrase: form.phrase.trim(), moodId: Number(form.moodId), weight: Number(form.weight) }), 'Word added')) setForm({ ...form, phrase: '' }); }}>
          <h2 className="h3">Teach LOOP a word</h2>
          <div className="form-row">
            <Field label="Word or phrase"><input className="input" required maxLength={60} value={form.phrase} onChange={(e) => setForm({ ...form, phrase: e.target.value })} placeholder="e.g. heartbroken" /></Field>
            <Field label="Means the mood"><select className="select" required value={form.moodId} onChange={(e) => setForm({ ...form, moodId: e.target.value })}><option value="">Choose…</option>{data.moods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
            <Field label="Strength" hint="0.1–1"><input className="input" type="number" min="0.1" max="1" step="0.05" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} /></Field>
          </div>
          <div><button className="btn btn-primary btn-sm">Add word</button></div>
        </form>
        <div className="panel form" style={{ marginTop: 16 }}>
          <h2 className="h3">Try a sentence</h2>
          <Field label="What a listener might type"><input className="input" value={trial} onChange={(e) => setTrial(e.target.value)} placeholder="I’ve had a long day and want something calm" /></Field>
          <p className="small" aria-live="polite">{heard ? (heard.moods.length ? <>LOOP hears <strong>{heard.moods.map((m) => m.name).join(', ')}</strong>{heard.context ? ` for ${heard.context.name.toLowerCase()}` : ''}</> : 'No mood recognised.') : ' '}</p>
        </div>
      </div>
      <div>
        <div className="section-head"><h2 className="h3">Known words ({list.length})</h2>
          <select className="select" aria-label="Filter by mood" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}><option value="">All moods</option>{data.moods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
        <ul className="list" style={{ maxHeight: 520, overflow: 'auto' }}>{list.map((k) => (
          <li key={k.id} className="list-item"><span className="small">“{k.phrase}” → {moodName(k.moodId)} <span className="muted">{Number(k.weight).toFixed(2)}</span></span>
            <button type="button" className="icon-btn" aria-label={`Remove “${k.phrase}”`} onClick={() => save(() => api.admin.removePhrase(k.id), 'Word removed')}><Icon name="x" size={16} /></button></li>
        ))}</ul>
      </div>
    </div>
  );
}

function Genres({ data, setData }) {
  const save = useSave(setData);
  const [confirm, dialog] = useConfirm();
  const [edit, setEdit] = useState(null);
  const blank = { id: null, name: '', parentId: '', color: '#3B47D6', description: '' };
  return (
    <>
      <div className="composer-actions"><button type="button" className="btn btn-primary btn-sm" onClick={() => setEdit(blank)}>Add a genre</button></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Genre</th><th>Part of</th><th className="num">Songs</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{data.genres.map((g) => (
          <tr key={g.id}><td><span className="dot-swatch" style={{ background: g.color }} /> <strong>{g.name}</strong><div className="tiny muted">{g.description}</div></td>
            <td className="small">{data.genres.find((p) => p.id === g.parentId)?.name || '—'}</td><td className="num">{g.songs}</td>
            <td className="row-actions"><button type="button" className="btn btn-sm" onClick={() => setEdit({ ...g, parentId: g.parentId || '', description: g.description || '' })}>Edit</button>
              <button type="button" className="btn btn-sm btn-quiet" disabled={g.songs > 0} onClick={() => confirm({ title: `Delete the genre “${g.name}”?`, danger: true, confirmLabel: 'Delete', onConfirm: async () => { setData(await api.admin.deleteGenre(g.id)); } })}>Delete</button></td></tr>
        ))}</tbody>
      </table></div>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : 'Add a genre'}>
        {edit && (
          <form className="form" onSubmit={async (e) => { e.preventDefault();
            const body = { name: edit.name.trim(), color: edit.color.toUpperCase(), description: edit.description, ...(edit.parentId ? { parentId: Number(edit.parentId) } : {}) };
            if (await save(() => (edit.id ? api.admin.updateGenre(edit.id, body) : api.admin.createGenre(body)), 'Genre saved')) setEdit(null); }}>
            <Field label="Name"><input className="input" required maxLength={40} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <div className="form-row">
              <Field label="Part of"><select className="select" value={edit.parentId} onChange={(e) => setEdit({ ...edit, parentId: e.target.value })}><option value="">Top level</option>{data.genres.filter((g) => g.id !== edit.id).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
              <Field label="Colour"><input className="input" type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} /></Field>
            </div>
            <Field label="Description"><input className="input" maxLength={200} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <div className="dialog-actions"><button type="button" className="btn btn-quiet" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary">Save</button></div>
          </form>
        )}
      </Dialog>
      {dialog}
    </>
  );
}

function Languages({ data, setData }) {
  const save = useSave(setData);
  const [edit, setEdit] = useState(null);
  return (
    <>
      <div className="composer-actions"><button type="button" className="btn btn-primary btn-sm" onClick={() => setEdit({ id: null, iso: '', name: '', nativeName: '', script: '' })}>Add a language</button></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Language</th><th>Code</th><th>Script</th><th className="num">Songs</th><th><span className="sr-only">Edit</span></th></tr></thead>
        <tbody>{data.languages.map((l) => (
          <tr key={l.id}><td><strong>{l.name}</strong> <span className="small muted">{l.nativeName}</span></td><td>{l.iso}</td><td className="small">{l.script}</td><td className="num">{l.songs}</td>
            <td><button type="button" className="btn btn-sm" onClick={() => setEdit({ ...l })}>Edit</button></td></tr>
        ))}</tbody>
      </table></div>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : 'Add a language'}>
        {edit && (
          <form className="form" onSubmit={async (e) => { e.preventDefault();
            const body = { iso: edit.iso.toLowerCase(), name: edit.name.trim(), nativeName: edit.nativeName.trim(), script: edit.script.trim() };
            if (await save(() => (edit.id ? api.admin.updateLanguage(edit.id, body) : api.admin.createLanguage(body)), 'Language saved')) setEdit(null); }}>
            <div className="form-row">
              <Field label="Name"><input className="input" required maxLength={40} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="ISO code" hint="2–3 letters"><input className="input" required maxLength={3} value={edit.iso} onChange={(e) => setEdit({ ...edit, iso: e.target.value })} /></Field>
            </div>
            <div className="form-row">
              <Field label="Name in the language"><input className="input" required maxLength={40} value={edit.nativeName} onChange={(e) => setEdit({ ...edit, nativeName: e.target.value })} /></Field>
              <Field label="Script"><input className="input" required maxLength={30} value={edit.script} onChange={(e) => setEdit({ ...edit, script: e.target.value })} /></Field>
            </div>
            <div className="dialog-actions"><button type="button" className="btn btn-quiet" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary">Save</button></div>
          </form>
        )}
      </Dialog>
    </>
  );
}

function Contexts({ data, setData }) {
  const save = useSave(setData);
  const [edit, setEdit] = useState(null);
  return (
    <>
      <ul className="list">{data.contexts.map((c) => (
        <li key={c.id} className="list-item"><div className="list-item-main"><span className="title">{c.emoji} {c.name}</span><span className="small muted">{c.description}</span>
          <span className="tiny muted">Words: {data.contextKeywords.filter((k) => k.contextId === c.id).map((k) => k.phrase).join(', ') || 'none'}</span></div>
          <button type="button" className="btn btn-sm" onClick={() => setEdit({ ...c, phrases: data.contextKeywords.filter((k) => k.contextId === c.id).map((k) => k.phrase).join(', ') })}>Edit</button></li>
      ))}</ul>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={`Edit ${edit?.name}`}>
        {edit && (
          <form className="form" onSubmit={async (e) => { e.preventDefault();
            if (await save(() => api.admin.updateContext(edit.id, { name: edit.name, emoji: edit.emoji, description: edit.description, phrases: edit.phrases.split(',').map((x) => x.trim()).filter((x) => x.length >= 2) }), 'Context saved')) setEdit(null); }}>
            <div className="form-row">
              <Field label="Name"><input className="input" required maxLength={40} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Emoji"><input className="input" required maxLength={8} value={edit.emoji} onChange={(e) => setEdit({ ...edit, emoji: e.target.value })} /></Field>
            </div>
            <Field label="Description"><input className="input" required maxLength={200} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <Field label="Words that mean this context" hint="separate with commas"><textarea className="textarea" value={edit.phrases} onChange={(e) => setEdit({ ...edit, phrases: e.target.value })} /></Field>
            <div className="dialog-actions"><button type="button" className="btn btn-quiet" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary">Save</button></div>
          </form>
        )}
      </Dialog>
    </>
  );
}
