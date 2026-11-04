/**
 * Typed operations. Defined once with zod; the same schemas are handed to the
 * LLM as tools (via JSON Schema) and validated by the kernel, so the two can
 * never disagree about what an operation looks like.
 *
 * Distances are passed as the user's own text ("8 inches", "1'6\"") and parsed
 * deterministically by units.ts; the LLM never converts units itself.
 */
import { z } from 'zod';

const compass = z.enum(['north', 'south', 'east', 'west']).describe('Compass direction, resolved through the plan north arrow');
const distance = z.string().min(1).describe('Length exactly as the user wrote it, e.g. 8", 8 inches, 1\'6", 450 mm');
const id = (what: string) => z.string().min(1).describe(`Id of the ${what}, from the model summary or find_entities`);

export const OperationSchemas = {
  move_opening: z
    .object({ openingId: id('door/window'), direction: compass, distance })
    .describe('Slide a door or window along its wall.'),
  centre_opening: z
    .object({ openingId: id('door/window'), roomId: id('room whose wall span to centre within').optional() })
    .describe('Centre a door or window on the wall span of a room.'),
  set_opening_width: z
    .object({ openingId: id('door/window'), width: distance })
    .describe('Change the clear width of a door or window, keeping its centre.'),
  add_opening: z
    .object({
      wallId: id('wall'),
      kind: z.enum(['door', 'window', 'sliding']),
      width: distance,
      label: z.string().describe('Short label, e.g. "Bed 3 window"'),
      roomId: id('room the opening serves').optional(),
    })
    .describe('Add a door or window, centred on the wall span of the room (or the wall).'),
  move_wall: z
    .object({ wallId: id('wall'), direction: compass, distance })
    .describe('Move a wall perpendicular to itself. Connected walls stretch; rooms bound to it resize.'),
  place_item: z
    .object({
      catalogueId: z.string().describe('Catalogue id from find_catalogue'),
      roomId: id('room'),
      against: compass.describe('Which wall of the room the item\'s back goes against'),
      hand: z.enum(['left', 'right']).optional().describe('For handed items: side of the chaise/extension, as seen sitting on the item'),
      label: z.string().optional(),
    })
    .describe('Place a catalogue item in a room, back against a wall, centred along it.'),
  move_item: z.object({ itemId: id('furniture item'), direction: compass, distance }).describe('Move a furniture item.'),
  centre_item: z
    .object({ itemId: id('furniture item'), axis: z.enum(['both', 'north-south', 'east-west']).default('both') })
    .describe('Centre a furniture item in its room along an axis.'),
  rotate_item: z.object({ itemId: id('furniture item'), degrees: z.enum(['90', '-90', '180']) }).describe('Rotate an item clockwise.'),
  flip_item: z.object({ itemId: id('furniture item') }).describe('Swap the hand of a handed item (e.g. chaise left <-> right).'),
  remove: z.object({ entityId: id('opening or furniture item') }).describe('Remove a door, window or furniture item.'),
  rename_room: z.object({ roomId: id('room'), name: z.string().min(1) }).describe('Rename a room.'),
} as const;

export type OperationName = keyof typeof OperationSchemas;
export type OperationArgs<N extends OperationName> = z.infer<(typeof OperationSchemas)[N]>;
export type Operation = { [N in OperationName]: { op: N; args: OperationArgs<N> } }[OperationName];

export const OPERATION_NAMES = Object.keys(OperationSchemas) as OperationName[];

export function isOperationName(name: string): name is OperationName {
  return name in OperationSchemas;
}

/** Validate untrusted input (e.g. an LLM tool call) into a typed Operation. */
export function parseOperation(name: string, input: unknown): Operation {
  if (!isOperationName(name)) throw new Error(`Unknown operation "${name}"`);
  const args = OperationSchemas[name].parse(input);
  return { op: name, args } as Operation;
}

/** JSON Schema for each operation, for use as LLM tool definitions. */
export function operationToolDefinitions(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return OPERATION_NAMES.map((name) => {
    const schema = OperationSchemas[name];
    const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
    delete json.$schema;
    delete json.description;
    return { name, description: schema.description ?? name, input_schema: json };
  });
}
