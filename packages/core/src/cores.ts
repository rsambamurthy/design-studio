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

/** Place a core in a room corner, turning it if that fits better. Throws if it can't fit. */
export function placeInCorner(model: BuildingModel, c: CoreElement, room: Room, corner: Corner) {
  const r = roomClearRect(model, room);
  const W = r.x1 - r.x0;
  const H = r.y1 - r.y0;
  for (const rot of [c.rotation, (c.rotation + 90) % 360]) {
    const q = (((Math.round(rot / 90) % 4) + 4) % 4);
    const [sx, sy] = q % 2 === 0 ? [c.width, c.length] : [c.length, c.width];
    if (sx <= W + 1 && sy <= H + 1) {
      c.rotation = rot;
      c.roomId = room.id;
      c.at = cornerPoint(model, room, corner, sx, sy);
      return;
    }
  }
  throw new ModelError(`The ${c.label.toLowerCase()} (${Math.round(c.width)} × ${Math.round(c.length)} mm) doesn't fit in ${room.name}.`);
}
