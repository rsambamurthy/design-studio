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
  /**
   * Present for a movable room block: its own rectangle (wall centre lines)
   * and wall thickness. Its bounds are then virtual walls ("blk:<room>:<side>")
   * generated from the rectangle, so the block moves as one piece. Sides that
   * lie on a fixed wall use that wall's thickness and aren't drawn twice.
   */
  block?: { x0: Mm; y0: Mm; x1: Mm; y1: Mm; thickness: Mm };
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
  /**
   * Present when the stair or lift is a self-contained unit with its own walls.
   * Walls are drawn on the sides that aren't already against a room wall; the
   * entry is on the local front (+y): the foot of the stair, the lift door.
   */
  enclosure?: { thickness: Mm };
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
  const w = model.walls.find((e) => e.id === id) ?? blockWall(model, id);
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
  if (w) return w;
  const v = blockWall(model, id);
  if (v) return v;
  throw new ModelError(`No wall with id "${id}"`);
}

const BLOCK_SIDES = ['top', 'bottom', 'left', 'right'] as const;

/** Id of a block room's side wall. */
export function blockWallId(roomId: string, side: PlanSide): string {
  return `blk:${roomId}:${side}`;
}

/** Room and side of a block wall id, or undefined. */
export function parseBlockWallId(id: string): { roomId: string; side: PlanSide } | undefined {
  const m = /^blk:(.+):(top|bottom|left|right)$/.exec(id);
  return m ? { roomId: m[1]!, side: m[2] as PlanSide } : undefined;
}

/** The fixed wall a block side lies on (same axis, covering the side), if any. */
export function fixedWallUnder(model: BuildingModel, room: Room, side: PlanSide): Wall | undefined {
  const b = room.block;
  if (!b) return undefined;
  const horizontal = side === 'top' || side === 'bottom';
  const axis = side === 'top' ? b.y0 : side === 'bottom' ? b.y1 : side === 'left' ? b.x0 : b.x1;
  const [lo, hi] = horizontal ? [b.x0, b.x1] : [b.y0, b.y1];
  return model.walls.find((w) => {
    const wh = Math.abs(w.a.y - w.b.y) < 1;
    if (wh !== horizontal) return false;
    const wAxis = horizontal ? w.a.y : w.a.x;
    if (Math.abs(wAxis - axis) > 2) return false;
    const [a, c] = horizontal ? [Math.min(w.a.x, w.b.x), Math.max(w.a.x, w.b.x)] : [Math.min(w.a.y, w.b.y), Math.max(w.a.y, w.b.y)];
    return a <= lo + 2 && c >= hi - 2;
  });
}

/** Synthesise a block room's side as a wall (top/bottom run left→right, left/right run top→bottom). */
function blockWall(model: BuildingModel, id: string): Wall | undefined {
  const p = parseBlockWallId(id);
  if (!p) return undefined;
  const room = model.rooms.find((r) => r.id === p.roomId);
  const b = room?.block;
  if (!room || !b) return undefined;
  const fixed = fixedWallUnder(model, room, p.side);
  const thickness = fixed ? Math.max(fixed.thickness, b.thickness) : b.thickness;
  const ends: Record<PlanSide, [Point, Point]> = {
    top: [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }],
    bottom: [{ x: b.x0, y: b.y1 }, { x: b.x1, y: b.y1 }],
    left: [{ x: b.x0, y: b.y0 }, { x: b.x0, y: b.y1 }],
    right: [{ x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }],
  };
  const [a, c] = ends[p.side];
  return { id, a, b: c, thickness, kind: fixed ? fixed.kind : 'internal' };
}

/** Bounds for a block room: its four virtual walls. */
export function blockBounds(roomId: string): Room['bounds'] {
  return Object.fromEntries(BLOCK_SIDES.map((s) => [s, blockWallId(roomId, s)])) as Room['bounds'];
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
