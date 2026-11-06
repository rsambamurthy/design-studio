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
      kind: z.enum(['door', 'window', 'sliding', 'opening']).describe('opening = plain gap with no door leaf (archway, stair entry)'),
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
  remove: z.object({ entityId: id('opening, furniture item, stair or lift') }).describe('Remove a door, window, furniture item, stair or lift.'),
  rename_room: z.object({ roomId: id('room'), name: z.string().min(1) }).describe('Rename a room.'),
  move_room: z
    .object({ roomId: id('room block'), direction: compass, distance })
    .describe('Move a room (bedroom, toilet, lobby, kitchen…) as a block, with its walls, doors, furniture, stairs and lifts. It lines up with a wall when close. The open living space adjusts around it.'),
  add_room: z
    .object({
      name: z.string().min(1).optional().describe('Default from the kind: Bed 2, Toilet 3, Kitchen…'),
      kind: z.enum(['bedroom', 'toilet', 'kitchen', 'service', 'living', 'dining', 'balcony', 'lobby', 'pooja', 'stair', 'lift', 'other']),
      width: distance.optional().describe('Clear width (plan east–west when north is up); default by kind'),
      depth: distance.optional().describe('Clear depth; default by kind'),
      inRoomId: id('open room to place it in (default: living/dining)').optional(),
      corner: z.enum(['north-west', 'north-east', 'south-west', 'south-east']).optional(),
      x: z.number().optional().describe('Plan x (mm) of the room centre, when dropped at a point'),
      y: z.number().optional().describe('Plan y (mm) of the room centre'),
    })
    .describe('Add a new room block in the open space, with a door, a window on an outer wall and fixtures for toilets and kitchens. Drag or move_room it afterwards.'),
  set_room_position: z
    .object({ roomId: id('room block'), x: z.number().describe('Plan x (mm) of the block\'s west wall centre line'), y: z.number().describe('Plan y (mm) of its north wall centre line') })
    .describe('Put a room block at an exact plan position (used by dragging in the app). Prefer move_room or place_room_against in conversation.'),
  set_brief: z
    .object({
      items: z
        .array(
          z.object({
            type: z.enum(['count', 'outer_wall', 'window', 'attached_toilet', 'zone', 'min_size', 'next_to']),
            rooms: z.string().describe('"bedrooms", "toilets", "wet rooms", "habitable", a room kind like "kitchen" or "pooja", or a room name'),
            zone: z.enum(['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'centre']).optional(),
            width: z.string().optional(),
            depth: z.string().optional(),
            other: z.string().optional().describe('For next_to: the other room(s)'),
            n: z.number().int().min(1).max(12).optional().describe('For count: how many rooms of this kind the plan needs'),
          }),
        )
        .max(30),
    })
    .describe('Replace the design brief: the checkable requirements the plan should meet (shown as a checklist; the Meet the brief agent works towards it).'),
  rotate_room: z
    .object({ roomId: id('room block'), degrees: z.enum(['90', '-90', '180']).default('90') })
    .describe('Turn a room block about its centre (e.g. make a vertical toilet horizontal). Doors, fixtures and furniture turn with it.'),
  place_room_against: z
    .object({
      roomId: id('room block to move'),
      targetId: z.string().describe('Room id to put it against, or "outer" for the outer walls'),
      side: compass.describe('Which side of the target it goes on (for "outer": which outer wall)'),
      align: z.enum(['north', 'south', 'east', 'west', 'centre', 'keep']).default('keep').describe('Line up this edge with the target\'s same edge, centre on it, or keep the current position along the wall'),
    })
    .describe('Move a room block so it sits flush against another room (sharing that wall) or against an outer wall, optionally lined up with an edge. Use this instead of guessing distances.'),
  add_door_between: z
    .object({
      roomA: id('first room'),
      roomB: id('second room (or the living/open space)'),
      width: distance.optional().describe("Default 2'6\" for toilets, 3' otherwise"),
      kind: z.enum(['door', 'opening', 'sliding']).default('door'),
    })
    .describe('Add a door on the wall two rooms share, centred on the shared part, opening into the smaller room. Fails if they do not touch.'),
  edit_door: z
    .object({
      openingId: id('door'),
      opensInto: id('room the leaf should swing into').optional(),
      flipHinge: z.boolean().optional().describe('Hinge on the other jamb'),
      width: distance.optional(),
    })
    .describe('Change which room a door opens into, which side it is hinged, or its width.'),
  set_room_size: z
    .object({ roomId: id('room block'), width: distance.optional(), depth: distance.optional() })
    .describe('Set the clear width and/or depth of a room block. The sides against walls or other rooms stay put.'),
  remove_room: z.object({ roomId: id('room block') }).describe('Remove a room block, with its doors, furniture and fixtures; its space returns to the open area.'),
  fit_out: z.object({ roomId: id('toilet or kitchen') }).describe('Add the standard fixtures: WC, wash basin (and shower when there is room) in a toilet; counter with sink and hob in a kitchen.'),
  set_room_use: z
    .object({
      roomId: id('room'),
      name: z.string().min(1),
      kind: z.enum(['bedroom', 'toilet', 'kitchen', 'service', 'living', 'dining', 'balcony', 'lobby', 'pooja', 'stair', 'lift', 'other']),
    })
    .describe('Change what a room is used for (name and type), e.g. turn a toilet into a store. Walls and doors stay.'),
  add_toilet: z
    .object({
      roomId: id('bedroom (or other room) the toilet is attached to'),
      width: distance.optional().describe('Clear width of the toilet (default 5\')'),
      length: distance.optional().describe('Clear length of the toilet (default 7\'); any spare length becomes a dress area'),
      beside: z.boolean().default(true).describe('If the room is too small to give up space, put a new toilet beside it in the open space instead'),
    })
    .describe('Add a toilet attached to a room: carved from the room along a wall without its door or window, with a door from the room, a ventilator on an outer wall, and a dress area if there is spare length.'),
  split_room: z
    .object({
      roomId: id('room to split'),
      side: compass.describe('Side of the room the new room takes'),
      size: distance.describe('Clear size of the new room, measured in from that side'),
      name: z.string().min(1).describe('Name of the new room, e.g. "Lift", "Stair", "Store"'),
      kind: z
        .enum(['bedroom', 'toilet', 'kitchen', 'service', 'living', 'dining', 'balcony', 'lobby', 'pooja', 'stair', 'lift', 'other'])
        .default('other'),
      wallThickness: distance.optional().describe('Thickness of the new wall (default 4½")'),
    })
    .describe('Split a room in two with a new wall. The new room takes the given side; the rest keeps the old name. Use this to make separate stair, lift, store or toilet units.'),

  // ---------- Rooms: swap use / move to a corner ----------
  swap_rooms: z
    .object({ roomA: id('first room'), roomB: id('second room') })
    .describe('Swap what two rooms are used for (e.g. kitchen and Bed 2). Names, room types, furniture, stair and lift move with the use; walls and doors stay.'),
  move_room_to: z
    .object({ roomId: id('room'), corner: z.enum(['north-west', 'north-east', 'south-west', 'south-east']) })
    .describe('Move a room\'s use to the room in a corner of the building, by swapping with whatever room is there.'),

  // ---------- Stair and lift ----------
  add_stair: z
    .object({
      roomId: id('room to put the stair in (default: the room at x, y)').optional(),
      type: z.enum(['dog-legged', 'straight']).default('dog-legged'),
      flightWidth: distance.optional().describe('Clear width of each flight (default 3\'6")'),
      floorHeight: distance.optional().describe('Floor-to-floor height (default 10\')'),
      corner: z.enum(['north-west', 'north-east', 'south-west', 'south-east']).optional(),
      enclosed: z.boolean().default(true).describe('Give it its own walls (default); false for an open stair'),
      x: z.number().optional().describe('Plan x (mm) of its centre, when dropped at a point'),
      y: z.number().optional(),
    })
    .describe('Add a staircase as its own walled unit, in a corner of a room (first corner where it fits if not given). It can be moved anywhere afterwards.'),
  add_lift: z
    .object({
      roomId: id('room to put the lift in (default: the room at x, y)').optional(),
      persons: z.enum(['4', '6', '8']).default('6').describe('Lift capacity'),
      corner: z.enum(['north-west', 'north-east', 'south-west', 'south-east']).optional(),
      x: z.number().optional().describe('Plan x (mm) of its centre, when dropped at a point'),
      y: z.number().optional(),
    })
    .describe('Add a lift as its own walled shaft with a door, in a corner of a room. It can be moved anywhere afterwards.'),
  move_core: z.object({ coreId: id('stair or lift'), direction: compass, distance }).describe('Move a stair or lift (with its walls), within its room or into another room. Snaps flush to a wall when close.'),
  place_core: z
    .object({ coreId: id('stair or lift'), roomId: id('room').optional(), corner: z.enum(['north-west', 'north-east', 'south-west', 'south-east']) })
    .describe('Put a stair or lift into a corner of its room, or of another room.'),
  rotate_core: z.object({ coreId: id('stair or lift'), degrees: z.enum(['90', '-90', '180']) }).describe('Turn a stair or lift.'),

  // ---------- Site: plot, setbacks, access, trees, building placement ----------
  set_plot: z
    .object({
      eastWest: distance.describe('Plot length along east–west, as the user wrote it'),
      northSouth: distance.describe('Plot length along north–south, as the user wrote it'),
    })
    .describe('Set (or change) the plot size. Creates the site if there is none; the building is centred in the buildable area.'),
  set_setback: z
    .object({ side: z.enum(['north', 'south', 'east', 'west', 'all']), distance })
    .describe('Set the required setback (open space) on one side of the plot, or all sides.'),
  set_access: z
    .object({
      side: compass.describe('Plot side the road or passage runs along'),
      kind: z.enum(['road', 'passage']),
      width: distance.optional().describe('Width of the road or passage; for a passage inside the plot this must fit in that side\'s setback'),
    })
    .describe('Record a road or access passage along one side of the plot (one per side).'),
  remove_access: z.object({ side: compass }).describe('Remove the road/passage on a side.'),
  add_tree: z
    .object({
      label: z.string().min(1).describe('e.g. "Mango tree"'),
      position: z
        .enum(['north-west corner', 'north-east corner', 'south-west corner', 'south-east corner', 'north side', 'south side', 'east side', 'west side', 'centre'])
        .describe('Where on the plot; sides mean the middle of that side'),
      inset: distance.optional().describe('Distance of the trunk from the boundary (default 4\')'),
      canopy: distance.optional().describe('Canopy diameter (default 20\')'),
      keep: z.boolean().default(true).describe('Must be kept (building must stay clear of its trunk zone)'),
    })
    .describe('Add an existing tree on the plot.'),
  move_tree: z.object({ treeId: id('tree'), direction: compass, distance }).describe('Move a tree marker.'),
  update_tree: z
    .object({
      treeId: id('tree'),
      label: z.string().min(1).optional(),
      position: z
        .enum(['north-west corner', 'north-east corner', 'south-west corner', 'south-east corner', 'north side', 'south side', 'east side', 'west side', 'centre'])
        .optional(),
      inset: distance.optional().describe('Trunk distance from the boundary'),
      canopy: distance.optional().describe('Canopy diameter'),
      keep: z.boolean().optional(),
    })
    .describe('Change an existing tree: name, position, distance from boundary, canopy size, or whether it must be kept.'),
  remove_tree: z.object({ treeId: id('tree') }).describe('Remove a tree from the site.'),
  place_building: z
    .object({
      northSouth: z.enum(['north', 'south', 'centre']).describe('Push the building to the north or south setback line, or centre it'),
      eastWest: z.enum(['east', 'west', 'centre']).describe('Push the building to the east or west setback line, or centre it'),
    })
    .describe('Position the building within the setbacks.'),
  move_building: z.object({ direction: compass, distance }).describe('Shift the whole building on the plot.'),
  fit_to_buildable: z
    .object({ rooms: z.enum(['keep', 'scale']).optional().describe('keep = rooms keep their sizes (default for room-block designs); scale = rooms stretch in proportion') })
    .describe('Make the outer walls exactly fill the buildable area inside the setbacks. In room-block designs rooms keep their sizes by default; otherwise rooms scale in proportion. Wall thicknesses, doors, windows and furniture sizes stay the same.'),
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
