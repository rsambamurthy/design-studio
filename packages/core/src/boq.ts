/**
 * Bill of quantities and cost: quantities measured from the plan, priced
 * from a rate card with three grades per item (basic, standard, premium).
 * The chosen grades, any custom rates and the budget live on the model
 * (set_costing), so they are versioned with the plan.
 *
 * Rates are indicative Chennai figures (2026) for a typical RCC framed
 * house; every rate can be overridden.
 */
import { blockWallRects } from './blocks';
import { roomClearRect } from './geometry';
import { openArea } from './kernel';
import { parseBlockWallId, type BuildingModel, type Room } from './model';

export const FLOOR_HEIGHT = 3000; // mm, floor to floor
const SQFT = 92903.04; // mm² per sq ft

export type GradeId = 'basic' | 'standard' | 'premium';
export const GRADES: GradeId[] = ['basic', 'standard', 'premium'];

export interface RateItem {
  id: string;
  group: 'Structure' | 'Walls' | 'Finishes' | 'Doors & windows' | 'Fittings' | 'Services';
  label: string;
  unit: 'sq ft' | 'm²' | 'm³' | 'no.' | 'rm' | 'set' | 'point';
  grades: Record<GradeId, { name: string; rate: number }>;
  /** The budget agent may step this item down a grade. */
  flexible: boolean;
}

const g = (b: [string, number], s: [string, number], p: [string, number]) => ({
  basic: { name: b[0], rate: b[1] },
  standard: { name: s[0], rate: s[1] },
  premium: { name: p[0], rate: p[1] },
});

export const RATE_CARD: RateItem[] = [
  { id: 'structure', group: 'Structure', label: 'RCC frame, foundation and roof slab', unit: 'sq ft', grades: g(['Standard design', 950], ['Good design', 1100], ['Premium design', 1300]), flexible: false },
  { id: 'wall-230', group: 'Walls', label: 'Outer walls, 230 mm', unit: 'm³', grades: g(['AAC blocks', 5200], ['Red brick', 6500], ['Wire-cut brick', 7400]), flexible: false },
  { id: 'wall-115', group: 'Walls', label: 'Inside walls, 115 mm', unit: 'm²', grades: g(['AAC blocks', 750], ['Red brick', 950], ['Wire-cut brick', 1100]), flexible: false },
  { id: 'plaster-in', group: 'Walls', label: 'Plaster, inside', unit: 'm²', grades: g(['12 mm cement', 320], ['12 mm cement, smooth', 380], ['Gypsum plaster', 450]), flexible: false },
  { id: 'plaster-out', group: 'Walls', label: 'Plaster, outside', unit: 'm²', grades: g(['20 mm cement', 420], ['20 mm, waterproofed', 480], ['20 mm, textured', 560]), flexible: false },
  { id: 'floor', group: 'Finishes', label: 'Flooring (dry rooms)', unit: 'm²', grades: g(['Ceramic tiles', 750], ['Vitrified tiles', 1100], ['Large vitrified / granite', 1600]), flexible: true },
  { id: 'floor-wet', group: 'Finishes', label: 'Toilet flooring, anti-skid', unit: 'm²', grades: g(['Ceramic anti-skid', 800], ['Vitrified anti-skid', 1000], ['Designer anti-skid', 1300]), flexible: true },
  { id: 'dado', group: 'Finishes', label: 'Wall tiles (toilets 7\', kitchen 2\')', unit: 'm²', grades: g(['Ceramic', 800], ['Glazed vitrified', 1050], ['Designer tiles', 1500]), flexible: true },
  { id: 'paint-in', group: 'Finishes', label: 'Painting inside (walls and ceilings)', unit: 'm²', grades: g(['Distemper', 160], ['Putty and emulsion', 220], ['Premium emulsion', 320]), flexible: true },
  { id: 'paint-out', group: 'Finishes', label: 'Painting outside', unit: 'm²', grades: g(['Cement paint', 200], ['Exterior emulsion', 260], ['Weatherproof premium', 350]), flexible: true },
  { id: 'door-main', group: 'Doors & windows', label: 'Main door', unit: 'no.', grades: g(['Hardwood frame, flush', 25000], ['Teak frame, teak-ply', 45000], ['Solid teak, carved', 80000]), flexible: true },
  { id: 'door', group: 'Doors & windows', label: 'Room doors', unit: 'no.', grades: g(['Flush door, laminate', 9000], ['Flush door, veneer', 14000], ['Membrane / solid wood', 22000]), flexible: true },
  { id: 'door-toilet', group: 'Doors & windows', label: 'Toilet doors', unit: 'no.', grades: g(['PVC', 6500], ['WPC', 9000], ['Flush, laminated', 14000]), flexible: true },
  { id: 'window', group: 'Doors & windows', label: 'Windows and ventilators', unit: 'm²', grades: g(['Aluminium', 4500], ['UPVC', 6500], ['UPVC, toughened glass', 9500]), flexible: true },
  { id: 'sanitary', group: 'Fittings', label: 'Toilet sanitaryware and fittings', unit: 'set', grades: g(['Basic brands', 22000], ['Mid-range brands', 40000], ['Premium brands', 75000]), flexible: true },
  { id: 'kitchen', group: 'Fittings', label: 'Kitchen counter with sink', unit: 'rm', grades: g(['Black granite, steel sink', 6500], ['Granite, quartz sink', 9000], ['Quartz top, premium sink', 14000]), flexible: true },
  { id: 'electrical', group: 'Services', label: 'Electrical wiring, switches, lights', unit: 'sq ft', grades: g(['Basic', 110], ['Modular switches', 140], ['Premium modular', 190]), flexible: true },
  { id: 'plumbing', group: 'Services', label: 'Plumbing per wet room (supply, drains)', unit: 'point', grades: g(['CPVC / PVC', 35000], ['CPVC, better fittings', 50000], ['Premium concealed', 70000]), flexible: false },
];

export interface Costing {
  grades?: Partial<Record<string, GradeId>>;
  /** Custom rates (₹ per unit) that override the grade's rate. */
  rates?: Partial<Record<string, number>>;
  budget?: number;
  contingencyPct?: number;
}

export interface Quantities {
  builtUpSqft: number;
  wall230M3: number;
  wall115M2: number;
  plasterInM2: number;
  plasterOutM2: number;
  floorM2: number;
  floorWetM2: number;
  dadoM2: number;
  paintInM2: number;
  paintOutM2: number;
  mainDoors: number;
  doors: number;
  toiletDoors: number;
  windowM2: number;
  toilets: number;
  counterRm: number;
  wetRooms: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Rooms either side of a wall (fixed walls by bounds, block sides by owner). */
function roomsOnWall(model: BuildingModel, wallId: string): Room[] {
  const blk = parseBlockWallId(wallId);
  if (blk) return model.rooms.filter((r) => r.id === blk.roomId);
  return model.rooms.filter((r) => !r.block && Object.values(r.bounds).includes(wallId));
}

export function measure(model: BuildingModel): Quantities {
  const H = FLOOR_HEIGHT;
  const ext = model.walls.filter((w) => w.kind === 'external');
  let builtUp = 0;
  if (ext.length) {
    const t = Math.max(...ext.map((w) => w.thickness)) / 2;
    const xs = ext.flatMap((w) => [w.a.x, w.b.x]);
    const ys = ext.flatMap((w) => [w.a.y, w.b.y]);
    builtUp = (Math.max(...xs) - Math.min(...xs) + 2 * t) * (Math.max(...ys) - Math.min(...ys) + 2 * t);
  }
  const openingArea = (wallId: string) => model.openings.filter((o) => o.wallId === wallId && o.kind !== 'opening').reduce((a, o) => a + o.width * o.height, 0) + model.openings.filter((o) => o.wallId === wallId && o.kind === 'opening').reduce((a, o) => a + o.width * 2100, 0);

  let v230 = 0;
  let a115 = 0;
  let plasterIn = 0;
  let plasterOut = 0;
  for (const w of model.walls) {
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const net = Math.max(0, len * H - openingArea(w.id));
    if (w.thickness >= 200) v230 += net * w.thickness;
    else a115 += net;
    if (w.kind === 'external') {
      plasterIn += net;
      plasterOut += net;
    } else plasterIn += 2 * net;
  }
  for (const { id, rect } of blockWallRects(model)) {
    const len = Math.max(rect.x1 - rect.x0, rect.y1 - rect.y0);
    const t = Math.min(rect.x1 - rect.x0, rect.y1 - rect.y0);
    const net = Math.max(0, len * H - openingArea(id));
    if (t >= 200) v230 += net * t;
    else a115 += net;
    plasterIn += 2 * net;
  }

  let floor = 0;
  let floorWet = 0;
  let ceiling = 0;
  let dado = 0;
  for (const r of model.rooms) {
    const c = roomClearRect(model, r);
    const area = !r.block && model.rooms.some((x) => x.block) ? openArea(model, r) : (c.x1 - c.x0) * (c.y1 - c.y0);
    ceiling += area;
    if (r.kind === 'toilet' || r.kind === 'service') {
      floorWet += area;
      dado += 2 * (c.x1 - c.x0 + c.y1 - c.y0) * 2134 - 760 * 2100;
    } else floor += area;
  }
  const counters = model.furniture.filter((f) => f.catalogueId === 'kitchen-counter');
  const counterMm = counters.length * 2400;
  dado += counterMm * 610;

  let mainDoors = 0;
  let doors = 0;
  let toiletDoors = 0;
  let windowArea = 0;
  for (const o of model.openings) {
    const wall = model.walls.find((w) => w.id === o.wallId);
    if (o.kind === 'window' || o.kind === 'sliding') {
      windowArea += o.width * o.height;
      continue;
    }
    if (o.kind !== 'door') continue;
    if (wall?.kind === 'external' && !o.wallId.startsWith('blk:')) {
      const inner = roomsOnWall(model, o.wallId);
      if (inner.some((r) => r.kind === 'toilet')) toiletDoors++;
      else mainDoors++;
      continue;
    }
    const rooms = roomsOnWall(model, o.wallId);
    if (rooms.some((r) => r.kind === 'lobby' || r.kind === 'stair' || r.kind === 'lift') || /entrance|main door|entry/i.test(o.label)) {
      mainDoors++;
      continue;
    }
    if (rooms.some((r) => r.kind === 'toilet') || /toilet|bath|wc/i.test(o.label)) toiletDoors++;
    else doors++;
  }
  const toilets = model.rooms.filter((r) => r.kind === 'toilet').length;
  const wetRooms = model.rooms.filter((r) => r.kind === 'toilet' || r.kind === 'kitchen' || r.kind === 'service').length;
  return {
    builtUpSqft: Math.round(builtUp / SQFT),
    wall230M3: r2(v230 / 1e9),
    wall115M2: r2(a115 / 1e6),
    plasterInM2: r2(plasterIn / 1e6),
    plasterOutM2: r2(plasterOut / 1e6),
    floorM2: r2(floor / 1e6),
    floorWetM2: r2(floorWet / 1e6),
    dadoM2: r2(Math.max(0, dado) / 1e6),
    paintInM2: r2((plasterIn + ceiling) / 1e6),
    paintOutM2: r2(plasterOut / 1e6),
    mainDoors,
    doors,
    toiletDoors,
    windowM2: r2(windowArea / 1e6),
    toilets,
    counterRm: r2(counterMm / 1000),
    wetRooms,
  };
}

const QTY: Record<string, (q: Quantities) => number> = {
  structure: (q) => q.builtUpSqft,
  'wall-230': (q) => q.wall230M3,
  'wall-115': (q) => q.wall115M2,
  'plaster-in': (q) => q.plasterInM2,
  'plaster-out': (q) => q.plasterOutM2,
  floor: (q) => q.floorM2,
  'floor-wet': (q) => q.floorWetM2,
  dado: (q) => q.dadoM2,
  'paint-in': (q) => q.paintInM2,
  'paint-out': (q) => q.paintOutM2,
  'door-main': (q) => q.mainDoors,
  door: (q) => q.doors,
  'door-toilet': (q) => q.toiletDoors,
  window: (q) => q.windowM2,
  sanitary: (q) => q.toilets,
  kitchen: (q) => q.counterRm,
  electrical: (q) => q.builtUpSqft,
  plumbing: (q) => q.wetRooms,
};

export interface BoqLine {
  id: string;
  group: RateItem['group'];
  label: string;
  unit: RateItem['unit'];
  qty: number;
  grade: GradeId;
  gradeName: string;
  rate: number;
  custom: boolean;
  amount: number;
}

export interface Boq {
  lines: BoqLine[];
  subtotal: number;
  contingencyPct: number;
  contingency: number;
  total: number;
  builtUpSqft: number;
  perSqft: number;
  budget?: number;
}

export function readCosting(model: BuildingModel): Costing {
  return model.costing ?? {};
}

export function costPlan(model: BuildingModel, costing: Costing = readCosting(model)): Boq {
  const q = measure(model);
  const lines: BoqLine[] = RATE_CARD.map((it) => {
    const grade = costing.grades?.[it.id] ?? 'standard';
    const custom = costing.rates?.[it.id];
    const rate = custom ?? it.grades[grade].rate;
    const qty = QTY[it.id]!(q);
    return { id: it.id, group: it.group, label: it.label, unit: it.unit, qty, grade, gradeName: custom !== undefined ? 'Custom rate' : it.grades[grade].name, rate, custom: custom !== undefined, amount: Math.round(qty * rate) };
  });
  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  const contingencyPct = costing.contingencyPct ?? 5;
  const contingency = Math.round((subtotal * contingencyPct) / 100);
  const total = subtotal + contingency;
  return { lines, subtotal, contingencyPct, contingency, total, builtUpSqft: q.builtUpSqft, perSqft: q.builtUpSqft ? Math.round(total / q.builtUpSqft) : 0, budget: costing.budget };
}

/** ₹ in Indian style: ₹48.6 L, ₹1.2 Cr, ₹45,000. */
export function formatInr(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? '−' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(1)} L`;
  return `${s}₹${Math.round(a).toLocaleString('en-IN')}`;
}

export interface BudgetStep {
  id: string;
  label: string;
  from: string;
  to: string;
  saves: number;
}

export interface BudgetPlan {
  budget: number;
  before: number;
  after: number;
  steps: BudgetStep[];
  grades: Record<string, GradeId>;
  met: boolean;
  /** Still over budget: how much, and roughly how many sq ft less built-up would close it. */
  gap: number;
  sqftToCut: number;
}

/**
 * Fit my budget: step finishes and fittings down one grade at a time, the
 * biggest saving first, until the estimate is within budget. Structure,
 * walls, plaster and plumbing are left alone. Items with a custom rate
 * are left as the user set them.
 */
export function fitBudget(model: BuildingModel, budget: number): BudgetPlan {
  const costing = readCosting(model);
  const grades: Record<string, GradeId> = Object.fromEntries(RATE_CARD.map((it) => [it.id, costing.grades?.[it.id] ?? 'standard']));
  const at = () => costPlan(model, { ...costing, grades, budget });
  const before = at().total;
  const steps: BudgetStep[] = [];
  let now = before;
  while (now > budget) {
    let best: { it: RateItem; to: GradeId; saves: number } | undefined;
    for (const it of RATE_CARD) {
      if (!it.flexible || costing.rates?.[it.id] !== undefined) continue;
      const k = GRADES.indexOf(grades[it.id]!);
      if (k <= 0) continue;
      const to = GRADES[k - 1]!;
      const was = grades[it.id]!;
      grades[it.id] = to;
      const saves = now - at().total;
      grades[it.id] = was;
      if (saves > 0 && (!best || saves > best.saves)) best = { it, to, saves };
    }
    if (!best) break;
    steps.push({ id: best.it.id, label: best.it.label, from: best.it.grades[grades[best.it.id]!].name, to: best.it.grades[best.to].name, saves: best.saves });
    grades[best.it.id] = best.to;
    now = at().total;
  }
  // One line per item, from where it started to where it ended.
  const merged: BudgetStep[] = [];
  for (const st of steps) {
    const m = merged.find((x) => x.id === st.id);
    if (m) {
      m.to = st.to;
      m.saves += st.saves;
    } else merged.push({ ...st });
  }
  steps.splice(0, steps.length, ...merged.sort((a, b) => b.saves - a.saves));
  const end = at();
  const gap = Math.max(0, end.total - budget);
  return { budget, before, after: end.total, steps, grades, met: gap === 0, gap, sqftToCut: gap && end.perSqft ? Math.ceil(gap / end.perSqft) : 0 };
}
