/**
 * The deterministic kernel. Applies one typed operation to a model and returns
 * a NEW model (the input is never mutated), a one-line summary, the
 * assumptions it made, and every entity id it touched (for ripple tracking).
 */
import { getCatalogueItem, itemFootprint } from './catalogue';
import {
  compassVector,
  isHorizontal,
  pointOnWall,
  planSideCompass,
  rectSize,
  rectsOverlap,
  roomAxisRect,
  roomClearRect,
  vectorToCompass,
  wallDir,
  wallLength,
  type Compass,
  type Rect,
} from './geometry';
import {
  ModelError,
  findEntity,
  getRoom,
  getWall,
  type BuildingModel,
  type FurnitureItem,
  type Opening,
  type Point,
  type CoreElement,
  type Room,
  type Site,
  type Wall,
} from './model';
import {
  PLAN_SIDES,
  buildableRect,
  compassToSide,
  eastWestIsPlanX,
  buildingOuterRect,
  footprintOnPlot,
  namedPlotPoint,
  type TreePosition,
} from './site';
import type { Operation } from './ops';
import { CORNERS, DEFAULT_FLOOR_HEIGHT, LIFT_SHAFTS, coreFootprint, coresOf, placeInCorner, sizeStair, type Corner } from './cores';
import { formatLength, parseLength } from './units';

export interface OpResult {
  model: BuildingModel;
  summary: string;
  assumptions: string[];
  changedIds: string[];
}

/** Minimum gap between an opening edge and the end of its wall segment. */
const JAMB_MIN = 100;

export function applyOperation(input: BuildingModel, operation: Operation): OpResult {
  const model: BuildingModel = structuredClone(input);
  const ctx = new Ctx(model);
  const { op, args } = operation;

  switch (op) {
    case 'move_opening': {
      const o = ctx.opening(args.openingId);
      const wall = getWall(model, o.wallId);
      const d = ctx.length(args.distance);
      const sign = ctx.alongWallSign(wall, args.direction, o.label);
      const next = o.offset + sign * d;
      ctx.checkOpeningFits(wall, next, o.width, o.label);
      o.offset = next;
      ctx.touch(o.id, wall.id);
      ctx.summary = `Moved ${o.label} ${formatLength(d, model.displayUnits)} ${args.direction}.`;
      ctx.note(`"${args.direction}" taken from the plan's north arrow (${describeNorth(model)}).`);
      break;
    }

    case 'centre_opening': {
      const o = ctx.opening(args.openingId);
      const wall = getWall(model, o.wallId);
      const room = args.roomId ? getRoom(model, args.roomId) : ctx.roomOnWall(wall.id);
      const [s0, s1] = ctx.roomSpanAlongWall(room, wall);
      o.offset = Math.round((s0 + s1) / 2);
      ctx.touch(o.id, wall.id);
      ctx.summary = `Centred ${o.label} on the ${room.name} wall.`;
      ctx.note(`Centred on ${room.name}'s clear (inside-face) span, ${formatLength(s1 - s0, model.displayUnits)}.`);
      break;
    }

    case 'set_opening_width': {
      const o = ctx.opening(args.openingId);
      const wall = getWall(model, o.wallId);
      const w = ctx.length(args.width);
      ctx.checkOpeningFits(wall, o.offset, w, o.label);
      const before = o.width;
      o.width = w;
      ctx.touch(o.id, wall.id);
      ctx.summary = `${o.label} width ${formatLength(before, model.displayUnits)} → ${formatLength(w, model.displayUnits)}.`;
      ctx.note('Width is the clear opening; the centre stayed fixed.');
      break;
    }

    case 'add_opening': {
      const wall = getWall(model, args.wallId);
      const w = ctx.length(args.width);
      let offset: number;
      if (args.roomId) {
        const [s0, s1] = ctx.roomSpanAlongWall(getRoom(model, args.roomId), wall);
        offset = Math.round((s0 + s1) / 2);
      } else {
        offset = Math.round(wallLength(wall) / 2);
      }
      ctx.checkOpeningFits(wall, offset, w, args.label);
      const o: Opening = {
        id: ctx.newId(args.kind === 'window' ? 'win' : 'door'),
        label: args.label,
        wallId: wall.id,
        kind: args.kind,
        offset,
        width: w,
        height: args.kind === 'window' ? 1200 : 2100,
        swingSide: 'left',
        hinge: 'start',
      };
      model.openings.push(o);
      ctx.touch(o.id, wall.id);
      ctx.summary = `Added ${args.label} (${formatLength(w, model.displayUnits)}).`;
      ctx.note('Placed centred on the wall span; say "move it" to shift it.');
      break;
    }

    case 'move_wall': {
      const wall = getWall(model, args.wallId);
      const d = ctx.length(args.distance);
      const v = compassVector(args.direction, model.northAngle);
      const horizontal = isHorizontal(wall);
      const component = horizontal ? v.y : v.x;
      if (Math.abs(component) < 0.7) {
        const runs = vectorToCompass(wallDir(wall), model.northAngle);
        throw new ModelError(
          `That wall runs ${axisName(runs)}, so it can only move ${horizontal ? perpNames(model, 'y') : perpNames(model, 'x')}, not ${args.direction}.`,
        );
      }
      const delta = Math.sign(component) * d;
      ctx.moveWall(wall, delta);
      ctx.summary = `Moved wall ${formatLength(d, model.displayUnits)} ${args.direction}.`;
      ctx.note(`Wall axis moved; rooms on both sides resized. Direction from the north arrow (${describeNorth(model)}).`);
      break;
    }

    case 'place_item': {
      const cat = getCatalogueItem(args.catalogueId);
      if (!cat) throw new ModelError(`Unknown catalogue item "${args.catalogueId}"`);
      const room = getRoom(model, args.roomId);
      const r = roomClearRect(model, room);
      const side = ctx.planSideFor(room, args.against);
      const rotation = { top: 0, right: 90, bottom: 180, left: 270 }[side];
      const half = cat.depth / 2;
      const at: Point = {
        top: { x: (r.x0 + r.x1) / 2, y: r.y0 + half },
        bottom: { x: (r.x0 + r.x1) / 2, y: r.y1 - half },
        left: { x: r.x0 + half, y: (r.y0 + r.y1) / 2 },
        right: { x: r.x1 - half, y: (r.y0 + r.y1) / 2 },
      }[side];
      const item: FurnitureItem = {
        id: ctx.newId('f'),
        catalogueId: cat.id,
        label: args.label ?? cat.name,
        roomId: room.id,
        at: { x: Math.round(at.x), y: Math.round(at.y) },
        rotation,
        mirrored: cat.handed ? args.hand === 'left' : false,
      };
      model.furniture.push(item);
      ctx.touch(item.id, room.id);
      ctx.summary = `Placed ${item.label} (${formatLength(cat.width, model.displayUnits)} × ${formatLength(cat.depth, model.displayUnits)}) in ${room.name}, back against the ${args.against} wall, centred along it.`;
      if (cat.handed) {
        ctx.note(`Chaise on the ${args.hand ?? 'right'} as seen sitting on it.`);
      }
      break;
    }

    case 'move_item': {
      const f = ctx.item(args.itemId);
      const d = ctx.length(args.distance);
      const v = compassVector(args.direction, model.northAngle);
      f.at = { x: Math.round(f.at.x + v.x * d), y: Math.round(f.at.y + v.y * d) };
      ctx.touch(f.id);
      ctx.summary = `Moved ${f.label} ${formatLength(d, model.displayUnits)} ${args.direction}.`;
      ctx.note(`Direction from the north arrow (${describeNorth(model)}).`);
      break;
    }

    case 'centre_item': {
      const f = ctx.item(args.itemId);
      const room = getRoom(model, f.roomId);
      const r = roomClearRect(model, room);
      const ns = compassVector('north', model.northAngle);
      const nsIsVertical = Math.abs(ns.y) > Math.abs(ns.x);
      const axis = args.axis ?? 'both';
      const centreX = axis === 'both' || (axis === 'east-west') === nsIsVertical;
      const centreY = axis === 'both' || (axis === 'north-south') === nsIsVertical;
      if (centreX) f.at = { ...f.at, x: Math.round((r.x0 + r.x1) / 2) };
      if (centreY) f.at = { ...f.at, y: Math.round((r.y0 + r.y1) / 2) };
      ctx.touch(f.id);
      ctx.summary = `Centred ${f.label} in ${room.name}${axis === 'both' ? '' : ` (${axis})`}.`;
      ctx.note('Centred on the room\'s clear (inside-face) dimensions.');
      break;
    }

    case 'rotate_item': {
      const f = ctx.item(args.itemId);
      f.rotation = (((f.rotation + Number(args.degrees)) % 360) + 360) % 360;
      ctx.touch(f.id);
      ctx.summary = `Rotated ${f.label} ${args.degrees}°.`;
      ctx.note('Rotation is clockwise as seen on the plan, about the item centre.');
      break;
    }

    case 'flip_item': {
      const f = ctx.item(args.itemId);
      const cat = getCatalogueItem(f.catalogueId);
      if (!cat?.handed) throw new ModelError(`${f.label} has no left/right version.`);
      f.mirrored = !f.mirrored;
      ctx.touch(f.id);
      ctx.summary = `${f.label}: extension now on the ${f.mirrored ? 'left' : 'right'}.`;
      ctx.note('Left/right as seen sitting on it.');
      break;
    }

    case 'remove': {
      const e = findEntity(model, args.entityId);
      if (!e) throw new ModelError(`Nothing with id "${args.entityId}"`);
      if (e.type === 'opening') {
        model.openings = model.openings.filter((o) => o.id !== e.id);
        ctx.touch(e.id, e.wallId);
      } else if (e.type === 'furniture') {
        model.furniture = model.furniture.filter((f) => f.id !== e.id);
        ctx.touch(e.id, e.roomId);
      } else if (e.type === 'core') {
        model.cores = coresOf(model).filter((c) => c.id !== e.id);
        ctx.touch(e.id, e.roomId);
      } else {
        throw new ModelError('Only doors, windows, furniture, stairs and lifts can be removed in this version.');
      }
      ctx.summary = `Removed ${e.label}.`;
      break;
    }

    case 'set_plot': {
      const ew = ctx.length(args.eastWest);
      const ns = ctx.length(args.northSouth);
      const xIsEW = eastWestIsPlanX(model.northAngle);
      const plot = { width: xIsEW ? ew : ns, depth: xIsEW ? ns : ew };
      if (plot.width > 1_000_000 || plot.depth > 1_000_000) throw new ModelError('That plot is over 1 km; check the units.');
      const creating = !model.site;
      const site = model.site ?? { plot, setbacks: { top: 0, bottom: 0, left: 0, right: 0 }, access: [], trees: [], buildingOffset: { x: 0, y: 0 } };
      site.plot = plot;
      model.site = site;
      centreBuilding(model, site);
      ctx.touch('site');
      ctx.summary = `Plot set to ${formatLength(ew, model.displayUnits)} (E–W) × ${formatLength(ns, model.displayUnits)} (N–S).`;
      if (creating) ctx.note('Setbacks start at 0 until you set them; the building was centred on the plot.');
      else ctx.note('The building was re-centred in the buildable area.');
      break;
    }

    case 'set_setback': {
      const site = ctx.site();
      const d = ctx.length(args.distance, true);
      const sides = args.side === 'all' ? PLAN_SIDES : [compassToSide(args.side, model.northAngle)];
      for (const s of sides) site.setbacks[s] = d;
      ctx.touch('site');
      ctx.summary =
        args.side === 'all'
          ? `Setbacks set to ${formatLength(d, model.displayUnits)} on all sides.`
          : `${cap(args.side)} setback set to ${formatLength(d, model.displayUnits)}.`;
      ctx.note('Setbacks are measured from the plot boundary to the building\'s outer wall face.');
      break;
    }

    case 'set_access': {
      const site = ctx.site();
      const side = compassToSide(args.side, model.northAngle);
      const width = args.width ? ctx.length(args.width) : site.setbacks[side];
      if (width <= 0) throw new ModelError('Give the width of the road or passage.');
      site.access = [...site.access.filter((a) => a.side !== side), { side, kind: args.kind, width }];
      ctx.touch('site');
      ctx.summary = `${cap(args.kind)} recorded along the ${args.side} side, ${formatLength(width, model.displayUnits)} wide.`;
      if (!args.width) ctx.note(`Width taken as the ${args.side} setback.`);
      if (args.kind === 'passage') ctx.note('A passage is treated as part of the plot, inside that side\'s setback.');
      break;
    }

    case 'remove_access': {
      const site = ctx.site();
      const side = compassToSide(args.side, model.northAngle);
      if (!site.access.some((a) => a.side === side)) throw new ModelError(`There is no road or passage on the ${args.side} side.`);
      site.access = site.access.filter((a) => a.side !== side);
      ctx.touch('site');
      ctx.summary = `Removed the access on the ${args.side} side.`;
      break;
    }

    case 'add_tree': {
      const site = ctx.site();
      const inset = args.inset ? ctx.length(args.inset) : 1219;
      const canopy = args.canopy ? ctx.length(args.canopy) : 6096;
      const at = namedPlotPoint(site, args.position as TreePosition, inset, model.northAngle);
      const id = ctx.newId('tree');
      site.trees.push({ id, label: args.label, at, canopyRadius: Math.round(canopy / 2), protectRadius: 1500, keep: args.keep ?? true, position: args.position, inset });
      ctx.touch('site', id);
      ctx.summary = `Added ${args.label} at the ${args.position}.`;
      ctx.note(
        `Trunk ${formatLength(inset, model.displayUnits)} in from the boundary${args.inset ? '' : ' (default)'}; canopy ${formatLength(canopy, model.displayUnits)} across${args.canopy ? '' : ' (default)'}; building kept 5' clear of the trunk.`,
      );
      break;
    }

    case 'move_tree': {
      const site = ctx.site();
      const t = site.trees.find((x) => x.id === args.treeId);
      if (!t) throw new ModelError(`No tree with id "${args.treeId}"`);
      const d = ctx.length(args.distance);
      const v = compassVector(args.direction, model.northAngle);
      t.at = { x: Math.round(t.at.x + v.x * d), y: Math.round(t.at.y + v.y * d) };
      ctx.touch('site', t.id);
      ctx.summary = `Moved ${t.label} ${formatLength(d, model.displayUnits)} ${args.direction}.`;
      break;
    }

    case 'update_tree': {
      const site = ctx.site();
      const t = site.trees.find((x) => x.id === args.treeId);
      if (!t) throw new ModelError(`No tree with id "${args.treeId}"`);
      const changes: string[] = [];
      if (args.label && args.label !== t.label) {
        changes.push(`renamed to ${args.label}`);
        t.label = args.label;
      }
      if (args.position || args.inset) {
        const position = (args.position ?? t.position ?? 'centre') as TreePosition;
        const inset = args.inset ? ctx.length(args.inset) : t.inset ?? 1219;
        t.at = namedPlotPoint(site, position, inset, model.northAngle);
        t.position = position;
        t.inset = inset;
        changes.push(`placed at the ${position}, trunk ${formatLength(inset, model.displayUnits)} from the boundary`);
      }
      if (args.canopy) {
        const canopy = ctx.length(args.canopy);
        t.canopyRadius = Math.round(canopy / 2);
        changes.push(`canopy ${formatLength(canopy, model.displayUnits)} across`);
      }
      if (args.keep !== undefined && args.keep !== t.keep) {
        t.keep = args.keep;
        changes.push(args.keep ? 'marked to keep' : 'no longer marked to keep');
      }
      if (changes.length === 0) throw new ModelError(`Nothing changed for ${t.label}.`);
      ctx.touch('site', t.id);
      ctx.summary = `${t.label}: ${changes.join('; ')}.`;
      break;
    }

    case 'remove_tree': {
      const site = ctx.site();
      const t = site.trees.find((x) => x.id === args.treeId);
      if (!t) throw new ModelError(`No tree with id "${args.treeId}"`);
      site.trees = site.trees.filter((x) => x.id !== t.id);
      ctx.touch('site');
      ctx.summary = `Removed ${t.label}.`;
      break;
    }

    case 'place_building': {
      const site = ctx.site();
      const f = footprintOnPlot(model, site);
      const b = buildableRect(site);
      let dx = 0;
      let dy = 0;
      for (const [dir, axisArg] of [
        [args.northSouth, 'ns'],
        [args.eastWest, 'ew'],
      ] as const) {
        if (dir === 'centre') {
          const axisIsX = axisArg === 'ew' ? eastWestIsPlanX(model.northAngle) : !eastWestIsPlanX(model.northAngle);
          if (axisIsX) dx = (b.x0 + b.x1) / 2 - (f.x0 + f.x1) / 2;
          else dy = (b.y0 + b.y1) / 2 - (f.y0 + f.y1) / 2;
          continue;
        }
        const side = compassToSide(dir, model.northAngle);
        if (side === 'top') dy = b.y0 - f.y0;
        if (side === 'bottom') dy = b.y1 - f.y1;
        if (side === 'left') dx = b.x0 - f.x0;
        if (side === 'right') dx = b.x1 - f.x1;
      }
      site.buildingOffset = { x: Math.round(site.buildingOffset.x + dx), y: Math.round(site.buildingOffset.y + dy) };
      ctx.touch('site');
      const words = [args.northSouth, args.eastWest].filter((w) => w !== 'centre');
      ctx.summary = words.length
        ? `Building pushed to the ${words.join('-')} setback line${words.length > 1 ? 's' : ''}${args.northSouth === 'centre' || args.eastWest === 'centre' ? ', centred the other way' : ''}.`
        : 'Building centred in the buildable area.';
      break;
    }

    case 'move_building': {
      const site = ctx.site();
      const d = ctx.length(args.distance);
      const v = compassVector(args.direction, model.northAngle);
      site.buildingOffset = { x: Math.round(site.buildingOffset.x + v.x * d), y: Math.round(site.buildingOffset.y + v.y * d) };
      ctx.touch('site');
      ctx.summary = `Moved the building ${formatLength(d, model.displayUnits)} ${args.direction} on the plot.`;
      break;
    }

    case 'fit_to_buildable': {
      const site = ctx.site();
      const b = buildableRect(site);
      const before = buildingOuterRect(model);
      fitBuilding(model, b.x1 - b.x0, b.y1 - b.y0, ctx);
      const f = footprintOnPlot(model, site);
      site.buildingOffset = { x: Math.round(site.buildingOffset.x + b.x0 - f.x0), y: Math.round(site.buildingOffset.y + b.y0 - f.y0) };
      const after = buildingOuterRect(model);
      for (const w of model.walls) ctx.touch(w.id);
      for (const r of model.rooms) ctx.touch(r.id);
      ctx.touch('site');
      ctx.summary = `Resized the layout to fill the buildable area: ${formatLength(after.x1 - after.x0, model.displayUnits)} × ${formatLength(after.y1 - after.y0, model.displayUnits)} outside (was ${formatLength(before.x1 - before.x0, model.displayUnits)} × ${formatLength(before.y1 - before.y0, model.displayUnits)}).`;
      ctx.note('Rooms scaled in proportion; wall thicknesses and door, window and furniture sizes are unchanged.');
      break;
    }

    case 'swap_rooms': {
      const a = getRoom(model, args.roomA);
      const b = getRoom(model, args.roomB);
      if (a.id === b.id) throw new ModelError('Pick two different rooms to swap.');
      swapRooms(model, a, b, ctx);
      ctx.summary = `Swapped ${b.name} and ${a.name}: ${a.name} is now where ${b.name} was.`;
      break;
    }

    case 'move_room_to': {
      const room = getRoom(model, args.roomId);
      const target = roomAtCorner(model, args.corner as Corner);
      if (!target) throw new ModelError(`No single room fills the ${args.corner} corner of the building.`);
      if (target.id === room.id) throw new ModelError(`${room.name} is already in the ${args.corner} corner.`);
      const was = target.name;
      swapRooms(model, room, target, ctx);
      ctx.summary = `Moved ${target.name} to the ${args.corner} corner; ${was} takes its old place.`;
      break;
    }

    case 'add_stair': {
      const room = getRoom(model, args.roomId);
      const flightWidth = args.flightWidth ? ctx.length(args.flightWidth) : 1067;
      const floorHeight = args.floorHeight ? ctx.length(args.floorHeight) : DEFAULT_FLOOR_HEIGHT;
      const type = args.type ?? 'dog-legged';
      const dims = sizeStair(type, flightWidth, floorHeight);
      const core: CoreElement = {
        id: ctx.newId('stair'),
        kind: 'stair',
        label: 'Staircase',
        roomId: room.id,
        at: { x: 0, y: 0 },
        rotation: 0,
        width: dims.width,
        length: dims.length,
        stair: { type, flightWidth, floorHeight, risers: dims.risers, riser: dims.riser, tread: dims.tread },
      };
      ctx.placeCore(core, room, args.corner as Corner | undefined);
      model.cores = [...coresOf(model), core];
      ctx.touch(core.id, room.id);
      const u = model.displayUnits;
      ctx.summary = `Added a ${type} staircase in ${room.name}: ${dims.risers} risers of ${formatLength(dims.riser, u)}, flights ${formatLength(flightWidth, u)} wide.`;
      ctx.note(`Footprint ${formatLength(core.width, u)} × ${formatLength(core.length, u)} for a ${formatLength(floorHeight, u)} floor-to-floor height${args.floorHeight ? '' : ' (default)'}; treads ${formatLength(dims.tread, u)}.`);
      break;
    }

    case 'add_lift': {
      const room = getRoom(model, args.roomId);
      const persons = Number(args.persons ?? '6');
      const shaft = LIFT_SHAFTS[persons]!;
      const core: CoreElement = {
        id: ctx.newId('lift'),
        kind: 'lift',
        label: `Lift (${persons} person)`,
        roomId: room.id,
        at: { x: 0, y: 0 },
        rotation: 0,
        width: shaft.w,
        length: shaft.d,
        lift: { persons },
      };
      ctx.placeCore(core, room, args.corner as Corner | undefined);
      model.cores = [...coresOf(model), core];
      ctx.touch(core.id, room.id);
      const u = model.displayUnits;
      ctx.summary = `Added a ${persons}-person lift in ${room.name}.`;
      ctx.note(`Shaft ${formatLength(shaft.w, u)} × ${formatLength(shaft.d, u)} (typical; confirm with the lift supplier).`);
      break;
    }

    case 'move_core': {
      const c = ctx.core(args.coreId);
      const d = ctx.length(args.distance);
      const v = compassVector(args.direction, model.northAngle);
      c.at = { x: Math.round(c.at.x + v.x * d), y: Math.round(c.at.y + v.y * d) };
      ctx.touch(c.id);
      ctx.summary = `Moved the ${c.label.toLowerCase()} ${formatLength(d, model.displayUnits)} ${args.direction}.`;
      break;
    }

    case 'place_core': {
      const c = ctx.core(args.coreId);
      const room = getRoom(model, args.roomId ?? c.roomId);
      placeInCorner(model, c, room, args.corner as Corner);
      ctx.touch(c.id, room.id);
      ctx.summary = `Put the ${c.label.toLowerCase()} in the ${args.corner} corner of ${room.name}.`;
      break;
    }

    case 'rotate_core': {
      const c = ctx.core(args.coreId);
      c.rotation = (((c.rotation + Number(args.degrees)) % 360) + 360) % 360;
      ctx.touch(c.id);
      ctx.summary = `Turned the ${c.label.toLowerCase()} ${args.degrees}°.`;
      break;
    }

    case 'split_room': {
      const room = getRoom(model, args.roomId);
      const side = ctx.planSideFor(room, args.side as Compass);
      const size = ctx.length(args.size);
      const t = args.wallThickness ? ctx.length(args.wallThickness) : 115;
      const r = roomClearRect(model, room);
      const ax = roomAxisRect(model, room);
      const vertical = side === 'left' || side === 'right';
      const span = vertical ? r.x1 - r.x0 : r.y1 - r.y0;
      const u = model.displayUnits;
      if (size < 600) throw new ModelError(`A room needs to be at least ${formatLength(600, u)} across.`);
      if (span - size - t < 600) {
        throw new ModelError(`${room.name} is ${formatLength(span, u)} across; ${formatLength(size, u)} plus the new wall leaves too little for ${room.name}.`);
      }
      const axis = Math.round(
        side === 'left' ? r.x0 + size + t / 2 : side === 'right' ? r.x1 - size - t / 2 : side === 'top' ? r.y0 + size + t / 2 : r.y1 - size - t / 2,
      );
      const wall: Wall = vertical
        ? { id: ctx.newId('w'), a: { x: axis, y: ax.y0 }, b: { x: axis, y: ax.y1 }, thickness: t, kind: 'internal' }
        : { id: ctx.newId('w'), a: { x: ax.x0, y: axis }, b: { x: ax.x1, y: axis }, thickness: t, kind: 'internal' };
      model.walls.push(wall);
      const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const;
      const kind = (args.kind ?? 'other') as Room['kind'];
      const created: Room = {
        id: ctx.newId('r'),
        name: args.name,
        kind,
        wet: kind === 'toilet' || kind === 'kitchen' || kind === 'service',
        bounds: { ...room.bounds, [opposite[side]]: wall.id },
      };
      room.bounds = { ...room.bounds, [side]: wall.id };
      model.rooms.push(created);
      // Furniture, stairs and lifts now in the new room move to it.
      const nr = roomClearRect(model, created);
      const inside = (p: Point) => p.x >= nr.x0 - 1 && p.x <= nr.x1 + 1 && p.y >= nr.y0 - 1 && p.y <= nr.y1 + 1;
      for (const f of model.furniture) if (f.roomId === room.id && inside(f.at)) { f.roomId = created.id; ctx.touch(f.id); }
      for (const c of coresOf(model)) if (c.roomId === room.id && inside(c.at)) { c.roomId = created.id; ctx.touch(c.id); }
      ctx.touch(wall.id, room.id, created.id);
      ctx.summary = `Split ${room.name}: new ${args.name} on the ${args.side} side, ${formatLength(size, u)} clear (${roomSizeText(model, created)}).`;
      ctx.note(`New ${formatLength(t, u)} wall with no door yet; add a door or opening to reach ${args.name}.`);
      break;
    }

    case 'rename_room': {
      const room = getRoom(model, args.roomId);
      const before = room.name;
      room.name = args.name;
      ctx.touch(room.id);
      ctx.summary = `Renamed ${before} to ${args.name}.`;
      break;
    }
  }

  model.revision = input.revision + 1;
  return { model, summary: ctx.summary, assumptions: ctx.assumptions, changedIds: [...ctx.changed] };
}

class Ctx {
  summary = '';
  assumptions: string[] = [];
  changed = new Set<string>();
  constructor(private model: BuildingModel) {}

  touch(...ids: string[]) {
    ids.forEach((i) => this.changed.add(i));
  }

  note(text: string) {
    this.assumptions.push(text);
  }

  length(text: string, allowZero = false): number {
    const p = parseLength(text);
    if (p.note) this.note(p.note);
    if (p.mm < 0 || (p.mm === 0 && !allowZero)) throw new ModelError('Length must be greater than zero.');
    return p.mm;
  }

  site(): Site {
    if (!this.model.site) throw new ModelError('Set the plot size first (e.g. "plot is 60\' east–west by 40\' north–south").');
    return this.model.site;
  }

  newId(prefix: string): string {
    const used = new Set([
      ...this.model.walls.map((e) => e.id),
      ...this.model.openings.map((e) => e.id),
      ...this.model.rooms.map((e) => e.id),
      ...this.model.furniture.map((e) => e.id),
      ...(this.model.site?.trees ?? []).map((e) => e.id),
      ...coresOf(this.model).map((e) => e.id),
    ]);
    let n = 1;
    while (used.has(`${prefix}-${n}`)) n++;
    return `${prefix}-${n}`;
  }

  opening(id: string): Opening {
    const o = this.model.openings.find((e) => e.id === id);
    if (!o) throw new ModelError(`No door or window with id "${id}"`);
    return o;
  }

  core(id: string): CoreElement {
    const c = coresOf(this.model).find((e) => e.id === id);
    if (!c) throw new ModelError(`No stair or lift with id "${id}"`);
    return c;
  }

  /** Put a new core in the given corner, or the first corner where it fits. */
  placeCore(c: CoreElement, room: Room, corner?: Corner) {
    if (corner) return placeInCorner(this.model, c, room, corner);
    let last: unknown;
    for (const k of CORNERS) {
      try {
        placeInCorner(this.model, c, room, k);
        const others = coresOf(this.model).filter((o) => o.roomId === room.id);
        if (others.every((o) => !rectsOverlap(coreFootprint(o), coreFootprint(c), 5))) return;
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new ModelError(`There's no free corner in ${room.name} for the ${c.label.toLowerCase()}.`);
  }

  item(id: string): FurnitureItem {
    const f = this.model.furniture.find((e) => e.id === id);
    if (!f) throw new ModelError(`No furniture item with id "${id}"`);
    return f;
  }

  /** +1 / -1 for moving along a wall in a compass direction; error if perpendicular. */
  alongWallSign(wall: Wall, dir: Compass, label: string): 1 | -1 {
    const v = compassVector(dir, this.model.northAngle);
    const w = wallDir(wall);
    const dot = v.x * w.x + v.y * w.y;
    if (Math.abs(dot) < 0.7) {
      const runs = vectorToCompass(w, this.model.northAngle);
      throw new ModelError(`${label} is on a wall running ${axisName(runs)}, so it can't move ${dir}.`);
    }
    return dot > 0 ? 1 : -1;
  }

  checkOpeningFits(wall: Wall, offset: number, width: number, label: string) {
    const len = wallLength(wall);
    const start = offset - width / 2;
    const end = offset + width / 2;
    if (start < JAMB_MIN || end > len - JAMB_MIN) {
      throw new ModelError(
        `${label} would run past the end of its wall (needs ${formatLength(JAMB_MIN, this.model.displayUnits)} at each end).`,
      );
    }
  }

  roomOnWall(wallId: string): Room {
    const r = this.model.rooms.find((room) => Object.values(room.bounds).includes(wallId));
    if (!r) throw new ModelError('That wall does not bound any room; name the room to centre within.');
    return r;
  }

  /** Clear span of a room along a wall, as offsets from wall.a. */
  roomSpanAlongWall(room: Room, wall: Wall): [number, number] {
    const r = roomClearRect(this.model, room);
    const d = wallDir(wall);
    const horizontal = isHorizontal(wall);
    const [lo, hi] = horizontal ? [r.x0, r.x1] : [r.y0, r.y1];
    const base = horizontal ? wall.a.x : wall.a.y;
    const sign = horizontal ? Math.sign(d.x) : Math.sign(d.y);
    const a = (lo - base) * sign;
    const b = (hi - base) * sign;
    return [Math.min(a, b), Math.max(a, b)];
  }

  planSideFor(room: Room, dir: Compass): 'top' | 'bottom' | 'left' | 'right' {
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      if (planSideCompass(side, this.model.northAngle) === dir) return side;
    }
    throw new ModelError(`${room.name} has no ${dir} wall at this orientation.`);
  }

  /**
   * Move an axis-aligned wall perpendicular to itself by delta (mm, plan axis).
   * Walls meeting its ends stretch; openings keep their physical position.
   */
  moveWall(wall: Wall, delta: number) {
    const horizontal = isHorizontal(wall);
    const key: 'x' | 'y' = horizontal ? 'y' : 'x';
    const old = wall.a[key];
    const spanKey: 'x' | 'y' = horizontal ? 'x' : 'y';
    const lo = Math.min(wall.a[spanKey], wall.b[spanKey]) - 1;
    const hi = Math.max(wall.a[spanKey], wall.b[spanKey]) + 1;

    const openingPos = new Map<string, Point>();
    for (const o of this.model.openings) openingPos.set(o.id, pointOnWall(getWall(this.model, o.wallId), o.offset));

    wall.a = { ...wall.a, [key]: old + delta };
    wall.b = { ...wall.b, [key]: old + delta };
    this.touch(wall.id);

    for (const other of this.model.walls) {
      if (other.id === wall.id) continue;
      for (const end of ['a', 'b'] as const) {
        const p = other[end];
        if (Math.abs(p[key] - old) < 1 && p[spanKey] >= lo && p[spanKey] <= hi) {
          other[end] = { ...p, [key]: old + delta };
          this.touch(other.id);
        }
      }
    }

    // Openings on any changed wall keep their physical position (re-project offset);
    // openings on the moved wall itself travel with it.
    for (const o of this.model.openings) {
      if (o.wallId === wall.id || !this.changed.has(o.wallId)) continue;
      const w = getWall(this.model, o.wallId);
      const p = openingPos.get(o.id)!;
      const d = wallDir(w);
      o.offset = Math.round((p.x - w.a.x) * d.x + (p.y - w.a.y) * d.y);
      this.touch(o.id);
    }
    for (const o of this.model.openings) if (o.wallId === wall.id) this.touch(o.id);

    for (const room of this.model.rooms) {
      if (Object.values(room.bounds).some((id) => this.changed.has(id))) this.touch(room.id);
    }
  }
}

/**
 * Scale the layout so its outer faces measure outerW × outerH. Wall axes are
 * scaled about the layout's top-left axis corner; thicknesses, opening widths
 * and furniture sizes are kept. Openings that no longer fit are pulled in.
 */
function fitBuilding(model: BuildingModel, outerW: number, outerH: number, ctx: Ctx) {
  const R = buildingOuterRect(model);
  const xs = model.walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = model.walls.flatMap((w) => [w.a.y, w.b.y]);
  const A = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  const sx = (outerW - (A.x0 - R.x0) - (R.x1 - A.x1)) / (A.x1 - A.x0);
  const sy = (outerH - (A.y0 - R.y0) - (R.y1 - A.y1)) / (A.y1 - A.y0);
  const u = model.displayUnits;
  if (!(sx >= 0.5 && sx <= 2 && sy >= 0.5 && sy <= 2)) {
    throw new ModelError(
      `The buildable area (${formatLength(outerW, u)} × ${formatLength(outerH, u)}) is too different from this layout (${formatLength(R.x1 - R.x0, u)} × ${formatLength(R.y1 - R.y0, u)}) to stretch it sensibly. Try a template closer in size.`,
    );
  }
  const X = (x: number) => Math.round(A.x0 + (x - A.x0) * sx);
  const Y = (y: number) => Math.round(A.y0 + (y - A.y0) * sy);
  const horizontalBefore = new Map(model.walls.map((w) => [w.id, isHorizontal(w)]));
  const roomBefore = new Map(model.rooms.map((r) => [r.id, roomClearRect(model, r)]));
  for (const w of model.walls) {
    w.a = { x: X(w.a.x), y: Y(w.a.y) };
    w.b = { x: X(w.b.x), y: Y(w.b.y) };
  }
  for (const o of model.openings) {
    const w = getWall(model, o.wallId);
    const s = horizontalBefore.get(w.id) ? sx : sy;
    const len = wallLength(w);
    let offset = Math.round(o.offset * s);
    if (o.width > len - 2 * JAMB_MIN) {
      o.width = Math.max(600, Math.round(len - 2 * JAMB_MIN));
      ctx.note(`${o.label} narrowed to fit its shorter wall.`);
    }
    offset = Math.min(Math.max(offset, JAMB_MIN + o.width / 2), len - JAMB_MIN - o.width / 2);
    o.offset = Math.round(offset);
  }
  // Furniture keeps its distance to the nearer wall of its room on each axis,
  // so a bed against a wall stays against it.
  for (const f of model.furniture) {
    const before = roomBefore.get(f.roomId);
    const room = model.rooms.find((r) => r.id === f.roomId);
    if (!before || !room) {
      f.at = { x: X(f.at.x), y: Y(f.at.y) };
      continue;
    }
    const after = roomClearRect(model, room);
    const fr = itemFootprint(f);
    const w = fr.x1 - fr.x0;
    const h = fr.y1 - fr.y0;
    const gl = fr.x0 - before.x0;
    const gr = before.x1 - fr.x1;
    const gt = fr.y0 - before.y0;
    const gb = before.y1 - fr.y1;
    const x = gl <= gr ? after.x0 + gl + w / 2 : after.x1 - gr - w / 2;
    const y = gt <= gb ? after.y0 + gt + h / 2 : after.y1 - gb - h / 2;
    f.at = { x: Math.round(x), y: Math.round(y) };
  }

  // Stairs and lifts keep their distance to the nearer walls too (never dropped).
  for (const c of coresOf(model)) {
    const before = roomBefore.get(c.roomId);
    const room = model.rooms.find((r) => r.id === c.roomId);
    if (!before || !room) {
      c.at = { x: X(c.at.x), y: Y(c.at.y) };
      continue;
    }
    const after = roomClearRect(model, room);
    const fr = coreFootprint(c);
    const w = fr.x1 - fr.x0;
    const h = fr.y1 - fr.y0;
    const x = fr.x0 - before.x0 <= before.x1 - fr.x1 ? after.x0 + (fr.x0 - before.x0) + w / 2 : after.x1 - (before.x1 - fr.x1) - w / 2;
    const y = fr.y0 - before.y0 <= before.y1 - fr.y1 ? after.y0 + (fr.y0 - before.y0) + h / 2 : after.y1 - (before.y1 - fr.y1) - h / 2;
    c.at = { x: Math.round(x), y: Math.round(y) };
    const nf = coreFootprint(c);
    if (nf.x1 - nf.x0 > after.x1 - after.x0 + 1 || nf.y1 - nf.y0 > after.y1 - after.y0 + 1) {
      c.rotation = (c.rotation + 90) % 360;
      const rf = coreFootprint(c);
      if (rf.x1 - rf.x0 > after.x1 - after.x0 + 1 || rf.y1 - rf.y0 > after.y1 - after.y0 + 1) {
        c.rotation = (c.rotation + 270) % 360;
        if (room.kind !== 'stair' && room.kind !== 'lift') ctx.note(`The ${c.label.toLowerCase()} no longer fits ${room.name}; it needs a bigger room.`);
      } else ctx.note(`The ${c.label.toLowerCase()} was turned to fit the resized ${room.name}.`);
    }
    // keep inside the room where possible
    const f2 = coreFootprint(c);
    const hw = (f2.x1 - f2.x0) / 2;
    const hh = (f2.y1 - f2.y0) / 2;
    if (hw * 2 <= after.x1 - after.x0) c.at = { ...c.at, x: Math.round(Math.min(Math.max(c.at.x, after.x0 + hw), after.x1 - hw)) };
    if (hh * 2 <= after.y1 - after.y0) c.at = { ...c.at, y: Math.round(Math.min(Math.max(c.at.y, after.y0 + hh), after.y1 - hh)) };
  }

  fitCoreRooms(model, ctx);

  // Items that no longer fit their resized room: try turning them, else leave them out.
  const fits = (f: FurnitureItem, r: Rect) => {
    const fr = itemFootprint(f);
    return fr.x1 - fr.x0 <= r.x1 - r.x0 + 1 && fr.y1 - fr.y0 <= r.y1 - r.y0 + 1;
  };
  const clampInto = (f: FurnitureItem, r: Rect) => {
    const fr = itemFootprint(f);
    const hw = (fr.x1 - fr.x0) / 2;
    const hh = (fr.y1 - fr.y0) / 2;
    f.at = { x: Math.round(Math.min(Math.max(f.at.x, r.x0 + hw), r.x1 - hw)), y: Math.round(Math.min(Math.max(f.at.y, r.y0 + hh), r.y1 - hh)) };
  };
  model.furniture = model.furniture.filter((f) => {
    const room = model.rooms.find((r) => r.id === f.roomId);
    if (!room) return true;
    const r = roomClearRect(model, room);
    if (!fits(f, r)) {
      f.rotation = (f.rotation + 90) % 360;
      if (!fits(f, r)) {
        ctx.note(`${f.label} left out: it doesn't fit the resized ${room.name}.`);
        return false;
      }
      ctx.note(`${f.label} turned to fit the resized ${room.name}.`);
    }
    clampInto(f, r);
    return true;
  });
}

/**
 * Stair and lift rooms keep the size their stair or lift needs: when a resize
 * leaves one too small, an inside wall is moved, taking the space from the
 * neighbouring ordinary room. The stair or lift is then put back in its corner.
 */
function fitCoreRooms(model: BuildingModel, ctx: Ctx) {
  const isCoreRoom = (r: Room) => r.kind === 'stair' || r.kind === 'lift';
  for (let pass = 0; pass < 2; pass++) {
    for (const c of coresOf(model)) {
      const room = model.rooms.find((r) => r.id === c.roomId);
      if (!room || !isCoreRoom(room)) continue;
      const r = roomClearRect(model, room);
      const fp = coreFootprint(c);
      // Prefer the stair's present turn; else turn it if the room suits that better.
      let [needW, needH] = [fp.x1 - fp.x0, fp.y1 - fp.y0];
      const W = r.x1 - r.x0;
      const H = r.y1 - r.y0;
      const deficit = (w: number, h: number) => Math.max(0, w - W) + Math.max(0, h - H);
      if (deficit(needH, needW) < deficit(needW, needH)) {
        c.rotation = (c.rotation + 90) % 360;
        [needW, needH] = [needH, needW];
      }
      const grow = (axis: 'x' | 'y', need: number) => {
        const have = axis === 'x' ? W : H;
        if (need <= have + 1) return;
        const sides: PlanSide4[] = axis === 'x' ? ['left', 'right'] : ['top', 'bottom'];
        const options = sides
          .map((side) => {
            const wall = getWall(model, room.bounds[side]);
            if (wall.kind === 'external') return null;
            const opp = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const;
            const neighbours = model.rooms.filter((o) => o.bounds[opp[side]] === wall.id);
            if (neighbours.length === 0) return null;
            const spare = Math.min(...neighbours.map((o) => {
              const nr = roomClearRect(model, o);
              return (axis === 'x' ? nr.x1 - nr.x0 : nr.y1 - nr.y0) - 900;
            }));
            const score = (neighbours.some(isCoreRoom) ? -1e6 : 0) + spare;
            return { side, wall, spare, score };
          })
          .filter((o): o is NonNullable<typeof o> => !!o && o.spare >= need - have)
          .sort((a, b) => b.score - a.score);
        const pick = options[0];
        if (!pick) return;
        const delta = Math.ceil(need - have);
        ctx.moveWall(pick.wall, pick.side === 'left' || pick.side === 'top' ? -delta : delta);
      };
      grow('x', needW);
      grow('y', needH);
      const after = roomClearRect(model, room);
      if (needW <= after.x1 - after.x0 + 1 && needH <= after.y1 - after.y0 + 1) {
        // Back into the nearest corner of the resized room.
        const cx = (after.x0 + after.x1) / 2;
        const cy = (after.y0 + after.y1) / 2;
        const x = c.at.x <= cx ? after.x0 + needW / 2 : after.x1 - needW / 2;
        const y = c.at.y <= cy ? after.y0 + needH / 2 : after.y1 - needH / 2;
        c.at = { x: Math.round(x), y: Math.round(y) };
      }
    }
  }
}
type PlanSide4 = 'top' | 'bottom' | 'left' | 'right';

/**
 * Resize a layout so its outer walls measure outerW × outerH (mm). Returns any
 * notes (e.g. openings narrowed). Used for template defaults and fit_to_buildable.
 */
export function resizeLayout(input: BuildingModel, outerW: number, outerH: number): { model: BuildingModel; notes: string[] } {
  const model = structuredClone(input);
  const ctx = new Ctx(model);
  fitBuilding(model, outerW, outerH, ctx);
  return { model, notes: ctx.assumptions };
}

/** The room whose clear rectangle sits in a corner of the building. */
function roomAtCorner(model: BuildingModel, corner: Corner): Room | undefined {
  const [a, b] = corner.split('-') as [Compass, Compass];
  const sides = [compassToSide(a, model.northAngle), compassToSide(b, model.northAngle)];
  const outer = buildingOuterRect(model);
  const score = (r: Room) => {
    const c = roomClearRect(model, r);
    let d = 0;
    for (const s of sides) d += s === 'top' ? c.y0 - outer.y0 : s === 'bottom' ? outer.y1 - c.y1 : s === 'left' ? c.x0 - outer.x0 : outer.x1 - c.x1;
    return d;
  };
  return [...model.rooms].sort((x, y) => score(x) - score(y))[0];
}

/**
 * Swap the use of two rooms: names, types, wet flag; furniture, stairs and lifts
 * move to the other room keeping their distance to the nearer walls. Door and
 * window labels that name a room follow it.
 */
function swapRooms(model: BuildingModel, a: Room, b: Room, ctx: Ctx) {
  const ra = roomClearRect(model, a);
  const rb = roomClearRect(model, b);
  const fa = { name: a.name, kind: a.kind, wet: a.wet };
  a.name = b.name;
  a.kind = b.kind;
  a.wet = b.wet;
  b.name = fa.name;
  b.kind = fa.kind;
  b.wet = fa.wet;

  const remap = (at: Point, w: number, h: number, from: Rect, to: Rect): Point => {
    const gl = at.x - w / 2 - from.x0;
    const gr = from.x1 - (at.x + w / 2);
    const gt = at.y - h / 2 - from.y0;
    const gb = from.y1 - (at.y + h / 2);
    const x = gl <= gr ? to.x0 + gl + w / 2 : to.x1 - gr - w / 2;
    const y = gt <= gb ? to.y0 + gt + h / 2 : to.y1 - gb - h / 2;
    return { x: Math.round(x), y: Math.round(y) };
  };
  const fits = (rect: Rect, room: Rect) => rect.x1 - rect.x0 <= room.x1 - room.x0 + 1 && rect.y1 - rect.y0 <= room.y1 - room.y0 + 1;

  for (const f of [...model.furniture]) {
    if (f.roomId !== a.id && f.roomId !== b.id) continue;
    const [from, to, dest] = f.roomId === a.id ? [ra, rb, b] : [rb, ra, a];
    const fp = itemFootprint(f);
    f.at = remap(f.at, fp.x1 - fp.x0, fp.y1 - fp.y0, from, to);
    f.roomId = dest.id;
    if (!fits(itemFootprint(f), to)) {
      f.rotation = (f.rotation + 90) % 360;
      if (!fits(itemFootprint(f), to)) {
        model.furniture = model.furniture.filter((x) => x.id !== f.id);
        ctx.note(`${f.label} left out: it doesn't fit in ${dest.name}'s new room.`);
        continue;
      }
    }
    ctx.touch(f.id);
  }
  for (const c of coresOf(model)) {
    if (c.roomId !== a.id && c.roomId !== b.id) continue;
    const [from, to, dest] = c.roomId === a.id ? [ra, rb, b] : [rb, ra, a];
    const fp = coreFootprint(c);
    c.at = remap(c.at, fp.x1 - fp.x0, fp.y1 - fp.y0, from, to);
    c.roomId = dest.id;
    if (!fits(coreFootprint(c), to)) {
      c.rotation = (c.rotation + 90) % 360;
      if (!fits(coreFootprint(c), to)) ctx.note(`The ${c.label.toLowerCase()} doesn't fit in its new room; resize the room or move it.`);
    }
    ctx.touch(c.id);
  }

  // Door/window labels that start with a room's name follow that room's use.
  const swapLabel = (label: string) =>
    label.startsWith(`${b.name} `) ? `${a.name} ${label.slice(b.name.length + 1)}` : label.startsWith(`${a.name} `) ? `${b.name} ${label.slice(a.name.length + 1)}` : label;
  for (const o of model.openings) {
    const next = swapLabel(o.label);
    if (next !== o.label) {
      o.label = next;
      ctx.touch(o.id);
    }
  }
  ctx.touch(a.id, b.id);
  if (a.wet !== b.wet) ctx.note('A wet room moved: check water supply and drainage, and the plumbing walls.');
}

/** Centre the building in the buildable area (or the plot when setbacks are zero). */
function centreBuilding(model: BuildingModel, site: Site) {
  const f = footprintOnPlot(model, site);
  const b = buildableRect(site);
  site.buildingOffset = {
    x: Math.round(site.buildingOffset.x + (b.x0 + b.x1) / 2 - (f.x0 + f.x1) / 2),
    y: Math.round(site.buildingOffset.y + (b.y0 + b.y1) / 2 - (f.y0 + f.y1) / 2),
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function axisName(c: Compass): string {
  return c === 'north' || c === 'south' ? 'north–south' : 'east–west';
}

function perpNames(model: BuildingModel, planAxis: 'x' | 'y'): string {
  const v = planAxis === 'y' ? { x: 0, y: -1 } : { x: 1, y: 0 };
  const a = vectorToCompass(v, model.northAngle);
  const b = vectorToCompass({ x: -v.x, y: -v.y }, model.northAngle);
  return `${a} or ${b}`;
}

export function describeNorth(model: BuildingModel): string {
  if (model.northAngle === 0) return 'north is up on the plan';
  return `north is ${model.northAngle}° clockwise from plan-up`;
}

/** Room size as displayed: clear dimensions, plan width × plan depth. */
export function roomSizeText(model: BuildingModel, room: Room): string {
  const { w, h } = rectSize(roomClearRect(model, room));
  return `${formatLength(w, model.displayUnits)} × ${formatLength(h, model.displayUnits)}`;
}

export function itemRect(f: FurnitureItem): Rect {
  return itemFootprint(f);
}
