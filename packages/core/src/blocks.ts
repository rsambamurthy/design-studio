/**
 * Movable room blocks. A block room has its own rectangle (wall centre lines)
 * and own walls; it sits inside the outer walls and can be moved or resized as
 * one piece. The open space left over belongs to the remainder room(s), usually
 * living/dining. Doors on a block's sides travel with it; windows on outer
 * walls stay with the façade.
 */
import { pointOnWall, roomAxisRect, roomClearRect, wallDir, type Rect } from './geometry';
import {
  ModelError,
  blockBounds,
  blockWallId,
  fixedWallUnder,
  getWall,
  parseBlockWallId,
  type BuildingModel,
  type Opening,
  type PlanSide,
  type Point,
  type Room,
} from './model';

export const BLOCK_WALL = 115; // 4½"
const SIDES = ['top', 'bottom', 'left', 'right'] as const;
const OPP: Record<PlanSide, PlanSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
/** Distance within which a moved block snaps to a wall line. */
export const BLOCK_SNAP = 300;

export const isBlock = (r: Room | undefined): r is Room & { block: NonNullable<Room['block']> } => !!r?.block;

/** Which room an opening's wall belongs to, when it's on a block side. */
export function openingBlock(model: BuildingModel, o: Opening): { room: Room; side: PlanSide } | undefined {
  const p = parseBlockWallId(o.wallId);
  if (!p) return undefined;
  const room = model.rooms.find((r) => r.id === p.roomId);
  return room ? { room, side: p.side } : undefined;
}

/** Physical centre of every opening on a block's sides. */
function openingPoints(model: BuildingModel, room: Room): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const o of model.openings) {
    const p = parseBlockWallId(o.wallId);
    if (p?.roomId === room.id) out.set(o.id, pointOnWall(getWall(model, o.wallId), o.offset));
  }
  return out;
}

/** Re-project openings to keep their physical position after a block's rectangle changed (sides that moved carry their openings). */
function restoreOpenings(model: BuildingModel, room: Room, before: Map<string, Point>, moved: Partial<Record<PlanSide, number>>) {
  for (const o of model.openings) {
    const p = parseBlockWallId(o.wallId);
    if (p?.roomId !== room.id) continue;
    const at = before.get(o.id);
    if (!at) continue;
    const w = getWall(model, o.wallId);
    const d = wallDir(w);
    const shift = moved[p.side] ?? 0;
    const q = p.side === 'top' || p.side === 'bottom' ? { x: at.x, y: at.y + shift } : { x: at.x + shift, y: at.y };
    o.offset = Math.round((q.x - w.a.x) * d.x + (q.y - w.a.y) * d.y);
  }
}

/** Move a block by (dx, dy), with its doors, furniture, stairs and lifts. */
export function translateBlock(model: BuildingModel, room: Room, dx: number, dy: number) {
  const b = room.block!;
  room.block = { ...b, x0: b.x0 + dx, x1: b.x1 + dx, y0: b.y0 + dy, y1: b.y1 + dy };
  for (const f of model.furniture) if (f.roomId === room.id) f.at = { x: f.at.x + dx, y: f.at.y + dy };
  for (const c of model.cores ?? []) if (c.roomId === room.id) c.at = { x: c.at.x + dx, y: c.at.y + dy };
  // Opening offsets are measured from the side's start, which moved too: nothing to do.
}

/** Wall lines a block can snap to: fixed walls and other blocks' sides. */
function snapLines(model: BuildingModel, room: Room): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const w of model.walls) {
    if (Math.abs(w.a.y - w.b.y) < 1) ys.push(w.a.y);
    else xs.push(w.a.x);
  }
  for (const r of model.rooms) {
    if (r.id === room.id || !r.block) continue;
    xs.push(r.block.x0, r.block.x1);
    ys.push(r.block.y0, r.block.y1);
  }
  return { xs, ys };
}

/** Nudge a block so a side lands on a nearby wall line. Returns the shift applied. */
export function snapBlock(model: BuildingModel, room: Room, within = BLOCK_SNAP): { dx: number; dy: number } {
  const b = room.block!;
  const { xs, ys } = snapLines(model, room);
  const best = (edges: number[], lines: number[]) => {
    let pick = 0;
    let dist = within + 1;
    for (const e of edges) for (const l of lines) if (Math.abs(l - e) < dist) [dist, pick] = [Math.abs(l - e), l - e];
    return dist <= within ? pick : 0;
  };
  const dx = Math.round(best([b.x0, b.x1], xs));
  const dy = Math.round(best([b.y0, b.y1], ys));
  if (dx || dy) translateBlock(model, room, dx, dy);
  return { dx, dy };
}

/** Change one side of a block (axis moves by delta along plan x or y), keeping doors in place. */
export function resizeBlockSide(model: BuildingModel, room: Room, side: PlanSide, delta: number) {
  const b = room.block!;
  const before = openingPoints(model, room);
  const next = { ...b };
  if (side === 'top') next.y0 += delta;
  if (side === 'bottom') next.y1 += delta;
  if (side === 'left') next.x0 += delta;
  if (side === 'right') next.x1 += delta;
  if (next.x1 - next.x0 < 600 || next.y1 - next.y0 < 600) throw new ModelError(`${room.name} would be too small.`);
  room.block = next;
  restoreOpenings(model, room, before, { [side]: delta });
}

/** Blocks whose side coincides with this block side (same line, overlapping span), with their side. */
export function coincidentSides(model: BuildingModel, room: Room, side: PlanSide): { room: Room; side: PlanSide }[] {
  const b = room.block;
  if (!b) return [];
  const horizontal = side === 'top' || side === 'bottom';
  const axis = side === 'top' ? b.y0 : side === 'bottom' ? b.y1 : side === 'left' ? b.x0 : b.x1;
  const [lo, hi] = horizontal ? [b.x0, b.x1] : [b.y0, b.y1];
  const out: { room: Room; side: PlanSide }[] = [];
  for (const r of model.rooms) {
    if (r.id === room.id || !r.block) continue;
    const o = OPP[side];
    const rb = r.block;
    const rAxis = o === 'top' ? rb.y0 : o === 'bottom' ? rb.y1 : o === 'left' ? rb.x0 : rb.x1;
    const [rlo, rhi] = horizontal ? [rb.x0, rb.x1] : [rb.y0, rb.y1];
    if (Math.abs(rAxis - axis) <= 2 && Math.min(hi, rhi) - Math.max(lo, rlo) > 50) out.push({ room: r, side: o });
  }
  return out;
}

/**
 * Split a block in two: the new block takes `size` (clear) from `side`.
 * Doors, furniture, stairs and lifts in the part given away go with it.
 */
export function splitBlock(model: BuildingModel, room: Room, side: PlanSide, size: number, created: Room) {
  const b = room.block!;
  const t = b.thickness;
  const clear = roomClearRect(model, room);
  const axis = Math.round(
    side === 'left' ? clear.x0 + size + t / 2 : side === 'right' ? clear.x1 - size - t / 2 : side === 'top' ? clear.y0 + size + t / 2 : clear.y1 - size - t / 2,
  );
  const before = openingPoints(model, room);
  const newRect = { ...b };
  const oldRect = { ...b };
  if (side === 'left') [newRect.x1, oldRect.x0] = [axis, axis];
  if (side === 'right') [newRect.x0, oldRect.x1] = [axis, axis];
  if (side === 'top') [newRect.y1, oldRect.y0] = [axis, axis];
  if (side === 'bottom') [newRect.y0, oldRect.y1] = [axis, axis];
  room.block = oldRect;
  created.block = newRect;
  created.bounds = blockBounds(created.id);
  model.rooms.push(created);
  // Openings now on the new block's part go to its matching side.
  for (const o of model.openings) {
    const p = parseBlockWallId(o.wallId);
    if (p?.roomId !== room.id) continue;
    const at = before.get(o.id)!;
    const inside = (r: Rect) => at.x >= r.x0 - 1 && at.x <= r.x1 + 1 && at.y >= r.y0 - 1 && at.y <= r.y1 + 1;
    const target = p.side === side || (p.side !== OPP[side] && inside(newRect)) ? created : room;
    o.wallId = blockWallId(target.id, p.side);
    const w = getWall(model, o.wallId);
    const d = wallDir(w);
    o.offset = Math.round((at.x - w.a.x) * d.x + (at.y - w.a.y) * d.y);
  }
}

/** Plan side, as one of the four, of a block-relative direction. */
export { SIDES as BLOCK_SIDES };

/**
 * Turn a walls-first layout into blocks: every room except the remainder kinds
 * becomes a block at its current place; doors on inside walls move to the block
 * they belong to; the remainder rooms take the outer walls; inside walls go.
 */
export function toBlocks(input: BuildingModel, remainder: Room['kind'][] = ['living', 'dining']): BuildingModel {
  const m = structuredClone(input);
  const blocks = m.rooms.filter((r) => !remainder.includes(r.kind) && !r.block);
  const rects = new Map(blocks.map((r) => [r.id, roomAxisRect(m, r)]));
  const ext = m.walls.filter((w) => w.kind === 'external');
  const internal = new Set(m.walls.filter((w) => w.kind !== 'external').map((w) => w.id));

  // Doors and openings on inside walls: give them to a block side on that line.
  const moved: { o: Opening; roomId: string; side: PlanSide; at: Point; flip: boolean }[] = [];
  for (const o of m.openings) {
    if (!internal.has(o.wallId)) continue;
    const w = getWall(m, o.wallId);
    const at = pointOnWall(w, o.offset);
    const horizontal = Math.abs(w.a.y - w.b.y) < 1;
    const cands: { room: Room; side: PlanSide }[] = [];
    for (const r of blocks) {
      const rr = rects.get(r.id)!;
      for (const s of SIDES) {
        if ((s === 'top' || s === 'bottom') !== horizontal) continue;
        const axis = s === 'top' ? rr.y0 : s === 'bottom' ? rr.y1 : s === 'left' ? rr.x0 : rr.x1;
        const onLine = horizontal ? Math.abs(at.y - axis) < 2 && at.x > rr.x0 && at.x < rr.x1 : Math.abs(at.x - axis) < 2 && at.y > rr.y0 && at.y < rr.y1;
        if (onLine) cands.push({ room: r, side: s });
      }
    }
    if (cands.length === 0) continue;
    const named = cands.find((c) => o.label.toLowerCase().startsWith(`${c.room.name.toLowerCase()} `));
    const area = (r: Room) => {
      const rr = rects.get(r.id)!;
      return (rr.x1 - rr.x0) * (rr.y1 - rr.y0);
    };
    const pick = named ?? [...cands].sort((a, b) => area(a.room) - area(b.room))[0]!;
    const d = wallDir(w);
    // Block sides run left→right / top→bottom.
    const flip = horizontal ? d.x < 0 : d.y < 0;
    moved.push({ o, roomId: pick.room.id, side: pick.side, at, flip });
  }

  for (const r of blocks) {
    const rr = rects.get(r.id)!;
    r.block = { ...rr, thickness: BLOCK_WALL };
    r.bounds = blockBounds(r.id);
  }
  // Remainder rooms take the outer walls.
  const outer = {
    top: ext.filter((w) => Math.abs(w.a.y - w.b.y) < 1).sort((a, b) => a.a.y - b.a.y)[0],
    bottom: ext.filter((w) => Math.abs(w.a.y - w.b.y) < 1).sort((a, b) => b.a.y - a.a.y)[0],
    left: ext.filter((w) => Math.abs(w.a.x - w.b.x) < 1).sort((a, b) => a.a.x - b.a.x)[0],
    right: ext.filter((w) => Math.abs(w.a.x - w.b.x) < 1).sort((a, b) => b.a.x - a.a.x)[0],
  };
  for (const r of m.rooms) {
    if (r.block) continue;
    if (!outer.top || !outer.bottom || !outer.left || !outer.right) throw new ModelError('The layout needs four outer walls.');
    r.bounds = { top: outer.top.id, bottom: outer.bottom.id, left: outer.left.id, right: outer.right.id };
  }
  m.walls = m.walls.filter((w) => !internal.has(w.id));
  for (const { o, roomId, side, at, flip } of moved) {
    o.wallId = blockWallId(roomId, side);
    const w = getWall(m, o.wallId);
    const d = wallDir(w);
    o.offset = Math.round((at.x - w.a.x) * d.x + (at.y - w.a.y) * d.y);
    if (flip) {
      o.hinge = o.hinge === 'start' ? 'end' : 'start';
      o.swingSide = o.swingSide === 'left' ? 'right' : 'left';
    }
  }
  // Openings left on removed walls (between two remainder rooms) go.
  m.openings = m.openings.filter((o) => !internal.has(o.wallId));
  return m;
}

/** Wall pieces to draw for blocks: each side not lying on a fixed wall. Shared sides are drawn once. */
export function blockWallRects(model: BuildingModel): { id: string; rect: Rect }[] {
  const out: { id: string; rect: Rect }[] = [];
  const seen = new Set<string>();
  for (const r of model.rooms) {
    const b = r.block;
    if (!b) continue;
    const t = b.thickness;
    for (const s of SIDES) {
      if (fixedWallUnder(model, r, s)) continue;
      const rect =
        s === 'top' ? { x0: b.x0 - t / 2, x1: b.x1 + t / 2, y0: b.y0 - t / 2, y1: b.y0 + t / 2 }
        : s === 'bottom' ? { x0: b.x0 - t / 2, x1: b.x1 + t / 2, y0: b.y1 - t / 2, y1: b.y1 + t / 2 }
        : s === 'left' ? { x0: b.x0 - t / 2, x1: b.x0 + t / 2, y0: b.y0 - t / 2, y1: b.y1 + t / 2 }
        : { x0: b.x1 - t / 2, x1: b.x1 + t / 2, y0: b.y0 - t / 2, y1: b.y1 + t / 2 };
      const key = [rect.x0, rect.x1, rect.y0, rect.y1].map((v) => Math.round(v)).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: blockWallId(r.id, s), rect });
    }
  }
  return out;
}

/** True when two blocks overlap (clear areas), beyond a small tolerance. */
export function blocksOverlap(model: BuildingModel, a: Room, b: Room, tol = 5): boolean {
  const ra = roomClearRect(model, a);
  const rb = roomClearRect(model, b);
  return ra.x0 < rb.x1 - tol && ra.x1 > rb.x0 + tol && ra.y0 < rb.y1 - tol && ra.y1 > rb.y0 + tol;
}

/**
 * Make a block's clear size w × h, moving only sides that are free (not on a
 * fixed wall or against another block); if both sides on an axis are held, the
 * far side (right/bottom) gives.
 */
export function setBlockClearSize(model: BuildingModel, room: Room, w?: number, h?: number) {
  const anchored = (sd: PlanSide) => !!fixedWallUnder(model, room, sd) || coincidentSides(model, room, sd).length > 0;
  const fix = (axis: 'x' | 'y', target?: number) => {
    if (target === undefined) return;
    const r = roomClearRect(model, room);
    const have = axis === 'x' ? r.x1 - r.x0 : r.y1 - r.y0;
    const delta = Math.round(target - have);
    if (Math.abs(delta) < 1) return;
    const [lo, hi] = axis === 'x' ? (['left', 'right'] as const) : (['top', 'bottom'] as const);
    const side = anchored(hi) && !anchored(lo) ? lo : hi;
    resizeBlockSide(model, room, side, side === lo ? -delta : delta);
  };
  fix('x', w);
  fix('y', h);
}
