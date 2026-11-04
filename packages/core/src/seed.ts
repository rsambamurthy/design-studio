/**
 * Sample design: a 52'6" (E–W) × 35' (N–S) first-floor flat, north up,
 * 3 bedrooms, kitchen, living/dining and a lift/stair lobby. Proportions follow
 * the reference project; it is a demo layout, not that building's drawings.
 */
import type { BuildingModel, Opening, Room, Wall } from './model';
import { parseLength } from './units';

export const L = (s: string) => parseLength(s).mm;

export const EXT = L('9"');
export const INT = L('4.5"');
export const PLUMB = L('6"');

const X = { w: 0, v1: L("13'"), v2: L("18'"), v3: L("28'"), v4: L("37'"), e: L("52'6\"") };
const Y = { n: 0, t: L("8'"), mid: L("14'"), s: L("35'") };

export function wall(id: string, a: [number, number], b: [number, number], thickness: number, kind: Wall['kind']): Wall {
  return { id, a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] }, thickness, kind };
}

export function room(id: string, name: string, kind: Room['kind'], top: string, bottom: string, left: string, right: string, wet = false): Room {
  return { id, name, kind, wet, bounds: { top, bottom, left, right } };
}

export function opening(id: string, label: string, wallId: string, kind: Opening['kind'], offset: string, width: string, swingSide: Opening['swingSide'] = 'left', hinge: Opening['hinge'] = 'start'): Opening {
  return { id, label, wallId, kind, offset: L(offset), width: L(width), height: kind === 'window' ? 1200 : 2100, swingSide, hinge };
}

export function sampleModel(): BuildingModel {
  return {
    schema: 1,
    id: 'sample-flat',
    name: 'Sample 3BHK Flat',
    northAngle: 0,
    displayUnits: 'ft-in',
    levelName: 'First floor',
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
      wall('w-core', [X.v4, Y.n], [X.v4, Y.s], INT, 'internal'),
    ],
    rooms: [
      room('r-bed1', 'Bed 1', 'bedroom', 'w-north', 'w-mid', 'w-west', 'w-bed1-t'),
      room('r-t1', 'Toilet 1', 'toilet', 'w-north', 'w-t1-t2', 'w-bed1-t', 'w-t-bed2', true),
      room('r-t2', 'Toilet 2', 'toilet', 'w-t1-t2', 'w-mid', 'w-bed1-t', 'w-t-bed2', true),
      room('r-bed2', 'Bed 2', 'bedroom', 'w-north', 'w-mid', 'w-t-bed2', 'w-bed2-kit'),
      room('r-kitchen', 'Kitchen', 'kitchen', 'w-north', 'w-mid', 'w-bed2-kit', 'w-core', true),
      room('r-bed3', 'Bed 3', 'bedroom', 'w-north', 'w-mid', 'w-core', 'w-east'),
      room('r-living', 'Living / Dining', 'living', 'w-mid', 'w-south', 'w-west', 'w-core'),
      room('r-lobby', 'Lobby · Lift · Stair', 'lobby', 'w-mid', 'w-south', 'w-core', 'w-east'),
    ],
    openings: [
      opening('d-bed1', 'Bed 1 door', 'w-mid', 'door', "10'6\"", "3'"),
      opening('d-t1', 'Toilet 1 door', 'w-bed1-t', 'door', "4'", "2'6\"", 'left'),
      opening('d-t2', 'Toilet 2 door', 'w-mid', 'door', "15'6\"", "2'6\""),
      opening('d-bed2', 'Bed 2 door', 'w-mid', 'door', "20'", "3'"),
      opening('d-kitchen', 'Kitchen door', 'w-mid', 'door', "32'6\"", "3'6\""),
      opening('d-bed3', 'Bed 3 door', 'w-mid', 'door', "39'6\"", "3'"),
      opening('d-main', 'Main door', 'w-core', 'door', "24'6\"", "3'6\"", 'right'),
      opening('win-bed1', 'Bed 1 window', 'w-north', 'window', "6'6\"", "5'"),
      opening('win-bed2', 'Bed 2 window', 'w-north', 'window', "23'", "5'"),
      opening('win-kitchen', 'Kitchen window', 'w-north', 'window', "32'6\"", "4'"),
      opening('win-bed3', 'Bed 3 window', 'w-east', 'window', "7'", "5'"),
      opening('win-living', 'Living window', 'w-south', 'sliding', "18'6\"", "8'"),
    ],
    furniture: [
      { id: 'f-bed1', catalogueId: 'bed-queen', label: 'Queen bed', roomId: 'r-bed1', at: { x: Math.ceil(EXT / 2) + 1050, y: L("6'9\"") }, rotation: 270, mirrored: false },
      { id: 'f-dining', catalogueId: 'dining-6', label: '6-seater dining', roomId: 'r-living', at: { x: L("28'"), y: L("24'6\"") }, rotation: 90, mirrored: false },
    ],
  };
}
