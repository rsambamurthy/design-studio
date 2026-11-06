/**
 * "Fix the issues" agent: a plan → act → check loop over the same typed
 * operations people use. A decider (Claude, or the rule-based one here)
 * proposes candidate fixes; every candidate is applied by the kernel, scored by
 * the checks, and kept only if the plan got better and stayed inside the
 * guard rails (no rooms removed, room sizes within 6", site untouched).
 */
import { runChecks, type Issue } from './checks';
import { checkBrief, roomZone, selectRooms, type BriefItem } from './brief';
import { parseLength } from './units';
import { fixedWallUnder } from './model';
import { roomClearRect } from './geometry';
import { applyOperation } from './kernel';
import { getWall, parseBlockWallId, type BuildingModel, type Room } from './model';
import { parseOperation, type OperationName } from './ops';
import { pointOnWall, wallDir } from './geometry';
import { itemFootprint } from './catalogue';
import { coreFootprint, coresOf, CORNERS } from './cores';
import { vectorToCompass } from './geometry';

/** Operations the fixer may use. Nothing that adds or deletes rooms or touches the site. */
export const FIX_OPS: OperationName[] = [
  'move_room',
  'place_room_against',
  'rotate_room',
  'set_room_size',
  'move_wall',
  'move_opening',
  'centre_opening',
  'set_opening_width',
  'edit_door',
  'add_door_between',
  'move_item',
  'centre_item',
  'rotate_item',
  'flip_item',
  'move_core',
  'place_core',
  'rotate_core',
  'move_building',
  'remove',
];

/** How far a room's clear width or depth may change while fixing. */
export const MAX_SIZE_DRIFT = 152; // 6"

export interface PlanScore {
  points: number;
  errors: number;
  warnings: number;
  advisories: number;
  /** No errors and no warnings (and, for a brief run, every brief item met). */
  pass: boolean;
  briefUnmet?: number;
  briefMet?: number;
  briefTotal?: number;
}

export function scorePlan(model: BuildingModel, issues: Issue[] = runChecks(model)): PlanScore {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const advisories = issues.length - errors - warnings;
  return { points: -100 * errors - 20 * warnings - advisories, errors, warnings, advisories, pass: errors === 0 && warnings === 0 };
}

/** Problems the fixer works on (errors first), each with a stable key. */
export function fixableIssues(issues: Issue[]): (Issue & { key: string })[] {
  const order = { error: 0, warning: 1, advisory: 2 } as const;
  return issues
    .filter((i) => i.severity !== 'advisory')
    .map((i) => ({ ...i, key: issueKey(i) }))
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

export function issueKey(i: Issue): string {
  return `${i.code}|${[...i.entityIds].sort().join(',')}`;
}

/** Something the agent works on: a check issue, or a brief item a room doesn't meet yet. */
export interface Problem {
  key: string;
  code: string;
  severity: 'error' | 'warning' | 'brief';
  message: string;
  entityIds: string[];
  item?: BriefItem;
}

/** What a run works towards: the problems to solve, how to score a plan, and the rules. */
export interface Objective {
  kind: 'fix' | 'brief';
  problems(model: BuildingModel): Problem[];
  score(model: BuildingModel): PlanScore;
  guard(base: BuildingModel, next: BuildingModel, ops: OpCall[]): string | undefined;
}

export const fixObjective: Objective = {
  kind: 'fix',
  problems: (m) => fixableIssues(runChecks(m)).map((i) => ({ key: i.key, code: i.code, severity: i.severity as 'error' | 'warning', message: i.message, entityIds: i.entityIds })),
  score: (m) => scorePlan(m),
  guard: (base, next, ops) => guardViolation(base, next, ops),
};

/** Extra operations the brief agent may use (adding windows and attached toilets, swapping rooms). */
export const BRIEF_OPS: OperationName[] = [...FIX_OPS, 'add_opening', 'add_toilet', 'swap_rooms'];

/** Placement first (where rooms go), then what they need (toilets, windows). */
const BRIEF_ORDER = ['zone', 'outer_wall', 'min_size', 'next_to', 'attached_toilet', 'window'];

export function briefProblems(model: BuildingModel): Problem[] {
  return unorderedBriefProblems(model).sort((a, b) => BRIEF_ORDER.indexOf(a.item!.type) - BRIEF_ORDER.indexOf(b.item!.type));
}

function unorderedBriefProblems(model: BuildingModel): Problem[] {
  const out: Problem[] = [];
  checkBrief(model).forEach((res, k) => {
    for (const f of res.failing) {
      out.push({ key: `brief.${res.item.type}|${k}|${f.roomId}`, code: `brief.${res.item.type}`, severity: 'brief', message: `${res.label}: ${f.why}.`, entityIds: [f.roomId], item: res.item });
    }
  });
  return out;
}

export const briefObjective: Objective = {
  kind: 'brief',
  problems(m) {
    const checks = fixableIssues(runChecks(m)).map((i) => ({ key: i.key, code: i.code, severity: i.severity as 'error' | 'warning', message: i.message, entityIds: i.entityIds }));
    // Errors first, then the brief, then warnings.
    return [...checks.filter((i) => i.severity === 'error'), ...briefProblems(m), ...checks.filter((i) => i.severity === 'warning')];
  },
  score(m) {
    const s = scorePlan(m);
    const unmet = briefProblems(m).length;
    const results = checkBrief(m);
    return { ...s, points: s.points - 40 * unmet, pass: s.pass && unmet === 0, briefUnmet: unmet, briefMet: results.filter((r) => r.met).length, briefTotal: results.filter((r) => !r.empty).length };
  },
  guard(base, next, ops) {
    for (const o of ops) {
      if (!BRIEF_OPS.includes(o.op as OperationName)) return `${o.op} isn't allowed while meeting the brief.`;
      if (o.op === 'remove' && !base.openings.some((x) => x.id === String(o.args.entityId ?? ''))) return 'Only doors and windows may be removed.';
    }
    // Rooms may be added only as toilets; none removed.
    for (const r of base.rooms) if (!next.rooms.some((x) => x.id === r.id)) return 'Rooms may not be removed.';
    for (const r of next.rooms) if (!base.rooms.some((x) => x.id === r.id) && r.kind !== 'toilet' && r.kind !== 'other') return 'Only toilets (and their dress areas) may be added.';
    if ((base.cores ?? []).length !== (next.cores ?? []).length) return 'Stairs and lifts may not be added or removed.';
    if (JSON.stringify(base.site?.plot) !== JSON.stringify(next.site?.plot) || JSON.stringify(base.site?.setbacks) !== JSON.stringify(next.site?.setbacks)) return 'The plot and setbacks may not change.';
    // A room (by name, so swaps count) may grow but not shrink by more than 6".
    for (const r of base.rooms) {
      if (!r.block) continue;
      const n = next.rooms.find((x) => x.name === r.name);
      if (!n) continue;
      const a = roomClearRect(base, r);
      const b = roomClearRect(next, n);
      const [a1, a2] = [a.x1 - a.x0, a.y1 - a.y0].sort((p, q) => p - q);
      const [b1, b2] = [b.x1 - b.x0, b.y1 - b.y0].sort((p, q) => p - q);
      if (b1! < a1! - MAX_SIZE_DRIFT || b2! < a2! - MAX_SIZE_DRIFT) return `${r.name} would get smaller by more than 6".`;
    }
    return undefined;
  },
};

export interface OpCall {
  op: string;
  args: Record<string, unknown>;
}

export interface Candidate {
  ops: OpCall[];
  /** One line on what this tries, for the step log. */
  why: string;
}

export interface DeciderInput {
  model: BuildingModel;
  score: PlanScore;
  issues: Problem[];
  /** Issues the decider gave up on (every candidate made things worse). */
  skip: Set<string>;
  history: StepRecord[];
  step: number;
  /** Rooms that must stay put (e.g. the room just placed, while repairing around it). */
  pinned?: Set<string>;
}

export interface Decider {
  /** Candidate fixes for the next problem, best first; empty = nothing more to try. */
  decide(input: DeciderInput): Promise<Candidate[]> | Candidate[];
}

export interface StepRecord {
  n: number;
  why: string;
  summary: string;
  ops: OpCall[];
  accepted: boolean;
  /** Why a candidate was turned down. */
  reason?: string;
  errors: number;
  warnings: number;
  issueKey?: string;
}

export type FixStatus = 'fixed' | 'stuck' | 'limit' | 'stopped' | 'nothing';

export interface FixResult {
  model: BuildingModel;
  status: FixStatus;
  before: PlanScore;
  after: PlanScore;
  steps: StepRecord[];
  /** Problems still open at the end. */
  remaining: Problem[];
}

export interface FixOptions {
  maxSteps?: number;
  /** Maximum candidates tried in total (accepted or not). */
  maxTries?: number;
  shouldStop?: () => boolean | Promise<boolean>;
  onStep?: (step: StepRecord, model: BuildingModel, score: PlanScore) => void | Promise<void>;
  /** What to work towards (default: clear errors and warnings). */
  objective?: Objective;
  /**
   * When a candidate creates new errors (e.g. a room placed onto another), try
   * up to this many repair steps that move the other rooms before judging it.
   */
  repairSteps?: number;
  pinned?: Set<string>;
}

/** Why a candidate breaks the rules, or undefined if it is allowed. */
export function guardViolation(base: BuildingModel, next: BuildingModel, ops: OpCall[]): string | undefined {
  for (const o of ops) {
    if (!FIX_OPS.includes(o.op as OperationName)) return `${o.op} isn't allowed while fixing.`;
    if (o.op === 'remove') {
      const id = String(o.args.entityId ?? '');
      if (!base.openings.some((x) => x.id === id)) return 'Only doors and windows may be removed while fixing.';
    }
  }
  const baseIds = new Set(base.rooms.map((r) => r.id));
  const nextIds = new Set(next.rooms.map((r) => r.id));
  if (baseIds.size !== nextIds.size || [...baseIds].some((id) => !nextIds.has(id))) return 'Rooms may not be added or removed while fixing.';
  if ((base.cores ?? []).length !== (next.cores ?? []).length) return 'Stairs and lifts may not be added or removed.';
  if (JSON.stringify(base.site?.plot) !== JSON.stringify(next.site?.plot) || JSON.stringify(base.site?.setbacks) !== JSON.stringify(next.site?.setbacks)) return 'The plot and setbacks may not change.';
  for (const r of base.rooms) {
    const n = next.rooms.find((x) => x.id === r.id)!;
    if (!r.block || !n.block) continue;
    const a = roomClearRect(base, r);
    const b = roomClearRect(next, n);
    const dw = Math.abs(b.x1 - b.x0 - (a.x1 - a.x0));
    const dh = Math.abs(b.y1 - b.y0 - (a.y1 - a.y0));
    const turned = Math.abs(b.x1 - b.x0 - (a.y1 - a.y0)) <= MAX_SIZE_DRIFT && Math.abs(b.y1 - b.y0 - (a.x1 - a.x0)) <= MAX_SIZE_DRIFT;
    if ((dw > MAX_SIZE_DRIFT || dh > MAX_SIZE_DRIFT) && !turned) return `${r.name} would change size by more than 6".`;
  }
  return undefined;
}

/** Apply a candidate's operations in order; throws on the first that fails. */
export function applyCandidate(model: BuildingModel, ops: OpCall[]): { model: BuildingModel; summary: string } {
  let m = model;
  const said: string[] = [];
  for (const o of ops) {
    const r = applyOperation(m, parseOperation(o.op, o.args));
    m = r.model;
    said.push(r.summary);
  }
  return { model: m, summary: said.join(' ') };
}

/**
 * Run the loop: ask the decider for candidates, try them in order, keep the
 * first that improves the score within the rules, repeat until the plan
 * passes, nothing more helps, the step limit, or a stop request.
 */
export async function runFixLoop(start: BuildingModel, decider: Decider, opts: FixOptions = {}): Promise<FixResult> {
  const obj = opts.objective ?? fixObjective;
  const maxSteps = opts.maxSteps ?? 15;
  const maxTries = opts.maxTries ?? 80;
  let model = start;
  let score = obj.score(model);
  const before = score;
  const steps: StepRecord[] = [];
  const skip = new Set<string>();
  let tries = 0;
  let accepted = 0;
  let status: FixStatus = before.pass ? 'nothing' : 'stuck';

  while (!score.pass) {
    if (opts.shouldStop && (await opts.shouldStop())) {
      status = 'stopped';
      break;
    }
    if (accepted >= maxSteps || tries >= maxTries) {
      status = 'limit';
      break;
    }
    const open = obj.problems(model).filter((i) => !skip.has(i.key));
    if (open.length === 0) {
      status = 'stuck';
      break;
    }
    const candidates = await decider.decide({ model, score, issues: open, skip, history: steps, step: steps.length, pinned: opts.pinned });
    const target = open[0]!.key;
    if (candidates.length === 0) {
      skip.add(target);
      continue;
    }
    let kept = false;
    for (const c of candidates) {
      if (tries >= maxTries) break;
      tries++;
      const rec: StepRecord = { n: steps.length + 1, why: c.why, summary: '', ops: c.ops, accepted: false, errors: score.errors, warnings: score.warnings, issueKey: target };
      try {
        const out = applyCandidate(model, c.ops);
        let bad = obj.guard(start, out.model, c.ops);
        if (!bad && opts.repairSteps && obj.score(out.model).errors > score.errors) {
          // Repair around the room(s) this candidate placed, keeping them pinned.
          const pinned = new Set(c.ops.flatMap((o) => [o.args.roomId, o.args.roomA, o.args.roomB].filter((x): x is string => typeof x === 'string')));
          const repair = await runFixLoop(out.model, ruleDecider, {
            objective: { ...fixObjective, guard: (_b, n, ops) => obj.guard(start, n, ops) },
            maxSteps: opts.repairSteps,
            maxTries: opts.repairSteps * 12,
            pinned,
          });
          const repaired = repair.steps.filter((x) => x.accepted);
          if (repaired.length) {
            out.model = repair.model;
            out.summary = `${out.summary} ${repaired.map((x) => x.summary).join(' ')}`;
            c.ops = [...c.ops, ...repaired.flatMap((x) => x.ops)];
            rec.ops = c.ops;
            bad = obj.guard(start, out.model, c.ops);
          }
        }
        rec.summary = out.summary;
        if (bad) {
          rec.reason = bad;
        } else {
          const next = obj.score(out.model);
          if (next.points > score.points) {
            model = out.model;
            score = next;
            rec.accepted = true;
            rec.errors = next.errors;
            rec.warnings = next.warnings;
          } else {
            rec.reason = next.points === score.points ? 'No improvement.' : 'Made the plan worse.';
          }
        }
      } catch (err) {
        rec.reason = err instanceof Error ? err.message : String(err);
      }
      steps.push(rec);
      if (opts.onStep) await opts.onStep(rec, model, score);
      if (rec.accepted) {
        kept = true;
        accepted++;
        break;
      }
    }
    if (!kept) skip.add(target);
  }
  if (score.pass && !before.pass) status = 'fixed';
  return { model, status, before, after: score, steps, remaining: obj.problems(model) };
}

// ---------------------------------------------------------------------------
// Rule-based decider: concrete candidate fixes for each kind of problem.
// Used without an API key, and after Claude's own idea when it doesn't work.
// ---------------------------------------------------------------------------

const DIRS = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

const mm = (n: number) => `${Math.max(1, Math.round(n))} mm`;

function roomById(model: BuildingModel, id: string): Room | undefined {
  return model.rooms.find((r) => r.id === id);
}

function area(model: BuildingModel, r: Room) {
  const c = roomClearRect(model, r);
  return (c.x1 - c.x0) * (c.y1 - c.y0);
}

/** Rooms on either side of a door. */
function doorRooms(model: BuildingModel, openingId: string): Room[] {
  const o = model.openings.find((x) => x.id === openingId);
  if (!o) return [];
  const w = getWall(model, o.wallId);
  const d = wallDir(w);
  const p = pointOnWall(w, o.offset);
  const n = { x: d.y, y: -d.x };
  const out: Room[] = [];
  for (const k of [1, -1]) {
    const q = { x: p.x + n.x * (w.thickness / 2 + 150) * k, y: p.y + n.y * (w.thickness / 2 + 150) * k };
    const hits = model.rooms.filter((r) => {
      const c = roomClearRect(model, r);
      return q.x >= c.x0 && q.x <= c.x1 && q.y >= c.y0 && q.y <= c.y1;
    });
    const r = hits.find((x) => x.block) ?? hits[0];
    if (r) out.push(r);
  }
  return out;
}

export const ruleDecider: Decider = {
  decide({ model, issues, pinned }) {
    const issue = issues[0];
    if (!issue) return [];
    const compass = (v: { x: number; y: number }) => vectorToCompass(v, model.northAngle);
    const out: Candidate[] = [];
    const [a, b] = issue.entityIds;
    switch (issue.code) {
      case 'block.overlap': {
        const ra = roomById(model, a!);
        const rb = roomById(model, b!);
        if (!ra || !rb) break;
        // Move the smaller room clear of the larger, the shortest way first; or set it against it.
        let [mover, fixed] = area(model, ra) <= area(model, rb) ? [ra, rb] : [rb, ra];
        if (pinned?.has(mover.id) && !pinned.has(fixed.id)) [mover, fixed] = [fixed, mover];
        if (pinned?.has(mover.id)) break;
        const m = mover.block!;
        const f = fixed.block!;
        const pushes = [
          { v: DIRS[0]!, d: m.y1 - f.y0 },
          { v: DIRS[1]!, d: f.y1 - m.y0 },
          { v: DIRS[2]!, d: m.x1 - f.x0 },
          { v: DIRS[3]!, d: f.x1 - m.x0 },
        ].filter((p) => p.d > 0).sort((p, q) => p.d - q.d);
        for (const p of pushes) out.push({ ops: [{ op: 'move_room', args: { roomId: mover.id, direction: compass(p.v), distance: mm(p.d) } }], why: `Move ${mover.name} ${compass(p.v)} clear of ${fixed.name}` });
        for (const side of ['north', 'south', 'east', 'west']) out.push({ ops: [{ op: 'place_room_against', args: { roomId: mover.id, targetId: fixed.id, side, align: 'keep' } }], why: `Put ${mover.name} against ${fixed.name}'s ${side} wall` });
        // Or the other one moves.
        if (!pinned?.has(fixed.id)) for (const p of pushes.slice(0, 2)) out.push({ ops: [{ op: 'move_room', args: { roomId: fixed.id, direction: compass({ x: -p.v.x, y: -p.v.y }), distance: mm(p.d) } }], why: `Move ${fixed.name} clear of ${mover.name}` });
        break;
      }
      case 'block.outside': {
        const r = roomById(model, a!);
        if (r) for (const v of DIRS) out.push({ ops: [{ op: 'move_room', args: { roomId: r.id, direction: compass(v), distance: '1 mm' } }], why: `Bring ${r.name} back inside the outer walls` });
        break;
      }
      case 'door.swing-blocked':
      case 'core.door-swing': {
        const door = model.openings.find((o) => o.id === a);
        if (!door) break;
        out.push({ ops: [{ op: 'edit_door', args: { openingId: door.id, flipHinge: true } }], why: `Hinge ${door.label} on the other side` });
        for (const r of doorRooms(model, door.id)) out.push({ ops: [{ op: 'edit_door', args: { openingId: door.id, opensInto: r.id } }], why: `Let ${door.label} open into ${r.name}` });
        const w = getWall(model, door.wallId);
        const d = wallDir(w);
        for (const dist of [305, 610, 914]) {
          for (const s of [1, -1]) out.push({ ops: [{ op: 'move_opening', args: { openingId: door.id, direction: compass({ x: d.x * s, y: d.y * s }), distance: mm(dist) } }], why: `Slide ${door.label} ${Math.round(dist / 305)}' along its wall` });
        }
        // Or move what it hits.
        const item = model.furniture.find((f) => f.id === b);
        if (item) for (const v of DIRS) out.push({ ops: [{ op: 'move_item', args: { itemId: item.id, direction: compass(v), distance: '450 mm' } }], why: `Move ${item.label} out of the door's way` });
        break;
      }
      case 'door.outside': {
        const door = model.openings.find((o) => o.id === a);
        const owner = door ? parseBlockWallId(door.wallId) : undefined;
        const open = model.rooms.find((r) => !r.block && (r.kind === 'living' || r.kind === 'dining'));
        if (door && owner && open) out.push({ ops: [{ op: 'remove', args: { entityId: door.id } }, { op: 'add_door_between', args: { roomA: owner.roomId, roomB: open.id } }], why: `Move ${door.label} to a wall facing the living area` });
        break;
      }
      case 'item.outside-room':
      case 'item.overlap':
      case 'item.front-clearance': {
        const item = model.furniture.find((f) => f.id === a);
        if (!item) break;
        out.push({ ops: [{ op: 'centre_item', args: { itemId: item.id, axis: 'both' } }], why: `Centre ${item.label} in its room` });
        // A slightly bigger room (within the 6" allowance) often gives the clearance.
        const host = roomById(model, item.roomId);
        if (host?.block) {
          const c = roomClearRect(model, host);
          for (const grow of [76, 152]) {
            out.push({ ops: [{ op: 'set_room_size', args: { roomId: host.id, width: mm(c.x1 - c.x0 + grow) } }], why: `Widen ${host.name} by ${grow === 76 ? '3"' : '6"'}` });
            out.push({ ops: [{ op: 'set_room_size', args: { roomId: host.id, depth: mm(c.y1 - c.y0 + grow) } }], why: `Deepen ${host.name} by ${grow === 76 ? '3"' : '6"'}` });
          }
        }
        out.push({ ops: [{ op: 'rotate_item', args: { itemId: item.id, degrees: '90' } }], why: `Turn ${item.label}` });
        for (const dist of [300, 600]) for (const v of DIRS) out.push({ ops: [{ op: 'move_item', args: { itemId: item.id, direction: compass(v), distance: mm(dist) } }], why: `Move ${item.label} ${compass(v)}` });
        break;
      }
      case 'core.outside-room':
      case 'core.overlap':
      case 'core.furniture':
      case 'core.under-room':
      case 'core.entry-blocked': {
        const core = coresOf(model).find((c) => c.id === a) ?? coresOf(model).find((c) => issue.entityIds.includes(c.id));
        if (!core) break;
        if (issue.code === 'core.entry-blocked') {
          for (const deg of ['180', '90', '-90'] as const) out.push({ ops: [{ op: 'rotate_core', args: { coreId: core.id, degrees: deg } }], why: `Turn the ${core.label.toLowerCase()} so its entry faces the room` });
        }
        for (const corner of CORNERS) out.push({ ops: [{ op: 'place_core', args: { coreId: core.id, corner } }], why: `Put the ${core.label.toLowerCase()} in the ${corner} corner` });
        const fp = coreFootprint(core);
        const size = Math.max(fp.x1 - fp.x0, fp.y1 - fp.y0);
        for (const v of DIRS) out.push({ ops: [{ op: 'move_core', args: { coreId: core.id, direction: compass(v), distance: mm(size / 2) } }], why: `Move the ${core.label.toLowerCase()} ${compass(v)}` });
        break;
      }
      default:
        break;
    }
    void itemFootprint;
    return out;
  },
};

/** Try one decider's candidates first, then another's (e.g. Claude, then the rules). */
export function chainDeciders(...deciders: Decider[]): Decider {
  return {
    async decide(input) {
      const all: Candidate[] = [];
      for (const d of deciders) {
        try {
          all.push(...(await d.decide(input)));
        } catch {
          /* fall through to the next decider */
        }
      }
      return all;
    },
  };
}

// ---------------------------------------------------------------------------
// Rule-based candidates for brief items.
// ---------------------------------------------------------------------------

const OUTER_SIDES = ['north', 'south', 'east', 'west'] as const;
const ACROSS: Record<(typeof OUTER_SIDES)[number], readonly ('north' | 'south' | 'east' | 'west')[]> = {
  north: ['east', 'west'],
  south: ['east', 'west'],
  east: ['north', 'south'],
  west: ['north', 'south'],
};

/** Ways to put a room against an outer wall: each side, kept in line, or pushed to either corner. Shortest move first. */
function toOuterWall(model: BuildingModel, r: Room): Candidate[] {
  const out: { c: Candidate; d: number }[] = [];
  for (const side of OUTER_SIDES) {
    for (const align of ['keep', ...ACROSS[side]] as const) {
      const ops: OpCall[] = [{ op: 'place_room_against', args: { roomId: r.id, targetId: 'outer', side, align } }];
      let d = Infinity;
      try {
        const m = applyCandidate(model, ops).model;
        const a = r.block!;
        const b = m.rooms.find((x) => x.id === r.id)!.block!;
        d = Math.abs(b.x0 - a.x0) + Math.abs(b.y0 - a.y0);
      } catch {
        continue;
      }
      out.push({ c: { ops, why: `Put ${r.name} against the ${side} outer wall${align === 'keep' ? '' : `, in the ${side}-${align} corner`.replace('east-north', 'north-east').replace('west-north', 'north-west').replace('east-south', 'south-east').replace('west-south', 'south-west')}` }, d });
    }
  }
  return out.sort((a, b) => a.d - b.d).map((x) => x.c);
}

/** Swap uses with a block that already satisfies a test, and is at least about as big. */
function swapsWith(model: BuildingModel, r: Room, ok: (o: Room) => boolean): Candidate[] {
  const ar = area(model, r);
  return model.rooms
    .filter((o) => o.block && o.id !== r.id && o.kind !== r.kind && ok(o) && area(model, o) >= ar * 0.85)
    .map((o) => ({ ops: [{ op: 'swap_rooms', args: { roomA: r.id, roomB: o.id } }], why: `Swap ${r.name} with ${o.name}` }));
}

function onOuter(model: BuildingModel, r: Room): boolean {
  return (['top', 'bottom', 'left', 'right'] as const).some((s) => fixedWallUnder(model, r, s)?.kind === 'external');
}

export const briefRuleDecider: Decider = {
  decide({ model, issues }) {
    const compass = (v: { x: number; y: number }) => vectorToCompass(v, model.northAngle);
    const p = issues[0];
    if (!p || !p.code.startsWith('brief.') || !p.item) return [];
    const r = roomById(model, p.entityIds[0]!);
    if (!r) return [];
    const item = p.item;
    const out: Candidate[] = [];
    switch (item.type) {
      case 'outer_wall':
        if (r.block) out.push(...toOuterWall(model, r));
        out.push(...swapsWith(model, r, (o) => onOuter(model, o)));
        break;
      case 'window': {
        if (r.block && onOuter(model, r)) {
          for (const s of ['top', 'bottom', 'left', 'right'] as const) {
            const w = fixedWallUnder(model, r, s);
            if (w?.kind !== 'external') continue;
            for (const width of ["5'", "4'", "3'"]) out.push({ ops: [{ op: 'add_opening', args: { wallId: w.id, kind: 'window', width, label: `${r.name} window`, roomId: r.id } }], why: `Add a ${width} window to ${r.name}` });
          }
        } else if (r.block) {
          // Get to an outer wall and add a window in one go.
          for (const c of toOuterWall(model, r).slice(0, 6)) out.push({ ops: [...c.ops], why: `${c.why} (for a window)` });
        }
        out.push(...swapsWith(model, r, (o) => onOuter(model, o)));
        break;
      }
      case 'attached_toilet':
        out.push({ ops: [{ op: 'add_toilet', args: { roomId: r.id } }], why: `Add a toilet attached to ${r.name}` });
        // Or bring a free-standing toilet against it with a door between.
        for (const t of model.rooms.filter((o) => o.kind === 'toilet' && o.block)) {
          for (const side of OUTER_SIDES) out.push({ ops: [{ op: 'place_room_against', args: { roomId: t.id, targetId: r.id, side, align: 'keep' } }, { op: 'add_door_between', args: { roomA: r.id, roomB: t.id } }], why: `Put ${t.name} against ${r.name} and connect them` });
        }
        break;
      case 'zone': {
        const z = item.zone;
        if (r.block && z !== 'centre') {
          const parts = z.split('-') as ('north' | 'south' | 'east' | 'west')[];
          if (parts.length === 2) {
            out.push({ ops: [{ op: 'place_room_against', args: { roomId: r.id, targetId: 'outer', side: parts[0], align: parts[1] } }], why: `Put ${r.name} in the ${z} corner` });
            out.push({ ops: [{ op: 'place_room_against', args: { roomId: r.id, targetId: 'outer', side: parts[1], align: parts[0] } }], why: `Put ${r.name} in the ${z} corner` });
          } else {
            out.push({ ops: [{ op: 'place_room_against', args: { roomId: r.id, targetId: 'outer', side: parts[0], align: 'centre' } }], why: `Put ${r.name} in the middle of the ${z} side` });
            out.push({ ops: [{ op: 'place_room_against', args: { roomId: r.id, targetId: 'outer', side: parts[0], align: 'keep' } }], why: `Put ${r.name} on the ${z} side` });
          }
        }
        out.push(...swapsWith(model, r, (o) => roomZone(model, o) === z));
        break;
      }
      case 'min_size': {
        if (!r.block) break;
        const w = parseLength(item.width).mm;
        const h = parseLength(item.depth).mm;
        const c = roomClearRect(model, r);
        const cw = c.x1 - c.x0;
        const ch = c.y1 - c.y0;
        // Grow by pushing chosen walls out (each way), so it can grow away from its neighbours.
        for (const [needW, needH] of [[w - cw, h - ch], [h - cw, w - ch]] as const) {
          const xs = needW > 1 ? (['left', 'right'] as const) : ([null] as const);
          const ys = needH > 1 ? (['top', 'bottom'] as const) : ([null] as const);
          for (const sx of xs) {
            for (const sy of ys) {
              const ops: OpCall[] = [];
              if (sx && !fixedWallUnder(model, r, sx)) ops.push({ op: 'move_wall', args: { wallId: r.bounds[sx], direction: compass({ x: sx === 'left' ? -1 : 1, y: 0 }), distance: mm(needW) } });
              if (sy && !fixedWallUnder(model, r, sy)) ops.push({ op: 'move_wall', args: { wallId: r.bounds[sy], direction: compass({ x: 0, y: sy === 'top' ? -1 : 1 }), distance: mm(needH) } });
              if (ops.length) out.push({ ops, why: `Enlarge ${r.name} towards the ${[sx, sy].filter(Boolean).map((x) => compass({ x: x === 'left' ? -1 : x === 'right' ? 1 : 0, y: x === 'top' ? -1 : x === 'bottom' ? 1 : 0 })).join(' and ')}` });
            }
          }
        }
        out.push({ ops: [{ op: 'set_room_size', args: { roomId: r.id, width: mm(Math.max(cw, w)), depth: mm(Math.max(ch, h)) } }], why: `Make ${r.name} at least ${item.width} × ${item.depth}` });
        out.push({ ops: [{ op: 'set_room_size', args: { roomId: r.id, width: mm(Math.max(cw, h)), depth: mm(Math.max(ch, w)) } }], why: `Make ${r.name} at least ${item.depth} × ${item.width}` });
        break;
      }
      case 'next_to': {
        if (!r.block) break;
        for (const o of selectRooms(model, item.other).filter((x) => x.block && x.id !== r.id)) {
          for (const side of OUTER_SIDES) for (const align of ['keep', 'centre'] as const) out.push({ ops: [{ op: 'place_room_against', args: { roomId: r.id, targetId: o.id, side, align } }], why: `Put ${r.name} against ${o.name}'s ${side} wall` });
        }
        break;
      }
    }
    return out;
  },
};

/** Rules for both check problems and brief items. */
export const allRulesDecider: Decider = chainDeciders(ruleDecider, briefRuleDecider);
