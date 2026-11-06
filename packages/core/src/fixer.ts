/**
 * "Fix the issues" agent: a plan → act → check loop over the same typed
 * operations people use. A decider (Claude, or the rule-based one here)
 * proposes candidate fixes; every candidate is applied by the kernel, scored by
 * the checks, and kept only if the plan got better and stayed inside the
 * guard rails (no rooms removed, room sizes within 6", site untouched).
 */
import { runChecks, type Issue } from './checks';
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
  /** No errors and no warnings. */
  pass: boolean;
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
  issues: (Issue & { key: string })[];
  /** Issues the decider gave up on (every candidate made things worse). */
  skip: Set<string>;
  history: StepRecord[];
  step: number;
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
  remaining: Issue[];
}

export interface FixOptions {
  maxSteps?: number;
  /** Maximum candidates tried in total (accepted or not). */
  maxTries?: number;
  shouldStop?: () => boolean | Promise<boolean>;
  onStep?: (step: StepRecord, model: BuildingModel, score: PlanScore) => void | Promise<void>;
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
  const maxSteps = opts.maxSteps ?? 15;
  const maxTries = opts.maxTries ?? 80;
  let model = start;
  let issues = runChecks(model);
  const before = scorePlan(model, issues);
  const steps: StepRecord[] = [];
  const skip = new Set<string>();
  let tries = 0;
  let accepted = 0;
  let status: FixStatus = before.pass ? 'nothing' : 'stuck';

  while (!scorePlan(model, issues).pass) {
    if (opts.shouldStop && (await opts.shouldStop())) {
      status = 'stopped';
      break;
    }
    if (accepted >= maxSteps || tries >= maxTries) {
      status = 'limit';
      break;
    }
    const score = scorePlan(model, issues);
    const open = fixableIssues(issues).filter((i) => !skip.has(i.key));
    if (open.length === 0) {
      status = 'stuck';
      break;
    }
    const candidates = await decider.decide({ model, score, issues: open, skip, history: steps, step: steps.length });
    if (candidates.length === 0) {
      status = 'stuck';
      break;
    }
    const target = open[0]!.key;
    let kept = false;
    for (const c of candidates) {
      if (tries >= maxTries) break;
      tries++;
      const rec: StepRecord = { n: steps.length + 1, why: c.why, summary: '', ops: c.ops, accepted: false, errors: score.errors, warnings: score.warnings, issueKey: target };
      try {
        const out = applyCandidate(model, c.ops);
        rec.summary = out.summary;
        const bad = guardViolation(start, out.model, c.ops);
        if (bad) {
          rec.reason = bad;
        } else {
          const nextIssues = runChecks(out.model);
          const next = scorePlan(out.model, nextIssues);
          if (next.points > score.points) {
            model = out.model;
            issues = nextIssues;
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
      if (opts.onStep) await opts.onStep(rec, model, scorePlan(model, issues));
      if (rec.accepted) {
        kept = true;
        accepted++;
        break;
      }
    }
    if (!kept) skip.add(target);
  }
  const after = scorePlan(model, issues);
  if (after.pass && !before.pass) status = 'fixed';
  return { model, status, before, after, steps, remaining: fixableIssues(issues) };
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
  decide({ model, issues }) {
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
        const [mover, fixed] = area(model, ra) <= area(model, rb) ? [ra, rb] : [rb, ra];
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
        for (const p of pushes.slice(0, 2)) out.push({ ops: [{ op: 'move_room', args: { roomId: fixed.id, direction: compass({ x: -p.v.x, y: -p.v.y }), distance: mm(p.d) } }], why: `Move ${fixed.name} clear of ${mover.name}` });
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
