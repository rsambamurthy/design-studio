/**
 * Orientation and geometry. Compass words are resolved ONLY here, through the
 * model's north angle, so "east" always means the same thing everywhere.
 */
import { ModelError, getWall, type BuildingModel, type Mm, type Point, type Room, type Wall } from './model';

export type Compass = 'north' | 'south' | 'east' | 'west';

const BEARING: Record<Compass, number> = { north: 0, east: 90, south: 180, west: 270 };

/** Unit vector in plan coordinates (y down) for a compass direction. */
export function compassVector(dir: Compass, northAngle: number): Point {
  const rad = ((BEARING[dir] + northAngle) * Math.PI) / 180;
  return { x: round6(Math.sin(rad)), y: round6(-Math.cos(rad)) };
}

/** The compass direction closest to a plan vector. */
export function vectorToCompass(v: Point, northAngle: number): Compass {
  let best: Compass = 'north';
  let bestDot = -Infinity;
  for (const dir of Object.keys(BEARING) as Compass[]) {
    const c = compassVector(dir, northAngle);
    const d = c.x * v.x + c.y * v.y;
    if (d > bestDot) {
      bestDot = d;
      best = dir;
    }
  }
  return best;
}

/** Compass name of the plan-up side, plan-down side, etc. for messages. */
export function planSideCompass(side: 'top' | 'bottom' | 'left' | 'right', northAngle: number): Compass {
  const v = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[side];
  return vectorToCompass(v, northAngle);
}

export function wallLength(w: Wall): Mm {
  return Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
}

export function wallDir(w: Wall): Point {
  const len = wallLength(w);
  if (len === 0) throw new ModelError(`Wall ${w.id} has zero length`);
  return { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len };
}

export function isHorizontal(w: Wall): boolean {
  return Math.abs(w.a.y - w.b.y) < 1;
}

export function isVertical(w: Wall): boolean {
  return Math.abs(w.a.x - w.b.x) < 1;
}

export function pointOnWall(w: Wall, offset: Mm): Point {
  const d = wallDir(w);
  return { x: w.a.x + d.x * offset, y: w.a.y + d.y * offset };
}

export interface Rect {
  x0: Mm;
  y0: Mm;
  x1: Mm;
  y1: Mm;
}

/**
 * Clear (inside face to inside face) rectangle of a room, from its bound walls.
 * "Clear" is the default dimension basis for room sizes.
 */
export function roomClearRect(model: BuildingModel, room: Room): Rect {
  const top = getWall(model, room.bounds.top);
  const bottom = getWall(model, room.bounds.bottom);
  const left = getWall(model, room.bounds.left);
  const right = getWall(model, room.bounds.right);
  return {
    x0: left.a.x + left.thickness / 2,
    x1: right.a.x - right.thickness / 2,
    y0: top.a.y + top.thickness / 2,
    y1: bottom.a.y - bottom.thickness / 2,
  };
}

/** Centre-to-centre rectangle (wall axes). */
export function roomAxisRect(model: BuildingModel, room: Room): Rect {
  return {
    x0: getWall(model, room.bounds.left).a.x,
    x1: getWall(model, room.bounds.right).a.x,
    y0: getWall(model, room.bounds.top).a.y,
    y1: getWall(model, room.bounds.bottom).a.y,
  };
}

export function rectSize(r: Rect): { w: Mm; h: Mm } {
  return { w: r.x1 - r.x0, h: r.y1 - r.y0 };
}

export function rectsOverlap(a: Rect, b: Rect, tol = 0): boolean {
  return a.x0 < b.x1 - tol && a.x1 > b.x0 + tol && a.y0 < b.y1 - tol && a.y1 > b.y0 + tol;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
