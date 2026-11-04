/**
 * Starter layouts a new design can begin from. All north-up, single level,
 * with generic default sizes; fit_to_buildable resizes them to the user's plot.
 */
import type { BuildingModel } from './model';
import { applyOperation, resizeLayout } from './kernel';
import { parseOperation } from './ops';
import { EXT, INT, L, PLUMB, opening, room, sampleModel, wall } from './seed';
import { planSideCompass, roomClearRect } from './geometry';
import { DEFAULT_FLOOR_HEIGHT, LIFT_SHAFTS, sizeStair } from './cores';

export interface Template {
  id: string;
  name: string;
  description: string;
  /** The layout at its default size, complete. */
  build: () => BuildingModel;
  /** The layout before size-dependent parts (e.g. the stair and lift units) are added. */
  base?: () => BuildingModel;
  /** Adds the size-dependent parts once the layout has its final size. */
  finish?: (m: BuildingModel) => BuildingModel;
}

function twoBhk(): BuildingModel {
  const X = { w: 0, v1: L("12'"), v2: L("17'"), v3: L("28'"), e: L("40'") };
  const Y = { n: 0, t: L("7'"), mid: L("12'"), s: L("30'") };
  return {
    schema: 1,
    id: 'template-2bhk',
    name: '2BHK Flat',
    northAngle: 0,
    displayUnits: 'ft-in',
    levelName: 'Typical floor',
    revision: 1,
    walls: [
      wall('w-north', [X.w, Y.n], [X.e, Y.n], EXT, 'external'),
      wall('w-south', [X.w, Y.s], [X.e, Y.s], EXT, 'external'),
      wall('w-west', [X.w, Y.n], [X.w, Y.s], EXT, 'external'),
      wall('w-east', [X.e, Y.n], [X.e, Y.s], EXT, 'external'),
      wall('w-mid', [X.w, Y.mid], [X.e, Y.mid], INT, 'internal'),
      wall('w-bed1-t', [X.v1, Y.n], [X.v1, Y.mid], PLUMB, 'plumbing'),
      wall('w-t1-t2', [X.v1, Y.t], [X.v2, Y.t], PLUMB, 'plumbing'),
      wall('w-t-bed2', [X.v2, Y.n], [X.v2, Y.mid], PLUMB, 'plumbing'),
      wall('w-bed2-kit', [X.v3, Y.n], [X.v3, Y.mid], INT, 'internal'),
    ],
    rooms: [
      room('r-bed1', 'Bed 1', 'bedroom', 'w-north', 'w-mid', 'w-west', 'w-bed1-t'),
      room('r-t1', 'Toilet 1', 'toilet', 'w-north', 'w-t1-t2', 'w-bed1-t', 'w-t-bed2', true),
      room('r-t2', 'Toilet 2', 'toilet', 'w-t1-t2', 'w-mid', 'w-bed1-t', 'w-t-bed2', true),
      room('r-bed2', 'Bed 2', 'bedroom', 'w-north', 'w-mid', 'w-t-bed2', 'w-bed2-kit'),
      room('r-kitchen', 'Kitchen', 'kitchen', 'w-north', 'w-mid', 'w-bed2-kit', 'w-east', true),
      room('r-living', 'Living / Dining', 'living', 'w-mid', 'w-south', 'w-west', 'w-east'),
    ],
    openings: [
      opening('d-bed1', 'Bed 1 door', 'w-mid', 'door', "9'", "3'"),
      opening('d-t1', 'Toilet 1 door', 'w-bed1-t', 'door', "3'6\"", "2'6\""),
      opening('d-t2', 'Toilet 2 door', 'w-mid', 'door', "14'6\"", "2'6\""),
      opening('d-bed2', 'Bed 2 door', 'w-mid', 'door', "19'6\"", "3'"),
      opening('d-kitchen', 'Kitchen door', 'w-mid', 'door', "34'", "3'6\""),
      opening('d-main', 'Main door', 'w-south', 'door', "34'", "3'6\""),
      opening('win-bed1', 'Bed 1 window', 'w-north', 'window', "6'", "5'"),
      opening('win-bed2', 'Bed 2 window', 'w-north', 'window', "22'6\"", "5'"),
      opening('win-kitchen', 'Kitchen window', 'w-north', 'window', "34'", "4'"),
      opening('win-living', 'Living window', 'w-south', 'sliding', "14'", "8'"),
    ],
    furniture: [
      { id: 'f-bed1', catalogueId: 'bed-queen', label: 'Queen bed', roomId: 'r-bed1', at: { x: Math.ceil(EXT / 2) + 1050, y: L("6'") }, rotation: 270, mirrored: false },
      { id: 'f-dining', catalogueId: 'dining-4', label: '4-seater dining', roomId: 'r-living', at: { x: L("28'"), y: L("21'") }, rotation: 90, mirrored: false },
    ],
  };
}

function oneBhk(): BuildingModel {
  const X = { w: 0, v1: L("14'"), v2: L("19'"), e: L("26'") };
  const Y = { n: 0, t: L("7'"), mid: L("12'"), s: L("24'") };
  return {
    schema: 1,
    id: 'template-1bhk',
    name: '1BHK Flat',
    northAngle: 0,
    displayUnits: 'ft-in',
    levelName: 'Typical floor',
    revision: 1,
    walls: [
      wall('w-north', [X.w, Y.n], [X.e, Y.n], EXT, 'external'),
      wall('w-south', [X.w, Y.s], [X.e, Y.s], EXT, 'external'),
      wall('w-west', [X.w, Y.n], [X.w, Y.s], EXT, 'external'),
      wall('w-east', [X.e, Y.n], [X.e, Y.s], EXT, 'external'),
      wall('w-mid', [X.w, Y.mid], [X.e, Y.mid], INT, 'internal'),
      wall('w-bed-t', [X.v1, Y.n], [X.v1, Y.mid], PLUMB, 'plumbing'),
      wall('w-t-wash', [X.v1, Y.t], [X.v2, Y.t], PLUMB, 'plumbing'),
      wall('w-t-kit', [X.v2, Y.n], [X.v2, Y.mid], PLUMB, 'plumbing'),
    ],
    rooms: [
      room('r-bed1', 'Bedroom', 'bedroom', 'w-north', 'w-mid', 'w-west', 'w-bed-t'),
      room('r-t1', 'Toilet', 'toilet', 'w-north', 'w-t-wash', 'w-bed-t', 'w-t-kit', true),
      room('r-wash', 'Wash', 'service', 'w-t-wash', 'w-mid', 'w-bed-t', 'w-t-kit', true),
      room('r-kitchen', 'Kitchen', 'kitchen', 'w-north', 'w-mid', 'w-t-kit', 'w-east', true),
      room('r-living', 'Living / Dining', 'living', 'w-mid', 'w-south', 'w-west', 'w-east'),
    ],
    openings: [
      opening('d-bed1', 'Bedroom door', 'w-mid', 'door', "11'", "3'"),
      opening('d-t1', 'Toilet door', 'w-t-wash', 'door', "2'6\"", "2'3\""),
      opening('d-wash', 'Wash opening', 'w-mid', 'door', "16'6\"", "3'"),
      opening('d-kitchen', 'Kitchen door', 'w-mid', 'door', "22'6\"", "3'"),
      opening('d-main', 'Main door', 'w-south', 'door', "20'", "3'6\""),
      opening('win-bed1', 'Bedroom window', 'w-north', 'window', "7'", "5'"),
      opening('win-t1', 'Toilet ventilator', 'w-north', 'window', "16'6\"", "1'6\""),
      opening('win-kitchen', 'Kitchen window', 'w-north', 'window', "22'6\"", "3'"),
      opening('win-living', 'Living window', 'w-south', 'sliding', "8'", "6'"),
    ],
    furniture: [
      { id: 'f-bed1', catalogueId: 'bed-queen', label: 'Queen bed', roomId: 'r-bed1', at: { x: Math.ceil(EXT / 2) + 1050, y: L("6'") }, rotation: 270, mirrored: false },
    ],
  };
}

/** 3BHK before its core is divided up: one lobby room for the common core. */
function threeBhkBase(): BuildingModel {
  const m: BuildingModel = { ...resizeLayout(sampleModel(), L("48'"), L("34'")).model, id: 'template-3bhk', name: '3BHK Flat', levelName: 'Typical floor' };
  return applyOperation(m, parseOperation('rename_room', { roomId: 'r-lobby', name: 'Lobby' })).model;
}

/**
 * Divide a lobby into separate units sized to what they hold: a Stair room
 * (dog-legged stair), a Lift shaft, a Duct / Store when space is left, and the
 * Lobby itself, with a stair entry, lift door and store door off the lobby.
 * Runs after the layout is sized, so the units fit the actual lobby.
 */
export function carveCoreUnits(input: BuildingModel, lobbyId: string, mainDoorId = 'd-main'): BuildingModel {
  let m = input;
  const op = (name: string, args: Record<string, unknown>) => {
    m = applyOperation(m, parseOperation(name, args)).model;
  };
  const mm = (n: number) => `${Math.ceil(n)} mm`;
  const lobby = () => m.rooms.find((r) => r.id === lobbyId)!;
  const roomNamed = (name: string) => m.rooms.find((r) => r.name === name)?.id;
  const wallBetween = (a: string, b: string) => {
    const ra = m.rooms.find((r) => r.id === a)!;
    const rb = m.rooms.find((r) => r.id === b)!;
    const pairs = [['top', 'bottom'], ['bottom', 'top'], ['left', 'right'], ['right', 'left']] as const;
    const hit = pairs.find(([x, y]) => ra.bounds[x] === rb.bounds[y]);
    if (!hit) throw new Error(`${ra.name} and ${rb.name} don't share a wall`);
    return ra.bounds[hit[0]];
  };
  const sides = ['top', 'bottom', 'left', 'right'] as const;
  type Side = (typeof sides)[number];
  const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const compass = (s: Side) => planSideCompass(s, m.northAngle);
  const clear = () => roomClearRect(m, lobby());
  const along = (s: Side) => {
    const r = clear();
    return s === 'top' || s === 'bottom' ? r.x1 - r.x0 : r.y1 - r.y0;
  };

  const door = m.openings.find((o) => o.id === mainDoorId);
  const doorSide = sides.find((s) => door && lobby().bounds[s] === door.wallId) ?? 'left';
  const T = 115;
  const stair = sizeStair('dog-legged', 1067, DEFAULT_FLOOR_HEIGHT);
  const shaft = LIFT_SHAFTS[6]!;

  // 1. Stair along a side next to the door wall, outer wall preferred.
  const perp = sides.filter((s) => s !== doorSide && s !== opposite[doorSide]);
  const ext = (s: Side) => m.walls.find((w) => w.id === lobby().bounds[s])?.kind === 'external';
  const stairSide = [...perp].sort((a, b) => Number(ext(b)) - Number(ext(a)))[0]!;
  const long = Math.max(stair.width, stair.length);
  const short = Math.min(stair.width, stair.length);
  const depth = along(stairSide) >= long ? short : long;
  op('split_room', { roomId: lobbyId, side: compass(stairSide), size: mm(depth), name: 'Stair', kind: 'stair' });
  const stairRoom = roomNamed('Stair')!;

  // 2. Lift shaft. If the stair room is longer than the stair, the spare end
  //    (away from the main door) becomes the lift; otherwise a lift column is
  //    taken off the lobby across from the main door, any spare as a duct/store.
  const liftDepth = Math.min(shaft.w, shaft.d);
  const liftLong = Math.max(shaft.w, shaft.d);
  const sr = roomClearRect(m, m.rooms.find((r) => r.id === stairRoom)!);
  const stairRunAlong = stairSide === 'top' || stairSide === 'bottom' ? sr.x1 - sr.x0 : sr.y1 - sr.y0;
  const stairUses = depth === short ? long : short;
  const spare = stairRunAlong - stairUses - T;
  const liftInStairRoom = spare >= liftDepth && depth >= liftDepth;
  if (liftInStairRoom) {
    op('split_room', { roomId: stairRoom, side: compass(opposite[doorSide]), size: mm(spare), name: 'Lift', kind: 'lift' });
  } else {
    op('split_room', { roomId: lobbyId, side: compass(opposite[doorSide]), size: mm(liftLong), name: 'Lift', kind: 'lift' });
    const column = roomNamed('Lift')!;
    const columnLength = along(opposite[doorSide]);
    if (columnLength - liftDepth - T >= 900) {
      op('split_room', { roomId: column, side: compass(opposite[stairSide]), size: mm(columnLength - liftDepth - T), name: 'Duct / Store', kind: 'other' });
    }
  }
  const liftRoom = roomNamed('Lift')!;
  op('add_lift', { roomId: liftRoom, persons: '6' });
  op('add_stair', { roomId: stairRoom, type: 'dog-legged' });
  // The stair sits at the main-door end of its room.
  const stairCore = (m.cores ?? []).find((c) => c.kind === 'stair')!;
  const cornerOf = (a: Side, b2: Side) => [compass(a), compass(b2)].sort((x, y) => (['north', 'south'].includes(x) ? -1 : 1) - (['north', 'south'].includes(y) ? -1 : 1)).join('-');
  op('place_core', { coreId: stairCore.id, corner: cornerOf(stairSide, doorSide) });

  // 3. Ways in off the lobby.
  op('add_opening', { wallId: wallBetween(lobbyId, stairRoom), kind: 'opening', width: '3\'6"', label: 'Stair entry', roomId: liftInStairRoom ? stairRoom : lobbyId });
  op('add_opening', { wallId: wallBetween(lobbyId, liftRoom), kind: 'sliding', width: '3\'', label: 'Lift door', roomId: liftRoom });
  const store = roomNamed('Duct / Store');
  if (store) op('add_opening', { wallId: wallBetween(lobbyId, store), kind: 'door', width: '2\'6"', label: 'Store door', roomId: store });
  if (door) op('centre_opening', { openingId: door.id, roomId: lobbyId });
  return m;
}

export const TEMPLATES: Template[] = [
  {
    id: '3bhk',
    name: '3BHK flat',
    description: '3 bedrooms, 2 toilets, kitchen, living/dining; separate lobby, stair and lift.',
    build: () => carveCoreUnits(threeBhkBase(), 'r-lobby'),
    base: threeBhkBase,
    finish: (m) => carveCoreUnits(m, 'r-lobby'),
  },
  { id: '2bhk', name: '2BHK flat', description: '2 bedrooms, 2 toilets, kitchen, living/dining.', build: twoBhk },
  { id: '1bhk', name: '1BHK flat', description: '1 bedroom, toilet, wash, kitchen, living/dining.', build: oneBhk },
];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
