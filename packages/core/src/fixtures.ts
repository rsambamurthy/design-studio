/**
 * Default fixtures for wet rooms: a WC and wash basin (and a shower area when
 * there's room) in a toilet, a counter with sink and hob in a kitchen. They are
 * ordinary furniture items afterwards: movable, removable, checked.
 */
import { getCatalogueItem, itemFootprint } from './catalogue';
import { pointOnWall, rectsOverlap, roomClearRect, type Rect } from './geometry';
import { getWall, type BuildingModel, type FurnitureItem, type PlanSide, type Room } from './model';
import { roomOpeningsOn } from './kernel';

const SIDES = ['top', 'bottom', 'left', 'right'] as const;
const OPP: Record<PlanSide, PlanSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const ROT: Record<PlanSide, number> = { top: 0, right: 90, bottom: 180, left: 270 };

function newId(model: BuildingModel): string {
  const used = new Set(model.furniture.map((f) => f.id));
  let n = 1;
  while (used.has(`fx-${n}`)) n++;
  return `fx-${n}`;
}

/** Side the room's door is on (first door found), if any. */
function doorSide(model: BuildingModel, room: Room): PlanSide | undefined {
  return SIDES.find((s) => roomOpeningsOn(model, room, s).some((o) => o.kind === 'door' || o.kind === 'opening' || o.kind === 'sliding'));
}

/**
 * Place items in a row along one wall of a room, backs to the wall, starting
 * from the end `fromStart` (true = the wall's left/top end). Returns false if they don't fit.
 */
function row(model: BuildingModel, room: Room, side: PlanSide, ids: string[], fromStart: boolean, gap = 100): FurnitureItem[] | undefined {
  const r = roomClearRect(model, room);
  const horizontal = side === 'top' || side === 'bottom';
  const [lo, hi] = horizontal ? [r.x0, r.x1] : [r.y0, r.y1];
  const items = ids.map((id) => getCatalogueItem(id)!);
  const total = items.reduce((a, c) => a + c.width, 0) + gap * (items.length + 1);
  if (total > hi - lo + 1) return undefined;
  const out: FurnitureItem[] = [];
  let pos = fromStart ? lo + gap : hi - gap;
  for (const c of items) {
    const centreAlong = fromStart ? pos + c.width / 2 : pos - c.width / 2;
    pos = fromStart ? pos + c.width + gap : pos - c.width - gap;
    const depthAt = side === 'top' ? r.y0 + c.depth / 2 : side === 'bottom' ? r.y1 - c.depth / 2 : side === 'left' ? r.x0 + c.depth / 2 : r.x1 - c.depth / 2;
    const at = horizontal ? { x: Math.round(centreAlong), y: Math.round(depthAt) } : { x: Math.round(depthAt), y: Math.round(centreAlong) };
    const f: FurnitureItem = { id: '', catalogueId: c.id, label: c.name, roomId: room.id, at, rotation: ROT[side], mirrored: false };
    out.push(f);
  }
  return out;
}

/** Keep clear of the door swing and existing items. */
function clear(model: BuildingModel, room: Room, items: FurnitureItem[]): boolean {
  const taken: Rect[] = model.furniture.filter((f) => f.roomId === room.id).map(itemFootprint);
  for (const o of model.openings) {
    if (o.kind !== 'door') continue;
    const w = getWall(model, o.wallId);
    const p = pointOnWall(w, o.offset);
    // The leaf sweeps the door's width along the wall and the same distance into the room.
    const along = o.width / 2 + 50;
    const deep = o.width + w.thickness / 2 + 10;
    const horizontal = Math.abs(w.a.y - w.b.y) < 1;
    taken.push(horizontal ? { x0: p.x - along, x1: p.x + along, y0: p.y - deep, y1: p.y + deep } : { x0: p.x - deep, x1: p.x + deep, y0: p.y - along, y1: p.y + along });
  }
  return items.every((f) => !taken.some((t) => rectsOverlap(itemFootprint(f), t, 5)));
}

/** One fixture with its back to a wall, centred at `along` (clamped inside the room). */
function onWall(room: Room, r: Rect, side: PlanSide, id: string, along: number): FurnitureItem {
  const c = getCatalogueItem(id)!;
  const horizontal = side === 'top' || side === 'bottom';
  const [lo, hi] = horizontal ? [r.x0, r.x1] : [r.y0, r.y1];
  const a = Math.min(hi - c.width / 2 - 50, Math.max(lo + c.width / 2 + 50, along));
  const d = side === 'top' ? r.y0 + c.depth / 2 : side === 'bottom' ? r.y1 - c.depth / 2 : side === 'left' ? r.x0 + c.depth / 2 : r.x1 - c.depth / 2;
  return { id: '', catalogueId: c.id, label: c.name, roomId: room.id, at: horizontal ? { x: Math.round(a), y: Math.round(d) } : { x: Math.round(d), y: Math.round(a) }, rotation: ROT[side], mirrored: false };
}

/**
 * Toilet with a window or ventilator: the WC right below it, the shower on the
 * opposite wall, and the wash basin on a side wall midway between the two.
 */
function toiletByWindow(model: BuildingModel, room: Room): FurnitureItem[] | undefined {
  const r = roomClearRect(model, room);
  // With windows on two walls, use the one that leaves the door on a side wall (so the door faces the basin).
  const door0 = doorSide(model, room);
  const order = [...SIDES].sort((a, b) => Number(door0 !== undefined && OPP[a] === door0) - Number(door0 !== undefined && OPP[b] === door0) || Number(a === door0) - Number(b === door0));
  for (const side of order) {
    const win = roomOpeningsOn(model, room, side).find((o) => o.kind === 'window' || o.kind === 'sliding');
    if (!win) continue;
    const p = pointOnWall(getWall(model, win.wallId), win.offset);
    const horizontal = side === 'top' || side === 'bottom';
    const along = horizontal ? p.x : p.y;
    const depth = horizontal ? r.y1 - r.y0 : r.x1 - r.x0;
    const wc = onWall(room, r, side, 'wc-floor', along);
    const items: FurnitureItem[] = [wc];
    // The shower area runs wall to wall across one end of the toilet, inside its walls and clear of
    // the door opening: on the wall opposite the WC when the toilet is deep enough, else at the far
    // end of the window wall. (The door may swing over it; it is open floor.)
    const doorAt = doorSide(model, room);
    const [lo, hi] = horizontal ? [r.x0, r.x1] : [r.y0, r.y1];
    const farEnd: PlanSide = along - lo > hi - along ? (horizontal ? 'left' : 'top') : horizontal ? 'right' : 'bottom';
    const sh = (doorAt !== OPP[side] && depth >= 700 + 450 + 900 ? showerArea(model, room, r, OPP[side], [wc]) : undefined) ?? showerArea(model, room, r, farEnd, [wc]);
    if (sh) items.push(sh);
    // Basin on a side wall, half way between the window wall and the opposite wall.
    const mid = horizontal ? (r.y0 + r.y1) / 2 : (r.x0 + r.x1) / 2;
    const perp: PlanSide[] = horizontal ? ['left', 'right'] : ['top', 'bottom'];
    // A side wall without the door first.
    const door = doorSide(model, room);
    // You walk in facing the basin: straight across from the door first, then half way along a side wall.
    const dOpen = door ? roomOpeningsOn(model, room, door).find((o) => o.kind === 'door') : undefined;
    const dPt = dOpen ? pointOnWall(getWall(model, dOpen.wallId), dOpen.offset) : undefined;
    const tries: [PlanSide, number][] = [];
    if (door && dPt) tries.push([OPP[door], door === 'top' || door === 'bottom' ? dPt.x : dPt.y]);
    for (const ps of [...perp.filter((x) => x !== door), ...perp.filter((x) => x === door)]) tries.push([ps, mid]);
    let basin: FurnitureItem | undefined;
    for (const [ps, at] of tries) {
      const b = onWall(room, r, ps, 'wash-basin', at);
      const overlaps = items.some((f) => rectsOverlap(itemFootprint(f), itemFootprint(b), 5));
      if (!overlaps && clear(model, room, [b])) {
        basin = b;
        break;
      }
    }
    if (basin) items.push(basin);
    // The WC and basin must stay out of the door's swing (the shower area may not).
    if (!clear(model, room, [wc])) continue;
    return items.filter((f) => f.catalogueId === 'shower' || clear(model, room, [f]));
  }
  return undefined;
}

/**
 * A shower area against wall `end`, running the full clear length of that wall
 * (so it is bounded by the walls on both sides) and 900 deep, cut back so it
 * stops short of any door opening on the side walls and of the given items.
 */
function showerArea(model: BuildingModel, room: Room, r: Rect, end: PlanSide, avoid: FurnitureItem[]): FurnitureItem | undefined {
  const horizontal = end === 'top' || end === 'bottom';
  const span = horizontal ? r.x1 - r.x0 : r.y1 - r.y0;
  const sign = end === 'top' || end === 'left' ? 1 : -1;
  const base = end === 'top' ? r.y0 : end === 'bottom' ? r.y1 : end === 'left' ? r.x0 : r.x1;
  // Never in front of the way in.
  if (roomOpeningsOn(model, room, end).some((o) => o.kind === 'door' || o.kind === 'opening' || o.kind === 'sliding')) return undefined;
  let d = 900;
  // Door openings on the two side walls: stop the shower at the door's jamb.
  const sides: PlanSide[] = horizontal ? ['left', 'right'] : ['top', 'bottom'];
  for (const s of sides) {
    for (const o of roomOpeningsOn(model, room, s)) {
      if (o.kind !== 'door' && o.kind !== 'opening' && o.kind !== 'sliding') continue;
      const p = pointOnWall(getWall(model, o.wallId), o.offset);
      const at = horizontal ? p.y : p.x;
      const near = sign > 0 ? at - o.width / 2 - base : base - (at + o.width / 2);
      if (near < d && sign * (at - base) + o.width / 2 > 0) d = Math.min(d, Math.max(0, near));
    }
  }
  // Keep off the WC and anything else already placed.
  for (const f of avoid) {
    const q = itemFootprint(f);
    const overlapsAlong = horizontal ? q.x1 > r.x0 && q.x0 < r.x1 : q.y1 > r.y0 && q.y0 < r.y1;
    if (!overlapsAlong) continue;
    const near = end === 'top' ? q.y0 - base : end === 'bottom' ? base - q.y1 : end === 'left' ? q.x0 - base : base - q.x1;
    if (near > 0) d = Math.min(d, near - 50);
  }
  if (d < 750) return undefined;
  const mid = horizontal ? (r.x0 + r.x1) / 2 : (r.y0 + r.y1) / 2;
  const c = base + (sign * d) / 2;
  const at = horizontal ? { x: Math.round(mid), y: Math.round(c) } : { x: Math.round(c), y: Math.round(mid) };
  return { id: '', catalogueId: 'shower', label: 'Shower area', roomId: room.id, at, rotation: ROT[end], mirrored: false, size: { width: Math.round(span), depth: Math.round(d) } };
}

/** Add the standard fixtures to a toilet or kitchen that has none. Returns the items added. */
export function fitOutRoom(model: BuildingModel, room: Room): FurnitureItem[] {
  if (model.furniture.some((f) => f.roomId === room.id && getCatalogueItem(f.catalogueId)?.category === 'sanitary')) return [];
  if (room.kind === 'toilet') {
    const items = toiletByWindow(model, room);
    if (items) {
      for (const f of items) {
        f.id = newId(model);
        model.furniture.push(f);
      }
      return items;
    }
  }
  const r = roomClearRect(model, room);
  const len = (s: PlanSide) => (s === 'top' || s === 'bottom' ? r.x1 - r.x0 : r.y1 - r.y0);
  const door = doorSide(model, room);
  // Walls to try: opposite the door first, then the longer free walls.
  const order = [...SIDES].filter((s) => s !== door).sort((a, b) => Number(b === (door ? OPP[door] : a)) - Number(a === (door ? OPP[door] : b)) || len(b) - len(a));
  let sets: string[][];
  if (room.kind === 'toilet') {
    const big = (r.x1 - r.x0) * (r.y1 - r.y0) >= 1500 * 2000 && Math.max(r.x1 - r.x0, r.y1 - r.y0) >= 2000;
    sets = big ? [['wc-floor', 'wash-basin', 'shower'], ['wc-floor', 'wash-basin'], ['wc-floor']] : [['wc-floor', 'wash-basin'], ['wc-floor']];
  } else if (room.kind === 'kitchen') {
    sets = [['kitchen-counter']];
  } else return [];
  for (const ids of sets) {
    for (const side of order) {
      for (const fromStart of [true, false]) {
        const items = row(model, room, side, ids, fromStart);
        if (!items || !clear(model, room, items)) continue;
        // Front clearance must stay inside the room.
        const fits = items.every((f) => {
          const c = getCatalogueItem(f.catalogueId)!;
          const across = side === 'top' || side === 'bottom' ? r.y1 - r.y0 : r.x1 - r.x0;
          return c.depth + Math.min(c.frontClearance, 600) <= across + 1;
        });
        if (!fits) continue;
        for (const f of items) {
          f.id = newId(model);
          model.furniture.push(f);
        }
        return items;
      }
    }
  }
  return [];
}

/** Fit out every toilet and kitchen in a model (used for starting layouts). */
export function fitOutAll(model: BuildingModel): BuildingModel {
  const m = structuredClone(model);
  for (const r of m.rooms) if (r.kind === 'toilet' || r.kind === 'kitchen') fitOutRoom(m, r);
  return m;
}
