/**
 * The brief: what the house must have, as checkable items. checkBrief says,
 * for every item and every room it applies to, whether the plan meets it.
 * The brief lives on the model (set_brief), so it is versioned with the plan.
 */
import { z } from 'zod';
import { compassVector, roomClearRect } from './geometry';
import { hasAttachedToilet, roomOpeningsOn } from './kernel';
import { coincidentSides } from './blocks';
import { fixedWallUnder, type BuildingModel, type Room } from './model';
import { formatLength, parseLength } from './units';

export const ZONES = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'centre'] as const;
export type Zone = (typeof ZONES)[number];

/**
 * Which rooms an item applies to: a group ("bedrooms", "toilets", "wet rooms",
 * "habitable") or a room kind ("kitchen", "pooja", "lobby") or a room's name/id.
 */
const rooms = z.string().min(1);

export const BriefItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('count'), rooms, n: z.coerce.number().int().min(1).max(12) }),
  z.object({ type: z.literal('outer_wall'), rooms }),
  z.object({ type: z.literal('window'), rooms }),
  z.object({ type: z.literal('attached_toilet'), rooms }),
  z.object({ type: z.literal('zone'), rooms, zone: z.enum(ZONES) }),
  z.object({ type: z.literal('min_size'), rooms, width: z.string(), depth: z.string() }),
  z.object({ type: z.literal('next_to'), rooms, other: z.string().min(1) }),
  z.object({ type: z.literal('service_entry'), rooms, entry: z.enum(['kitchen', 'outside']) }),
]);
export type BriefItem = z.infer<typeof BriefItemSchema>;

export const BriefSchema = z.object({ items: z.array(BriefItemSchema).max(30) });
export type Brief = z.infer<typeof BriefSchema>;

const HABITABLE: Room['kind'][] = ['bedroom', 'living', 'dining', 'kitchen', 'pooja'];

/** Rooms a selector refers to. */
export function selectRooms(model: BuildingModel, sel: string): Room[] {
  const s = sel.trim().toLowerCase();
  const byKind = (k: Room['kind']) => model.rooms.filter((r) => r.kind === k);
  if (s === 'bedrooms' || s === 'bedroom') return byKind('bedroom');
  if (s === 'toilets' || s === 'toilet' || s === 'bathrooms' || s === 'bathroom') return byKind('toilet');
  if (s === 'wet rooms' || s === 'wet') return model.rooms.filter((r) => r.wet);
  if (s === 'habitable') return model.rooms.filter((r) => HABITABLE.includes(r.kind));
  const kinds: Room['kind'][] = ['kitchen', 'pooja', 'lobby', 'living', 'dining', 'balcony', 'service', 'stair', 'lift', 'other'];
  const k = kinds.find((x) => x === s || `${x}s` === s || (x === 'other' && s === 'store'));
  if (k) return byKind(k);
  return model.rooms.filter((r) => r.id.toLowerCase() === s || r.name.toLowerCase() === s);
}

/** The 3 × 3 compass zone of the building a room's centre falls in. */
export function roomZone(model: BuildingModel, room: Room): Zone {
  const ext = model.walls.filter((w) => w.kind === 'external');
  const xs = ext.flatMap((w) => [w.a.x, w.b.x]);
  const ys = ext.flatMap((w) => [w.a.y, w.b.y]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const hw = (Math.max(...xs) - Math.min(...xs)) / 2 || 1;
  const hh = (Math.max(...ys) - Math.min(...ys)) / 2 || 1;
  const c = roomClearRect(model, room);
  const u = { x: ((c.x0 + c.x1) / 2 - cx) / hw, y: ((c.y0 + c.y1) / 2 - cy) / hh };
  const n = compassVector('north', model.northAngle);
  const e = compassVector('east', model.northAngle);
  const north = u.x * n.x + u.y * n.y;
  const east = u.x * e.x + u.y * e.y;
  const ns = north > 1 / 3 ? 'north' : north < -1 / 3 ? 'south' : '';
  const ew = east > 1 / 3 ? 'east' : east < -1 / 3 ? 'west' : '';
  return ((ns && ew ? `${ns}-${ew}` : ns || ew) || 'centre') as Zone;
}

function onOuterWall(model: BuildingModel, r: Room): boolean {
  const sides = ['top', 'bottom', 'left', 'right'] as const;
  if (r.block) return sides.some((s) => fixedWallUnder(model, r, s)?.kind === 'external');
  return sides.some((s) => model.walls.find((w) => w.id === r.bounds[s])?.kind === 'external');
}

function hasWindow(model: BuildingModel, r: Room): boolean {
  return (['top', 'bottom', 'left', 'right'] as const).some((s) => roomOpeningsOn(model, r, s).some((o) => o.kind === 'window' || o.kind === 'sliding'));
}

function touches(model: BuildingModel, a: Room, b: Room): boolean {
  if (a.block && b.block) return (['top', 'bottom', 'left', 'right'] as const).some((s) => coincidentSides(model, a, s).some((c) => c.room.id === b.id));
  return Object.values(a.bounds).some((w) => Object.values(b.bounds).includes(w));
}

export interface BriefResult {
  item: BriefItem;
  /** Plain-language line for the checklist. */
  label: string;
  met: boolean;
  /** Rooms that don't meet it yet (ids), with a short reason each. */
  failing: { roomId: string; name: string; why: string }[];
  /** The selector matched no rooms. */
  empty: boolean;
}

/** Human label for a brief item. */
export function briefLabel(item: BriefItem): string {
  const who = item.rooms.toLowerCase() === 'bedrooms' ? 'Every bedroom' : item.rooms.toLowerCase() === 'toilets' ? 'Every toilet' : item.rooms.toLowerCase() === 'wet rooms' ? 'Toilets and kitchen' : cap(item.rooms);
  switch (item.type) {
    case 'count':
      return countLabel(item.rooms, item.n);
    case 'outer_wall':
      return `${who} on an outer wall`;
    case 'window':
      return `${who} has a window`;
    case 'attached_toilet':
      return `${who} has an attached toilet`;
    case 'zone':
      return `${who} in the ${item.zone === 'centre' ? 'centre' : item.zone}`;
    case 'min_size':
      return `${who} at least ${item.width} × ${item.depth}`;
    case 'next_to':
      return `${who} next to ${item.other}`;
    case 'service_entry':
      return item.entry === 'outside' ? 'Service area with its own outside door' : 'Service area entered from the kitchen';
  }
}

/** "3 bedrooms", "1 kitchen", "2 toilets". */
export function countLabel(rooms: string, n: number): string {
  const base = rooms.toLowerCase().replace(/s$/, '');
  return `${n} ${base}${n === 1 ? '' : 's'}`;
}

/** The room kind a count item adds. */
export function countKind(rooms: string): Room['kind'] {
  const s = rooms.trim().toLowerCase().replace(/s$/, '');
  if (s === 'bathroom') return 'toilet';
  if (s === 'store') return 'other';
  return (['bedroom', 'toilet', 'kitchen', 'pooja', 'lobby', 'service', 'balcony', 'dining'] as const).find((k) => k === s) ?? 'other';
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function checkBrief(model: BuildingModel, brief: Brief | undefined = readBrief(model)): BriefResult[] {
  if (!brief) return [];
  const u = model.displayUnits;
  return brief.items.map((item) => {
    const targets = selectRooms(model, item.rooms);
    if (item.type === 'count') {
      const short = Math.max(0, item.n - targets.length);
      const failing = Array.from({ length: short }, (_, k) => ({ roomId: `count:${item.rooms}:${k}`, name: item.rooms, why: `${targets.length} of ${item.n} so far` }));
      return { item, label: briefLabel(item), met: short === 0, failing, empty: false };
    }
    const failing: BriefResult['failing'] = [];
    for (const r of targets) {
      let why: string | undefined;
      switch (item.type) {
        case 'outer_wall':
          if (!onOuterWall(model, r)) why = `${r.name} isn't on an outer wall`;
          break;
        case 'window':
          if (!hasWindow(model, r)) why = `${r.name} has no window`;
          break;
        case 'attached_toilet':
          if (!hasAttachedToilet(model, r)) why = `${r.name} has no attached toilet`;
          break;
        case 'zone': {
          const z = roomZone(model, r);
          if (z !== item.zone) why = `${r.name} is in the ${z}, not the ${item.zone}`;
          break;
        }
        case 'min_size': {
          const c = roomClearRect(model, r);
          const w = c.x1 - c.x0;
          const h = c.y1 - c.y0;
          const mw = parseLength(item.width).mm;
          const mh = parseLength(item.depth).mm;
          const ok = (w >= mw - 5 && h >= mh - 5) || (w >= mh - 5 && h >= mw - 5);
          if (!ok) why = `${r.name} is ${formatLength(w, u)} × ${formatLength(h, u)}`;
          break;
        }
        case 'service_entry': {
          const kitchen = model.rooms.find((k) => k.kind === 'kitchen');
          const fromKitchen = !!kitchen && touches(model, r, kitchen) && doorBetweenRooms(model, r, kitchen);
          const outside = (['top', 'bottom', 'left', 'right'] as const).some((s) => (r.block ? fixedWallUnder(model, r, s)?.kind === 'external' : false) && roomOpeningsOn(model, r, s).some((o) => o.kind === 'door' && model.walls.find((w) => w.id === o.wallId)?.kind === 'external'));
          if (!fromKitchen) why = `${r.name} has no door from the kitchen`;
          else if (item.entry === 'outside' && !outside) why = `${r.name} has no door from outside`;
          break;
        }
        case 'next_to': {
          const others = selectRooms(model, item.other).filter((o) => o.id !== r.id);
          if (others.length && !others.some((o) => touches(model, r, o))) why = `${r.name} doesn't share a wall with ${others.map((o) => o.name).join(' or ')}`;
          break;
        }
      }
      if (why) failing.push({ roomId: r.id, name: r.name, why });
    }
    return { item, label: briefLabel(item), met: targets.length > 0 && failing.length === 0, failing, empty: targets.length === 0 };
  });
}

/** Parse a stored brief (tolerates older/looser shapes). */
export function readBrief(model: BuildingModel): Brief | undefined {
  const r = BriefSchema.safeParse(model.brief ?? { items: [] });
  return r.success && r.data.items.length ? r.data : undefined;
}

/** A door in the wall the two rooms share. */
function doorBetweenRooms(model: BuildingModel, a: Room, b: Room): boolean {
  return (['top', 'bottom', 'left', 'right'] as const).some((s) => {
    const shared = a.block && b.block ? coincidentSides(model, a, s).some((c) => c.room.id === b.id) : false;
    return shared && roomOpeningsOn(model, a, s).some((o) => o.kind === 'door' || o.kind === 'opening');
  });
}
