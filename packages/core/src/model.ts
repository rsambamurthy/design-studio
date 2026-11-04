/**
 * The single building model. Everything (plans, schedules, cost) is derived
 * from this. All lengths are integer millimetres. Plan coordinates follow SVG:
 * x grows to the right, y grows downward ("plan-up" is -y).
 */

export type Mm = number;

export interface Point {
  x: Mm;
  y: Mm;
}

export type WallKind = 'external' | 'internal' | 'plumbing';

export interface Wall {
  id: string;
  /** Axis line start and end. */
  a: Point;
  b: Point;
  thickness: Mm;
  kind: WallKind;
}

export type OpeningKind = 'door' | 'window' | 'sliding';

export interface Opening {
  id: string;
  label: string;
  wallId: string;
  kind: OpeningKind;
  /** Distance along the wall from wall.a to the opening centre. */
  offset: Mm;
  width: Mm;
  height: Mm;
  /** Which side of the wall a door leaf swings into (relative to a->b, left = counter-clockwise normal). */
  swingSide: 'left' | 'right';
  /** Hinge end of the leaf, looking along a->b. */
  hinge: 'start' | 'end';
}

export type RoomKind =
  | 'bedroom'
  | 'toilet'
  | 'kitchen'
  | 'service'
  | 'living'
  | 'dining'
  | 'balcony'
  | 'lobby'
  | 'pooja'
  | 'other';

/**
 * MVP rooms are axis-aligned rectangles whose edges are bound to walls.
 * Moving a bound wall moves the matching room edge, which is how a single
 * edit ripples through the plan.
 */
export interface Room {
  id: string;
  name: string;
  kind: RoomKind;
  wet: boolean;
  /**
   * Wall ids for each plan edge. Deliberately plan-relative (top/bottom/left/right),
   * never compass names: compass directions are resolved through northAngle only.
   */
  bounds: { top: string; bottom: string; left: string; right: string };
}

export interface FurnitureItem {
  id: string;
  catalogueId: string;
  label: string;
  roomId: string;
  /** Centre of the item. */
  at: Point;
  /** Rotation in degrees, clockwise, 0 = item's front faces plan-down. */
  rotation: number;
  /** Mirror for handed items (e.g. chaise left vs right). */
  mirrored: boolean;
}

export interface BuildingModel {
  schema: 1;
  id: string;
  name: string;
  /** Clockwise angle of true north from plan-up, degrees. 0 = north is up. */
  northAngle: number;
  displayUnits: 'ft-in' | 'mm';
  levelName: string;
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  furniture: FurnitureItem[];
  revision: number;
}

export type Entity =
  | ({ type: 'wall' } & Wall)
  | ({ type: 'opening' } & Opening)
  | ({ type: 'room' } & Room)
  | ({ type: 'furniture' } & FurnitureItem);

export function findEntity(model: BuildingModel, id: string): Entity | undefined {
  const w = model.walls.find((e) => e.id === id);
  if (w) return { type: 'wall', ...w };
  const o = model.openings.find((e) => e.id === id);
  if (o) return { type: 'opening', ...o };
  const r = model.rooms.find((e) => e.id === id);
  if (r) return { type: 'room', ...r };
  const f = model.furniture.find((e) => e.id === id);
  if (f) return { type: 'furniture', ...f };
  return undefined;
}

export function getWall(model: BuildingModel, id: string): Wall {
  const w = model.walls.find((e) => e.id === id);
  if (!w) throw new ModelError(`No wall with id "${id}"`);
  return w;
}

export function getRoom(model: BuildingModel, id: string): Room {
  const r = model.rooms.find((e) => e.id === id);
  if (!r) throw new ModelError(`No room with id "${id}"`);
  return r;
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}
