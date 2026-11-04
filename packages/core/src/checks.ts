/**
 * Validation engine (MVP subset): furniture fit, overlaps, front clearances,
 * door swings and typical minimum room sizes. Deterministic and geometric; the
 * LLM only explains results. Limits here are typical values, advisory only.
 */
import { getCatalogueItem, itemFootprint } from './catalogue';
import { rectSize, rectsOverlap, roomClearRect, wallDir, pointOnWall, type Rect } from './geometry';
import { getWall, type BuildingModel, type FurnitureItem, type Opening, type Point } from './model';
import { formatLength } from './units';

export type Severity = 'error' | 'warning' | 'advisory';

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  entityIds: string[];
  /** Where to draw a marker on the plan. */
  at?: Point;
}

/** Typical minimum clear width (mm) of the shorter side. Advisory only. */
const ROOM_MINIMUMS: Partial<Record<string, { minSide: number; label: string }>> = {
  bedroom: { minSide: 2700, label: 'bedroom' },
  toilet: { minSide: 1200, label: 'toilet' },
  kitchen: { minSide: 1800, label: 'kitchen' },
};

const OVERLAP_TOL = 5;

export function runChecks(model: BuildingModel): Issue[] {
  const issues: Issue[] = [];
  const u = model.displayUnits;

  for (const room of model.rooms) {
    const min = ROOM_MINIMUMS[room.kind];
    if (!min) continue;
    const { w, h } = rectSize(roomClearRect(model, room));
    const shorter = Math.min(w, h);
    if (shorter < min.minSide) {
      const r = roomClearRect(model, room);
      issues.push({
        code: 'room.min-size',
        severity: 'advisory',
        message: `${room.name} is ${formatLength(shorter, u)} wide; a ${min.label} is typically at least ${formatLength(min.minSide, u)}.`,
        entityIds: [room.id],
        at: centre(r),
      });
    }
  }

  const swings = model.openings.filter((o) => o.kind === 'door').map((o) => ({ o, rect: doorSwingRect(model, o) }));

  for (const f of model.furniture) {
    const room = model.rooms.find((r) => r.id === f.roomId);
    const fr = itemFootprint(f);
    const cat = getCatalogueItem(f.catalogueId);
    if (room) {
      const rr = roomClearRect(model, room);
      if (fr.x0 < rr.x0 - OVERLAP_TOL || fr.x1 > rr.x1 + OVERLAP_TOL || fr.y0 < rr.y0 - OVERLAP_TOL || fr.y1 > rr.y1 + OVERLAP_TOL) {
        issues.push({ code: 'item.outside-room', severity: 'error', message: `${f.label} does not fit inside ${room.name}.`, entityIds: [f.id, room.id], at: f.at });
      }
      if (cat && cat.frontClearance > 0) {
        const zone = frontZone(f, cat.frontClearance);
        const free = clearDepthInFront(model, f, rr);
        if (free < cat.frontClearance) {
          issues.push({
            code: 'item.front-clearance',
            severity: 'warning',
            message: `${f.label}: ${formatLength(Math.max(free, 0), u)} free in front (typical minimum ${formatLength(cat.frontClearance, u)}).`,
            entityIds: [f.id],
            at: centre(zone),
          });
        }
      }
    }
    for (const g of model.furniture) {
      if (g.id <= f.id) continue;
      if (rectsOverlap(fr, itemFootprint(g), OVERLAP_TOL)) {
        issues.push({ code: 'item.overlap', severity: 'error', message: `${f.label} overlaps ${g.label}.`, entityIds: [f.id, g.id], at: f.at });
      }
    }
    for (const { o, rect } of swings) {
      if (rectsOverlap(fr, rect, OVERLAP_TOL)) {
        issues.push({ code: 'door.swing-blocked', severity: 'warning', message: `${o.label} swing hits ${f.label}.`, entityIds: [o.id, f.id], at: centre(rect) });
      }
    }
  }

  return issues;
}

/** Square swept by a door leaf, on its swing side. */
export function doorSwingRect(model: BuildingModel, o: Opening): Rect {
  const wall = getWall(model, o.wallId);
  const d = wallDir(wall);
  const sideSign = o.swingSide === 'left' ? 1 : -1;
  const n = { x: d.y * sideSign, y: -d.x * sideSign };
  const p = pointOnWall(wall, o.offset);
  const face = wall.thickness / 2;
  const half = o.width / 2;
  const corners = [
    { x: p.x - d.x * half + n.x * face, y: p.y - d.y * half + n.y * face },
    { x: p.x + d.x * half + n.x * face, y: p.y + d.y * half + n.y * face },
    { x: p.x - d.x * half + n.x * (face + o.width), y: p.y - d.y * half + n.y * (face + o.width) },
    { x: p.x + d.x * half + n.x * (face + o.width), y: p.y + d.y * half + n.y * (face + o.width) },
  ];
  return bbox(corners);
}

/** Unit vector the item's front faces, in plan coordinates. */
export function frontVector(f: FurnitureItem): Point {
  const q = (((Math.round(f.rotation / 90) % 4) + 4) % 4);
  return [{ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }][q]!;
}

function frontZone(f: FurnitureItem, depth: number): Rect {
  const r = itemFootprint(f);
  const v = frontVector(f);
  if (v.y === 1) return { x0: r.x0, x1: r.x1, y0: r.y1, y1: r.y1 + depth };
  if (v.y === -1) return { x0: r.x0, x1: r.x1, y0: r.y0 - depth, y1: r.y0 };
  if (v.x === 1) return { x0: r.x1, x1: r.x1 + depth, y0: r.y0, y1: r.y1 };
  return { x0: r.x0 - depth, x1: r.x0, y0: r.y0, y1: r.y1 };
}

/** Free depth in front of an item, up to the room wall or the nearest other item. */
function clearDepthInFront(model: BuildingModel, f: FurnitureItem, room: Rect): number {
  const r = itemFootprint(f);
  const v = frontVector(f);
  let free =
    v.y === 1 ? room.y1 - r.y1 : v.y === -1 ? r.y0 - room.y0 : v.x === 1 ? room.x1 - r.x1 : r.x0 - room.x0;
  for (const g of model.furniture) {
    if (g.id === f.id || g.roomId !== f.roomId) continue;
    const gr = itemFootprint(g);
    const lateral = v.y !== 0 ? gr.x0 < r.x1 && gr.x1 > r.x0 : gr.y0 < r.y1 && gr.y1 > r.y0;
    if (!lateral) continue;
    const gap = v.y === 1 ? gr.y0 - r.y1 : v.y === -1 ? r.y0 - gr.y1 : v.x === 1 ? gr.x0 - r.x1 : r.x0 - gr.x1;
    if (gap >= -OVERLAP_TOL) free = Math.min(free, gap);
  }
  return Math.round(free);
}

function bbox(ps: Point[]): Rect {
  return {
    x0: Math.min(...ps.map((p) => p.x)),
    x1: Math.max(...ps.map((p) => p.x)),
    y0: Math.min(...ps.map((p) => p.y)),
    y1: Math.max(...ps.map((p) => p.y)),
  };
}

function centre(r: Rect): Point {
  return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 };
}

