import { describe, expect, it } from 'vitest';
import {
  TEMPLATES,
  applyOperation,
  coreFootprint,
  enclosureOf,
  findEntities,
  modelSummary,
  parseOperation,
  roomClearRect,
  runChecks,
  sampleModel,
  startDesign,
  type BuildingModel,
} from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const apply = (m: BuildingModel, n: string, a: unknown) => applyOperation(m, op(n, a));
const room = (m: BuildingModel, name: string) => m.rooms.find((r) => r.name === name)!;
const errors = (m: BuildingModel) => runChecks(m).filter((i) => i.severity === 'error');
/** The 3BHK flat with a stair and lift chosen (they stand beside the lobby, opening into it). */
const withCores = (plot: ReturnType<typeof op>[] = []) => startDesign('3bhk', plot, 'T', { core: 'both' }).model;

describe('stair and lift', () => {
  it('the stair and lift are their own walled units beside the lobby, opening into it', () => {
    const m = withCores();
    expect(m.cores!.map((c) => c.kind).sort()).toEqual(['lift', 'stair']);
    const lobby = room(m, 'Lobby');
    expect(m.cores!.every((c) => c.roomId !== lobby.id && !!c.enclosure)).toBe(true);
    // The stair always; the lift too when there's space left beside the lobby (here the stair takes it).
    for (const c of m.cores!.filter((x) => x.kind === 'stair')) {
      const f = coreFootprint(c);
      const b = lobby.block!;
      const t = (c.enclosure?.thickness ?? 0) + b.thickness / 2;
      const touches = Math.abs(f.y1 + t - b.y0) < 5 || Math.abs(f.y0 - t - b.y1) < 5 || Math.abs(f.x1 + t - b.x0) < 5 || Math.abs(f.x0 - t - b.x1) < 5;
      expect(touches, c.label).toBe(true);
    }
    expect(runChecks(m).filter((i) => i.code.startsWith('core') && i.severity !== 'advisory')).toEqual([]);
    expect(errors(m)).toEqual([]);
  });

  it('an open (unwalled) stair in an ordinary room is flagged', () => {
    const m = apply(sampleModel(), 'add_stair', { roomId: 'r-living', enclosed: false }).model;
    const own = runChecks(m).filter((i) => i.code === 'core.own-room');
    expect(own).toHaveLength(1);
    expect(own[0]!.message).toMatch(/usually its own enclosed unit/);
  });

  it('the stair and lift fit narrow and wide plinths', () => {
    for (const [ew, ns, sb] of [["60'", "40'", "5'"], ["30'", "60'", "3'"], ["40'", "60'", "5'"], ["60'", "40'", "0"]] as const) {
      const model = withCores([op('set_plot', { eastWest: ew, northSouth: ns }), op('set_setback', { side: 'all', distance: sb })]);
      expect(model.cores!.length).toBe(2);
      expect(errors(model), `${ew} × ${ns}`).toEqual([]);
    }
  });

  it('a lift can be moved into another room, and snaps flush to a wall', () => {
    const m = withCores();
    const lift = m.cores!.find((c) => c.kind === 'lift')!;
    // Far west, across the living room.
    const r = apply(m, 'move_core', { coreId: lift.id, direction: 'west', distance: "20'" });
    const moved = r.model.cores!.find((c) => c.id === lift.id)!;
    expect(moved.roomId).toBe('r-living');
    // Nudge it near the living room's north wall: it snaps flush.
    const down = apply(r.model, 'move_core', { coreId: lift.id, direction: 'south', distance: '1000 mm' }).model;
    const liv = roomClearRect(down, room(down, 'Living / Dining'));
    const gap = coreFootprint(down.cores!.find((c) => c.id === lift.id)!).y0 - liv.y0;
    const r2 = apply(down, 'move_core', { coreId: lift.id, direction: 'north', distance: `${Math.round(gap - 60)} mm` });
    const f2 = coreFootprint(r2.model.cores!.find((c) => c.id === lift.id)!);
    expect(Math.abs(f2.y0 - liv.y0)).toBeLessThanOrEqual(1);
  });

  it('warns when the lift door faces a wall', () => {
    const m = withCores();
    const lift = m.cores!.find((c) => c.kind === 'lift')!;
    // Push it against the front wall with its door facing that wall.
    let r = apply(m, 'move_core', { coreId: lift.id, direction: 'south', distance: "20'" });
    const side = (rot: number) => (['bottom', 'left', 'top', 'right'] as const)[((Math.round(rot / 90) % 4) + 4) % 4];
    const now = r.model.cores!.find((c) => c.id === lift.id)!;
    if (side(now.rotation) !== 'bottom') r = apply(r.model, 'rotate_core', { coreId: lift.id, degrees: String((360 - now.rotation) % 360 || 180) as '90' });
    expect(runChecks(r.model).some((i) => i.code === 'core.entry-blocked')).toBe(true);
  });

  it('starting a design can drop the lift, or both', () => {
    const plot = [op('set_plot', { eastWest: "60'", northSouth: "40'" })];
    expect(startDesign('3bhk', plot, 'T', { core: 'stair' }).model.cores!.map((c) => c.kind)).toEqual(['stair']);
    expect(startDesign('3bhk', plot, 'T', { core: 'none' }).model.cores ?? []).toEqual([]);
    const two = startDesign('2bhk', plot, 'T', { core: 'stair' }).model;
    expect(two.cores!.map((c) => c.kind)).toEqual(['stair']);
    expect(errors(two)).toEqual([]);
  });

  it('sizes a dog-legged stair from floor height', () => {
    const r = apply(sampleModel(), 'add_stair', { roomId: 'r-lobby', floorHeight: "10'" });
    const s = r.model.cores![0]!;
    expect(s.stair!.risers).toBe(19);
    expect(s.stair!.riser).toBe(160);
    expect(r.summary).toMatch(/19 risers of 6¼"/);
  });

  it('places the stair in the requested corner of the room', () => {
    const m = apply(sampleModel(), 'add_stair', { roomId: 'r-lobby', corner: 'south-east' }).model;
    const s = m.cores![0]!;
    const f = coreFootprint(s);
    const rr = roomClearRect(m, room(m, 'Lobby · Lift · Stair'));
    expect(Math.abs(f.x1 - rr.x1)).toBeLessThanOrEqual(1);
    expect(Math.abs(f.y1 - rr.y1)).toBeLessThanOrEqual(1);
  });

  it('refuses a stair that cannot fit the room', () => {
    expect(() => apply(sampleModel(), 'add_stair', { roomId: 'r-t1' })).toThrow(/doesn't fit in Toilet 1/);
  });

  it('a second core goes to a free corner; overlap is flagged when forced', () => {
    let m = apply(sampleModel(), 'add_stair', { roomId: 'r-lobby' }).model;
    m = apply(m, 'add_lift', { roomId: 'r-lobby', persons: '8' }).model;
    expect(errors(m)).toEqual([]);
    const lift = m.cores!.find((c) => c.kind === 'lift')!;
    const stair = m.cores!.find((c) => c.kind === 'stair')!;
    const forced = apply(m, 'place_core', { coreId: lift.id, corner: m.cores && stairCorner(m, stair.id) }).model;
    expect(runChecks(forced).map((i) => i.code)).toContain('core.overlap');
  });

  it('moves, turns and removes a lift', () => {
    let m = apply(sampleModel(), 'add_lift', { roomId: 'r-lobby' }).model;
    const id = m.cores![0]!.id;
    const before = m.cores![0]!.at;
    m = apply(m, 'move_core', { coreId: id, direction: 'north', distance: '1\'' }).model;
    expect(m.cores![0]!.at.y).toBe(before.y - 305);
    m = apply(m, 'rotate_core', { coreId: id, degrees: '90' }).model;
    expect(m.cores![0]!.rotation).toBe(90);
    m = apply(m, 'remove', { entityId: id }).model;
    expect(m.cores).toEqual([]);
  });

  it('the assistant can find them by name', () => {
    const m = withCores();
    expect(findEntities(m, 'move the staircase')[0]!.type).toBe('core');
    expect(findEntities(m, 'the lift')[0]!.label).toMatch(/Lift/);
    expect(modelSummary(m)).toMatch(/STAIRS & LIFTS/);
  });

  it('stairs and lifts survive fitting to a plinth and turning the layout', () => {
    const plot = [
      op('set_plot', { eastWest: "30'", northSouth: "60'" }),
      op('set_setback', { side: 'all', distance: "3'" }),
    ];
    const model = withCores(plot);
    expect(model.cores!.length).toBe(2);
    for (const c of model.cores!) {
      const rr = roomClearRect(model, model.rooms.find((r) => r.id === c.roomId)!);
      const f = coreFootprint(c);
      expect(f.x0).toBeGreaterThanOrEqual(rr.x0 - 6);
      expect(f.x1).toBeLessThanOrEqual(rr.x1 + 6);
    }
  });
});

function stairCorner(m: BuildingModel, stairId: string) {
  const s = m.cores!.find((c) => c.id === stairId)!;
  const rr = roomClearRect(m, m.rooms.find((r) => r.id === s.roomId)!);
  const f = coreFootprint(s);
  const ns = Math.abs(f.y0 - rr.y0) < 2 ? 'north' : 'south';
  const ew = Math.abs(f.x0 - rr.x0) < 2 ? 'west' : 'east';
  return `${ns}-${ew}`;
}

describe('swap and move rooms', () => {
  it('swaps kitchen and Bed 2: names, types, furniture and door labels follow', () => {
    let m = apply(sampleModel(), 'place_item', { catalogueId: 'wardrobe-3', roomId: 'r-bed2', against: 'west' }).model;
    const kitchenRect = roomClearRect(m, room(m, 'Kitchen'));
    const r = apply(m, 'swap_rooms', { roomA: 'r-bed2', roomB: 'r-kitchen' });
    m = r.model;
    expect(m.rooms.find((x) => x.id === 'r-bed2')!.name).toBe('Kitchen');
    expect(m.rooms.find((x) => x.id === 'r-kitchen')!.name).toBe('Bed 2');
    expect(m.rooms.find((x) => x.id === 'r-kitchen')!.kind).toBe('bedroom');
    const wardrobe = m.furniture.find((f) => f.catalogueId === 'wardrobe-3')!;
    expect(wardrobe.roomId).toBe('r-kitchen');
    expect(wardrobe.at.x).toBeGreaterThan(kitchenRect.x0);
    expect(m.openings.find((o) => o.id === 'd-bed2')!.label).toBe('Kitchen door');
    expect(m.openings.find((o) => o.id === 'd-kitchen')!.label).toBe('Bed 2 door');
    expect(r.assumptions.join(' ')).toMatch(/wet room moved/);
  });

  it('moves a room (with its stair) to the north-east corner', () => {
    const m = apply(sampleModel(), 'add_stair', { roomId: 'r-lobby' }).model;
    const r = apply(m, 'move_room_to', { roomId: 'r-lobby', corner: 'north-east' });
    const lobbyNow = r.model.rooms.find((x) => x.name === 'Lobby · Lift · Stair')!;
    expect(lobbyNow.id).toBe('r-bed3');
    expect(r.model.cores!.every((c) => c.roomId === 'r-bed3')).toBe(true);
    expect(r.summary).toMatch(/Moved Lobby · Lift · Stair to the north-east corner; Bed 3 takes its old place/);
  });

  it('splits a room with a new wall; the new room takes the named side', () => {
    const m0 = sampleModel();
    const before = roomClearRect(m0, room(m0, 'Bed 3'));
    const r = apply(m0, 'split_room', { roomId: 'r-bed3', side: 'east', size: "5'", name: 'Dress', kind: 'other' });
    const dress = roomClearRect(r.model, room(r.model, 'Dress'));
    const bed = roomClearRect(r.model, room(r.model, 'Bed 3'));
    expect(Math.round(dress.x1 - dress.x0)).toBe(1524);
    expect(dress.x1).toBe(before.x1);
    expect(bed.x0).toBe(before.x0);
    expect(Math.round(bed.x1 - bed.x0)).toBe(Math.round(before.x1 - before.x0 - 1524 - 115));
    expect(r.summary).toMatch(/Split Bed 3: new Dress on the east side/);
  });

  it('refuses a split that leaves too little', () => {
    expect(() => apply(sampleModel(), 'split_room', { roomId: 'r-t1', side: 'east', size: "4'", name: 'X' })).toThrow(/too little/);
  });

  it('refuses to swap a room with itself', () => {
    expect(() => apply(sampleModel(), 'swap_rooms', { roomA: 'r-bed1', roomB: 'r-bed1' })).toThrow(/two different rooms/);
  });

  it('flags a wet room with no plumbing or outer wall', () => {
    const m = structuredClone(sampleModel());
    // Make every wall around the kitchen an ordinary internal wall.
    const k = m.rooms.find((r) => r.id === 'r-kitchen')!;
    for (const id of Object.values(k.bounds)) m.walls.find((w) => w.id === id)!.kind = 'internal';
    const codes = runChecks(m).filter((i) => i.code === 'room.no-plumbing-wall');
    expect(codes.map((i) => i.message)).toEqual(['Kitchen has no plumbing or outer wall for pipes and drains; check the routing.']);
    expect(runChecks(sampleModel()).some((i) => i.code === 'room.no-plumbing-wall')).toBe(false);
  });
});
