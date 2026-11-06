'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { Issue } from '@ds/core';
import {
  TREE_POSITIONS,
  compassToSide,
  eastWestIsPlanX,
  formatLength,
  parseLength,
  type BuildingModel,
  type Compass,
} from '@ds/core';

export interface OpInput {
  op: string;
  args: Record<string, unknown>;
}

export interface ApplyResult {
  error?: string;
  summary?: string;
  assumptions?: string[];
  newIssues?: Issue[];
  revision?: number | null;
}

interface Props {
  model: BuildingModel;
  busy: boolean;
  /** Apply typed operations as one saved revision. */
  apply: (request: string, ops: OpInput[]) => Promise<ApplyResult>;
  revLabel: (n: number) => string;
}

const SIDES: Compass[] = ['north', 'south', 'east', 'west'];
type AccessKind = 'none' | 'road' | 'passage';

export default function SitePanel({ model, busy, apply, revLabel }: Props) {
  const site = model.site;
  const u = model.displayUnits;
  const fmt = (mm: number) => formatLength(mm, u);
  const sideOf = (c: Compass) => compassToSide(c, model.northAngle);

  // Default plot when none is set yet: 60' east–west × 40' north–south.
  const [ew, setEw] = useState("60'");
  const [ns, setNs] = useState("40'");
  const [setbacks, setSetbacks] = useState<Record<Compass, string>>({ north: '', south: '', east: '', west: '' });
  const [access, setAccess] = useState<Record<Compass, { kind: AccessKind; width: string }>>({
    north: { kind: 'none', width: '' },
    south: { kind: 'none', width: '' },
    east: { kind: 'none', width: '' },
    west: { kind: 'none', width: '' },
  });
  const [tree, setTree] = useState({ label: '', position: 'north-west corner', inset: "4'", canopy: "20'" });
  const [editTree, setEditTree] = useState<{ id: string; label: string; position: string; inset: string; canopy: string; keep: boolean } | null>(null);
  const [place, setPlace] = useState({ northSouth: 'centre', eastWest: 'centre' });
  const [error, setError] = useState('');
  const [result, setResult] = useState<ApplyResult | null>(null);

  // Refill the form whenever the saved model changes (chat edits, undo, restore).
  useEffect(() => {
    if (site) {
      const xEW = eastWestIsPlanX(model.northAngle);
      setEw(fmt(xEW ? site.plot.width : site.plot.depth));
      setNs(fmt(xEW ? site.plot.depth : site.plot.width));
      setSetbacks(Object.fromEntries(SIDES.map((c) => [c, fmt(site.setbacks[sideOf(c)])])) as Record<Compass, string>);
      setAccess(
        Object.fromEntries(
          SIDES.map((c) => {
            const a = site.access.find((x) => x.side === sideOf(c));
            return [c, a ? { kind: a.kind, width: fmt(a.width) } : { kind: 'none', width: '' }];
          }),
        ) as Record<Compass, { kind: AccessKind; width: string }>,
      );
    }
  }, [JSON.stringify(model.site), model.northAngle]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(request: string, ops: OpInput[]) {
    setError('');
    setResult(null);
    if (ops.length === 0) {
      setError('Nothing changed.');
      return;
    }
    const r = await apply(request, ops);
    if (r.error) setError(r.error);
    else setResult(r);
  }

  /** Validate a length field before sending, so typos are caught here. */
  function check(label: string, v: string): string {
    try {
      parseLength(v);
      return v.trim();
    } catch {
      throw new Error(`${label}: "${v}" isn't a length. Use forms like 12', 5'6", 1500 mm.`);
    }
  }

  const guard = (fn: () => Promise<void>) => (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    fn().catch((err: Error) => setError(err.message));
  };

  const savePlot = guard(async () => {
    const a = check('East–west', ew);
    const b = check('North–south', ns);
    await run(`Plot ${a} (E–W) × ${b} (N–S)`, [{ op: 'set_plot', args: { eastWest: a, northSouth: b } }]);
  });

  const saveSetbacks = guard(async () => {
    const ops: OpInput[] = [];
    for (const c of SIDES) {
      const v = check(`${c} setback`, setbacks[c] || '0');
      const mm = parseLength(v).mm;
      if (!site || Math.abs(mm - site.setbacks[sideOf(c)]) > 1) ops.push({ op: 'set_setback', args: { side: c, distance: v } });
    }
    await run('Update setbacks', ops);
  });

  const saveAccess = guard(async () => {
    const ops: OpInput[] = [];
    for (const c of SIDES) {
      const want = access[c];
      const have = site?.access.find((x) => x.side === sideOf(c));
      if (want.kind === 'none') {
        if (have) ops.push({ op: 'remove_access', args: { side: c } });
        continue;
      }
      const width = want.width.trim() ? check(`${c} ${want.kind} width`, want.width) : undefined;
      const same = have && have.kind === want.kind && (!width || Math.abs(parseLength(width).mm - have.width) <= 1);
      if (!same) ops.push({ op: 'set_access', args: { side: c, kind: want.kind, ...(width ? { width } : {}) } });
    }
    await run('Update road / passage', ops);
  });

  const addTree = guard(async () => {
    if (!tree.label.trim()) throw new Error('Name the tree, e.g. "Mango tree".');
    const inset = check('Distance from boundary', tree.inset);
    const canopy = check('Canopy', tree.canopy);
    await run(`Add ${tree.label.trim()}`, [{ op: 'add_tree', args: { label: tree.label.trim(), position: tree.position, inset, canopy, keep: true } }]);
    setTree((t) => ({ ...t, label: '' }));
  });

  const saveTree = guard(async () => {
    if (!editTree || !site) return;
    const t = site.trees.find((x) => x.id === editTree.id);
    if (!t) throw new Error('That tree no longer exists.');
    const args: Record<string, unknown> = { treeId: t.id };
    if (!editTree.label.trim()) throw new Error('Give the tree a name.');
    if (editTree.label.trim() !== t.label) args.label = editTree.label.trim();
    const inset = check('Trunk from boundary', editTree.inset);
    const canopy = check('Canopy across', editTree.canopy);
    const insetChanged = Math.abs(parseLength(inset).mm - (t.inset ?? 1219)) > 1;
    if (!editTree.position && insetChanged) throw new Error('Choose where the tree is ("Where") to change its distance from the boundary.');
    if (editTree.position && (editTree.position !== t.position || insetChanged)) {
      args.position = editTree.position;
      args.inset = inset;
    }
    if (Math.abs(parseLength(canopy).mm - t.canopyRadius * 2) > 2) args.canopy = canopy;
    if (editTree.keep !== t.keep) args.keep = editTree.keep;
    if (Object.keys(args).length === 1) throw new Error('Nothing changed.');
    await run(`Edit ${t.label}`, [{ op: 'update_tree', args }]);
    setEditTree(null);
  });

  const placeBuilding = guard(async () => {
    await run('Position building', [{ op: 'place_building', args: place }]);
  });

  return (
    <div className="site-panel">
      <p className="card-desc">
        Enter lengths as you&apos;d write them: 40&apos;, 12&apos;6&quot;, 1500 mm. Setbacks are measured from the plot boundary to the building&apos;s outer wall face.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {result && (
        <div className="site-result" role="status">
          <div>{result.summary}</div>
          {result.assumptions && result.assumptions.length > 0 && <div className="assume">Assumed: {result.assumptions.join(' ')}</div>}
          {result.newIssues && result.newIssues.length > 0 ? (
            <div className="delta warn">{result.newIssues.map((x) => `⚠ ${x.message}`).join(' ')}</div>
          ) : (
            <div className="delta">✓ No new problems</div>
          )}
          {result.revision ? <div className="mode">Saved as Rev {revLabel(result.revision)}</div> : null}
        </div>
      )}

      <form className="site-section" onSubmit={savePlot}>
        <div className="site-head">Plot size</div>
        <div className="field-grid two">
          <label>East–west<input value={ew} onChange={(e) => setEw(e.target.value)} placeholder="60'" inputMode="text" /></label>
          <label>North–south<input value={ns} onChange={(e) => setNs(e.target.value)} placeholder="40'" /></label>
        </div>
        <button className="btn-primary btn-sm" disabled={busy || !ew || !ns}>{site ? 'Update plot' : 'Set plot'}</button>
      </form>

      {site && (
        <>
          <form className="site-section" onSubmit={saveSetbacks}>
            <div className="site-head">Setbacks (required open space)</div>
            <div className="field-grid four">
              {SIDES.map((c) => (
                <label key={c}>
                  {c[0]!.toUpperCase() + c.slice(1)}
                  <input value={setbacks[c]} onChange={(e) => setSetbacks((s) => ({ ...s, [c]: e.target.value }))} placeholder="5'" />
                </label>
              ))}
            </div>
            <button className="btn-primary btn-sm" disabled={busy}>Save setbacks</button>
          </form>

          <form className="site-section" onSubmit={saveAccess}>
            <div className="site-head">Road / access passage</div>
            {SIDES.map((c) => (
              <div key={c} className="access-row">
                <span className="access-side">{c[0]!.toUpperCase() + c.slice(1)}</span>
                <select value={access[c].kind} onChange={(e) => setAccess((a) => ({ ...a, [c]: { ...a[c], kind: e.target.value as AccessKind } }))} aria-label={`${c} access`}>
                  <option value="none">None</option>
                  <option value="road">Road</option>
                  <option value="passage">Passage (inside plot)</option>
                </select>
                {access[c].kind !== 'none' && (
                  <input value={access[c].width} onChange={(e) => setAccess((a) => ({ ...a, [c]: { ...a[c], width: e.target.value } }))} placeholder="width" aria-label={`${c} width`} />
                )}
              </div>
            ))}
            <button className="btn-primary btn-sm" disabled={busy}>Save access</button>
          </form>

          <div className="site-section">
            <div className="site-head">Trees</div>
            {site.trees.length === 0 ? (
              <p className="card-desc">None yet.</p>
            ) : (
              <ul className="tree-list">
                {site.trees.map((t) =>
                  editTree?.id === t.id ? (
                    <li key={t.id} className="tree-edit">
                      <form onSubmit={saveTree} className="tree-form">
                        <div className="field-grid two">
                          <label>Tree<input value={editTree.label} onChange={(e) => setEditTree({ ...editTree, label: e.target.value })} aria-label="Tree name" /></label>
                          <label>
                            Where
                            <select value={editTree.position} onChange={(e) => setEditTree({ ...editTree, position: e.target.value })} aria-label="Tree position">
                              {!t.position && <option value="">Keep where it is</option>}
                              {TREE_POSITIONS.map((p) => (
                                <option key={p} value={p}>{p}</option>
                              ))}
                            </select>
                          </label>
                          <label>Trunk from boundary<input value={editTree.inset} onChange={(e) => setEditTree({ ...editTree, inset: e.target.value })} aria-label="Trunk from boundary" /></label>
                          <label>Canopy across<input value={editTree.canopy} onChange={(e) => setEditTree({ ...editTree, canopy: e.target.value })} aria-label="Canopy across" /></label>
                        </div>
                        <label className="nd-check">
                          <input type="checkbox" checked={editTree.keep} onChange={(e) => setEditTree({ ...editTree, keep: e.target.checked })} /> Must be kept (building stays clear of the trunk)
                        </label>
                        <div className="row wrap">
                          <button className="btn-primary btn-sm" disabled={busy}>Save tree</button>
                          <button type="button" className="btn-secondary btn-sm" onClick={() => setEditTree(null)}>Cancel</button>
                        </div>
                      </form>
                    </li>
                  ) : (
                    <li key={t.id}>
                      <span>🌳 {t.label}{t.keep ? '' : ' (may be removed)'}</span>
                      <span className="row">
                        <button
                          className="linkish"
                          disabled={busy}
                          onClick={() =>
                            setEditTree({
                              id: t.id,
                              label: t.label,
                              position: t.position ?? '',
                              inset: fmt(t.inset ?? 1219),
                              canopy: fmt(t.canopyRadius * 2),
                              keep: t.keep,
                            })
                          }
                        >
                          Edit
                        </button>
                        <button
                          className="linkish danger-text"
                          disabled={busy}
                          onClick={() => void run(`Remove ${t.label}`, [{ op: 'remove_tree', args: { treeId: t.id } }])}
                        >
                          Remove
                        </button>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
            <form onSubmit={addTree} className="tree-form">
              <div className="field-grid two">
                <label>Tree<input value={tree.label} onChange={(e) => setTree({ ...tree, label: e.target.value })} placeholder="Mango tree" /></label>
                <label>
                  Where
                  <select value={tree.position} onChange={(e) => setTree({ ...tree, position: e.target.value })}>
                    {TREE_POSITIONS.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label>Trunk from boundary<input value={tree.inset} onChange={(e) => setTree({ ...tree, inset: e.target.value })} /></label>
                <label>Canopy across<input value={tree.canopy} onChange={(e) => setTree({ ...tree, canopy: e.target.value })} /></label>
              </div>
              <button className="btn-secondary btn-sm" disabled={busy}>Add tree</button>
            </form>
          </div>

          <form className="site-section" onSubmit={placeBuilding}>
            <div className="site-head">Building position</div>
            <div className="field-grid two">
              <label>
                North–south
                <select value={place.northSouth} onChange={(e) => setPlace({ ...place, northSouth: e.target.value })}>
                  <option value="north">Against north setback</option>
                  <option value="centre">Centred</option>
                  <option value="south">Against south setback</option>
                </select>
              </label>
              <label>
                East–west
                <select value={place.eastWest} onChange={(e) => setPlace({ ...place, eastWest: e.target.value })}>
                  <option value="west">Against west setback</option>
                  <option value="centre">Centred</option>
                  <option value="east">Against east setback</option>
                </select>
              </label>
            </div>
            <div className="row wrap">
              <button className="btn-primary btn-sm" disabled={busy}>Place building</button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm('Resize the whole layout so its outer walls fill the plinth (inside the setbacks)? Rooms scale in proportion; you can undo.')) return;
                  void run('Fit layout to plinth', [{ op: 'fit_to_buildable', args: {} }]);
                }}
              >
                Fit layout to plinth
              </button>
            </div>
            <p className="card-desc">For finer moves, ask the assistant: “move the building 1 foot east”. After changing the plot or setbacks, use Fit layout to plinth to resize the layout to match.</p>
          </form>
        </>
      )}
    </div>
  );
}
