import { describe, expect, it } from 'vitest';
import {
  TEMPLATES,
  applyOperation,
  blockWallId,
  parseOperation,
  pointOnWall,
  getWall,
  roomClearRect,
  rotateLayout,
  runChecks,
  startDesign,
  type BuildingModel,
} from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const apply = (m: BuildingModel, n: string, a: unknown) => applyOperation(m, op(n, a));
const room = (m: BuildingModel, name: string) => m.rooms.find((r) => r.name === name)!;
const errors = (m: BuildingModel) => runChecks(m).filter((i) => i.severity === 'error');
const three = () => TEMPLATES.find((t) => t.id === '3bhk')!.build();

describe('room blocks', () => {
  it('templates are blocks inside outer walls; living/dining is the open space', () => {
    for (const t of TEMPLATES) {
      const m = t.build();
      expect(m.walls.every((w) => w.kind === 'external')).toBe(true);
      for (const r of m.rooms) expect(!!r.block).toBe(r.kind !== 'living' && r.kind !== 'dining');
      expect(errors(m), t.id).toEqual([]);
    }
  });

  it('a bedroom moves with its door, furniture; the doors stay on its walls', () => {
    const m = three();
    const bed1 = room(m, 'Bed 1');
    const door = m.openings.find((o) => o.label === 'Bed 1 door')!;
    const before = pointOnWall(getWall(m, door.wallId), door.offset);
    const bedItem = m.furniture.find((f) => f.roomId === bed1.id)!;
    const r = apply(m, 'move_room', { roomId: bed1.id, direction: 'south', distance: "6'" });
    const d2 = r.model.openings.find((o) => o.id === door.id)!;
    const after = pointOnWall(getWall(r.model, d2.wallId), d2.offset);
    expect(Math.round(after.y - before.y)).toBe(1829);
    expect(r.model.furniture.find((f) => f.id === bedItem.id)!.at.y - bedItem.at.y).toBe(1829);
    expect(r.summary).toMatch(/Moved Bed 1 6'0" south/);
  });

  it('flags a block dropped onto another', () => {
    const m = three();
    const r = apply(m, 'move_room', { roomId: room(m, 'Bed 1').id, direction: 'east', distance: "8'" });
    expect(errors(r.model).some((i) => i.code === 'block.overlap')).toBe(true);
  });

  it('snaps to a nearby wall line', () => {
    const m = three();
    const bed2 = room(m, 'Bed 2');
    const moved = apply(m, 'move_room', { roomId: bed2.id, direction: 'south', distance: "10'" }).model;
    const back = apply(moved, 'move_room', { roomId: bed2.id, direction: 'north', distance: "9'10\"" });
    expect(room(back.model, 'Bed 2').block!.y0).toBe(bed2.block!.y0);
    expect(back.assumptions.join(' ')).toMatch(/Lined up/);
  });

  it('dragging a shared block wall resizes both rooms', () => {
    const m = three();
    const bed2 = room(m, 'Bed 2');
    const kit = room(m, 'Kitchen');
    const r = apply(m, 'move_wall', { wallId: blockWallId(bed2.id, 'right'), direction: 'east', distance: "1'" });
    expect(room(r.model, 'Bed 2').block!.x1 - bed2.block!.x1).toBe(305);
    expect(room(r.model, 'Kitchen').block!.x0 - kit.block!.x0).toBe(305);
  });

  it('the living room cannot be moved; it is the open space', () => {
    const m = three();
    expect(() => apply(m, 'move_room', { roomId: room(m, 'Living / Dining').id, direction: 'east', distance: "1'" })).toThrow(/open space/);
  });

  it('add_room puts a new block in free space without overlaps', () => {
    const m = three();
    const r = apply(m, 'add_room', { name: 'Study', kind: 'other', width: "8'", depth: "9'" });
    expect(room(r.model, 'Study').block).toBeTruthy();
    expect(errors(r.model)).toEqual([]);
  });

  it('turning a block layout keeps doors on the right walls', () => {
    const m = three();
    const rot = rotateLayout(m);
    const bed1 = room(rot, 'Bed 1');
    const d = rot.openings.find((o) => o.label === 'Bed 1 door')!;
    const p = pointOnWall(getWall(rot, d.wallId), d.offset);
    const r = roomClearRect(rot, bed1);
    // The door is on Bed 1's edge, within its span.
    const onEdge = (Math.abs(p.x - r.x0) < 200 || Math.abs(p.x - r.x1) < 200) && p.y > r.y0 && p.y < r.y1;
    const onEdge2 = (Math.abs(p.y - r.y0) < 200 || Math.abs(p.y - r.y1) < 200) && p.x > r.x0 && p.x < r.x1;
    expect(onEdge || onEdge2).toBe(true);
    expect(errors(rot)).toEqual([]);
  });

  it('best fit on several plots gives block layouts with no errors', () => {
    for (const [ew, ns, sb] of [["60'", "40'", '0'], ["60'", "40'", "5'"], ["30'", "60'", "3'"], ["40'", "30'", "3'"]] as const) {
      const { model } = startDesign('auto', [op('set_plot', { eastWest: ew, northSouth: ns }), op('set_setback', { side: 'all', distance: sb })], 'T', { toilets: 3 });
      expect(errors(model), `${ew} × ${ns}`).toEqual([]);
    }
  });
});

describe('fixtures', () => {
  it('starting layouts have a WC and basin in each toilet and a counter in the kitchen', () => {
    for (const t of TEMPLATES.filter((x) => x.id !== 'shell')) {
      const m = t.build();
      for (const r of m.rooms.filter((x) => x.kind === 'toilet')) {
        expect(m.furniture.some((f) => f.roomId === r.id && f.catalogueId === 'wc-floor'), `${t.id} ${r.name}`).toBe(true);
      }
      const k = m.rooms.find((x) => x.kind === 'kitchen')!;
      expect(m.furniture.some((f) => f.roomId === k.id && f.catalogueId === 'kitchen-counter')).toBe(true);
    }
  });

  it('fixtures move with their room block', () => {
    const m = three();
    const t1 = room(m, 'Toilet 1');
    const wc = m.furniture.find((f) => f.roomId === t1.id && f.catalogueId === 'wc-floor')!;
    const r = apply(m, 'move_room', { roomId: t1.id, direction: 'south', distance: "10'" });
    expect(r.model.furniture.find((f) => f.id === wc.id)!.at.y - wc.at.y).toBe(3048);
  });

  it('fit_out refuses a room that already has fixtures', () => {
    const m = three();
    expect(() => apply(m, 'fit_out', { roomId: room(m, 'Toilet 1').id })).toThrow(/already has fixtures/);
  });
});

describe('bare shell and dropped blocks', () => {
  const shellAt = () => startDesign('shell', [op('set_plot', { eastWest: "60'", northSouth: "40'" }), op('set_setback', { side: 'all', distance: "5'" })], 'S').model;

  it('starts with only the outer walls, sized to the plinth', () => {
    const m = shellAt();
    expect(m.walls).toHaveLength(4);
    expect(m.rooms.map((r) => r.kind)).toEqual(['living']);
    expect(m.cores ?? []).toEqual([]);
  });

  it('drops a bedroom at a point: snapped to the outer wall, with a door and a window', () => {
    const m = shellAt();
    const r = apply(m, 'add_room', { kind: 'bedroom', x: 2000, y: 2000 });
    const bed = room(r.model, 'Bed 1');
    expect(bed.block!.x0).toBe(0);
    expect(bed.block!.y0).toBe(0);
    expect(r.model.openings.some((o) => o.label === 'Bed 1 door')).toBe(true);
    expect(r.model.openings.some((o) => o.label === 'Bed 1 window')).toBe(true);
    expect(errors(r.model)).toEqual([]);
    const c = roomClearRect(r.model, bed);
    expect([Math.round(c.x1 - c.x0), Math.round(c.y1 - c.y0)]).toEqual([3353, 3658]);
  });

  it('a dropped bathroom comes with a WC and basin', () => {
    const m = apply(shellAt(), 'add_room', { kind: 'toilet', x: 500, y: 9000 }).model;
    const t = room(m, 'Toilet 1');
    expect(m.furniture.filter((f) => f.roomId === t.id).map((f) => f.catalogueId).sort()).toEqual(['wash-basin', 'wc-floor']);
  });

  it('stairs dropped on a room too small for them stand in the open space', () => {
    let m = apply(shellAt(), 'add_room', { kind: 'lobby', x: 13000, y: 7000 }).model;
    const lobby = room(m, 'Lobby');
    const lr = roomClearRect(m, lobby);
    m = apply(m, 'add_stair', { x: (lr.x0 + lr.x1) / 2, y: (lr.y0 + lr.y1) / 2 }).model;
    expect(m.cores![0]!.roomId).toBe(room(m, 'Living / Dining').id);
  });

  it('stairs and lift drop at a point', () => {
    let m = apply(shellAt(), 'add_room', { kind: 'lobby', x: 13000, y: 7000 }).model;
    const lobby = room(m, 'Lobby');
    m = apply(m, 'add_stair', { x: 7000, y: 7000 }).model;
    m = apply(m, 'add_lift', { x: 9000, y: 2000 }).model;
    expect(m.cores!.map((c) => c.kind).sort()).toEqual(['lift', 'stair']);
    expect(errors(m)).toEqual([]);
    expect(lobby).toBeTruthy();
  });

  it('typed sizes keep the sides against walls', () => {
    const m = apply(shellAt(), 'add_room', { kind: 'bedroom', x: 2000, y: 2000 }).model;
    const bed = room(m, 'Bed 1');
    const r = apply(m, 'set_room_size', { roomId: bed.id, width: "13'", depth: "11'" });
    const c = roomClearRect(r.model, room(r.model, 'Bed 1'));
    expect(Math.round(c.x1 - c.x0)).toBe(3962);
    expect(Math.round(c.y1 - c.y0)).toBe(3353);
    expect(room(r.model, 'Bed 1').block!.x0).toBe(0);
    expect(r.summary).toMatch(/13'0" × 11'0"/);
  });

  it('removing a room returns its space', () => {
    const m = apply(shellAt(), 'add_room', { kind: 'toilet', x: 500, y: 9000 }).model;
    const r = apply(m, 'remove_room', { roomId: room(m, 'Toilet 1').id });
    expect(r.model.rooms.map((x) => x.kind)).toEqual(['living']);
    expect(r.model.furniture).toEqual([]);
    expect(r.model.openings).toEqual([]);
  });
});
