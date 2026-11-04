'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { TEMPLATES, TREE_POSITIONS, buildingOuterRect, formatLength, parseLength, type BuildingModel, type Compass } from '@ds/core';

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
  const [template, setTemplate] = useState('3bhk');
  const [withPlot, setWithPlot] = useState(true);
  const [ew, setEw] = useState('');
  const [ns, setNs] = useState('');
  const [setbacks, setSetbacks] = useState<Record<Compass, string>>({ north: '', south: '', east: '', west: '' });
  const [access, setAccess] = useState({ side: 'none', kind: 'passage', width: '' });
  const [trees, setTrees] = useState<TreeRow[]>([]);
  const [fit, setFit] = useState(true);
  const [error, setError] = useState('');

  function len(label: string, v: string, allowEmpty = false): string | null {
    const t = v.trim();
    if (!t) {
      if (allowEmpty) return null;
      throw new Error(`${label} is needed.`);
    }
    try {
      parseLength(t);
    } catch {
      throw new Error(`${label}: "${t}" isn't a length. Use forms like 62'6", 12', 1500 mm.`);
    }
    return t;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
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
      await onCreate({ name: name.trim() || 'Untitled design', template, siteOps, fit: withPlot && fit });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the design.');
    }
  };

  const tplSize = (id: string) => {
    const r = buildingOuterRect(models[id]!);
    return `${formatLength(r.x1 - r.x0, 'ft-in')} × ${formatLength(r.y1 - r.y0, 'ft-in')} outside`;
  };

  return (
    <form className="card new-design" onSubmit={submit}>
      <div className="card-title">New design</div>

      <label className="nd-label" htmlFor="nd-name">Name</label>
      <input id="nd-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vaidyas – first floor" aria-label="Design name" maxLength={120} />

      <div className="nd-label">Start from</div>
      <div className="tpl-grid" role="radiogroup" aria-label="Starting layout">
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
            <span className="tpl-size">{tplSize(t.id)}</span>
          </button>
        ))}
      </div>

      <label className="nd-check">
        <input type="checkbox" checked={withPlot} onChange={(e) => setWithPlot(e.target.checked)} /> Enter the plot details now
      </label>

      {withPlot && (
        <div className="nd-plot">
          <div className="field-grid two">
            <label>Plot east–west<input value={ew} onChange={(e) => setEw(e.target.value)} placeholder={'62\'6"'} aria-label="Plot east–west" /></label>
            <label>Plot north–south<input value={ns} onChange={(e) => setNs(e.target.value)} placeholder="52'" aria-label="Plot north–south" /></label>
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
          <label className="nd-check">
            <input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} /> Size the layout to fill the buildable area (inside the setbacks)
          </label>
        </div>
      )}

      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn-primary nd-create" disabled={busy}>{busy ? 'Creating…' : 'Create design'}</button>
    </form>
  );
}
