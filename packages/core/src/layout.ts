/**
 * Starting a design from a plot: pick a standard layout that suits the plinth
 * (the area inside the setbacks), turn it 90° if the plinth is deep rather than
 * wide, and size it to fill the plinth exactly. The user can change it after.
 */
import { applyOperation, hasAttachedToilet } from './kernel';
import { roomClearRect } from './geometry';
import { ModelError, type BuildingModel, type Opening, type Room } from './model';
import { parseOperation, type Operation } from './ops';
import { buildableRect, buildingOuterRect } from './site';
import { TEMPLATES, getTemplate } from './templates';
import { formatLength } from './units';

const SQFT = 92903.04;
/** How far a standard layout may be stretched or squeezed on each axis. */
export const FIT_MIN = 0.5;
export const FIT_MAX = 2;

/** Turn a layout 90° clockwise on the plan (north stays up). */
export function rotateLayout(input: BuildingModel): BuildingModel {
  const m = structuredClone(input);
  const maxY = Math.max(...m.walls.flatMap((w) => [w.a.y, w.b.y]));
  const rot = (p: { x: number; y: number }) => ({ x: maxY - p.y, y: p.x });
  for (const w of m.walls) {
    w.a = rot(w.a);
    w.b = rot(w.b);
  }
  // Keep walls running east or south (a before b), flipping opening data to match.
  for (const w of m.walls) {
    const reversed = w.a.x > w.b.x || (w.a.x === w.b.x && w.a.y > w.b.y);
    if (!reversed) continue;
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    [w.a, w.b] = [w.b, w.a];
    for (const o of m.openings.filter((x: Opening) => x.wallId === w.id)) {
      o.offset = Math.round(len - o.offset);
      o.hinge = o.hinge === 'start' ? 'end' : 'start';
      o.swingSide = o.swingSide === 'left' ? 'right' : 'left';
    }
  }
  for (const r of m.rooms as Room[]) {
    const b = r.bounds;
    r.bounds = { top: b.left, right: b.top, bottom: b.right, left: b.bottom };
  }
  for (const f of m.furniture) {
    f.at = rot(f.at);
    f.rotation = (f.rotation + 90) % 360;
  }
  for (const c of m.cores ?? []) {
    c.at = rot(c.at);
    c.rotation = (c.rotation + 90) % 360;
  }
  return m;
}

export interface LayoutChoice {
  templateId: string;
  rotated: boolean;
  reason: string;
}

/** Choose a standard layout for a plinth of plinthW × plinthH (mm, outer faces). */
export function chooseLayout(plinthW: number, plinthH: number): LayoutChoice {
  const sqft = (plinthW * plinthH) / SQFT;
  const order = sqft < 750 ? ['1bhk', '2bhk', '3bhk'] : sqft < 1250 ? ['2bhk', '3bhk', '1bhk'] : ['3bhk', '2bhk', '1bhk'];
  for (const id of order) {
    const base = buildingOuterRect(getTemplate(id)!.build());
    const w = base.x1 - base.x0;
    const h = base.y1 - base.y0;
    const options = [
      { rotated: false, sx: plinthW / w, sy: plinthH / h },
      { rotated: true, sx: plinthW / h, sy: plinthH / w },
    ].filter((o) => o.sx >= FIT_MIN && o.sx <= FIT_MAX && o.sy >= FIT_MIN && o.sy <= FIT_MAX);
    if (options.length === 0) continue;
    const score = (o: { sx: number; sy: number }) => Math.abs(Math.log(o.sx)) + Math.abs(Math.log(o.sy)) + 2 * Math.abs(Math.log(o.sx / o.sy));
    const best = options.sort((a, b) => score(a) - score(b))[0]!;
    const name = TEMPLATES.find((t) => t.id === id)!.name;
    return {
      templateId: id,
      rotated: best.rotated,
      reason: `${name}${best.rotated ? ', turned 90°' : ''}, chosen for a ${Math.round(sqft)} sq ft plinth`,
    };
  }
  throw new ModelError(
    `No standard layout suits a ${formatLength(plinthW, 'ft-in')} × ${formatLength(plinthH, 'ft-in')} plinth (${Math.round(sqft)} sq ft). Check the plot size and setbacks.`,
  );
}

export interface StartResult {
  model: BuildingModel;
  ops: Operation[];
  notes: string[];
}

/**
 * Build Rev A: apply the site operations, then (when a plot is given) choose or
 * use the requested layout and size it to fill the plinth.
 */
export interface RoomCounts {
  /** 1–3; picks the layout. */
  bedrooms?: number;
  /** Total toilets; extra ones are attached to bedrooms, fewer turns the common toilet into a store. */
  toilets?: number;
  /** Stair and lift: both, stair only, or none. Left out = as the layout comes. */
  core?: 'both' | 'stair' | 'none';
}

export function startDesign(templateId: string, siteOps: Operation[], name: string, counts: RoomCounts = {}): StartResult {
  const notes: string[] = [];
  if (counts.bedrooms && templateId === 'auto') templateId = `${counts.bedrooms}bhk`;
  const auto = templateId === 'auto';
  const first = getTemplate(auto ? '3bhk' : templateId);
  if (!first) throw new ModelError('Pick a starting layout.');

  // 1. Site on a provisional model.
  let model: BuildingModel = { ...first.build(), name, revision: 1 };
  for (const op of siteOps) model = applyOperation(model, op).model;
  const site = model.site;

  if (!site) {
    if (auto) throw new ModelError('Enter the plot size so a layout can be chosen for it.');
    notes.push(`Started from the ${first.name} template`);
    if (counts.core) model = adjustCores(model, counts.core, notes);
    if (counts.toilets) model = adjustToilets(model, counts.toilets, notes);
    return { model: { ...model, revision: 1 }, ops: siteOps, notes };
  }

  // 2. Choose the layout for the plinth (or orient the requested one).
  const b = buildableRect(site);
  const pw = b.x1 - b.x0;
  const ph = b.y1 - b.y0;
  if (pw <= 0 || ph <= 0) throw new ModelError('The setbacks leave no room to build. Reduce them or enlarge the plot.');
  let choice: LayoutChoice;
  if (auto) {
    choice = chooseLayout(pw, ph);
  } else {
    const base = buildingOuterRect(first.build());
    const w = base.x1 - base.x0;
    const h = base.y1 - base.y0;
    const rotated = Math.abs(Math.log(pw / h)) + Math.abs(Math.log(ph / w)) < Math.abs(Math.log(pw / w)) + Math.abs(Math.log(ph / h));
    choice = { templateId: first.id, rotated, reason: `${first.name}${rotated ? ', turned 90°' : ''}` };
  }
  const template = getTemplate(choice.templateId)!;
  let layout = template.base ? template.base() : template.build();
  if (choice.rotated) layout = rotateLayout(layout);
  model = { ...layout, name, revision: 1, site: structuredClone(site) };
  notes.push(`Started from ${choice.reason}`);

  // 3. Size it to the plinth.
  const fit = parseOperation('fit_to_buildable', {});
  model = applyOperation(model, fit).model;
  if (template.finish) model = template.finish(model);
  notes.push(`sized to the ${formatLength(pw, 'ft-in')} × ${formatLength(ph, 'ft-in')} plinth`);
  if (counts.core) model = adjustCores(model, counts.core, notes);
  if (counts.toilets) model = adjustToilets(model, counts.toilets, notes);
  return { model: { ...model, revision: 1 }, ops: [...siteOps, fit], notes };
}

/**
 * Bring a layout to the wanted number of toilets: attach new ones to bedrooms
 * that have none (largest first), or turn surplus common toilets into stores.
 */
export function adjustToilets(input: BuildingModel, wanted: number, notes: string[] = []): BuildingModel {
  let m = input;
  const toilets = () => m.rooms.filter((r) => r.kind === 'toilet');
  const have = toilets().length;
  if (wanted === have) return m;
  if (wanted < 1) throw new ModelError('A home needs at least one toilet.');
  if (wanted < have) {
    // Common toilets (not opening off a bedroom) go first.
    const attachedTo = (t: Room) => m.rooms.some((b) => b.kind === 'bedroom' && hasAttachedToilet({ ...m, rooms: [b, t] }, b));
    const order = [...toilets()].sort((a, b) => Number(attachedTo(a)) - Number(attachedTo(b)));
    for (const t of order.slice(0, have - wanted)) {
      m = applyOperation(m, parseOperation('set_room_use', { roomId: t.id, name: 'Store', kind: 'other' })).model;
      notes.push(`${t.name} made a store`);
    }
    return m;
  }
  const area = (r: Room) => {
    const c = roomClearRect(m, r);
    return (c.x1 - c.x0) * (c.y1 - c.y0);
  };
  const failures: string[] = [];
  while (toilets().length < wanted) {
    // Attached to bedrooms without one (largest first), then a common toilet off the living area.
    const beds = m.rooms.filter((r) => r.kind === 'bedroom' && !hasAttachedToilet(m, r) && !failures.includes(r.id)).sort((a, b) => area(b) - area(a));
    const living = m.rooms.filter((r) => (r.kind === 'living' || r.kind === 'dining') && !failures.includes(r.id)).sort((a, b) => area(b) - area(a));
    const bed = beds[0] ?? living[0];
    if (!bed) {
      const n = toilets().length;
      throw new ModelError(
        `Only ${n} toilet${n === 1 ? '' : 's'} fit${n === 1 ? 's' : ''} this layout: the bedrooms and living area are too small to give up space for another toilet. Choose ${n} toilets, more bedroom space (a bigger plinth), or fewer bedrooms.`,
      );
    }
    try {
      m = applyOperation(m, parseOperation('add_toilet', { roomId: bed.id })).model;
      notes.push(bed.kind === 'bedroom' ? `toilet attached to ${bed.name}` : `common toilet off ${bed.name}`);
    } catch {
      failures.push(bed.id);
    }
  }
  return m;
}

/** Add or remove the stair and lift to match the choice. New ones go in the lobby, else the living room. */
export function adjustCores(input: BuildingModel, choice: 'both' | 'stair' | 'none', notes: string[] = []): BuildingModel {
  let m = input;
  const run = (name: string, args: Record<string, unknown>) => {
    m = applyOperation(m, parseOperation(name, args)).model;
  };
  const want = { stair: choice !== 'none', lift: choice === 'both' };
  for (const c of [...(m.cores ?? [])]) {
    if (!want[c.kind]) {
      run('remove', { entityId: c.id });
      notes.push(`no ${c.kind}`);
    }
  }
  const host = m.rooms.find((r) => r.kind === 'lobby') ?? m.rooms.find((r) => r.kind === 'living');
  if (!host) return m;
  for (const kind of ['stair', 'lift'] as const) {
    if (!want[kind] || (m.cores ?? []).some((c) => c.kind === kind)) continue;
    try {
      run(kind === 'stair' ? 'add_stair' : 'add_lift', { roomId: host.id });
      notes.push(`${kind} added in ${host.name}`);
    } catch (err) {
      throw new ModelError(`No room for the ${kind} in ${host.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return m;
}
