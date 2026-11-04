/**
 * Validation engine (MVP subset): furniture fit, overlaps, front clearances,
 * door swings and typical minimum room sizes. Deterministic and geometric; the
 * LLM only explains results. Limits here are typical values, advisory only.
 */
import { getCatalogueItem, itemFootprint } from './catalogue';
import { rectSize, rectsOverlap, roomClearRect, wallDir, pointOnWall, type Rect } from './geometry';
import { fixedWallUnder, getWall, type BuildingModel, type FurnitureItem, type Opening, type PlanSide, type Point } from './model';
import { PLAN_SIDES, boundaryGaps, circleHitsRect, footprintOnPlot, sideToCompass } from './site';
import { MAX_RISER, coresOf, enclosureOf } from './cores';
import { blocksOverlap, coincidentSides } from './blocks';
import { roomOpeningsOn } from './kernel';
import { formatLength } from './units';

export type Severity = 'error' | 'warning' | 'advisory';

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  entityIds: string[];
  /** Where to draw a marker. */
  at?: Point;
  /** Coordinate space of `at`: the building plan (default) or the site plan. */
  space?: 'plan' | 'site';
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

  issues.push(...coreChecks(model, swings));
  issues.push(...plumbingChecks(model));
  issues.push(...blockChecks(model));
  issues.push(...siteChecks(model));
  return issues;
}

/** Stairs and lifts: inside their room, not overlapping, clear of door swings, sensible risers. */
function coreChecks(model: BuildingModel, swings: { o: Opening; rect: Rect }[]): Issue[] {
  const out: Issue[] = [];
  const u = model.displayUnits;
  const cores = coresOf(model);
  for (const c of cores) {
    const enc = enclosureOf(model, c);
    const fp = enc.outer;
    const room = model.rooms.find((r) => r.id === c.roomId);
    if (enc.entryBlocked) {
      out.push({
        code: 'core.entry-blocked',
        severity: 'warning',
        message: `The ${c.label.toLowerCase()}'s ${c.kind === 'lift' ? 'door' : 'entry'} faces a wall; turn it.`,
        entityIds: [c.id],
        at: c.at,
      });
    }
    if (room && room.kind !== c.kind && !c.enclosure) {
      out.push({
        code: 'core.own-room',
        severity: 'advisory',
        message: `The ${c.label.toLowerCase()} is inside ${room.name}. A ${c.kind === 'stair' ? 'staircase' : 'lift shaft'} is usually its own enclosed unit: split off a ${c.kind} room for it.`,
        entityIds: [c.id, room.id],
        at: c.at,
      });
    }
    if (room) {
      const rr = roomClearRect(model, room);
      if (fp.x0 < rr.x0 - OVERLAP_TOL || fp.x1 > rr.x1 + OVERLAP_TOL || fp.y0 < rr.y0 - OVERLAP_TOL || fp.y1 > rr.y1 + OVERLAP_TOL) {
        out.push({ code: 'core.outside-room', severity: 'error', message: `The ${c.label.toLowerCase()} doesn't fit inside ${room.name}.`, entityIds: [c.id, room.id], at: c.at });
      }
    }
    for (const d of cores) {
      if (d.id <= c.id) continue;
      if (rectsOverlap(fp, enclosureOf(model, d).outer, OVERLAP_TOL)) {
        out.push({ code: 'core.overlap', severity: 'error', message: `The ${c.label.toLowerCase()} overlaps the ${d.label.toLowerCase()}.`, entityIds: [c.id, d.id], at: c.at });
      }
    }
    for (const f of model.furniture) {
      if (rectsOverlap(fp, itemFootprint(f), OVERLAP_TOL)) {
        out.push({ code: 'core.furniture', severity: 'error', message: `${f.label} overlaps the ${c.label.toLowerCase()}.`, entityIds: [c.id, f.id], at: f.at });
      }
    }
    for (const { o, rect } of swings) {
      if (rectsOverlap(fp, rect, OVERLAP_TOL)) {
        out.push({ code: 'core.door-swing', severity: 'warning', message: `${o.label} swing hits the ${c.label.toLowerCase()}.`, entityIds: [o.id, c.id], at: c.at });
      }
    }
    if (c.stair && c.stair.riser > MAX_RISER) {
      out.push({ code: 'stair.riser', severity: 'warning', message: `Stair risers are ${formatLength(c.stair.riser, u)}; typically at most ${formatLength(MAX_RISER, u)}.`, entityIds: [c.id], at: c.at });
    }
  }
  return out;
}

/** Wet rooms (toilet, kitchen, service) should touch at least one plumbing or external wall. */
function plumbingChecks(model: BuildingModel): Issue[] {
  const out: Issue[] = [];
  for (const r of model.rooms) {
    if (!r.wet) continue;
    const walls = Object.values(r.bounds).map((id) => model.walls.find((w) => w.id === id));
    if (walls.some((w) => w && (w.kind === 'plumbing' || w.kind === 'external'))) continue;
    if (r.block) {
      // A block is fine against an outer wall, or back to back with another wet room.
      const sides = ['top', 'bottom', 'left', 'right'] as const;
      if (sides.some((sd) => fixedWallUnder(model, r, sd)?.kind === 'external')) continue;
      if (sides.some((sd) => coincidentSides(model, r, sd).some((c) => c.room.wet))) continue;
    }
    const c = roomClearRect(model, r);
    out.push({
      code: 'room.no-plumbing-wall',
      severity: 'advisory',
      message: `${r.name} has no plumbing or outer wall for pipes and drains; check the routing.`,
      entityIds: [r.id],
      at: { x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2 },
    });
  }
  return out;
}

/** Setbacks, plot fit, tree protection and passage width. */
export function siteChecks(model: BuildingModel): Issue[] {
  const site = model.site;
  if (!site) return [];
  const u = model.displayUnits;
  const out: Issue[] = [];
  const f = footprintOnPlot(model, site);
  const gaps = boundaryGaps(model, site);
  const mid = { x: (f.x0 + f.x1) / 2, y: (f.y0 + f.y1) / 2 };
  const edgePoint = (side: PlanSide) =>
    side === 'top' ? { x: mid.x, y: f.y0 } : side === 'bottom' ? { x: mid.x, y: f.y1 } : side === 'left' ? { x: f.x0, y: mid.y } : { x: f.x1, y: mid.y };

  for (const side of PLAN_SIDES) {
    const c = sideToCompass(side, model.northAngle);
    if (gaps[side] < -1) {
      out.push({ code: 'site.outside-plot', severity: 'error', message: `The building runs ${formatLength(-gaps[side], u)} past the ${c} boundary.`, entityIds: ['site'], at: edgePoint(side), space: 'site' });
    } else if (gaps[side] < site.setbacks[side] - 1) {
      out.push({
        code: 'site.setback',
        severity: 'error',
        message: `${cap(c)} setback: building is ${formatLength(Math.max(gaps[side], 0), u)} from the boundary; ${formatLength(site.setbacks[side], u)} required.`,
        entityIds: ['site'],
        at: edgePoint(side),
        space: 'site',
      });
    }
  }

  for (const a of site.access) {
    const c = sideToCompass(a.side, model.northAngle);
    if (a.kind === 'passage' && gaps[a.side] < a.width - 1) {
      out.push({
        code: 'site.access-blocked',
        severity: 'error',
        message: `The ${formatLength(a.width, u)} ${c} passage is narrowed to ${formatLength(Math.max(gaps[a.side], 0), u)} by the building.`,
        entityIds: ['site'],
        at: edgePoint(a.side),
        space: 'site',
      });
    }
  }

  for (const t of site.trees) {
    if (!t.keep) continue;
    if (circleHitsRect(t.at, t.protectRadius, f)) {
      out.push({ code: 'site.tree-conflict', severity: 'error', message: `The building is within ${formatLength(t.protectRadius, u)} of the ${t.label} trunk.`, entityIds: [t.id], at: t.at, space: 'site' });
    } else if (circleHitsRect(t.at, t.canopyRadius, f)) {
      out.push({ code: 'site.tree-canopy', severity: 'advisory', message: `The building is under the ${t.label} canopy; check roots and branches.`, entityIds: [t.id], at: t.at, space: 'site' });
    }
  }
  return out;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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


/** Room blocks: inside the outer walls, not overlapping each other, bedrooms with a window. */
function blockChecks(model: BuildingModel): Issue[] {
  const out: Issue[] = [];
  const blocks = model.rooms.filter((r) => r.block);
  if (blocks.length === 0) return out;
  const xs = model.walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = model.walls.flatMap((w) => [w.a.y, w.b.y]);
  const shell = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  const centre = (r: Rect) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });
  blocks.forEach((r, i) => {
    const b = r.block!;
    if (b.x0 < shell.x0 - 2 || b.x1 > shell.x1 + 2 || b.y0 < shell.y0 - 2 || b.y1 > shell.y1 + 2) {
      out.push({ code: 'block.outside', severity: 'error', message: `${r.name} sticks out of the building.`, entityIds: [r.id], at: centre(roomClearRect(model, r)) });
    }
    for (const o of blocks.slice(i + 1)) {
      if (blocksOverlap(model, r, o)) {
        const a = roomClearRect(model, r);
        const c = roomClearRect(model, o);
        const at = { x: (Math.max(a.x0, c.x0) + Math.min(a.x1, c.x1)) / 2, y: (Math.max(a.y0, c.y0) + Math.min(a.y1, c.y1)) / 2 };
        out.push({ code: 'block.overlap', severity: 'error', message: `${r.name} overlaps ${o.name}.`, entityIds: [r.id, o.id], at });
      }
    }
    if (r.kind === 'bedroom') {
      const sides = ['top', 'bottom', 'left', 'right'] as const;
      const hasWindow = sides.some((sd) => roomOpeningsOn(model, r, sd).some((x) => x.kind === 'window' || x.kind === 'sliding'));
      if (!hasWindow) {
        out.push({ code: 'room.no-window', severity: 'advisory', message: `${r.name} has no window; move it to an outer wall or add one.`, entityIds: [r.id], at: centre(roomClearRect(model, r)) });
      }
    }
  });
  // Stairs, lifts and furniture belong to the block they stand in.
  for (const c of model.cores ?? []) {
    const inBlock = blocks.find((r) => {
      const rr = roomClearRect(model, r);
      return c.at.x > rr.x0 && c.at.x < rr.x1 && c.at.y > rr.y0 && c.at.y < rr.y1;
    });
    const own = model.rooms.find((r) => r.id === c.roomId);
    if (inBlock && inBlock.id !== c.roomId && !own?.block) {
      out.push({ code: 'core.under-room', severity: 'error', message: `The ${c.label.toLowerCase()} is under ${inBlock.name}.`, entityIds: [c.id, inBlock.id], at: c.at });
    }
  }
  return out;
}
