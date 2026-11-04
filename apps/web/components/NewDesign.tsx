'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { TEMPLATES, TREE_POSITIONS, buildingOuterRect, formatLength, parseLength, parseOperation, startDesign, type BuildingModel, type Compass } from '@ds/core';

const SIDES: Compass[] = ['north', 'south', 'east', 'west'];

interface TreeRow {
  label: string;
  position: string;
}

/** Small line drawing of a template's walls. */
function Thumb({ model }: { model: BuildingModel }) {
  const r = buildingOuterRect(model);
  const pad = 600;
  return (
    <svg className="tpl-thumb" viewBox={`${r.x0 - pad} ${r.y0 - pad} ${r.x1 - r.x0 + pad * 2} ${r.y1 - r.y0 + pad * 2}`} aria-hidden="true">
      {model.walls.map((w) => (
        <line key={w.id} x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} strokeWidth={Math.max(w.thickness, 160)} strokeLinecap="square" />
      ))}
    </svg>
  );
}

export default function NewDesign({ onCreate, busy }: { onCreate: (body: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const models = useMemo(() => Object.fromEntries(TEMPLATES.map((t) => [t.id, t.build()])), []);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('auto');
  const [withPlot, setWithPlot] = useState(true);
  // Default plot: 60' east–west × 40' north–south (edit freely).
  const [ew, setEw] = useState("60'");
  const [ns, setNs] = useState("40'");
  const [setbacks, setSetbacks] = useState<Record<Compass, string>>({ north: '', south: '', east: '', west: '' });
  const [access, setAccess] = useState({ side: 'none', kind: 'passage', width: '' });
  const [trees, setTrees] = useState<TreeRow[]>([]);
  const [error, setError] = useState('');
  const [bedrooms, setBedrooms] = useState(0); // 0 = decide from the plinth
  const [toilets, setToilets] = useState(0); // 0 = as the layout comes
  const [core, setCore] = useState<'' | 'both' | 'stair' | 'none'>(''); // '' = as the layout comes

  function len(label: string, v: string, allowEmpty = false): string | null {
    const t = v.trim();
    if (!t) {
      if (allowEmpty) return null;
      throw new Error(`${label} is needed.`);
    }
    try {
      parseLength(t);
    } catch {
      throw new Error(`${label}: "${t}" isn't a length. Use forms like 40', 12'6", 1500 mm.`);
    }
    return t;
  }

  function buildSiteOps() {
      const siteOps: { op: string; args: Record<string, unknown> }[] = [];
      if (withPlot) {
        siteOps.push({ op: 'set_plot', args: { eastWest: len('Plot east–west', ew), northSouth: len('Plot north–south', ns) } });
        for (const c of SIDES) {
          const v = len(`${c} setback`, setbacks[c], true);
          if (v) siteOps.push({ op: 'set_setback', args: { side: c, distance: v } });
        }
        if (access.side !== 'none') {
          const w = len('Road / passage width', access.width, true);
          siteOps.push({ op: 'set_access', args: { side: access.side, kind: access.kind, ...(w ? { width: w } : {}) } });
        }
        for (const t of trees) {
          if (t.label.trim()) siteOps.push({ op: 'add_tree', args: { label: t.label.trim(), position: t.position, keep: true } });
        }
      }
      return siteOps;
  }

  const counts = () => ({ ...(template === 'auto' && bedrooms ? { bedrooms } : {}), ...(toilets ? { toilets } : {}), ...(core ? { core } : {}) });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const siteOps = buildSiteOps();
      if (!withPlot && template === 'auto' && !bedrooms) throw new Error('Pick a layout or the number of bedrooms, or enter the plot so one can be chosen for it.');
      await onCreate({ name: name.trim() || 'Untitled design', template, siteOps, ...counts() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the design.');
    }
  };

  /** Plinth (area inside the setbacks) from the current inputs, and the layout best fit would pick. */
  const plinth = useMemo(() => {
    if (!withPlot) return null;
    try {
      const W = parseLength(ew).mm;
      const D = parseLength(ns).mm;
      const sb = (c: Compass) => (setbacks[c].trim() ? parseLength(setbacks[c]).mm : 0);
      const pw = W - sb('east') - sb('west');
      const ph = D - sb('north') - sb('south');
      if (pw <= 0 || ph <= 0) return { text: 'The setbacks leave no room to build.', bad: true };
      const area = Math.round((pw * ph) / 92903.04);
      const head = `Plinth ${formatLength(pw, 'ft-in')} × ${formatLength(ph, 'ft-in')} (${area.toLocaleString('en-IN')} sq ft)`;
      try {
        // Same code the server runs, so the preview matches what gets created.
        const ops = buildSiteOps().map((o) => parseOperation(o.op, o.args));
        const r = startDesign(template, ops, 'preview', counts());
        const beds = r.model.rooms.filter((x) => x.kind === 'bedroom').length;
        const wcs = r.model.rooms.filter((x) => x.kind === 'toilet').length;
        const layout = r.notes[0]?.replace(/^Started from /, '').replace(/, chosen for .*$/, '') ?? '';
        const kinds = (r.model.cores ?? []).map((c) => c.kind);
        const coreText = kinds.includes('lift') ? ', stair + lift' : kinds.includes('stair') ? ', stair' : '';
        return { text: `${head} → ${layout}: ${beds} bedroom${beds === 1 ? '' : 's'}, ${wcs} toilet${wcs === 1 ? '' : 's'}${coreText}`, bad: false };
      } catch (err) {
        return { text: `${head}. ${err instanceof Error ? err.message : ''}`, bad: true };
      }
    } catch {
      return null;
    }
  }, [withPlot, ew, ns, setbacks, access, trees, template, bedrooms, toilets, core]);

  const tplSize = (id: string) => {
    const r = buildingOuterRect(models[id]!);
    return `${formatLength(r.x1 - r.x0, 'ft-in')} × ${formatLength(r.y1 - r.y0, 'ft-in')} outside`;
  };

  return (
    <form className="card new-design" onSubmit={submit}>
      <div className="card-title">New design</div>

      <label className="nd-label" htmlFor="nd-name">Name</label>
      <input id="nd-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ground floor – option 1" aria-label="Design name" maxLength={120} />

      <div className="nd-label">Start from</div>
      <div className="tpl-grid" role="radiogroup" aria-label="Starting layout">
        <button type="button" role="radio" aria-checked={template === 'auto'} className={`tpl-card auto ${template === 'auto' ? 'on' : ''}`} onClick={() => setTemplate('auto')}>
          <span className="tpl-auto-mark" aria-hidden="true">✦</span>
          <span className="tpl-name">Best fit for this plot</span>
          <span className="tpl-desc">Picks 1, 2 or 3 BHK from the plinth size and turns it to suit the plot&apos;s shape.</span>
        </button>
        {TEMPLATES.map((t) => (
          <button
            type="button"
            key={t.id}
            role="radio"
            aria-checked={template === t.id}
            className={`tpl-card ${template === t.id ? 'on' : ''}`}
            onClick={() => setTemplate(t.id)}
          >
            <Thumb model={models[t.id]!} />
            <span className="tpl-name">{t.name}</span>
            <span className="tpl-desc">{t.description}</span>
            <span className="tpl-size">{withPlot ? 'sized to your plinth' : `default ${tplSize(t.id)}`}</span>
          </button>
        ))}
      </div>

      <div className="nd-rooms">
        <div>
          <div className="nd-label">Bedrooms</div>
          <div className="chips" role="radiogroup" aria-label="Bedrooms">
            {[0, 1, 2, 3].map((n) => {
              const fixed = template !== 'auto';
              const on = fixed ? n === Number(template[0]) : bedrooms === n;
              return (
                <button type="button" key={n} role="radio" aria-checked={on} className={`chip ${on ? 'on' : ''}`} disabled={fixed} onClick={() => setBedrooms(n)}>
                  {n === 0 ? 'Best fit' : n}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="nd-label">Toilets</div>
          <div className="chips" role="radiogroup" aria-label="Toilets">
            {[0, 1, 2, 3, 4].map((n) => (
              <button type="button" key={n} role="radio" aria-checked={toilets === n} className={`chip ${toilets === n ? 'on' : ''}`} onClick={() => setToilets(n)}>
                {n === 0 ? 'Standard' : n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="nd-label">Stair &amp; lift</div>
          <div className="chips" role="radiogroup" aria-label="Stair and lift">
            {([['', 'Standard'], ['both', 'Stair + lift'], ['stair', 'Stair only'], ['none', 'None']] as const).map(([v, label]) => (
              <button type="button" key={label} role="radio" aria-checked={core === v} className={`chip ${core === v ? 'on' : ''}`} onClick={() => setCore(v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="nd-hint">The stair and lift are walled units you can drag anywhere afterwards. Extra toilets are attached to bedrooms (largest first), then a common toilet off the living area. Fewer turns the common toilet into a store.</p>
      </div>

      <label className="nd-check">
        <input type="checkbox" checked={withPlot} onChange={(e) => setWithPlot(e.target.checked)} /> Enter the plot details now
      </label>

      {withPlot && (
        <div className="nd-plot">
          <div className="field-grid two">
            <label>Plot east–west<input value={ew} onChange={(e) => setEw(e.target.value)} placeholder="60'" aria-label="Plot east–west" /></label>
            <label>Plot north–south<input value={ns} onChange={(e) => setNs(e.target.value)} placeholder="40'" aria-label="Plot north–south" /></label>
          </div>
          <div className="nd-sub">Setbacks (leave blank for none)</div>
          <div className="field-grid four">
            {SIDES.map((c) => (
              <label key={c}>
                {c[0]!.toUpperCase() + c.slice(1)}
                <input value={setbacks[c]} onChange={(e) => setSetbacks((s) => ({ ...s, [c]: e.target.value }))} placeholder="5'" aria-label={`${c} setback`} />
              </label>
            ))}
          </div>
          <div className="nd-sub">Road or access passage</div>
          <div className="field-grid three">
            <label>
              Side
              <select value={access.side} onChange={(e) => setAccess({ ...access, side: e.target.value })} aria-label="Access side">
                <option value="none">None</option>
                {SIDES.map((c) => (
                  <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>
                ))}
              </select>
            </label>
            <label>
              Type
              <select value={access.kind} onChange={(e) => setAccess({ ...access, kind: e.target.value })} disabled={access.side === 'none'} aria-label="Access type">
                <option value="passage">Passage (inside plot)</option>
                <option value="road">Road</option>
              </select>
            </label>
            <label>
              Width
              <input value={access.width} onChange={(e) => setAccess({ ...access, width: e.target.value })} disabled={access.side === 'none'} placeholder="= setback" aria-label="Access width" />
            </label>
          </div>
          <div className="nd-sub">Trees to keep</div>
          {trees.map((t, i) => (
            <div key={i} className="field-grid tree-row">
              <input value={t.label} onChange={(e) => setTrees((ts) => ts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="Mango tree" aria-label={`Tree ${i + 1} name`} />
              <select value={t.position} onChange={(e) => setTrees((ts) => ts.map((x, j) => (j === i ? { ...x, position: e.target.value } : x)))} aria-label={`Tree ${i + 1} position`}>
                {TREE_POSITIONS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <button type="button" className="linkish danger-text" onClick={() => setTrees((ts) => ts.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          {trees.length < 6 && (
            <button type="button" className="btn-secondary btn-sm" onClick={() => setTrees((ts) => [...ts, { label: '', position: 'north-west corner' }])}>+ Add a tree</button>
          )}
          {plinth && <p className={`nd-plinth ${plinth.bad ? 'bad' : ''}`}>{plinth.text}</p>}
          <p className="card-desc">The layout is sized to fill the plinth (the area inside the setbacks). You can change rooms and sizes afterwards.</p>
        </div>
      )}

      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn-primary nd-create" disabled={busy}>{busy ? 'Creating…' : 'Create design'}</button>
    </form>
  );
}
