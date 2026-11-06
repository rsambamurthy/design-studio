/**
 * Preliminary structural layout derived from the plan: columns, beams, slab
 * panels and isolated footings with rule-of-thumb sizes, plus concrete and
 * steel quantities. It is a starting point for a structural engineer, who
 * must check, design and sign the structure; it is not a design.
 *
 * Structural walls are the outer walls, 230 mm walls and the walls of room
 * blocks other than toilets, pooja rooms and stores (those are partitions
 * standing on the slab or a beam). Columns go where structural walls meet,
 * extra columns split spans longer than MAX_SPAN, and columns are kept out
 * of door and window openings.
 */
import { blockWallRects } from './blocks';
import { roomClearRect } from './geometry';
import { openArea } from './kernel';
import { getWall, parseBlockWallId, type BuildingModel, type Room } from './model';

export const MAX_SPAN = 4500;
const SNAP = 300;

export interface StructureSettings {
  /** Floors carried by the columns (ground + upper floors). */
  floors: number;
  /** Safe bearing capacity of the soil, kN/m². */
  sbc: number;
  floorHeight: number;
}

export const DEFAULT_STRUCTURE: StructureSettings = { floors: 2, sbc: 150, floorHeight: 3000 };

export interface Column {
  id: string;
  x: number;
  y: number;
  /** Plan size (mm): b along x, d along y. */
  b: number;
  d: number;
  grid: string;
  /** Floor area it carries per floor (m²). */
  tributary: number;
  load: number;
  footing: number;
  moved?: string;
}

export interface Beam {
  id: string;
  a: string;
  b: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  span: number;
  width: number;
  depth: number;
}

export interface SlabPanel {
  id: string;
  room: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  short: number;
  long: number;
  way: 'one-way' | 'two-way';
  thickness: number;
  /** Floor area (mm²); for the open living space, what is left around the room blocks. */
  area: number;
  /** The open space around room blocks (drawn as a label only). */
  open: boolean;
}

export interface StructureNote {
  severity: 'warning' | 'info';
  message: string;
  at?: { x: number; y: number };
}

export interface Structure {
  settings: StructureSettings;
  gridX: { label: string; x: number }[];
  gridY: { label: string; y: number }[];
  columns: Column[];
  beams: Beam[];
  slabs: SlabPanel[];
  notes: StructureNote[];
  quantities: { concreteM3: number; steelKg: number; parts: { label: string; concreteM3: number; steelKg: number }[] };
}

interface Line {
  /** Horizontal (fixed y) or vertical (fixed x). */
  h: boolean;
  at: number;
  from: number;
  to: number;
  wallIds: string[];
}

const PARTITION_KINDS: Room['kind'][] = ['toilet', 'pooja', 'other', 'service'];

/** Axis lines of structural walls, merged where they continue each other. */
function structuralLines(model: BuildingModel): Line[] {
  const raw: Line[] = [];
  for (const w of model.walls) {
    const h = Math.abs(w.a.y - w.b.y) < 1;
    const v = Math.abs(w.a.x - w.b.x) < 1;
    if (!h && !v) continue;
    if (w.kind !== 'external' && w.thickness < 200) {
      // A thin fixed wall is structural only between habitable rooms.
      const rooms = model.rooms.filter((r) => !r.block && Object.values(r.bounds).includes(w.id));
      if (rooms.some((r) => PARTITION_KINDS.includes(r.kind))) continue;
    }
    raw.push(h ? { h, at: w.a.y, from: Math.min(w.a.x, w.b.x), to: Math.max(w.a.x, w.b.x), wallIds: [w.id] } : { h, at: w.a.x, from: Math.min(w.a.y, w.b.y), to: Math.max(w.a.y, w.b.y), wallIds: [w.id] });
  }
  for (const { id, rect } of blockWallRects(model)) {
    const owner = model.rooms.find((r) => r.id === parseBlockWallId(id)?.roomId);
    if (!owner || PARTITION_KINDS.includes(owner.kind)) continue;
    const h = rect.x1 - rect.x0 >= rect.y1 - rect.y0;
    const t = h ? (rect.y1 - rect.y0) / 2 : (rect.x1 - rect.x0) / 2;
    raw.push(h ? { h, at: (rect.y0 + rect.y1) / 2, from: rect.x0 + t, to: rect.x1 - t, wallIds: [id] } : { h, at: (rect.x0 + rect.x1) / 2, from: rect.y0 + t, to: rect.y1 - t, wallIds: [id] });
  }
  // Merge collinear overlapping or touching pieces.
  const out: Line[] = [];
  for (const l of raw.sort((a, b) => Number(a.h) - Number(b.h) || a.at - b.at || a.from - b.from)) {
    const prev = out.find((o) => o.h === l.h && Math.abs(o.at - l.at) < 60 && l.from <= o.to + 60 && l.to >= o.from - 60);
    if (prev) {
      prev.from = Math.min(prev.from, l.from);
      prev.to = Math.max(prev.to, l.to);
      prev.wallIds.push(...l.wallIds);
    } else out.push({ ...l, wallIds: [...l.wallIds] });
  }
  return out;
}

/** Door/window spans (along the line) on a line's walls. */
function openingSpans(model: BuildingModel, line: Line): [number, number][] {
  const out: [number, number][] = [];
  for (const o of model.openings) {
    if (!line.wallIds.includes(o.wallId)) continue;
    let w;
    try {
      w = getWall(model, o.wallId);
    } catch {
      continue;
    }
    const a = line.h ? w.a.x : w.a.y;
    const bb = line.h ? w.b.x : w.b.y;
    const c = a + Math.sign(bb - a || 1) * o.offset;
    out.push([c - o.width / 2, c + o.width / 2]);
  }
  return out;
}

const round50 = (n: number) => Math.ceil(n / 50) * 50;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Settings saved on the design, over the defaults. */
export function structureSettings(model: BuildingModel): StructureSettings {
  return { ...DEFAULT_STRUCTURE, ...(model.structure?.floors ? { floors: model.structure.floors } : {}), ...(model.structure?.sbc ? { sbc: model.structure.sbc } : {}) };
}

export function generateStructure(model: BuildingModel, settings: StructureSettings = structureSettings(model)): Structure {
  const lines = structuralLines(model);
  const notes: StructureNote[] = [];
  const key = (x: number, y: number) => `${Math.round(x / SNAP)}:${Math.round(y / SNAP)}`;
  const pts = new Map<string, { x: number; y: number }>();
  const add = (x: number, y: number) => {
    // Merge with a column already within SNAP.
    for (const p of pts.values()) if (Math.abs(p.x - x) < SNAP && Math.abs(p.y - y) < SNAP) return;
    pts.set(key(x, y), { x, y });
  };
  const hs = lines.filter((l) => l.h);
  const vs = lines.filter((l) => !l.h);
  // Junctions: a horizontal and a vertical structural line meet (cross, T or L).
  for (const h of hs) for (const v of vs) if (v.at >= h.from - 60 && v.at <= h.to + 60 && h.at >= v.from - 60 && h.at <= v.to + 60) add(v.at, h.at);
  // Free ends of lines.
  for (const l of lines) {
    add(l.h ? l.from : l.at, l.h ? l.at : l.from);
    add(l.h ? l.to : l.at, l.h ? l.at : l.to);
  }

  // Columns on a line, in order along it.
  const onLine = (l: Line) =>
    [...pts.values()]
      .filter((p) => (l.h ? Math.abs(p.y - l.at) < SNAP && p.x >= l.from - SNAP && p.x <= l.to + SNAP : Math.abs(p.x - l.at) < SNAP && p.y >= l.from - SNAP && p.y <= l.to + SNAP))
      .sort((a, b) => (l.h ? a.x - b.x : a.y - b.y));

  // Split long spans, lining extra columns up with columns elsewhere where possible
  // (so beams can later run straight across open floor between them).
  for (let pass = 0; pass < 2; pass++) {
    for (const l of lines) {
      const ps = onLine(l);
      for (let i = 0; i + 1 < ps.length; i++) {
        let a = l.h ? ps[i]!.x : ps[i]!.y;
        const b = l.h ? ps[i + 1]!.x : ps[i + 1]!.y;
        if (b - a <= MAX_SPAN) continue;
        const aligned = [...new Set([...pts.values()].map((p) => (l.h ? p.x : p.y)))].filter((v) => v > a + 1200 && v < b - 1200).sort((x, y) => x - y);
        while (b - a > MAX_SPAN) {
          const reach = aligned.filter((v) => v > a + 1200 && v <= a + MAX_SPAN && b - v >= 1200);
          const n = Math.ceil((b - a) / MAX_SPAN);
          const c = reach.length ? reach[reach.length - 1]! : a + (b - a) / n;
          add(l.h ? c : l.at, l.h ? l.at : c);
          a = c;
        }
      }
    }
  }

  // Keep columns out of openings: slide along the line to the nearer edge.
  const moved = new Map<string, string>();
  for (const l of lines) {
    const spans = openingSpans(model, l);
    for (const [k, p] of pts) {
      const along = l.h ? p.x : p.y;
      const off = l.h ? Math.abs(p.y - l.at) : Math.abs(p.x - l.at);
      if (off > 60) continue;
      const hit = spans.find(([s, e]) => along > s - 150 && along < e + 150);
      if (!hit) continue;
      const left = hit[0] - 150;
      const right = hit[1] + 150;
      const to = along - left <= right - along ? left : right;
      if (to < l.from - 1 || to > l.to + 1) {
        notes.push({ severity: 'warning', message: 'A column falls in a door or window at the end of a wall; the opening needs moving or a transfer beam.', at: p });
        continue;
      }
      if (l.h) p.x = to;
      else p.y = to;
      moved.set(k, 'Moved clear of an opening');
    }
  }

  // The user's edits: removed and moved columns (matched by position, so they survive small plan changes).
  const edits = model.structure;
  for (const r of edits?.removed ?? []) {
    for (const [k, p] of pts) if (Math.abs(p.x - r.x) < 400 && Math.abs(p.y - r.y) < 400) pts.delete(k);
  }
  for (const mv of edits?.moved ?? []) {
    const hit = [...pts.entries()].find(([, p]) => Math.abs(p.x - mv.from.x) < 400 && Math.abs(p.y - mv.from.y) < 400);
    if (!hit) continue;
    const to = projectToLine(lines, mv.to);
    if (!to) continue;
    hit[1].x = to.x;
    hit[1].y = to.y;
    moved.set(hit[0], 'Moved by you');
  }

  // Grid lines from distinct column x and y.
  const distinct = (vals: number[]) => {
    const out: number[] = [];
    for (const v of vals.sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1]! > 750) out.push(v);
    return out;
  };
  const all = [...pts.values()];
  const gx = distinct(all.map((p) => p.x));
  const gy = distinct(all.map((p) => p.y));
  const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`);
  const gridX = gx.map((x, i) => ({ label: String(i + 1), x }));
  const gridY = gy.map((y, i) => ({ label: letter(i), y }));
  const nearest = <T extends { x?: number; y?: number }>(arr: T[], v: number, f: (t: T) => number) => arr.reduce((b, t) => (Math.abs(f(t) - v) < Math.abs(f(b) - v) ? t : b));

  // Tributary area per column: nearest-column sampling over the floor.
  const ext = model.walls.filter((w) => w.kind === 'external');
  const xs = ext.flatMap((w) => [w.a.x, w.b.x]);
  const ys = ext.flatMap((w) => [w.a.y, w.b.y]);
  const B = xs.length ? { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } : { x0: 0, x1: 0, y0: 0, y1: 0 };
  const step = 250;
  const trib = new Map<string, number>();
  for (let x = B.x0 + step / 2; x < B.x1; x += step) {
    for (let y = B.y0 + step / 2; y < B.y1; y += step) {
      let best = '';
      let bd = Infinity;
      for (const [k, p] of pts) {
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      if (best) trib.set(best, (trib.get(best) ?? 0) + step * step);
    }
  }

  const LOAD = 12; // kN/m² per floor, factored dead + live, rule of thumb
  const columns: Column[] = [...pts.entries()]
    .sort(([, a], [, b]) => a.y - b.y || a.x - b.x)
    .map(([k, p], i) => {
      const t = (trib.get(k) ?? 0) / 1e6;
      const load = Math.round(t * LOAD * settings.floors);
      const big = load > 600;
      const footing = Math.max(1200, Math.ceil((Math.sqrt((load * 1.1) / settings.sbc) * 1000) / 100) * 100);
      const g = `${nearest(gridY, p.y, (q) => q.y).label}${nearest(gridX, p.x, (q) => q.x).label}`;
      return { id: `C${i + 1}`, x: Math.round(p.x), y: Math.round(p.y), b: 230, d: big ? 450 : 300, grid: g, tributary: r1(t), load, footing, moved: moved.get(k) };
    });

  // Beams: between consecutive columns along each structural line.
  const beams: Beam[] = [];
  const colAt = (p: { x: number; y: number }) => columns.find((c) => Math.abs(c.x - p.x) < 2 && Math.abs(c.y - p.y) < 2)!;
  for (const l of lines) {
    const ps = onLine(l).map((p) => colAt({ x: Math.round(p.x), y: Math.round(p.y) })).filter(Boolean);
    for (let i = 0; i + 1 < ps.length; i++) {
      const a = ps[i]!;
      const b = ps[i + 1]!;
      const span = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
      if (span < 300) continue;
      if (beams.some((x) => (x.a === a.id && x.b === b.id) || (x.a === b.id && x.b === a.id))) continue;
      beams.push({ id: `B${beams.length + 1}`, a: a.id, b: b.id, x0: a.x, y0: a.y, x1: b.x, y1: b.y, span, width: 230, depth: Math.max(300, round50(span / 12 + 50)) });
      if (span > MAX_SPAN + 300) notes.push({ severity: 'warning', message: `Beam ${a.id}–${b.id} spans ${(span / 1000).toFixed(1)} m; consider a column between.`, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
    }
  }

  // Beams across open space, where the slab would otherwise span too far.
  addOpenBeams(model, B, columns, beams, notes);

  // Slab panels: one per room.
  const slabs: SlabPanel[] = [];
  for (const r of model.rooms) {
    const c = roomClearRect(model, r);
    const w = c.x1 - c.x0;
    const h = c.y1 - c.y0;
    if (w < 300 || h < 300) continue;
    const open = !r.block && model.rooms.some((x) => x.block);
    const short = Math.min(w, h);
    const long = Math.max(w, h);
    const way = long / short > 2 ? 'one-way' : 'two-way';
    const thickness = short > 4000 ? 150 : 125;
    slabs.push({ id: `S${slabs.length + 1}`, room: r.name, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, short, long, way, thickness, area: open ? openArea(model, r) : w * h, open });
    if (short > 5000 && !r.block && !open) notes.push({ severity: 'info', message: `${r.name} slab is about ${(short / 1000).toFixed(1)} m across; the engineer may add a beam to break it up.`, at: { x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2 } });
  }

  // Quantities (rule-of-thumb steel per m³ of concrete).
  const H = settings.floorHeight;
  const colC = columns.reduce((a, c) => a + ((c.b * c.d) / 1e6) * (H / 1000) * settings.floors, 0);
  const beamC = beams.reduce((a, b) => a + (b.width / 1000) * ((b.depth - 125) / 1000) * (b.span / 1000), 0) * settings.floors;
  const slabC = slabs.reduce((a, s) => a + (s.area * s.thickness) / 1e9, 0) * settings.floors;
  const footC = columns.reduce((a, c) => a + (c.footing / 1000) ** 2 * 0.45 + ((c.b * c.d) / 1e6) * 1.2, 0);
  const parts = [
    { label: 'Footings', concreteM3: r1(footC), steelKg: Math.round(footC * 80) },
    { label: 'Columns', concreteM3: r1(colC), steelKg: Math.round(colC * 180) },
    { label: 'Beams', concreteM3: r1(beamC), steelKg: Math.round(beamC * 130) },
    { label: 'Slabs', concreteM3: r1(slabC), steelKg: Math.round(slabC * 85) },
  ];
  return {
    settings,
    gridX,
    gridY,
    columns,
    beams,
    slabs,
    notes,
    quantities: { concreteM3: r1(parts.reduce((a, p) => a + p.concreteM3, 0)), steelKg: parts.reduce((a, p) => a + p.steelKg, 0), parts },
  };
}

/** Nearest point on a structural wall line (within 900 mm), or undefined. */
export function projectToLine(lines: Line[], p: { x: number; y: number }): { x: number; y: number } | undefined {
  let best: { x: number; y: number } | undefined;
  let bd = 900;
  for (const l of lines) {
    const along = Math.min(l.to, Math.max(l.from, l.h ? p.x : p.y));
    const q = l.h ? { x: along, y: l.at } : { x: l.at, y: along };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best && { x: Math.round(best.x), y: Math.round(best.y) };
}

/** Where columns may be dragged to: the structural wall lines. */
export function structuralWallLines(model: BuildingModel): { h: boolean; at: number; from: number; to: number }[] {
  return structuralLines(model).map(({ h, at, from, to }) => ({ h, at, from, to }));
}

const OPEN_SPAN = MAX_SPAN + 300;
const MAX_OPEN_BEAM = 7500;

/**
 * Greedily add column-to-column beams across open floor until no point of
 * the slab spans more than OPEN_SPAN between supports (or nothing helps).
 */
function addOpenBeams(model: BuildingModel, B: { x0: number; x1: number; y0: number; y1: number }, columns: Column[], beams: Beam[], notes: StructureNote[]) {
  if (B.x1 <= B.x0) return;
  const step = 300;
  const cells: { x: number; y: number }[] = [];
  for (let x = B.x0 + step / 2; x < B.x1; x += step) for (let y = B.y0 + step / 2; y < B.y1; y += step) cells.push({ x, y });
  type Seg = { h: boolean; at: number; from: number; to: number };
  const seg = (b: { x0: number; y0: number; x1: number; y1: number }): Seg =>
    Math.abs(b.y1 - b.y0) < 5 ? { h: true, at: b.y0, from: Math.min(b.x0, b.x1), to: Math.max(b.x0, b.x1) } : { h: false, at: b.x0, from: Math.min(b.y0, b.y1), to: Math.max(b.y0, b.y1) };
  // Outer walls always support the slab.
  const supports: Seg[] = [
    { h: true, at: B.y0, from: B.x0, to: B.x1 },
    { h: true, at: B.y1, from: B.x0, to: B.x1 },
    { h: false, at: B.x0, from: B.y0, to: B.y1 },
    { h: false, at: B.x1, from: B.y0, to: B.y1 },
    ...beams.map(seg),
  ];
  const spanAt = (c: { x: number; y: number }, extra?: Seg) => {
    let l = B.x0, r = B.x1, t = B.y0, b = B.y1;
    const all = extra ? [...supports, extra] : supports;
    for (const s of all) {
      if (!s.h && c.y >= s.from && c.y <= s.to) {
        if (s.at <= c.x && s.at > l) l = s.at;
        if (s.at >= c.x && s.at < r) r = s.at;
      } else if (s.h && c.x >= s.from && c.x <= s.to) {
        if (s.at <= c.y && s.at > t) t = s.at;
        if (s.at >= c.y && s.at < b) b = s.at;
      }
    }
    return Math.min(r - l, b - t);
  };
  const worst = (extra?: Seg) => {
    let max = 0;
    let over = 0;
    let at = cells[0]!;
    for (const c of cells) {
      const s = spanAt(c, extra);
      if (s > OPEN_SPAN) over++;
      if (s > max) {
        max = s;
        at = c;
      }
    }
    return { max, over, at };
  };
  // Candidate beams: consecutive columns in line, not already joined.
  const cands: { a: Column; b: Column; s: Seg; span: number }[] = [];
  for (const a of columns) {
    for (const b of columns) {
      if (a === b) continue;
      const vert = Math.abs(a.x - b.x) < 5 && b.y > a.y;
      const horiz = Math.abs(a.y - b.y) < 5 && b.x > a.x;
      if (!vert && !horiz) continue;
      const span = Math.hypot(b.x - a.x, b.y - a.y);
      if (span < 1500 || span > MAX_OPEN_BEAM) continue;
      const between = columns.some((c) => c !== a && c !== b && (vert ? Math.abs(c.x - a.x) < 5 && c.y > a.y && c.y < b.y : Math.abs(c.y - a.y) < 5 && c.x > a.x && c.x < b.x));
      if (between) continue;
      if (beams.some((x) => (x.a === a.id && x.b === b.id) || (x.a === b.id && x.b === a.id))) continue;
      cands.push({ a, b, s: seg({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }), span });
    }
  }
  let now = worst();
  for (let i = 0; i < 8 && now.max > OPEN_SPAN && cands.length; i++) {
    let best: { k: number; w: ReturnType<typeof worst> } | undefined;
    cands.forEach((c, k) => {
      const w = worst(c.s);
      if (!best || w.max < best.w.max - 1 || (Math.abs(w.max - best.w.max) <= 1 && (w.over < best.w.over || (w.over === best.w.over && c.span < cands[best.k]!.span)))) best = { k, w };
    });
    if (!best || (best.w.max >= now.max - 1 && best.w.over >= now.over)) break;
    const c = cands.splice(best.k, 1)[0]!;
    supports.push(c.s);
    const span = Math.round(c.span);
    const id = `B${beams.length + 1}`;
    const depth = Math.max(300, round50(span / 12 + 50));
    beams.push({ id, a: c.a.id, b: c.b.id, x0: c.a.x, y0: c.a.y, x1: c.b.x, y1: c.b.y, span, width: 230, depth });
    notes.push({ severity: 'info', message: `Beam ${id} (${c.a.id}–${c.b.id}, ${(span / 1000).toFixed(1)} m, 230×${depth}) added across open floor to keep slab spans short.` });
    now = best.w;
  }
  if (now.max > 5500) notes.push({ severity: 'warning', message: `Part of the slab still spans about ${(now.max / 1000).toFixed(1)} m between beams; the engineer may add a column, a beam or a thicker slab here.`, at: now.at });
}
