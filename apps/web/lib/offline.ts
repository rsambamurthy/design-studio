/**
 * Offline command parser, used when no ANTHROPIC_API_KEY is configured.
 * Handles the common small edits with plain pattern matching so the app is
 * usable (and demoable) without the LLM. Anything else gets a helpful reply.
 */
import {
  applyOperation,
  findEntities,
  matchCatalogue,
  parseOperation,
  runChecks,
  type BuildingModel,
  type Operation,
} from '@ds/core';
import { diffIssues, errorText, type TurnResult } from './agent';

const DIR = '(north|south|east|west)';
const LEN = String.raw`(\d+(?:\.\d+)?\s*(?:'|ft|feet|foot)\s*-?\s*(?:\d+(?:\.\d+)?\s*(?:"|in|inch|inches)?)?|\d+(?:\.\d+)?\s*(?:"|(?:inches|inch|in|mm|cm|m)\b)|\d+(?:\.\d+)?)`;

export function runOfflineTurn(start: BuildingModel, message: string): TurnResult {
  const text = message.trim().replace(/\bcenter\b/gi, 'centre');
  const lower = text.toLowerCase();
  let ops: Operation[] = [];

  try {
    ops = planOps(start, lower);
  } catch (err) {
    return reply(start, errorText(err));
  }
  if (ops.length === 0) {
    return reply(
      start,
      'Offline mode (no API key configured) understands: "move the Bed 2 door 8 inches east", "move the wall between Bed 2 and kitchen 6" west", "centre the Bed 2 door", "add a sofa with chaise on the right in the living room against the west wall", "flip the sofa", "remove the sofa".',
    );
  }

  let model = start;
  const summaries: string[] = [];
  const assumptions: string[] = [];
  const changed = new Set<string>();
  try {
    for (const op of ops) {
      const r = applyOperation(model, op);
      model = r.model;
      summaries.push(r.summary);
      assumptions.push(...r.assumptions);
      r.changedIds.forEach((id) => changed.add(id));
    }
  } catch (err) {
    return reply(start, errorText(err));
  }
  return {
    model: { ...model, revision: start.revision + 1 },
    reply: summaries.join(' '),
    ops,
    summaries,
    assumptions: [...new Set(assumptions)],
    changedIds: [...changed],
    newIssues: diffIssues(runChecks(start), runChecks(model)),
    mode: 'offline',
  };
}

function planOps(model: BuildingModel, s: string): Operation[] {
  let m: RegExpMatchArray | null;

  // move <ref> <len> <dir>   |   move <ref> <dir> by <len>
  if ((m = s.match(new RegExp(`^(?:move|shift|slide)\\s+(.+?)\\s+(?:by\\s+)?${LEN}\\s*(?:to(?:wards)?\\s+the\\s+)?${DIR}\\b`))) ||
      (m = s.match(new RegExp(`^(?:move|shift|slide)\\s+(.+?)\\s+(?:to(?:wards)?\\s+the\\s+)?${DIR}\\s+by\\s+${LEN}`)))) {
    const [ref, a, b] = [m[1]!, m[2]!, m[3]!];
    const [distance, direction] = /^(north|south|east|west)$/.test(a) ? [b, a] : [a, b];
    const target = resolve(model, ref);
    const name = target.type === 'opening' ? 'move_opening' : target.type === 'wall' ? 'move_wall' : target.type === 'furniture' ? 'move_item' : null;
    if (!name) throw new Error(`I can't move a whole room yet; move one of its walls instead.`);
    const idKey = name === 'move_opening' ? 'openingId' : name === 'move_wall' ? 'wallId' : 'itemId';
    return [parseOperation(name, { [idKey]: target.id, direction, distance: distance.trim() })];
  }

  if ((m = s.match(/^swap\s+(?:the\s+)?(.+?)\s+(?:and|with)\s+(?:the\s+)?(.+)$/))) {
    const a = findEntities(model, m[1]!).find((e) => e.type === 'room');
    const b = findEntities(model, m[2]!).find((e) => e.type === 'room');
    if (!a || !b) throw new Error('Name two rooms to swap, e.g. "swap the kitchen and Bed 2".');
    return [parseOperation('swap_rooms', { roomA: a.id, roomB: b.id })];
  }

  // "split the lobby on the east side, 6' as lift" / "split bed 3 east 5' as dress"
  if ((m = s.match(new RegExp(String.raw`^split\s+(?:the\s+)?(.+?)\s+(?:on\s+|from\s+)?(?:the\s+|its\s+)?${DIR}(?:\s+side)?,?\s+(?:by\s+)?${LEN}(?:\s+clear)?,?\s+(?:as|for|into)\s+(?:a\s+|an\s+|the\s+)?(.+)$`)))) {
    const r = findEntities(model, m[1]!).find((e) => e.type === 'room');
    if (!r) throw new Error(`Which room is "${m[1]}"?`);
    const raw = m[4]!.trim();
    const kinds = ['stair', 'lift', 'toilet', 'kitchen', 'bedroom', 'balcony', 'lobby', 'pooja'] as const;
    const kind = kinds.find((k) => raw.includes(k)) ?? (/\bbath|wash\b/.test(raw) ? 'toilet' : 'other');
    const name = raw.replace(/\b\w/g, (c) => c.toUpperCase());
    return [parseOperation('split_room', { roomId: r.id, side: m[2], size: m[3]!.trim(), name, kind })];
  }

  if ((m = s.match(/^move\s+(?:the\s+)?(.+?)\s+to\s+the\s+(north-west|north-east|south-west|south-east)\s+corner$/))) {
    const r = findEntities(model, m[1]!).find((e) => e.type === 'room');
    if (!r) throw new Error(`Which room is "${m[1]}"?`);
    return [parseOperation('move_room_to', { roomId: r.id, corner: m[2] })];
  }

  if ((m = s.match(/^centre\s+(.+)$/))) {
    const target = resolve(model, m[1]!);
    if (target.type === 'opening') return [parseOperation('centre_opening', { openingId: target.id })];
    if (target.type === 'furniture') return [parseOperation('centre_item', { itemId: target.id, axis: 'both' })];
    throw new Error('I can centre a door, window or furniture item.');
  }

  if ((m = s.match(/^(?:add|place|put)\s+(.+?)\s+in\s+(?:the\s+)?(.+?)(?:\s+against\s+(?:the\s+)?(north|south|east|west)\s+wall)?$/))) {
    const item = matchCatalogue(m[1]!);
    if (!item) throw new Error(`I couldn't find "${m[1]}" in the catalogue.`);
    const room = findEntities(model, m[2]!).find((e) => e.type === 'room');
    if (!room) throw new Error(`Which room is "${m[2]}"?`);
    const hand = /\bleft\b/.test(m[1]!) ? 'left' : 'right';
    return [parseOperation('place_item', { catalogueId: item.id, roomId: room.id, against: m[3] ?? 'west', hand })];
  }

  if ((m = s.match(/^(?:flip|mirror)\s+(.+)$/))) {
    return [parseOperation('flip_item', { itemId: resolve(model, m[1]!).id })];
  }

  if ((m = s.match(/^(?:remove|delete)\s+(.+)$/))) {
    return [parseOperation('remove', { entityId: resolve(model, m[1]!).id })];
  }

  return [];
}

function resolve(model: BuildingModel, ref: string) {
  const matches = findEntities(model, ref);
  const top = matches[0];
  if (!top) throw new Error(`I couldn't find "${ref.trim()}" in this design.`);
  const second = matches[1];
  if (second && second.score === top.score && second.type === top.type) {
    throw new Error(`"${ref.trim()}" could be ${top.label} or ${second.label}. Which one?`);
  }
  return top;
}

function reply(model: BuildingModel, text: string): TurnResult {
  return { model, reply: text, ops: [], summaries: [], assumptions: [], changedIds: [], newIssues: [], mode: 'offline' };
}
