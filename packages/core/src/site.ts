/**
 * Site geometry: the building footprint on the plot, the buildable area inside
 * the setbacks, and conversions between compass words and plan sides.
 */
import { compassVector, planSideCompass, type Compass, type Rect } from './geometry';
import { ModelError, type BuildingModel, type PlanSide, type Point, type Site } from './model';

export const PLAN_SIDES: PlanSide[] = ['top', 'bottom', 'left', 'right'];

/** Plan side of the plot that faces a compass direction. Needs north along a plan edge. */
export function compassToSide(dir: Compass, northAngle: number): PlanSide {
  const side = PLAN_SIDES.find((s) => planSideCompass(s, northAngle) === dir);
  if (!side) throw new ModelError(`The ${dir} side isn't along a plot edge at this north angle.`);
  const v = compassVector(dir, northAngle);
  if (Math.abs(Math.abs(v.x) - Math.abs(v.y)) < 0.2) {
    throw new ModelError('Plot sides need north pointing along a plan edge (0°, 90°, 180° or 270°) for now.');
  }
  return side;
}

export function sideToCompass(side: PlanSide, northAngle: number): Compass {
  return planSideCompass(side, northAngle);
}

/** True when east–west runs left–right on the plan. */
export function eastWestIsPlanX(northAngle: number): boolean {
  const e = compassVector('east', northAngle);
  return Math.abs(e.x) > Math.abs(e.y);
}

/** Building outer faces (walls' outside faces), in building coordinates. */
export function buildingOuterRect(model: BuildingModel): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const w of model.walls) {
    const t = w.thickness / 2;
    x0 = Math.min(x0, w.a.x - t, w.b.x - t);
    y0 = Math.min(y0, w.a.y - t, w.b.y - t);
    x1 = Math.max(x1, w.a.x + t, w.b.x + t);
    y1 = Math.max(y1, w.a.y + t, w.b.y + t);
  }
  return { x0, y0, x1, y1 };
}

/** Building outer footprint in plot coordinates. */
export function footprintOnPlot(model: BuildingModel, site: Site): Rect {
  const r = buildingOuterRect(model);
  const o = site.buildingOffset;
  return { x0: r.x0 + o.x, x1: r.x1 + o.x, y0: r.y0 + o.y, y1: r.y1 + o.y };
}

/** The area inside the setbacks, in plot coordinates. */
export function buildableRect(site: Site): Rect {
  const s = site.setbacks;
  return { x0: s.left, y0: s.top, x1: site.plot.width - s.right, y1: site.plot.depth - s.bottom };
}

/** Clear distance from the building's outer face to each plot edge. */
export function boundaryGaps(model: BuildingModel, site: Site): Record<PlanSide, number> {
  const f = footprintOnPlot(model, site);
  return { top: f.y0, left: f.x0, right: site.plot.width - f.x1, bottom: site.plot.depth - f.y1 };
}

export type TreePosition =
  | 'north-west corner'
  | 'north-east corner'
  | 'south-west corner'
  | 'south-east corner'
  | 'north side'
  | 'south side'
  | 'east side'
  | 'west side'
  | 'centre';

export const TREE_POSITIONS: TreePosition[] = [
  'north-west corner',
  'north-east corner',
  'south-west corner',
  'south-east corner',
  'north side',
  'south side',
  'east side',
  'west side',
  'centre',
];

/** Plot point for a named position, `inset` in from the boundary. */
export function namedPlotPoint(site: Site, pos: TreePosition, inset: number, northAngle: number): Point {
  const W = site.plot.width;
  const D = site.plot.depth;
  const along = (side: PlanSide): Partial<Point> =>
    side === 'top' ? { y: inset } : side === 'bottom' ? { y: D - inset } : side === 'left' ? { x: inset } : { x: W - inset };
  const centre = { x: W / 2, y: D / 2 };
  if (pos === 'centre') return centre;
  const words = pos.replace(/ (corner|side)$/, '').split('-') as Compass[];
  let p: Point = { ...centre };
  for (const w of words) p = { ...p, ...along(compassToSide(w, northAngle)) };
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** Does a circle overlap a rectangle? */
export function circleHitsRect(c: Point, r: number, rect: Rect): boolean {
  const nx = Math.max(rect.x0, Math.min(c.x, rect.x1));
  const ny = Math.max(rect.y0, Math.min(c.y, rect.y1));
  return (c.x - nx) ** 2 + (c.y - ny) ** 2 < r * r;
}
