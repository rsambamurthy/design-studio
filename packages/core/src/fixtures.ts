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
  for (const side of SIDES) {
    const win = roomOpeningsOn(model, room, side).find((o) => o.kind === 'window' || o.kind === 'sliding');
    if (!win) continue;
    const p = pointOnWall(getWall(model, win.wallId), win.offset);
    const horizontal = side === 'top' || side === 'bottom';
    const along = horizontal ? p.x : p.y;
    const depth = horizontal ? r.y1 - r.y0 : r.x1 - r.x0;
    const wc = onWall(room, r, side, 'wc-floor', along);
    const items: FurnitureItem[] = [wc];
    // Shower on the opposite wall, facing the WC, if the WC's leg room still leaves space for it.
    // A shower area is open floor, so the door may swing over it.
    if (depth >= 700 + 450 + 900) {
      const sh = onWall(room, r, OPP[side], 'shower', along);
      if (!rectsOverlap(itemFootprint(sh), itemFootprint(wc), 5)) items.push(sh);
    }
    // Basin on a side wall, half way between the window wall and the opposite wall.
    const mid = horizontal ? (r.y0 + r.y1) / 2 : (r.x0 + r.x1) / 2;
    const perp: PlanSide[] = horizontal ? ['left', 'right'] : ['top', 'bottom'];
    // A side wall without the door first.
    const door = doorSide(model, room);
    const order = [...perp.filter((x) => x !== door), ...perp.filter((x) => x === door)];
    let basin: FurnitureItem | undefined;
    for (const ps of order) {
      const b = onWall(room, r, ps, 'wash-basin', mid);
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
