import { describe, expect, it } from 'vitest';
import {
  allRulesDecider,
  applyOperation,
  briefObjective,
  checkBrief,
  parseOperation,
  roomZone,
  runChecks,
  runFixLoop,
  startDesign,
  type BuildingModel,
} from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const apply = (m: BuildingModel, n: string, a: unknown) => applyOperation(m, op(n, a)).model;
const room = (m: BuildingModel, name: string) => m.rooms.find((r) => r.name === name)!;
const shell = () =>
  startDesign('shell', [op('set_plot', { eastWest: "60'", northSouth: "40'" }), op('set_setback', { side: 'all', distance: "5'" })], 'T').model;

const BRIEF = [
  { type: 'outer_wall', rooms: 'bedrooms' },
  { type: 'window', rooms: 'bedrooms' },
  { type: 'attached_toilet', rooms: 'bedrooms' },
  { type: 'zone', rooms: 'kitchen', zone: 'south-east' },
  { type: 'min_size', rooms: 'bedrooms', width: "10'", depth: "11'" },
];

/** Rooms dropped in roughly, nothing thought through. */
function rough(): BuildingModel {
  let m = shell();
  m = apply(m, 'add_room', { kind: 'bedroom', x: 6000, y: 4500 });
  m = apply(m, 'add_room', { kind: 'bedroom', x: 11000, y: 6500 });
  m = apply(m, 'add_room', { kind: 'kitchen', x: 2500, y: 2000 });
  m = apply(m, 'set_room_size', { roomId: room(m, 'Bed 2').id, width: "9'", depth: "10'" });
  return apply(m, 'set_brief', { items: BRIEF });
}

describe('brief checker', () => {
  it('says which rooms meet each item', () => {
    const m = rough();
    const res = checkBrief(m);
    expect(res.map((r) => r.label)).toEqual([
      'Every bedroom on an outer wall',
      'Every bedroom has a window',
      'Every bedroom has an attached toilet',
      'Kitchen in the south-east',
      "Every bedroom at least 10' × 11'",
    ]);
    expect(res.every((r) => !r.met)).toBe(true);
    expect(res[4]!.failing.map((f) => f.name)).toEqual(['Bed 2']);
    expect(roomZone(m, room(m, 'Kitchen'))).toBe('north-west');
  });

  it('is saved with the design and versioned', () => {
    const r = applyOperation(shell(), op('set_brief', { items: BRIEF.slice(0, 2) }));
    expect(r.model.brief?.items).toHaveLength(2);
    expect(r.summary).toMatch(/Brief set: every bedroom on an outer wall; every bedroom has a window/);
  });
});

describe('meet the brief agent (rules only)', () => {
  it('works a rough plan through to every brief item met, with no errors', async () => {
    const start = rough();
    const r = await runFixLoop(start, allRulesDecider, { objective: briefObjective, maxSteps: 30, maxTries: 300, repairSteps: 4 });
    const res = checkBrief(r.model);
    const open = res.filter((x) => !x.met).map((x) => `${x.label}: ${x.failing.map((f) => f.why).join(', ')}`);
    expect(open, open.join(' | ')).toEqual([]);
    expect(runChecks(r.model).filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.status).toBe('fixed');
    // Nothing removed; bedrooms not shrunk.
    for (const x of start.rooms) expect(r.model.rooms.some((y) => y.id === x.id)).toBe(true);
  });
});

describe('meet the brief: a second scenario', () => {
  it('three bedrooms, kitchen and pooja: bedrooms on outer walls with windows, pooja in the north-east, wet rooms on outer walls', async () => {
    let m = startDesign('shell', [op('set_plot', { eastWest: "60'", northSouth: "45'" }), op('set_setback', { side: 'all', distance: "5'" })], 'T').model;
    m = apply(m, 'add_room', { kind: 'bedroom', x: 4000, y: 5000 });
    m = apply(m, 'add_room', { kind: 'bedroom', x: 9000, y: 5500 });
    m = apply(m, 'add_room', { kind: 'bedroom', x: 13000, y: 7000 });
    m = apply(m, 'add_room', { kind: 'kitchen', x: 8000, y: 9000 });
    m = apply(m, 'add_room', { kind: 'pooja', x: 2000, y: 9500 });
    m = apply(m, 'set_brief', {
      items: [
        { type: 'outer_wall', rooms: 'bedrooms' },
        { type: 'window', rooms: 'bedrooms' },
        { type: 'zone', rooms: 'pooja', zone: 'north-east' },
        { type: 'outer_wall', rooms: 'wet rooms' },
      ],
    });
    const r = await runFixLoop(m, allRulesDecider, { objective: briefObjective, maxSteps: 30, maxTries: 300, repairSteps: 4 });
    const open = checkBrief(r.model).filter((x) => !x.met).map((x) => `${x.label}: ${x.failing.map((f) => f.why).join(', ')}`);
    expect(open, open.join(' | ')).toEqual([]);
    expect(runChecks(r.model).filter((i) => i.severity === 'error')).toEqual([]);
  });
});
