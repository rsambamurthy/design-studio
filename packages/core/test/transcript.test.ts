/** The requests from the user's design-studio transcript that went wrong, as tests. */
import { describe, expect, it } from 'vitest';
import { applyOperation, coincidentSides, getWall, itemFootprint, parseOperation, pointOnWall, rectsOverlap, roomClearRect, runChecks, startDesign, wallDir, type BuildingModel } from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const apply = (m: BuildingModel, n: string, a: unknown) => applyOperation(m, op(n, a)).model;
const room = (m: BuildingModel, name: string) => m.rooms.find((r) => r.name === name)!;
const errors = (m: BuildingModel) => runChecks(m).filter((i) => i.severity === 'error');
const shell = () =>
  startDesign('shell', [op('set_plot', { eastWest: "60'", northSouth: "40'" }), op('set_setback', { side: 'all', distance: "5'" })], 'T').model;

describe('transcript requests', () => {
  it('"Make T1 horizontal": the room turns and its fixtures turn with it (no overlaps)', () => {
    let m = apply(shell(), 'add_room', { kind: 'toilet', x: 1000, y: 3000 });
    const t1 = room(m, 'Toilet 1');
    const before = roomClearRect(m, t1);
    m = apply(m, 'rotate_room', { roomId: t1.id });
    const after = roomClearRect(m, room(m, 'Toilet 1'));
    expect(Math.round(after.x1 - after.x0)).toBe(Math.round(before.y1 - before.y0));
    const items = m.furniture.filter((f) => f.roomId === t1.id).map(itemFootprint);
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) expect(rectsOverlap(items[i]!, items[j]!, 5)).toBe(false);
    expect(errors(m)).toEqual([]);
  });

  it('"Bring T2 adjacent to T1\'s north wall, aligned to the west wall"', () => {
    let m = apply(shell(), 'add_room', { kind: 'toilet', x: 1000, y: 5000 });
    m = apply(m, 'add_room', { kind: 'toilet', x: 9000, y: 6000 });
    const t1 = room(m, 'Toilet 1');
    const t2 = room(m, 'Toilet 2');
    m = apply(m, 'place_room_against', { roomId: t2.id, targetId: t1.id, side: 'north', align: 'west' });
    const a = room(m, 'Toilet 1').block!;
    const b = room(m, 'Toilet 2').block!;
    expect(b.y1).toBe(a.y0);
    expect(b.x0).toBe(a.x0);
    expect(coincidentSides(m, room(m, 'Toilet 2'), 'bottom').map((c) => c.room.id)).toContain(t1.id);
    expect(errors(m)).toEqual([]);
  });

  it('a huge move stops at the outer wall instead of leaving the building', () => {
    let m = apply(shell(), 'add_room', { kind: 'toilet', x: 6000, y: 4000 });
    m = apply(m, 'move_room', { roomId: room(m, 'Toilet 1').id, direction: 'west', distance: "50'" });
    expect(errors(m).filter((i) => i.code === 'block.outside')).toEqual([]);
    expect(room(m, 'Toilet 1').block!.x0).toBe(0);
  });

  it('"Entrance to T2 from B2": a door on the shared wall, opening into the toilet', () => {
    let m = apply(shell(), 'add_room', { kind: 'bedroom', x: 2000, y: 2000 });
    m = apply(m, 'add_room', { kind: 'toilet', x: 9000, y: 8000 });
    const bed = room(m, 'Bed 1');
    const t = room(m, 'Toilet 1');
    m = apply(m, 'place_room_against', { roomId: t.id, targetId: bed.id, side: 'south', align: 'west' });
    const r = applyOperation(m, op('add_door_between', { roomA: bed.id, roomB: t.id }));
    const door = r.model.openings.find((o) => o.label === 'Toilet 1 door from Bed 1')!;
    expect(door).toBeTruthy();
    // The leaf swings toward the toilet's centre.
    const w = getWall(r.model, door.wallId);
    const d = wallDir(w);
    const side = door.swingSide === 'left' ? 1 : -1;
    const n = { x: d.y * side, y: -d.x * side };
    const p = pointOnWall(w, door.offset);
    const c = roomClearRect(r.model, room(r.model, 'Toilet 1'));
    expect(((c.x0 + c.x1) / 2 - p.x) * n.x + ((c.y0 + c.y1) / 2 - p.y) * n.y).toBeGreaterThan(0);
    expect(r.summary).toMatch(/opening into Toilet 1/);
  });

  it('rooms that do not touch get a clear message instead of a guessed door', () => {
    let m = apply(shell(), 'add_room', { kind: 'bedroom', x: 2000, y: 2000 });
    m = apply(m, 'add_room', { kind: 'toilet', x: 12000, y: 8000 });
    expect(() => apply(m, 'add_door_between', { roomA: room(m, 'Bed 1').id, roomB: room(m, 'Toilet 1').id })).toThrow(/don't share a wall/);
  });

  it('"Let the door open inwards into the toilet": edit_door', () => {
    let m = apply(shell(), 'add_room', { kind: 'toilet', x: 6000, y: 4000 });
    const t = room(m, 'Toilet 1');
    const door = m.openings.find((o) => o.label === 'Toilet 1 door')!;
    const flipped = apply(m, 'edit_door', { openingId: door.id, opensInto: room(m, 'Living / Dining').id });
    expect(flipped.openings.find((o) => o.id === door.id)!.swingSide).not.toBe(door.swingSide);
    const back = apply(flipped, 'edit_door', { openingId: door.id, opensInto: t.id });
    expect(back.openings.find((o) => o.id === door.id)!.swingSide).toBe(door.swingSide);
  });

  it('"Make B1 14 x 13" gives exactly 14\'0" × 13\'0", even against the thick outer walls', () => {
    let m = apply(shell(), 'add_room', { kind: 'bedroom', x: 200, y: 200 });
    m = apply(m, 'set_room_size', { roomId: room(m, 'Bed 1').id, width: "14'", depth: "13'" });
    const c = roomClearRect(m, room(m, 'Bed 1'));
    expect([Math.round(c.x1 - c.x0), Math.round(c.y1 - c.y0)]).toEqual([4267, 3962]);
  });
});

describe('door placement details', () => {
  it('a door from a bedroom into a fitted toilet clears the fixtures, and the toilet\'s living-room door goes', () => {
    let m = apply(shell(), 'add_room', { kind: 'bedroom', x: 2000, y: 2000 });
    m = apply(m, 'add_room', { kind: 'toilet', x: 9000, y: 8000 });
    m = apply(m, 'place_room_against', { roomId: room(m, 'Toilet 1').id, targetId: room(m, 'Bed 1').id, side: 'south', align: 'west' });
    const r = applyOperation(m, op('add_door_between', { roomA: room(m, 'Bed 1').id, roomB: room(m, 'Toilet 1').id }));
    expect(runChecks(r.model).filter((i) => i.code.includes('swing'))).toEqual([]);
    const toiletDoors = r.model.openings.filter((o) => o.label.startsWith('Toilet 1 door'));
    expect(toiletDoors.map((o) => o.label)).toEqual(['Toilet 1 door from Bed 1']);
    expect(r.assumptions.join(' ')).toMatch(/Removed Toilet 1's door to the living area/);
  });
});

describe('changing the plot while working', () => {
  it('a bigger plot: the outer walls grow to the new buildable area, rooms keep their sizes, rooms on the east wall move with it', () => {
    let m = apply(shell(), 'add_room', { kind: 'bedroom', x: 200, y: 200 });
    m = apply(m, 'add_room', { kind: 'toilet', x: 99999, y: 200 });
    const bedBefore = roomClearRect(m, room(m, 'Bed 1'));
    const t = room(m, 'Toilet 1').block!;
    const r = applyOperation(m, op('set_plot', { eastWest: "70'", northSouth: "45'" }));
    const outer = r.model.walls;
    const xs = outer.flatMap((w) => [w.a.x, w.b.x]);
    const ys = outer.flatMap((w) => [w.a.y, w.b.y]);
    // 70' − 10' setbacks = 60' outside, 45' − 10' = 35'
    expect(Math.abs(Math.max(...xs) - Math.min(...xs) + 230 - 18288)).toBeLessThanOrEqual(1);
    expect(Math.abs(Math.max(...ys) - Math.min(...ys) + 230 - 10668)).toBeLessThanOrEqual(1);
    const bedAfter = roomClearRect(r.model, room(r.model, 'Bed 1'));
    expect(Math.round(bedAfter.x1 - bedAfter.x0)).toBe(Math.round(bedBefore.x1 - bedBefore.x0));
    expect(room(r.model, 'Toilet 1').block!.x1).toBe(Math.max(...xs));
    expect(room(r.model, 'Toilet 1').block!.x1 - room(r.model, 'Toilet 1').block!.x0).toBe(t.x1 - t.x0);
    expect(r.assumptions.join(' ')).toMatch(/Outer walls now 60'0" × 35'0"/);
    expect(runChecks(r.model).filter((i) => i.space === 'site' && i.severity !== 'advisory')).toEqual([]);
  });

  it('a bigger setback shrinks the building; rooms that would stick out come back in', () => {
    let m = apply(shell(), 'add_room', { kind: 'bedroom', x: 99999, y: 99999 });
    const r = applyOperation(m, op('set_setback', { side: 'east', distance: "15'" }));
    expect(errors(r.model).filter((i) => i.code === 'block.outside')).toEqual([]);
    expect(runChecks(r.model).filter((i) => i.code === 'site.setback')).toEqual([]);
  });
});
