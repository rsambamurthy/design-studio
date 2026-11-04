/**
 * LLM orchestrator. Runs server-side only (the API key never reaches the
 * browser). The LLM proposes typed operations; the deterministic kernel applies
 * and validates them. One user message = one atomic revision.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  applyOperation,
  findCatalogue,
  findEntities,
  modelSummary,
  operationToolDefinitions,
  parseOperation,
  runChecks,
  type BuildingModel,
  type Issue,
  type Operation,
} from '@ds/core';

export interface TurnResult {
  model: BuildingModel;
  reply: string;
  ops: Operation[];
  summaries: string[];
  assumptions: string[];
  changedIds: string[];
  newIssues: Issue[];
  /** Set when the agent needs the user to choose before editing. */
  question?: { text: string; options: string[] };
  mode: 'llm' | 'offline';
}

const MAX_STEPS = 8;

const SYSTEM = `You are the design assistant inside an Indian residential design tool. The user edits ONE building model in plain language; you translate each request into typed operations (tools). You never draw and never invent geometry.

Rules:
- Use ids from the model summary. If a reference is unclear, call find_entities first.
- Distances: pass the user's text exactly ("8 inches", "1'6\\""). Never convert units yourself.
- Directions: use compass words. "Up/down/left/right on the plan" are NOT compass words; if the user uses them, ask which compass direction they mean unless the summary's orientation makes it unambiguous (north up: up=north, right=east).
- Room sizes in the summary are CLEAR (inside face to inside face). If the user's number could be clear or centre-to-centre and the difference matters, ask.
- Ask (call ask_user, then stop) ONLY when two readings would produce different geometry and you cannot tell which is meant. Otherwise act and let the user undo.
- Site (plot, setbacks, road/passage, trees, building position): set_plot must come first if the summary says there is no plot. A passage that runs inside the plot along one side is set_access kind "passage"; it usually matches that side's setback. After site changes, mention any setback the building now breaks. If the layout is too big or small for the buildable area, offer fit_to_buildable (it resizes rooms in proportion).
- Moving a room ("put the kitchen where Bed 2 is", "move the lobby to the north-east corner") means swapping room uses: swap_rooms or move_room_to. Walls and doors stay; furniture, stair and lift follow the room. Resizing a room means moving its walls (move_wall).
- Stairs and lifts are real elements (add_stair, add_lift, move_core, place_core, rotate_core). Each belongs in its own enclosed unit: a room of kind "stair" or "lift", never inside a lobby, living room or bedroom. To create a unit, split_room an existing room (e.g. split the lobby on its east side, 6' clear, name "Lift", kind lift), then add the stair or lift into the new room and add a way in (add_opening: kind "opening" for a stair entry, "sliding" for a lift door, "door" otherwise) on the wall it shares with the lobby.
- To add a toilet use add_toilet on the bedroom it should be attached to (or the living room for a common toilet); it picks a wall without the room's door or window, adds the door, a ventilator and a dress or wash area. To drop a toilet, set_room_use it to a Store (kind other). set_room_use also changes any room's use.
- split_room divides any room with a new wall (new toilet, store, dress, stair, lift). The new room has no door until you add one.
- Several operations in one turn are fine; they become one revision.
- If an operation returns an error, either fix your call or explain the problem plainly. Do not retry the same call.
- Finish with ONE short sentence of what changed. The app shows assumptions, knock-on effects and check results separately, so do not repeat them.`;

const EXTRA_TOOLS = [
  {
    name: 'find_entities',
    description: 'Resolve a plain-language reference ("the Bed 2 door", "wall between Bed 2 and kitchen") to ranked entity ids.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'find_catalogue',
    description: 'Find catalogue items (furniture, appliances, sanitaryware, cars) by description; returns ids and sizes in mm.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'ask_user',
    description: 'Ask ONE short clarifying question with 2-4 tappable options, when the request is genuinely ambiguous. Ends the turn without editing.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 } },
      required: ['question', 'options'],
    },
  },
] as const;

export async function runTurn(start: BuildingModel, message: string, recent: string[] = []): Promise<TurnResult> {
  const client = new Anthropic();
  const modelId = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const tools = [...operationToolDefinitions(), ...EXTRA_TOOLS];

  const issuesBefore = runChecks(start);
  let model = start;
  const ops: Operation[] = [];
  const summaries: string[] = [];
  const assumptions: string[] = [];
  const changed = new Set<string>();
  let question: TurnResult['question'];
  let finalText = '';

  const context = `CURRENT MODEL\n${modelSummary(model)}${recent.length ? `\n\nRECENT REQUESTS (oldest first)\n${recent.map((r) => `- ${r}`).join('\n')}` : ''}`;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `${context}\n\nUSER REQUEST\n${message}` }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({
      model: modelId,
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: tools as unknown as Anthropic.Tool[],
      messages,
    });
    messages.push({ role: 'assistant', content: res.content });

    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (text) finalText = text;
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (calls.length === 0 || res.stop_reason !== 'tool_use') break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      try {
        if (call.name === 'ask_user') {
          const input = call.input as { question: string; options: string[] };
          question = { text: input.question, options: input.options.slice(0, 4) };
          results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Question shown to the user. Stop now.' });
          continue;
        }
        if (call.name === 'find_entities') {
          const out = findEntities(model, (call.input as { text: string }).text);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) });
          continue;
        }
        if (call.name === 'find_catalogue') {
          const out = findCatalogue((call.input as { text: string }).text);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) });
          continue;
        }
        const op = parseOperation(call.name, call.input);
        const r = applyOperation(model, op);
        model = r.model;
        ops.push(op);
        summaries.push(r.summary);
        assumptions.push(...r.assumptions);
        r.changedIds.forEach((id) => changed.add(id));
        results.push({ type: 'tool_result', tool_use_id: call.id, content: `OK: ${r.summary}` });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: errorText(err), is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
    if (question) break;
  }

  // Keep the model's revision at +1 for the whole turn, however many ops ran.
  if (ops.length > 0) model = { ...model, revision: start.revision + 1 };

  return {
    model,
    reply: question ? question.text : finalText || (summaries.join(' ') || 'No change made.'),
    ops,
    summaries,
    assumptions: dedupe(assumptions),
    changedIds: [...changed],
    newIssues: diffIssues(issuesBefore, runChecks(model)),
    question,
    mode: 'llm',
  };
}

export function diffIssues(before: Issue[], after: Issue[]): Issue[] {
  const seen = new Set(before.map((i) => `${i.code}|${i.message}`));
  return after.filter((i) => !seen.has(`${i.code}|${i.message}`));
}

export function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err) return `Invalid input: ${JSON.stringify((err as { issues: unknown }).issues)}`;
  return err instanceof Error ? err.message : String(err);
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
