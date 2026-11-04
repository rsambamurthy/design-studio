/**
 * Starter layouts a new design can begin from. All north-up, single level,
 * with generic default sizes; fit_to_buildable resizes them to the user's plot.
 */
import type { BuildingModel } from './model';
import { applyOperation, resizeLayout } from './kernel';
import { parseOperation } from './ops';
import { EXT, INT, L, PLUMB, opening, room, sampleModel, wall } from './seed';
import { toBlocks } from './blocks';
import { fitOutAll } from './fixtures';

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

/** 3BHK with a lobby holding a walled staircase and lift shaft, both movable. */
function threeBhk(): BuildingModel {
  let m: BuildingModel = { ...resizeLayout(sampleModel(), L("48'"), L("34'")).model, id: 'template-3bhk', name: '3BHK Flat', levelName: 'Typical floor' };
  const op = (name: string, args: Record<string, unknown>) => {
    m = applyOperation(m, parseOperation(name, args)).model;
  };
  op('rename_room', { roomId: 'r-lobby', name: 'Lobby' });
  op('add_stair', { roomId: 'r-lobby', type: 'dog-legged', corner: 'south-east' });
  op('add_lift', { roomId: 'r-lobby', persons: '6', corner: 'north-east' });
  return { ...m, revision: 1 };
}

/** The bare shell: outer walls only. Rooms are dragged in as blocks. */
function shell(): BuildingModel {
  const W = L("48'");
  const H = L("34'");
  return {
    schema: 1,
    id: 'template-shell',
    name: 'Bare shell',
    northAngle: 0,
    displayUnits: 'ft-in',
    levelName: 'Typical floor',
    revision: 1,
    walls: [
      wall('w-north', [0, 0], [W, 0], EXT, 'external'),
      wall('w-south', [0, H], [W, H], EXT, 'external'),
      wall('w-west', [0, 0], [0, H], EXT, 'external'),
      wall('w-east', [W, 0], [W, H], EXT, 'external'),
    ],
    rooms: [room('r-living', 'Living / Dining', 'living', 'w-north', 'w-south', 'w-west', 'w-east')],
    openings: [],
    furniture: [],
  };
}

export const TEMPLATES: Template[] = [
  {
    id: 'shell',
    name: 'Bare shell',
    description: 'Outer walls only. Drag in bedrooms, bathrooms, kitchen, lobby, stairs and lift, then set their sizes.',
    build: shell,
  },
  {
    id: '3bhk',
    name: '3BHK flat',
    description: '3 bedrooms, 2 toilets, kitchen, living/dining, lobby with stair and lift.',
    build: () => fitOutAll(toBlocks(threeBhk())),
  },
  { id: '2bhk', name: '2BHK flat', description: '2 bedrooms, 2 toilets, kitchen, living/dining.', build: () => fitOutAll(toBlocks(twoBhk())) },
  { id: '1bhk', name: '1BHK flat', description: '1 bedroom, toilet, wash, kitchen, living/dining.', build: () => fitOutAll(toBlocks(oneBhk())) },
];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
