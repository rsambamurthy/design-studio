import { describe, expect, it } from 'vitest';
import {
  applyOperation,
  parseOperation,
  roomClearRect,
  ruleDecider,
  runChecks,
  runFixLoop,
  scorePlan,
  startDesign,
  type BuildingModel,
  type Decider,
} from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const apply = (m: BuildingModel, n: string, a: unknown) => applyOperation(m, op(n, a)).model;
const room = (m: BuildingModel, name: string) => m.rooms.find((r) => r.name === name)!;
const shell = () =>
  startDesign('shell', [op('set_plot', { eastWest: "60'", northSouth: "40'" }), op('set_setback', { side: 'all', distance: "5'" })], 'T').model;

/** A plan with a handful of typical mistakes. */
export function brokenPlan(): BuildingModel {
  let m = shell();
  m = apply(m, 'add_room', { kind: 'bedroom', x: 2000, y: 2000 });
  m = apply(m, 'add_room', { kind: 'bedroom', x: 4000, y: 3000 }); // overlaps Bed 1
  m = apply(m, 'add_room', { kind: 'toilet', x: 9000, y: 6000 });
  m = apply(m, 'add_room', { kind: 'lobby', x: 13000, y: 6000 });
  m = apply(m, 'add_stair', { x: 7000, y: 7500 });
  m = apply(m, 'add_lift', { x: 7600, y: 7600 }); // overlaps the stair
  return m;
}

describe('fix-the-issues loop', () => {
  it('the broken plan really is broken', () => {
    const s = scorePlan(brokenPlan());
    expect(s.errors).toBeGreaterThanOrEqual(2);
    expect(s.pass).toBe(false);
  });

  it('the rule-based agent clears every error and warning, within the rules', async () => {
    const start = brokenPlan();
    const r = await runFixLoop(start, ruleDecider);
    expect(r.status).toBe('fixed');
    expect(r.after.errors).toBe(0);
    expect(r.after.warnings).toBe(0);
    // Same rooms, same sizes (within 6")
    expect(r.model.rooms.map((x) => x.id).sort()).toEqual(start.rooms.map((x) => x.id).sort());
    for (const s of start.rooms.filter((x) => x.block)) {
      const a = roomClearRect(start, s);
      const b = roomClearRect(r.model, r.model.rooms.find((x) => x.id === s.id)!);
      expect(Math.abs(b.x1 - b.x0 - (a.x1 - a.x0)) <= 152 || Math.abs(b.x1 - b.x0 - (a.y1 - a.y0)) <= 152).toBe(true);
    }
    expect(r.steps.filter((x) => x.accepted).length).toBeGreaterThan(0);
  });

  it('turns down candidates that break the rules or make things worse', async () => {
    const start = brokenPlan();
    const bad: Decider = {
      decide: () => [
        { ops: [{ op: 'remove_room', args: { roomId: room(start, 'Bed 2').id } }], why: 'delete the room' },
        { ops: [{ op: 'set_room_size', args: { roomId: room(start, 'Bed 2').id, width: "6'" } }], why: 'shrink it' },
        { ops: [{ op: 'set_plot', args: { eastWest: "90'", northSouth: "90'" } }], why: 'bigger plot' },
      ],
    };
    const r = await runFixLoop(start, bad);
    expect(r.status).toBe('stuck');
    expect(r.model).toBe(start);
    expect(r.steps.slice(0, 3).map((x) => x.reason)).toEqual([
      "remove_room isn't allowed while fixing.",
      `Bed 2 would change size by more than 6".`,
      "set_plot isn't allowed while fixing.",
    ]);
  });

  it('stops when asked', async () => {
    let n = 0;
    const r = await runFixLoop(brokenPlan(), ruleDecider, { shouldStop: () => n++ >= 1 });
    expect(r.status).toBe('stopped');
  });

  it('reports nothing to do on a clean plan', async () => {
    const r = await runFixLoop(shell(), ruleDecider);
    expect(r.status).toBe('nothing');
    expect(r.steps).toEqual([]);
  });

  it('fixes a door that swings into a fixture', async () => {
    let m = apply(shell(), 'add_room', { kind: 'toilet', x: 6000, y: 4000 });
    const t = room(m, 'Toilet 1');
    const door = m.openings.find((o) => o.label === 'Toilet 1 door')!;
    m = apply(m, 'edit_door', { openingId: door.id, opensInto: t.id });
    m = apply(m, 'set_room_size', { roomId: t.id, width: "4'3\"" }); // tight: the WC comes within the door's reach
    // Slide the door along its wall until its swing hits a fixture.
    let clash = m;
    for (let off = 100; off < 3000 && runChecks(clash).every((i) => i.code !== 'door.swing-blocked'); off += 50) {
      clash = { ...m, openings: m.openings.map((o) => (o.id === door.id ? { ...o, offset: off } : o)) };
    }
    expect(runChecks(clash).some((i) => i.code === 'door.swing-blocked')).toBe(true);
    const r = await runFixLoop(clash, ruleDecider);
    expect(r.status).toBe('fixed');
    expect(r.model.rooms.find((x) => x.id === t.id)).toBeTruthy();
  });
});

describe('fix agent test set', () => {
  // Messy plans of the kind people make while dragging blocks in quickly.
  const cases: [string, [string, number, number][]][] = [
    ['two bedrooms on top of each other', [['bedroom', 2000, 2000], ['bedroom', 3000, 2500]]],
    ['toilet dropped onto a bedroom', [['bedroom', 2000, 2000], ['toilet', 3500, 3000]]],
    ['stairs and lift on top of each other', [['stair', 7000, 7000], ['lift', 7400, 7300]]],
    ['bedroom, kitchen and two toilets in a heap', [['bedroom', 5000, 5000], ['kitchen', 6000, 5500], ['toilet', 5500, 6000], ['toilet', 6200, 5200]]],
    ['lobby with stairs dropped on a bedroom', [['bedroom', 9000, 2000], ['lobby', 9500, 2500], ['stair', 9000, 3000]]],
  ];
  for (const [name, drops] of cases) {
    it(`fixes: ${name}`, async () => {
      let m = shell();
      for (const [kind, x, y] of drops) {
        m = kind === 'stair' ? apply(m, 'add_stair', { x, y }) : kind === 'lift' ? apply(m, 'add_lift', { x, y }) : apply(m, 'add_room', { kind, x, y });
      }
      const before = scorePlan(m);
      expect(before.pass).toBe(false);
      const r = await runFixLoop(m, ruleDecider);
      expect(r.after.errors, r.remaining.map((i) => i.message).join('; ')).toBe(0);
      expect(r.after.warnings, r.remaining.map((i) => i.message).join('; ')).toBe(0);
      expect(r.steps.filter((s) => s.accepted).length).toBeLessThanOrEqual(15);
    });
  }
});
