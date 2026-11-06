/**
 * Architectural layout schemes. A scheme divides the whole building, wall
 * line to wall line, into rooms and open zones (living, foyer, dining,
 * passage) with no leftover space, the way a plan is drawn: bands and
 * columns with set depths for bedrooms, toilets and kitchens and the rest
 * shared out. Doors are placed by intent (toilet off its bedroom, bedroom
 * off the passage) and the entrance opens into the foyer.
 *
 * Schemes are written with the front (entrance, road) at the bottom of the
 * plan and the back at the top. Sizes are clear feet; wall centre lines are
 * worked out here.
 */
import type { Rect } from './geometry';
import type { BuildingModel, Room } from './model';

const FT = 304.8;
const WALL = 115;
/** Centre-line size for a clear size in feet. */
const c = (clearFt: number) => Math.round(clearFt * FT + WALL);

export interface LayoutRoom {
  name: string;
  kind: Room['kind'];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Name of the room or zone its door opens to. */
  door?: string;
}

export interface LayoutZone {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LayoutPlan {
  rooms: LayoutRoom[];
  zones: LayoutZone[];
  /** Zone the main door opens into, and which outer side it is on. */
  entrance?: { zone: string; side: 'top' | 'bottom' | 'left' | 'right'; x0?: number; y0?: number; x1?: number; y1?: number };
}

type Leaf = { room: string; kind: Room['kind']; door?: string } | { zone: string };
interface Part {
  /** Fixed centre-line size (mm). */
  size?: number;
  /** Share of what is left after fixed sizes. */
  flex?: number;
  /** Smallest centre-line size it may get (mm). */
  min?: number;
  /** Largest (mm); what's over goes to the other flexible parts. */
  max?: number;
  node: Node;
}
type Node = Leaf | { split: 'x' | 'y'; parts: Part[] };

const room = (name: string, kind: Room['kind'], door?: string): Leaf => ({ room: name, kind, door });
const zone = (name: string): Leaf => ({ zone: name });
const fixed = (ft: number, node: Node): Part => ({ size: c(ft), node });
/** Takes only the space left when the rooms beside it reach their largest size. */
const spare = (node: Node): Part => ({ flex: 0, node });
const flex = (node: Node, w = 1, minFt = 0, maxFt = 0): Part => ({ flex: w, min: minFt ? c(minFt) : 0, max: maxFt ? c(maxFt) : undefined, node });
const X = (...parts: Part[]): Node => ({ split: 'x', parts });
const Y = (...parts: Part[]): Node => ({ split: 'y', parts });

/** Share a length out: fixed parts first (scaled down if they don't fit), flex parts by weight, honouring minimums. */
function share(total: number, parts: Part[]): number[] {
  const fixedSum = parts.reduce((a, p) => a + (p.size ?? 0), 0);
  const flexParts = parts.filter((p) => p.size === undefined);
  const need = fixedSum + flexParts.reduce((a, p) => a + (p.min ?? 0), 0);
  if (need > total) {
    // Not enough room for every minimum: everything shrinks in proportion (the checks will say what's tight).
    const k = total / need;
    return parts.map((p) => (p.size ?? p.min ?? 0) * k);
  }
  if (!flexParts.length || fixedSum >= total) {
    const k = fixedSum ? total / fixedSum : 0;
    return parts.map((p) => (p.size ?? 0) * k);
  }
  let left = total - fixedSum;
  const sizes = parts.map((p) => (p.size ?? (p.flex === 0 ? 0 : -1)));
  // Spare parts (flex 0) only take what capped rooms leave over.
  const spare = flexParts.filter((p) => p.flex === 0);
  let free = flexParts.filter((p) => p.flex !== 0);
  // Give minimums to flex parts that would fall below them, then share the rest.
  for (let guard = 0; guard < 6; guard++) {
    const w = free.reduce((a, p) => a + (p.flex ?? 1), 0);
    const short = free.filter((p) => (left * (p.flex ?? 1)) / w < (p.min ?? 0));
    if (!short.length) break;
    for (const p of short) {
      sizes[parts.indexOf(p)] = p.min!;
      left -= p.min!;
    }
    free = free.filter((p) => !short.includes(p));
    if (!free.length || left <= 0) break;
  }
  // Share out, capping parts at their maximum while others can take the rest.
  for (let guard = 0; guard < 6 && free.length; guard++) {
    const w = free.reduce((a, p) => a + (p.flex ?? 1), 0);
    const over = free.filter((p) => p.max !== undefined && (left * (p.flex ?? 1)) / w > p.max);
    if (!over.length || (over.length === free.length && !spare.length)) break;
    for (const p of over) {
      sizes[parts.indexOf(p)] = p.max!;
      left -= p.max!;
    }
    free = free.filter((p) => !over.includes(p));
  }
  if (free.length) {
    const w = free.reduce((a, p) => a + (p.flex ?? 1), 0);
    for (const p of free) sizes[parts.indexOf(p)] = Math.max(0, (left * (p.flex ?? 1)) / (w || 1));
  } else if (spare.length) {
    for (const p of spare) sizes[parts.indexOf(p)] = left / spare.length;
  }
  return sizes.map((s) => Math.max(0, s));
}

function solve(node: Node, r: Rect, out: LayoutPlan) {
  if ('split' in node) {
    const total = node.split === 'x' ? r.x1 - r.x0 : r.y1 - r.y0;
    const sizes = share(total, node.parts);
    let at = node.split === 'x' ? r.x0 : r.y0;
    node.parts.forEach((p, i) => {
      // Round to whole mm; the last part takes the remainder so edges meet exactly.
      const end = i === node.parts.length - 1 ? (node.split === 'x' ? r.x1 : r.y1) : Math.round(at + sizes[i]!);
      const sub = node.split === 'x' ? { x0: at, x1: end, y0: r.y0, y1: r.y1 } : { x0: r.x0, x1: r.x1, y0: at, y1: end };
      if (end - at > 1) solve(p.node, sub, out);
      at = end;
    });
    return;
  }
  if ('zone' in node) {
    // Adjacent pieces of the same zone stay one zone.
    out.zones.push({ name: node.zone, ...r });
    return;
  }
  out.rooms.push({ name: node.room, kind: node.kind, door: node.door, ...r });
}

export interface SchemeInput {
  bedrooms: number;
  toilets: number;
  pooja: boolean;
  stores: number;
}

export interface Scheme {
  id: string;
  name: string;
  description: string;
  build: (w: number, d: number, p: SchemeInput) => Node;
}

/**
 * A bedroom with its toilet beside it, sharing the band's depth: the toilet
 * takes the top of a narrow column and the passage the rest.
 */
const bedName = (i: number) => (i === 0 ? 'Master Bed' : `Bed ${i + 1}`);

export const SCHEMES: Scheme[] = [
  {
    id: 'spine',
    name: 'Central foyer',
    description: 'Bedrooms across the back off a short passage; living, foyer and dining through the middle; kitchen and service at the front corner.',
    build: (w, _d, p) => {
      const n = p.bedrooms;
      const extraToilets = Math.max(0, p.toilets - n);
      const wide = w > c(46);
      // Back band: Bed 2 | toilet over a short passage | Master (| toilet | Bed 4 on wide plots).
      const back = X(
        flex(room('Bed 2', 'bedroom', 'Passage'), 1, 11, 15),
        fixed(5, Y(fixed(9, room('Toilet 1', 'toilet', 'Master Bed')), flex(zone('Passage')))),
        flex(room('Master Bed', 'bedroom', 'Passage'), 1.12, 12, 17),
        ...(n >= 4 && wide ? [fixed(5, Y(fixed(9, room('Toilet 4', 'toilet', 'Bed 4')), flex(zone('Passage')))), flex(room('Bed 4', 'bedroom', 'Passage'), 1, 11)] : []),
      );
      // Middle: Bed 2's toilet over the living room, the foyer, then pooja / store / Bed 4 by the entrance.
      const side: Part[] = [];
      if (p.pooja) side.push(fixed(5.5, room('Pooja', 'pooja', 'Foyer')));
      for (let i = 0; i < p.stores; i++) side.push(fixed(5, room(i ? `Store ${i + 1}` : 'Store', 'other', 'Foyer')));
      side.push(flex(zone('Entrance')));
      const middle = X(
        flex(Y(fixed(5, X(fixed(9, room('Toilet 2', 'toilet', 'Bed 2')), flex(zone('Living')))), flex(zone('Living'))), 1.25, 13),
        flex(zone('Foyer'), 0.55, 5.5),
        fixed(6, Y(...side)),
      );
      // Front: kitchen over service in one column; dining with Bed 3, its toilet and the common toilet in front.
      const frontRow: Part[] = [spare(zone('Dining'))];
      if (extraToilets > 0) frontRow.push(fixed(4.5, room(`Toilet ${n + (n >= 4 && !wide ? 0 : 1)}`, 'toilet', 'Dining')));
      if (n >= 3) frontRow.push(fixed(5, room('Toilet 3', 'toilet', 'Bed 3')), flex(room('Bed 3', 'bedroom', 'Dining'), 1, 10, 15));
      if (n >= 4 && !wide) frontRow.push(fixed(5, room('Toilet 4', 'toilet', 'Bed 4')), flex(room('Bed 4', 'bedroom', 'Dining'), 1, 10, 15));
      if (n < 3) frontRow.push(flex(zone('Dining')));
      const front = X(
        fixed(11.5, Y(flex(room('Kitchen', 'kitchen', 'Dining'), 1, 11, 14), fixed(5, room('Service', 'service', 'Kitchen')))),
        flex(Y(flex(zone('Dining'), 1, 7), fixed(10, X(...frontRow)))),
      );
      return Y(fixed(14, back), flex(middle, 1, 13), fixed(18, front));
    },
  },
  {
    id: 'wing',
    name: 'Bedroom wing',
    description: 'Bedrooms in a private wing down one side, each with its own toilet off a short lobby; kitchen, dining and living in one run on the other side, entered at the front.',
    build: (_w, _d, p) => {
      const n = p.bedrooms;
      const beds: Part[] = [];
      const lane: Part[] = [];
      for (let i = 0; i < n; i++) {
        const name = bedName(i);
        const depth = i === 0 ? 14.5 : 13;
        beds.push(fixed(depth, room(name, 'bedroom', 'Passage')));
        lane.push(fixed(depth, Y(fixed(8, room(`Toilet ${i + 1}`, 'toilet', name)), flex(zone('Passage')))));
      }
      beds.push(flex(zone('Foyer')));
      lane.push(flex(zone('Foyer')));
      const extra = Math.max(0, p.toilets - n);
      const small: Part[] = [];
      if (p.pooja) small.push(fixed(5.5, room('Pooja', 'pooja', 'Dining')));
      if (extra) small.push(fixed(5.5, room(`Toilet ${n + 1}`, 'toilet', 'Dining')));
      for (let i = 0; i < p.stores; i++) small.push(fixed(5, room(i ? `Store ${i + 1}` : 'Store', 'other', 'Dining')));
      small.push(flex(zone('Dining')));
      const pub = Y(
        fixed(12, X(flex(room('Kitchen', 'kitchen', 'Dining'), 1, 9, 14), fixed(4.5, room('Service', 'service', 'Kitchen')), spare(zone('Dining')))),
        flex(X(flex(zone('Dining')), fixed(6, Y(...small))), 0.8, 12),
        flex(zone('Living'), 1.2, 12),
      );
      return X(fixed(12.5, Y(...beds)), fixed(5, Y(...lane)), flex(pub, 1, 16));
    },
  },
  {
    id: 'split',
    name: 'Split bedrooms',
    description: 'Master suite and kitchen at the back; the other bedrooms at the front either side of the foyer; living and dining between them.',
    build: (_w, _d, p) => {
      const n = p.bedrooms;
      const extra = Math.max(0, p.toilets - n);
      const narrow = _w < c((n - 1) * 16.5 + 8);
      const smallRooms: Part[] = [];
      if (p.pooja) smallRooms.push(fixed(5.5, room('Pooja', 'pooja', narrow ? 'Dining' : 'Foyer')));
      if (extra) smallRooms.push(fixed(5, room(`Toilet ${n + 1}`, 'toilet', narrow ? 'Dining' : 'Foyer')));
      for (let k = 0; k < p.stores; k++) smallRooms.push(fixed(5, room(k ? `Store ${k + 1}` : 'Store', 'other', narrow ? 'Dining' : 'Foyer')));
      const backRow = X(
        flex(room('Master Bed', 'bedroom', 'Passage'), 1.2, 12, 17),
        fixed(5, Y(fixed(8, room('Toilet 1', 'toilet', 'Master Bed')), flex(zone('Passage')))),
        ...(narrow && smallRooms.length ? [fixed(5.5, Y(...smallRooms, flex(zone('Dining'))))] : [flex(zone('Dining'), 0.3, 0)]),
        fixed(11.5, Y(flex(room('Kitchen', 'kitchen', 'Dining'), 1, 9, 14), fixed(4.5, room('Service', 'service', 'Kitchen')))),
      );
      const fronts: Part[] = [];
      for (let i = 1; i < n; i++) {
        if (i === Math.ceil((n - 1) / 2) + 1 || (n === 2 && i === 1)) {
          const small = narrow ? [] : smallRooms;
          fronts.push(flex(X(flex(zone('Foyer'), 1, 6), ...(small.length ? [fixed(6, Y(...small, flex(zone('Foyer'))))] : [])), 0.9, 7));
        }
        if (narrow) {
          // Narrow plot: the toilet sits over its bedroom, entered from it, with living space beside it.
          const bed = `Bed ${i + 1}`;
          const t = room(`Toilet ${i + 1}`, 'toilet', bed);
          fronts.push(flex(Y(fixed(5, i % 2 ? X(flex(zone('Living')), fixed(8, t)) : X(fixed(8, t), flex(zone('Living')))), flex(room(bed, 'bedroom', 'Living'), 1, 10)), 1, 11));
        } else {
          fronts.push(flex(room(`Bed ${i + 1}`, 'bedroom', 'Living'), 1, 10.5, 15));
          fronts.push(fixed(5, Y(fixed(3.5, zone('Living')), flex(room(`Toilet ${i + 1}`, 'toilet', `Bed ${i + 1}`)))));
        }
      }
      if (n === 1) fronts.push(flex(zone('Foyer')));
      return Y(fixed(14, backRow), flex(zone('Dining'), 0.8, 9), flex(zone('Living'), 1, 11), fixed(narrow ? 18 : 12.5, X(...fronts)));
    },
  },
];

/** Merge touching pieces of the same zone into the fewest rectangles worth labelling. */
function tidyZones(zs: LayoutZone[]): LayoutZone[] {
  const out: LayoutZone[] = [];
  for (const z of zs) {
    const m = out.find((o) => o.name === z.name && ((o.x0 === z.x0 && o.x1 === z.x1 && (o.y1 === z.y0 || o.y0 === z.y1)) || (o.y0 === z.y0 && o.y1 === z.y1 && (o.x1 === z.x0 || o.x0 === z.x1))));
    if (m) {
      m.x0 = Math.min(m.x0, z.x0);
      m.y0 = Math.min(m.y0, z.y0);
      m.x1 = Math.max(m.x1, z.x1);
      m.y1 = Math.max(m.y1, z.y1);
    } else out.push({ ...z });
  }
  return out;
}

/** The building's outer wall centre-line rectangle. */
export function shellRect(model: BuildingModel): Rect | undefined {
  const ext = model.walls.filter((w) => w.kind === 'external');
  if (!ext.length) return undefined;
  const xs = ext.flatMap((w) => [w.a.x, w.b.x]);
  const ys = ext.flatMap((w) => [w.a.y, w.b.y]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Lay a scheme out in the building. */
export function planScheme(model: BuildingModel, scheme: Scheme, input: SchemeInput, flip: { x?: boolean; y?: boolean } = {}): LayoutPlan {
  const r = shellRect(model);
  if (!r) throw new Error('The design has no outer walls to lay out in.');
  const out: LayoutPlan = { rooms: [], zones: [] };
  // Schemes are drawn for plots deeper than wide; on a wide plot the scheme turns so its front faces a long side.
  const turn = r.x1 - r.x0 > (r.y1 - r.y0) * 1.1;
  if (turn) {
    solve(scheme.build(r.y1 - r.y0, r.x1 - r.x0, input), { x0: r.y0, y0: r.x0, x1: r.y1, y1: r.x1 }, out);
    const swap = <T extends { x0: number; y0: number; x1: number; y1: number }>(q: T): T => ({ ...q, x0: q.y0, y0: q.x0, x1: q.y1, y1: q.x1 });
    out.rooms = out.rooms.map(swap);
    out.zones = out.zones.map(swap);
  } else solve(scheme.build(r.x1 - r.x0, r.y1 - r.y0, input), r, out);
  // Mirror images of the same scheme (kitchen on the other side, bedrooms at the front…).
  const fl = <T extends { x0: number; y0: number; x1: number; y1: number }>(q: T): T => ({
    ...q,
    ...(flip.x ? { x0: r.x0 + r.x1 - q.x1, x1: r.x0 + r.x1 - q.x0 } : {}),
    ...(flip.y ? { y0: r.y0 + r.y1 - q.y1, y1: r.y0 + r.y1 - q.y0 } : {}),
  });
  out.rooms = out.rooms.map(fl);
  out.zones = tidyZones(tidyZones(out.zones.map(fl)));
  // Entrance: an entrance/foyer zone on an outer wall (the front first), else living or dining.
  const sideOf = (z: LayoutZone): LayoutPlan['entrance'] => {
    const touches: { side: 'top' | 'bottom' | 'left' | 'right'; len: number }[] = [
      { side: 'bottom', len: Math.abs(z.y1 - r.y1) < 2 ? z.x1 - z.x0 : 0 },
      { side: 'right', len: Math.abs(z.x1 - r.x1) < 2 ? z.y1 - z.y0 : 0 },
      { side: 'left', len: Math.abs(z.x0 - r.x0) < 2 ? z.y1 - z.y0 : 0 },
      { side: 'top', len: Math.abs(z.y0 - r.y0) < 2 ? z.x1 - z.x0 : 0 },
    ];
    const t = touches.find((x) => x.len > 1500);
    return t ? { zone: z.name, side: t.side, x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1 } : undefined;
  };
  for (const name of ['Entrance', 'Foyer', 'Living', 'Dining']) {
    const e = out.zones.filter((z) => z.name === name).map(sideOf).find(Boolean);
    if (e) {
      out.entrance = e;
      break;
    }
  }
  return out;
}

/** Bedrooms, toilets, pooja and stores the brief asks for (or the plan has). */
export function schemeInput(model: BuildingModel): SchemeInput {
  const items = (model.brief?.items ?? []) as { type: string; rooms: string; n?: number | string }[];
  const count = (sel: string, kinds: Room['kind'][], fallback: number) => {
    const it = items.find((i) => i.type === 'count' && i.rooms.toLowerCase().replace(/s$/, '') === sel);
    return it ? Number(it.n) : Math.max(fallback, model.rooms.filter((r) => kinds.includes(r.kind)).length);
  };
  const bedrooms = Math.min(4, Math.max(1, count('bedroom', ['bedroom'], 3)));
  return {
    bedrooms,
    toilets: count('toilet', ['toilet'], bedrooms),
    pooja: count('pooja', ['pooja'], 0) > 0,
    stores: Math.min(2, count('store', [], 0)),
  };
}
