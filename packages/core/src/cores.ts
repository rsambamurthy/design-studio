/**
 * Stairs and lifts: sizing, footprints and placement in a room corner.
 * Sizes are typical residential values (advisory), not a structural design.
 */
import { roomClearRect, type Compass, type Rect } from './geometry';
import { ModelError, type BuildingModel, type CoreElement, type PlanSide, type Point, type Room } from './model';
import { compassToSide } from './site';

export const DEFAULT_FLOOR_HEIGHT = 3000; // 10'
export const MAX_RISER = 190;
export const TREAD = 250;

export function coresOf(m: BuildingModel): CoreElement[] {
  return m.cores ?? [];
}

/** Riser count, riser height and footprint for a stair. */
export function sizeStair(type: 'dog-legged' | 'straight', flightWidth: number, floorHeight: number) {
  const risers = Math.ceil(floorHeight / 165);
  const riser = Math.round(floorHeight / risers);
  const treads = risers - 1;
  if (type === 'dog-legged') {
    const perFlight = Math.ceil(treads / 2);
    return { risers, riser, tread: TREAD, width: flightWidth * 2 + 100, length: perFlight * TREAD + flightWidth };
  }
  // Straight flight with one mid landing.
  return { risers, riser, tread: TREAD, width: flightWidth, length: treads * TREAD + flightWidth };
}

/** Typical lift shaft sizes (mm) by capacity. */
export const LIFT_SHAFTS: Record<number, { w: number; d: number }> = {
  4: { w: 1500, d: 1500 },
  6: { w: 1700, d: 1800 },
  8: { w: 1900, d: 2000 },
};

/** Axis-aligned footprint (rotation in multiples of 90°). */
export function coreFootprint(c: CoreElement): Rect {
  const q = (((Math.round(c.rotation / 90) % 4) + 4) % 4);
  const [sx, sy] = q % 2 === 0 ? [c.width, c.length] : [c.length, c.width];
  return { x0: c.at.x - sx / 2, x1: c.at.x + sx / 2, y0: c.at.y - sy / 2, y1: c.at.y + sy / 2 };
}

export type Corner = 'north-west' | 'north-east' | 'south-west' | 'south-east';
export const CORNERS: Corner[] = ['north-west', 'north-east', 'south-west', 'south-east'];

/** Centre point that puts a footprint of sx × sy flush into a room's corner. */
export function cornerPoint(model: BuildingModel, room: Room, corner: Corner, sx: number, sy: number): Point {
  const r = roomClearRect(model, room);
  const [a, b] = corner.split('-') as [Compass, Compass];
  const sides = [compassToSide(a, model.northAngle), compassToSide(b, model.northAngle)];
  const has = (s: PlanSide) => sides.includes(s);
  const x = has('left') ? r.x0 + sx / 2 : has('right') ? r.x1 - sx / 2 : (r.x0 + r.x1) / 2;
  const y = has('top') ? r.y0 + sy / 2 : has('bottom') ? r.y1 - sy / 2 : (r.y0 + r.y1) / 2;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Plan side the core's entry (local front, +y) faces at a rotation. */
export function entrySide(rotation: number): PlanSide {
  const q = (((Math.round(rotation / 90) % 4) + 4) % 4);
  return (['bottom', 'left', 'top', 'right'] as const)[q]!;
}

/** Lift door width in the enclosure. */
export const LIFT_DOOR = 900;
const FLUSH = 15;

export interface Enclosure {
  /** Wall pieces (plan rectangles) on the sides not already against a room wall. */
  walls: Rect[];
  /** Body plus its own walls: what must stay clear of everything else. */
  outer: Rect;
  /** Side the entry faces, and whether a room wall blocks it. */
  entry: PlanSide;
  entryBlocked: boolean;
}

/** The core's own walls, given the room it stands in (sides flush with the room's walls get none). */
export function enclosureOf(model: BuildingModel, c: CoreElement): Enclosure {
  const b = coreFootprint(c);
  const entry = entrySide(c.rotation);
  const room = model.rooms.find((r) => r.id === c.roomId);
  const rr = room ? roomClearRect(model, room) : undefined;
  const flush: Record<PlanSide, boolean> = {
    top: !!rr && Math.abs(b.y0 - rr.y0) <= FLUSH,
    bottom: !!rr && Math.abs(b.y1 - rr.y1) <= FLUSH,
    left: !!rr && Math.abs(b.x0 - rr.x0) <= FLUSH,
    right: !!rr && Math.abs(b.x1 - rr.x1) <= FLUSH,
  };
  if (!c.enclosure) return { walls: [], outer: b, entry, entryBlocked: flush[entry] };
  const t = c.enclosure.thickness;
  const has = (s: PlanSide) => !flush[s] && !(s === entry && c.kind === 'stair');
  const outer = {
    x0: b.x0 - (has('left') ? t : 0),
    x1: b.x1 + (has('right') ? t : 0),
    y0: b.y0 - (has('top') ? t : 0),
    y1: b.y1 + (has('bottom') ? t : 0),
  };
  const walls: Rect[] = [];
  for (const s of ['top', 'bottom', 'left', 'right'] as const) {
    if (!has(s)) continue;
    const r =
      s === 'top' ? { x0: outer.x0, x1: outer.x1, y0: b.y0 - t, y1: b.y0 }
      : s === 'bottom' ? { x0: outer.x0, x1: outer.x1, y0: b.y1, y1: b.y1 + t }
      : s === 'left' ? { x0: b.x0 - t, x1: b.x0, y0: outer.y0, y1: outer.y1 }
      : { x0: b.x1, x1: b.x1 + t, y0: outer.y0, y1: outer.y1 };
    if (s === entry && c.kind === 'lift') {
      // Split the wall around a centred door.
      const horizontal = s === 'top' || s === 'bottom';
      const mid = horizontal ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2;
      const half = LIFT_DOOR / 2;
      if (horizontal) {
        walls.push({ ...r, x1: mid - half }, { ...r, x0: mid + half });
      } else {
        walls.push({ ...r, y1: mid - half }, { ...r, y0: mid + half });
      }
    } else walls.push(r);
  }
  return { walls, outer, entry, entryBlocked: flush[entry] };
}

/**
 * Place a core in a room corner. Tries each turn, preferring one whose entry
 * faces into the room, and leaves room for its own walls. Throws if it can't fit.
 */
export function placeInCorner(model: BuildingModel, c: CoreElement, room: Room, corner: Corner) {
  const r = roomClearRect(model, room);
  const W = r.x1 - r.x0;
  const H = r.y1 - r.y0;
  const t = c.enclosure?.thickness ?? 0;
  const [a, b2] = corner.split('-') as [Compass, Compass];
  const cornerSides = [compassToSide(a, model.northAngle), compassToSide(b2, model.northAngle)];
  const start = (((Math.round(c.rotation / 90) % 4) + 4) % 4) * 90;
  const turns = [0, 90, 180, 270].map((d) => (start + d) % 360);
  const fitting = turns.filter((rot) => {
    const q = rot / 90;
    const [sx, sy] = q % 2 === 0 ? [c.width, c.length] : [c.length, c.width];
    const needW = sx + (sx >= W - 1 ? 0 : t);
    const needH = sy + (sy >= H - 1 ? 0 : t);
    return needW <= W + 1 && needH <= H + 1;
  });
  const best = fitting.find((rot) => !cornerSides.includes(entrySide(rot))) ?? fitting[0];
  if (best === undefined) {
    throw new ModelError(`The ${c.label.toLowerCase()} (${Math.round(c.width)} × ${Math.round(c.length)} mm) doesn't fit in ${room.name}.`);
  }
  const q = best / 90;
  const [sx, sy] = q % 2 === 0 ? [c.width, c.length] : [c.length, c.width];
  c.rotation = best;
  c.roomId = room.id;
  c.at = cornerPoint(model, room, corner, sx, sy);
}

/**
 * After a stair or lift is moved: it belongs to the room its centre is in, and
 * snaps flush to a room wall when its own wall would otherwise clash with it.
 */
export function settleCore(model: BuildingModel, c: CoreElement) {
  // Room blocks sit on top of the open space, so a block wins over the room around it.
  const containing = model.rooms.filter((r) => {
    const rr = roomClearRect(model, r);
    return c.at.x >= rr.x0 && c.at.x <= rr.x1 && c.at.y >= rr.y0 && c.at.y <= rr.y1;
  });
  const inRoom = containing.find((r) => r.block) ?? containing[0];
  if (inRoom) c.roomId = inRoom.id;
  const room = model.rooms.find((r) => r.id === c.roomId);
  if (!room) return;
  const rr = roomClearRect(model, room);
  const b = coreFootprint(c);
  const snap = (c.enclosure?.thickness ?? 0) + 50;
  let dx = 0;
  let dy = 0;
  if (b.x0 - rr.x0 < snap) dx = rr.x0 - b.x0;
  else if (rr.x1 - b.x1 < snap) dx = rr.x1 - b.x1;
  if (b.y0 - rr.y0 < snap) dy = rr.y0 - b.y0;
  else if (rr.y1 - b.y1 < snap) dy = rr.y1 - b.y1;
  // Only snap when close (never drag a stair across the room).
  if (Math.abs(dx) > snap) dx = 0;
  if (Math.abs(dy) > snap) dy = 0;
  c.at = { x: Math.round(c.at.x + dx), y: Math.round(c.at.y + dy) };
}
