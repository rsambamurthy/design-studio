/**
 * "Fix the issues": runs the core fix loop in the background on a draft of the
 * design. Claude proposes a fix for each problem (when an API key is set); the
 * rule-based fixes are tried after it. Progress is written to agent_runs after
 * every step; nothing touches the design until the user keeps the result.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  BRIEF_OPS,
  FIX_OPS,
  allRulesDecider,
  briefObjective,
  checkBrief,
  fixObjective,
  readBrief,
  chainDeciders,
  modelSummary,
  operationToolDefinitions,
  parseOperation,
  ruleDecider,
  runFixLoop,
  type BuildingModel,
  type Candidate,
  type Decider,
  type Operation,
  type PlanScore,
  type StepRecord,
} from '@ds/core';
import { AuthError } from './auth';
import { getDb, newId } from './db';
import { appendRevision, getDesign } from './designs';

const FIX_SYSTEM = `You fix problems in a residential floor plan, one problem at a time, using the tools.

Each turn you get the plan (rooms with positions and gaps, doors, furniture and fixtures, stairs and lifts) and the open problems, errors first. Pick the FIRST problem and call one to three tools that fix it. Then stop.

Rules (steps that break them are turned down automatically):
- Don't add or remove rooms, stairs or lifts, and don't change the plot or setbacks.
- A room's clear width and depth may change by at most 6". Prefer moving, turning or lining up a room over resizing it.
- Only doors and windows may be removed (e.g. to put a door on a better wall with add_door_between).
- Use the "place" lines to work out moves; use place_room_against to put a room flush against another, instead of guessing distances.
- Door swing clashes: try edit_door (opensInto the other room, or flipHinge), move_opening along the wall, or moving the fixture.
- A fix that makes the plan worse is undone; the history shows what was tried. Don't repeat a failed idea.
- If you can't see a fix for the first problem, call give_up with a short reason.`;

const BRIEF_SYSTEM = `You change a residential floor plan so it meets the client's brief, one problem at a time, using the tools.

Each turn you get the plan (rooms with positions and gaps, doors, fixtures, stairs and lifts), the brief checklist with what is met, and the open problems in order: errors first, then brief items, then warnings. Work on the FIRST open problem: call one to three tools for it, then stop.

How to meet common brief items:
- Room on an outer wall / needs a window: place_room_against with targetId "outer" (side = the outer wall; align to a corner if useful), or swap_rooms with a room already on an outer wall; then add_opening a window on the OUTER wall (wallId of the outer wall, roomId the room).
- Room in a compass zone (e.g. kitchen in the south-east): place_room_against "outer" on one of the zone's sides, aligned to the other (side south, align east), or swap_rooms with the room already there.
- Attached toilet: add_toilet on the bedroom (it carves one out, or puts a new toilet beside it with a door).
- Minimum size: set_room_size, or move_wall on the room's own blk: walls to grow it away from neighbours.
- Next to another room: place_room_against that room.

Rules (steps that break them are turned down automatically):
- Don't remove rooms, stairs or lifts; only toilets may be added (via add_toilet). Don't change the plot or setbacks.
- Rooms may grow, but not shrink by more than 6".
- A step that makes the plan worse overall is undone; if it puts a room on top of another, the other room is moved out of the way automatically when possible. The history shows what was tried; don't repeat a failed idea.
- If you can't see a way to meet the first problem, call give_up.`;

const GIVE_UP = {
  name: 'give_up',
  description: 'No sensible fix for the first problem within the rules.',
  input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
};

/** Claude proposes one candidate fix per step. Tracks token use. */
export function claudeDecider(usage: { tokens: number }, kind: RunKind = 'fix'): Decider {
  const client = new Anthropic();
  const modelId = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const allowed: readonly string[] = kind === 'brief' ? BRIEF_OPS : FIX_OPS;
  const tools = [...operationToolDefinitions().filter((t) => allowed.includes(t.name)), GIVE_UP];
  const system = kind === 'brief' ? BRIEF_SYSTEM : FIX_SYSTEM;
  return {
    async decide({ model, issues, history }) {
      const recent = history
        .slice(-10)
        .map((h) => `- ${h.accepted ? 'KEPT' : 'TURNED DOWN'}: ${h.why}${h.reason ? ` (${h.reason})` : ''}`)
        .join('\n');
      const problems = issues.map((i, k) => `${k + 1}. [${i.severity}] ${i.message} (ids: ${i.entityIds.join(', ')})`).join('\n');
      const res = await client.messages.create({
        model: modelId,
        max_tokens: 800,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: tools as unknown as Anthropic.Tool[],
        tool_choice: { type: 'any' },
        messages: [
          {
            role: 'user',
            content: `PLAN\n${modelSummary(model)}${
              kind === 'brief' ? `\n\nBRIEF\n${checkBrief(model).map((b) => `- [${b.met ? 'x' : b.empty ? '-' : ' '}] ${b.label}${b.failing.length ? ` (${b.failing.map((f) => f.why).join('; ')})` : ''}`).join('\n')}` : ''
            }\n\nOPEN PROBLEMS (work on the first)\n${problems}${recent ? `\n\nTRIED SO FAR\n${recent}` : ''}`,
          },
        ],
      });
      usage.tokens += (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0);
      const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (calls.length === 0 || calls.some((c) => c.name === 'give_up')) return [];
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join(' ').trim();
      const ops = calls.map((c) => ({ op: c.name, args: c.input as Record<string, unknown> }));
      const candidate: Candidate = { ops, why: text ? text.slice(0, 160) : `Claude: ${ops.map((o) => o.op.replace(/_/g, ' ')).join(', ')}` };
      return [candidate];
    },
  };
}

export type RunKind = 'fix' | 'brief';

export interface AgentRun {
  id: string;
  kind: RunKind;
  status: 'running' | 'done' | 'failed' | 'kept' | 'discarded';
  outcome: string | null;
  baseRev: number;
  model: BuildingModel;
  steps: StepRecord[];
  before: PlanScore | null;
  after: PlanScore | null;
  remaining: { message: string; severity: string }[] | null;
  message: string | null;
  mode: string | null;
  tokens: number;
  stopRequested: boolean;
  createdAt: string;
}

type Row = {
  id: string;
  kind: RunKind;
  status: AgentRun['status'];
  outcome: string | null;
  base_rev: number;
  model: BuildingModel;
  steps: StepRecord[];
  before_score: PlanScore | null;
  after_score: PlanScore | null;
  remaining: AgentRun['remaining'];
  message: string | null;
  mode: string | null;
  tokens: number;
  stop_requested: boolean;
  created_at: string;
  updated_at: string;
};

const asRun = (r: Row): AgentRun => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  outcome: r.outcome,
  baseRev: r.base_rev,
  model: r.model,
  steps: r.steps,
  before: r.before_score,
  after: r.after_score,
  remaining: r.remaining,
  message: r.message,
  mode: r.mode,
  tokens: r.tokens,
  stopRequested: r.stop_requested,
  createdAt: String(r.created_at),
});

/** A run that hasn't reported for this long is treated as interrupted (e.g. a server restart). */
const STALE_MS = 3 * 60 * 1000;

async function loadRun(userId: string, designId: string, runId: string): Promise<Row> {
  const db = await getDb();
  const { rows } = await db.query<Row>(`SELECT * FROM agent_runs WHERE id = $1 AND design_id = $2 AND user_id = $3`, [runId, designId, userId]);
  const r = rows[0];
  if (!r) throw new AuthError('Agent run not found.', 404);
  if (r.status === 'running' && Date.now() - new Date(r.updated_at).getTime() > STALE_MS) {
    await db.query(`UPDATE agent_runs SET status = 'failed', message = 'The run was interrupted. Start it again.', updated_at = now() WHERE id = $1`, [r.id]);
    return { ...r, status: 'failed', message: 'The run was interrupted. Start it again.' };
  }
  return r;
}

export async function getRun(userId: string, designId: string, runId: string): Promise<AgentRun> {
  return asRun(await loadRun(userId, designId, runId));
}

/** The latest run for a design, if it is still running or waiting for Keep/Discard. */
export async function openRun(userId: string, designId: string): Promise<AgentRun | null> {
  const db = await getDb();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM agent_runs WHERE design_id = $1 AND user_id = $2 AND status IN ('running', 'done') ORDER BY created_at DESC LIMIT 1`,
    [designId, userId],
  );
  return rows[0] ? getRun(userId, designId, rows[0].id) : null;
}

/** Start fixing in the background; returns at once with the new run. */
export async function startFixRun(userId: string, designId: string, kind: RunKind = 'fix'): Promise<AgentRun> {
  const existing = await openRun(userId, designId);
  if (existing?.status === 'running') return existing;
  const design = await getDesign(userId, designId);
  if (kind === 'brief' && !readBrief(design.model)) throw new AuthError('Set the brief first (Brief tab).');
  const db = await getDb();
  const id = newId(12);
  const mode = process.env.ANTHROPIC_API_KEY ? 'claude' : 'rules';
  await db.query(
    `UPDATE agent_runs SET status = 'discarded', updated_at = now() WHERE design_id = $1 AND user_id = $2 AND status = 'done'`,
    [designId, userId],
  );
  await db.query(
    `INSERT INTO agent_runs (id, design_id, user_id, kind, status, base_rev, model, mode) VALUES ($1, $2, $3, $7, 'running', $4, $5, $6)`,
    [id, designId, userId, design.currentRev, JSON.stringify(design.model), mode, kind],
  );
  void execute(id, design.model, mode, kind);
  return getRun(userId, designId, id);
}

async function execute(runId: string, start: BuildingModel, mode: string, kind: RunKind) {
  const db = await getDb();
  const usage = { tokens: 0 };
  const rules = kind === 'brief' ? allRulesDecider : ruleDecider;
  const decider = mode === 'claude' ? chainDeciders(claudeDecider(usage, kind), rules) : rules;
  const steps: StepRecord[] = [];
  try {
    const result = await runFixLoop(start, decider, {
      objective: kind === 'brief' ? briefObjective : fixObjective,
      repairSteps: kind === 'brief' ? 4 : 0,
      maxTries: kind === 'brief' ? 300 : 80,
      maxSteps: kind === 'brief' ? 30 : 15,
      shouldStop: async () => {
        const { rows } = await db.query<{ stop_requested: boolean }>(`SELECT stop_requested FROM agent_runs WHERE id = $1`, [runId]);
        return !!rows[0]?.stop_requested;
      },
      onStep: async (step, model, score) => {
        steps.push(step);
        await db.query(`UPDATE agent_runs SET steps = $2, model = $3, after_score = $4, tokens = $5, updated_at = now() WHERE id = $1`, [
          runId,
          JSON.stringify(steps),
          JSON.stringify(model),
          JSON.stringify(score),
          usage.tokens,
        ]);
      },
    });
    await db.query(
      `UPDATE agent_runs SET status = 'done', outcome = $2, model = $3, before_score = $4, after_score = $5, remaining = $6, tokens = $7, updated_at = now() WHERE id = $1`,
      [
        runId,
        result.status,
        JSON.stringify(result.model),
        JSON.stringify(result.before),
        JSON.stringify(result.after),
        JSON.stringify(result.remaining.map((i) => ({ message: i.message, severity: i.severity }))),
        usage.tokens,
      ],
    );
  } catch (err) {
    await db.query(`UPDATE agent_runs SET status = 'failed', message = $2, updated_at = now() WHERE id = $1`, [runId, err instanceof Error ? err.message.slice(0, 500) : 'The run failed.']);
  }
}

export async function stopRun(userId: string, designId: string, runId: string): Promise<AgentRun> {
  await loadRun(userId, designId, runId);
  const db = await getDb();
  await db.query(`UPDATE agent_runs SET stop_requested = true WHERE id = $1`, [runId]);
  return getRun(userId, designId, runId);
}

export async function discardRun(userId: string, designId: string, runId: string): Promise<AgentRun> {
  const r = await loadRun(userId, designId, runId);
  if (r.status === 'running') throw new AuthError('Stop the run first.', 409);
  const db = await getDb();
  await db.query(`UPDATE agent_runs SET status = 'discarded', updated_at = now() WHERE id = $1`, [runId]);
  return getRun(userId, designId, runId);
}

/** Save the fixed plan as one revision (undo puts everything back). */
export async function keepRun(userId: string, designId: string, runId: string): Promise<{ run: AgentRun; revision: number | null }> {
  const r = await loadRun(userId, designId, runId);
  if (r.status !== 'done') throw new AuthError(r.status === 'running' ? 'The run is still going; stop it first.' : 'This run can no longer be kept.', 409);
  const kept = r.steps.filter((s) => s.accepted);
  if (kept.length === 0) throw new AuthError('Nothing was changed, so there is nothing to keep.', 409);
  const ops: Operation[] = [];
  for (const s of kept) for (const o of s.ops) ops.push(parseOperation(o.op, o.args));
  const b = r.before_score;
  const a = r.after_score;
  const what = r.kind === 'brief' ? 'Worked towards the brief' : 'Fixed issues';
  const summary = `${what} with ${kept.length} change${kept.length === 1 ? '' : 's'}: ${kept.map((s) => s.summary).join(' ')}`.slice(0, 1900);
  const { revision } = await appendRevision(userId, designId, async (_current, currentRev) => {
    if (currentRev !== r.base_rev) throw new AuthError('The design changed while the agent was working. Discard this run and start again.', 409);
    return {
      request:
        r.kind === 'brief'
          ? `Meet the brief${b && a && a.briefTotal ? ` (${b.briefMet ?? 0}/${b.briefTotal} → ${a.briefMet ?? 0}/${a.briefTotal} met)` : ''}`
          : `Fix the issues${b && a ? ` (errors ${b.errors}→${a.errors}, warnings ${b.warnings}→${a.warnings})` : ''}`,
      summary,
      ops,
      model: r.model,
    };
  });
  const db = await getDb();
  await db.query(`UPDATE agent_runs SET status = 'kept', updated_at = now() WHERE id = $1`, [runId]);
  return { run: await getRun(userId, designId, runId), revision };
}
