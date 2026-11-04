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

/** 'opening' is a plain gap in the wall (archway, stair entry) with no leaf. */
export type OpeningKind = 'door' | 'window' | 'sliding' | 'opening';

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
  | 'stair'
  | 'lift'
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

export type PlanSide = 'top' | 'bottom' | 'left' | 'right';

/**
 * A staircase or lift: a fixed element with its own footprint, placed in a room.
 * Local frame like furniture: `width` along local x, `length` along local y,
 * rotated clockwise by `rotation` (multiples of 90°) about `at`.
 */
export interface CoreElement {
  id: string;
  kind: 'stair' | 'lift';
  label: string;
  roomId: string;
  at: Point;
  rotation: number;
  width: Mm;
  length: Mm;
  stair?: { type: 'dog-legged' | 'straight'; flightWidth: Mm; floorHeight: Mm; risers: number; riser: Mm; tread: Mm };
  lift?: { persons: number };
}

export interface Tree {
  id: string;
  label: string;
  /** Trunk centre, in plot coordinates. */
  at: Point;
  /** Canopy radius: building under it is flagged as advisory. */
  canopyRadius: Mm;
  /** Trunk/root protection radius: building inside it is an error. */
  protectRadius: Mm;
  keep: boolean;
  /** Named position it was placed at (e.g. "north-west corner"), if any. */
  position?: string;
  /** Trunk distance from the boundary used with `position`. */
  inset?: Mm;
}

export interface Access {
  /** Plan side of the plot the road or passage runs along. */
  side: PlanSide;
  kind: 'road' | 'passage';
  width: Mm;
}

/**
 * The plot around the building. Plot coordinates: origin at the plot's
 * top-left corner on the plan, same axes as the building. The building's wall
 * coordinates are shifted by `buildingOffset` to sit on the plot.
 * Setbacks are stored per plan side and shown as compass sides via northAngle.
 */
export interface Site {
  plot: { width: Mm; depth: Mm };
  setbacks: Record<PlanSide, Mm>;
  access: Access[];
  trees: Tree[];
  buildingOffset: Point;
}

export interface BuildingModel {
  schema: 1;
  /** Optional until the user enters a plot. */
  site?: Site;
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
  /** Stairs and lifts. Optional: older designs have none. */
  cores?: CoreElement[];
  revision: number;
}

export type Entity =
  | ({ type: 'wall' } & Wall)
  | ({ type: 'opening' } & Opening)
  | ({ type: 'room' } & Room)
  | ({ type: 'furniture' } & FurnitureItem)
  | ({ type: 'core' } & CoreElement);

export function findEntity(model: BuildingModel, id: string): Entity | undefined {
  const w = model.walls.find((e) => e.id === id);
  if (w) return { type: 'wall', ...w };
  const o = model.openings.find((e) => e.id === id);
  if (o) return { type: 'opening', ...o };
  const r = model.rooms.find((e) => e.id === id);
  if (r) return { type: 'room', ...r };
  const f = model.furniture.find((e) => e.id === id);
  if (f) return { type: 'furniture', ...f };
  const c = (model.cores ?? []).find((e) => e.id === id);
  if (c) return { type: 'core', ...c };
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
