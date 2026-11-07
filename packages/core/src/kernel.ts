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
  blockBounds,
  findEntity,
  fixedWallUnder,
  getRoom,
  getWall,
  parseBlockWallId,
  type BuildingModel,
  type FurnitureItem,
  blockWallId,
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
import { parseOperation as parseOp, type Operation } from './ops';
import { doorSwingRect } from './checks';
import { clampBlockInside, coincidentSides, resizeBlockSide, rotateBlock, setBlockClearSize, shellAxisRect, snapBlock, splitBlock, translateBlock } from './blocks';
import { fitOutAll, fitOutRoom } from './fixtures';
import { RATE_CARD } from './boq';
import { generateStructure } from './structure';
import { BriefSchema, briefLabel } from './brief';
import { CORNERS, DEFAULT_FLOOR_HEIGHT, LIFT_SHAFTS, coreFootprint, coresOf, enclosureOf, placeInCorner, settleCore, sizeStair, type Corner } from './cores';
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
      else if (!model.rooms.some((r) => r.block) && !model.walls.every((w) => w.kind === 'external')) ctx.note('The building was re-centred in the buildable area.');
      if (!creating) followSite(model, ctx);
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
      followSite(model, ctx);
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
      if (args.rooms !== 'scale' && (model.rooms.some((r) => r.block) || model.walls.every((w) => w.kind === 'external'))) {
        const { before, after } = fitShell(model, ctx);
        ctx.summary = `Outer walls now fill the buildable area: ${formatLength(after.x1 - after.x0, model.displayUnits)} × ${formatLength(after.y1 - after.y0, model.displayUnits)} outside (was ${formatLength(before.x1 - before.x0, model.displayUnits)} × ${formatLength(before.y1 - before.y0, model.displayUnits)}).`;
        ctx.note('Rooms kept their sizes; rooms against an outer wall moved with it.');
        break;
      }
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
      const room = args.roomId ? getRoom(model, args.roomId) : roomAtPoint(model, args.x, args.y);
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
        ...(args.enclosed === false ? {} : { enclosure: { thickness: 115 } }),
      };
      if (args.x !== undefined && args.y !== undefined) dropCore(model, core, room, args.x, args.y);
      else ctx.placeCore(core, room, args.corner as Corner | undefined);
      model.cores = [...coresOf(model), core];
      ctx.touch(core.id, room.id);
      const u = model.displayUnits;
      ctx.summary = `Added a ${type} staircase in ${room.name}: ${dims.risers} risers of ${formatLength(dims.riser, u)}, flights ${formatLength(flightWidth, u)} wide.`;
      ctx.note(`Footprint ${formatLength(core.width, u)} × ${formatLength(core.length, u)} for a ${formatLength(floorHeight, u)} floor-to-floor height${args.floorHeight ? '' : ' (default)'}; treads ${formatLength(dims.tread, u)}.`);
      break;
    }

    case 'add_lift': {
      const room = args.roomId ? getRoom(model, args.roomId) : roomAtPoint(model, args.x, args.y);
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
        enclosure: { thickness: 115 },
      };
      if (args.x !== undefined && args.y !== undefined) dropCore(model, core, room, args.x, args.y);
      else ctx.placeCore(core, room, args.corner as Corner | undefined);
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
      const from = c.roomId;
      c.at = { x: Math.round(c.at.x + v.x * d), y: Math.round(c.at.y + v.y * d) };
      {
        // Never outside the building.
        const sh = shellAxisRect(model);
        const ext = model.walls.find((w) => w.kind === 'external')?.thickness ?? 230;
        const fp = coreFootprint(c);
        const t = c.enclosure?.thickness ?? 0;
        const lo = { x: sh.x0 + ext / 2 + t, y: sh.y0 + ext / 2 + t };
        const hi = { x: sh.x1 - ext / 2 - t, y: sh.y1 - ext / 2 - t };
        const dx = fp.x0 < lo.x ? lo.x - fp.x0 : fp.x1 > hi.x ? hi.x - fp.x1 : 0;
        const dy = fp.y0 < lo.y ? lo.y - fp.y0 : fp.y1 > hi.y ? hi.y - fp.y1 : 0;
        if (dx || dy) {
          c.at = { x: Math.round(c.at.x + dx), y: Math.round(c.at.y + dy) };
          ctx.note('Stopped at the outer wall.');
        }
      }
      settleCore(model, c);
      ctx.touch(c.id, c.roomId, from);
      const into = c.roomId !== from ? ` into ${getRoom(model, c.roomId).name}` : '';
      ctx.summary = `Moved the ${c.label.toLowerCase()} ${formatLength(d, model.displayUnits)} ${args.direction}${into}.`;
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
      settleCore(model, c);
      ctx.touch(c.id);
      ctx.summary = `Turned the ${c.label.toLowerCase()} ${args.degrees}°.`;
      break;
    }

    case 'split_room': {
      const room = getRoom(model, args.roomId);
      const side = ctx.planSideFor(room, args.side as Compass);
      const size = ctx.length(args.size);
      const t = room.block ? room.block.thickness : args.wallThickness ? ctx.length(args.wallThickness) : 115;
      const r = roomClearRect(model, room);
      if (!room.block && model.rooms.some((x) => x.block)) {
        throw new ModelError(`${room.name} is open space around the room blocks; use add_room to put a new room in it.`);
      }
      const ax = roomAxisRect(model, room);
      const vertical = side === 'left' || side === 'right';
      const span = vertical ? r.x1 - r.x0 : r.y1 - r.y0;
      const u = model.displayUnits;
      if (size < 600) throw new ModelError(`A room needs to be at least ${formatLength(600, u)} across.`);
      if (span - size - t < 600) {
        throw new ModelError(`${room.name} is ${formatLength(span, u)} across; ${formatLength(size, u)} plus the new wall leaves too little for ${room.name}.`);
      }
      const kindB = (args.kind ?? 'other') as Room['kind'];
      if (room.block) {
        const created: Room = {
          id: ctx.newId('r'),
          name: args.name,
          kind: kindB,
          wet: kindB === 'toilet' || kindB === 'kitchen' || kindB === 'service',
          bounds: room.bounds,
        };
        splitBlock(model, room, side, size, created);
        const nr = roomClearRect(model, created);
        const inside = (p: Point) => p.x >= nr.x0 - 1 && p.x <= nr.x1 + 1 && p.y >= nr.y0 - 1 && p.y <= nr.y1 + 1;
        for (const f of model.furniture) if (f.roomId === room.id && inside(f.at)) { f.roomId = created.id; ctx.touch(f.id); }
        for (const c of coresOf(model)) if (c.roomId === room.id && inside(c.at)) { c.roomId = created.id; ctx.touch(c.id); }
        ctx.touch(room.id, created.id);
        ctx.summary = `Split ${room.name}: new ${args.name} on the ${args.side} side, ${formatLength(size, u)} clear (${roomSizeText(model, created)}).`;
        ctx.note(`New ${formatLength(t, u)} wall with no door yet; add a door or opening to reach ${args.name}.`);
        break;
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

    case 'move_room': {
      const room = getRoom(model, args.roomId);
      if (!room.block) {
        throw new ModelError(
          room.kind === 'living' || room.kind === 'dining'
            ? `${room.name} is the open space around the rooms; move the rooms instead.`
            : `${room.name} is fixed by walls in this design; swap it with another room instead.`,
        );
      }
      const d = ctx.length(args.distance);
      const v = compassVector(args.direction, model.northAngle);
      const size0 = roomClearRect(model, room);
      const start0 = { ...room.block };
      translateBlock(model, room, Math.round(v.x * d), Math.round(v.y * d));
      const clamped = clampBlockInside(model, room);
      const snapped = snapBlock(model, room);
      keepClearSize(model, room, size0, { x: room.block!.x0 - start0.x0 + (room.block!.x1 - start0.x1), y: room.block!.y0 - start0.y0 + (room.block!.y1 - start0.y1) });
      if (clamped.dx || clamped.dy) ctx.note(`Stopped at the outer wall.`);
      rehomeDoors(model, room, ctx);
      for (const f of model.furniture) if (f.roomId === room.id) ctx.touch(f.id);
      for (const c of coresOf(model)) if (c.roomId === room.id) ctx.touch(c.id);
      ctx.touch(room.id);
      ctx.summary = `Moved ${room.name} ${formatLength(d, model.displayUnits)} ${args.direction}.`;
      if (snapped.dx || snapped.dy) ctx.note('Lined up with the nearest wall.');
      break;
    }

    case 'add_room': {
      const kind = (args.kind ?? 'other') as Room['kind'];
      const def = ROOM_DEFAULTS[kind] ?? ROOM_DEFAULTS.other!;
      const w = args.width ? ctx.length(args.width) : def.w;
      const h = args.depth ? ctx.length(args.depth) : def.h;
      const name = args.name ?? defaultRoomName(model, kind);
      const host = args.inRoomId ? getRoom(model, args.inRoomId) : model.rooms.find((r) => !r.block && (r.kind === 'living' || r.kind === 'dining'));
      if (!host) throw new ModelError('There is no open space to add a room in.');
      const created =
        args.x !== undefined && args.y !== undefined
          ? placeBlockAt(model, ctx, host, w, h, name, kind, args.x, args.y)
          : placeFreeBlock(model, ctx, host, w, h, name, kind, args.corner as Corner | undefined);
      addBlockDoorAndVent(model, ctx, created);
      fitOutRoom(model, model.rooms.find((x) => x.id === created.id)!).forEach((f) => ctx.touch(f.id));
      ctx.touch(created.id);
      ctx.summary = `Added ${name} (${roomSizeText(model, model.rooms.find((x) => x.id === created.id)!)}).`;
      ctx.note('Drag it by its name to move it, drag its walls or type a size to resize it.');
      break;
    }

    case 'set_room_position': {
      const room = getRoom(model, args.roomId);
      if (!room.block) throw new ModelError(`${room.name} is fixed by walls; it can't be moved.`);
      const b = room.block;
      const dx = Math.round(args.x - b.x0);
      const dy = Math.round(args.y - b.y0);
      const size0 = roomClearRect(model, room);
      translateBlock(model, room, dx, dy);
      const pulled = clampBlockInside(model, room);
      keepClearSize(model, room, size0, { x: dx + pulled.dx, y: dy + pulled.dy });
      rehomeDoors(model, room, ctx);
      const fx = dx + Math.round(pulled.dx);
      const fy = dy + Math.round(pulled.dy);
      for (const f of model.furniture) if (f.roomId === room.id) ctx.touch(f.id);
      for (const c of coresOf(model)) if (c.roomId === room.id) ctx.touch(c.id);
      ctx.touch(room.id);
      const words: string[] = [];
      const u = model.displayUnits;
      const say = (d: number, plan: { x: number; y: number }) => {
        if (Math.abs(d) < 1) return;
        words.push(`${formatLength(Math.abs(d), u)} ${vectorToCompass({ x: plan.x * Math.sign(d), y: plan.y * Math.sign(d) }, model.northAngle)}`);
      };
      say(fx, { x: 1, y: 0 });
      say(fy, { x: 0, y: 1 });
      ctx.summary = words.length ? `Moved ${room.name} ${words.join(' and ')}.` : `${room.name} stays where it is.`;
      break;
    }

    case 'apply_layout': {
      // Clear the old blocks, their openings and furniture, and the cores; keep the shell and the open room.
      const blocks = new Set(model.rooms.filter((r) => r.block).map((r) => r.id));
      const host = model.rooms.find((r) => !r.block && (r.kind === 'living' || r.kind === 'dining')) ?? model.rooms.find((r) => !r.block);
      if (!host) throw new ModelError('The design has no open room to lay out in.');
      model.rooms = model.rooms.filter((r) => !blocks.has(r.id));
      model.openings = model.openings.filter((o) => !o.wallId.startsWith('blk:') && model.walls.find((w) => w.id === o.wallId)?.kind !== 'external');
      model.furniture = model.furniture.filter((f) => model.rooms.some((r) => r.id === f.roomId) && f.roomId !== host.id);
      // Stairs and lifts stay (they are the building's, not the layout's); they are stood again after.
      const keepCores = coresOf(model).map((c) => structuredClone(c));
      model.cores = [];
      host.name = 'Living / Dining';
      const made = new Map<string, Room>();
      for (const lr of args.rooms) {
        const room: Room = { id: ctx.newId('r'), name: lr.name, kind: lr.kind, wet: lr.kind === 'toilet' || lr.kind === 'kitchen' || lr.kind === 'service', bounds: blockBounds('x'), block: { x0: Math.round(lr.x0), y0: Math.round(lr.y0), x1: Math.round(lr.x1), y1: Math.round(lr.y1), thickness: 115 } };
        room.bounds = blockBounds(room.id);
        model.rooms.push(room);
        made.set(lr.name, room);
      }
      model.zones = args.zones.map((z) => ({ ...z }));
      const rectOf = (name: string) => {
        const r = args.rooms.find((x) => x.name === name);
        return r ? [r] : args.zones.filter((z) => z.name === name);
      };
      // Doors: on the side shared with the target, near the end closest to the target's middle.
      for (const lr of args.rooms) {
        if (!lr.door) continue;
        const room = made.get(lr.name)!;
        const width = lr.kind === 'toilet' ? 750 : lr.kind === 'pooja' || lr.kind === 'other' ? 760 : lr.kind === 'service' ? 760 : 900;
        let placed = false;
        // The named target first; failing that any open zone it touches, so no room is left without a way in.
        // A pooja opens only off the living area (or else the kitchen), never a passage or a bedroom.
        const living = /^(living|foyer|dining|hall|entrance)/i;
        const targets =
          lr.kind === 'pooja'
            ? [...rectOf(lr.door), ...args.zones.filter((z) => z.name !== lr.door && living.test(z.name)), ...args.rooms.filter((r) => r.kind === 'kitchen')]
            : [...rectOf(lr.door), ...args.zones.filter((z) => z.name !== lr.door)];
        for (const t of targets) {
          const sides: { side: PlanSide4; s0: number; s1: number }[] = [];
          const ox = [Math.max(lr.x0, t.x0), Math.min(lr.x1, t.x1)] as const;
          const oy = [Math.max(lr.y0, t.y0), Math.min(lr.y1, t.y1)] as const;
          if (Math.abs(lr.y0 - t.y1) < 3) sides.push({ side: 'top', s0: ox[0], s1: ox[1] });
          if (Math.abs(lr.y1 - t.y0) < 3) sides.push({ side: 'bottom', s0: ox[0], s1: ox[1] });
          if (Math.abs(lr.x0 - t.x1) < 3) sides.push({ side: 'left', s0: oy[0], s1: oy[1] });
          if (Math.abs(lr.x1 - t.x0) < 3) sides.push({ side: 'right', s0: oy[0], s1: oy[1] });
          const sd = sides.filter((x) => x.s1 - x.s0 >= width + 250).sort((a, b) => b.s1 - b.s0 - (a.s1 - a.s0))[0];
          if (!sd) continue;
          const horizontal = sd.side === 'top' || sd.side === 'bottom';
          const tc = horizontal ? (t.x0 + t.x1) / 2 : (t.y0 + t.y1) / 2;
          const nearStart = Math.abs(sd.s0 - tc) <= Math.abs(sd.s1 - tc);
          const margin = 60 + 115 / 2 + width / 2;
          let along = nearStart ? sd.s0 + margin : sd.s1 - margin;
          if (lr.kind === 'toilet') {
            // A toilet is entered at the middle of its wall, facing the wash basin, clear of the WC and shower at the ends.
            const mid = horizontal ? (lr.x0 + lr.x1) / 2 : (lr.y0 + lr.y1) / 2;
            along = Math.min(sd.s1 - margin, Math.max(sd.s0 + margin, mid));
          }
          const origin = horizontal ? lr.x0 : lr.y0;
          const o: Opening = { id: ctx.newId('door'), label: `${lr.name} door`, wallId: blockWallId(room.id, sd.side), kind: 'door', offset: Math.round(along - origin), width, height: 2100, swingSide: 'left', hinge: nearStart ? 'start' : 'end' };
          model.openings.push(o);
          setSwingInto(model, o, room);
          placed = true;
          break;
        }
        if (!placed) ctx.note(`${lr.name} has no wall long enough onto ${lr.door} or the open area for a door.`);
      }
      // Windows on outer walls: bedrooms, kitchens, toilets (ventilators) and the open zones.
      const ext = model.walls.filter((w) => w.kind === 'external');
      const addWindow = (wallId: string, centre: number, span: number, width: number, label: string) => {
        const w = Math.min(width, span - 600);
        if (w < 450) return;
        model.openings.push({ id: ctx.newId('win'), label, wallId, kind: 'window', offset: Math.round(centre), width: Math.round(w), height: label.includes('ventilator') ? 600 : 1500, swingSide: 'left', hinge: 'start' });
      };
      /**
       * One ventilator per toilet: on its short outer wall if it has one (the WC goes under it);
       * on a long wall it goes to the corner away from the door, so the WC sits in that corner
       * rather than in the middle of the toilet.
       */
      const toiletVentilator = (lr: Rect & { name: string }) => {
        const room = made.get(lr.name)!;
        const door = model.openings.find((o) => o.wallId.startsWith(`blk:${room.id}:`) && o.kind === 'door');
        const doorPt = door ? pointOnWall(getWall(model, door.wallId), door.offset) : undefined;
        const cands: { w: (typeof ext)[number]; h: boolean; lo: number; hi: number; long: boolean }[] = [];
        for (const w of ext) {
          const h = Math.abs(w.a.y - w.b.y) < 1;
          const onIt = h ? Math.abs(w.a.y - lr.y0) < 3 || Math.abs(w.a.y - lr.y1) < 3 : Math.abs(w.a.x - lr.x0) < 3 || Math.abs(w.a.x - lr.x1) < 3;
          if (!onIt) continue;
          const [lo, hi] = h ? [Math.max(lr.x0, Math.min(w.a.x, w.b.x)), Math.min(lr.x1, Math.max(w.a.x, w.b.x))] : [Math.max(lr.y0, Math.min(w.a.y, w.b.y)), Math.min(lr.y1, Math.max(w.a.y, w.b.y))];
          if (hi - lo < 900) continue;
          const other = h ? lr.y1 - lr.y0 : lr.x1 - lr.x0;
          cands.push({ w, h, lo, hi, long: hi - lo > other + 1 });
        }
        const c = cands.sort((a, b) => Number(a.long) - Number(b.long))[0];
        if (!c) return;
        const a = c.h ? c.w.a.x : c.w.a.y;
        const dir = Math.sign((c.h ? c.w.b.x : c.w.b.y) - a) || 1;
        let centre = (c.lo + c.hi) / 2;
        if (c.long) {
          const edge = 115 / 2 + 150 + 300; // clear of the corner, ventilator half-width
          const ends = [c.lo + edge, c.hi - edge];
          const d = doorPt ? (c.h ? doorPt.x : doorPt.y) : c.lo;
          centre = Math.abs(ends[0]! - d) >= Math.abs(ends[1]! - d) ? ends[0]! : ends[1]!;
        }
        addWindow(c.w.id, (centre - a) * dir, c.hi - c.lo, 600, `${lr.name} ventilator`);
      };
      const windowsFor = (r: Rect, label: string, width: number) => {
        for (const w of ext) {
          const h = Math.abs(w.a.y - w.b.y) < 1;
          const onIt = h ? (Math.abs(w.a.y - r.y0) < 3 || Math.abs(w.a.y - r.y1) < 3) : Math.abs(w.a.x - r.x0) < 3 || Math.abs(w.a.x - r.x1) < 3;
          if (!onIt) continue;
          const [lo, hi] = h ? [Math.max(r.x0, Math.min(w.a.x, w.b.x)), Math.min(r.x1, Math.max(w.a.x, w.b.x))] : [Math.max(r.y0, Math.min(w.a.y, w.b.y)), Math.min(r.y1, Math.max(w.a.y, w.b.y))];
          if (hi - lo < 900) continue;
          const a = h ? w.a.x : w.a.y;
          const dir = Math.sign((h ? w.b.x : w.b.y) - a) || 1;
          addWindow(w.id, ((lo + hi) / 2 - a) * dir, hi - lo, width, label);
        }
      };
      for (const lr of args.rooms) {
        if (lr.kind === 'toilet') {
          toiletVentilator(lr);
          continue;
        }
        const width = lr.kind === 'bedroom' ? 1500 : lr.kind === 'kitchen' ? 1200 : lr.kind === 'service' ? 1200 : 0;
        if (width) windowsFor(lr, `${lr.name} window`, width);
      }
      for (const z of args.zones) if (/living|dining|hall/i.test(z.name) && Math.min(z.x1 - z.x0, z.y1 - z.y0) > 2400) windowsFor(z, `${z.name} window`, 1800);
      // Service area: its own door from outside when the brief asks for it.
      if (args.serviceDoor) {
        for (const lr of args.rooms.filter((r) => r.kind === 'service')) {
          const room = made.get(lr.name)!;
          for (const side of ['top', 'bottom', 'left', 'right'] as const) {
            const wall = fixedWallUnder(model, room, side);
            if (wall?.kind !== 'external') continue;
            const h = side === 'top' || side === 'bottom';
            const span = h ? lr.x1 - lr.x0 : lr.y1 - lr.y0;
            if (span < 1300) continue;
            const a = h ? wall.a.x : wall.a.y;
            const dir = Math.sign((h ? wall.b.x : wall.b.y) - a) || 1;
            const centre = h ? (lr.x0 + lr.x1) / 2 : (lr.y0 + lr.y1) / 2;
            model.openings = model.openings.filter((o) => !(o.wallId === wall.id && Math.abs(o.offset - (centre - a) * dir) < 1200));
            const o: Opening = { id: ctx.newId('door'), label: 'Service door', wallId: wall.id, kind: 'door', offset: Math.round((centre - a) * dir), width: 900, height: 2100, swingSide: 'left', hinge: 'start' };
            model.openings.push(o);
            setSwingInto(model, o, room);
            break;
          }
        }
      }
      // Main door from outside into the entrance zone.
      if (args.entrance) {
        const en = args.entrance;
        const z = en.x0 !== undefined ? { x0: en.x0, y0: en.y0!, x1: en.x1!, y1: en.y1! } : args.zones.find((q) => q.name === en.zone);
        const side = args.entrance.side;
        const wall = ext.find((w) => {
          const h = Math.abs(w.a.y - w.b.y) < 1;
          if (!z) return false;
          if (side === 'bottom' || side === 'top') return h && Math.abs(w.a.y - (side === 'bottom' ? z.y1 : z.y0)) < 3;
          return !h && Math.abs(w.a.x - (side === 'right' ? z.x1 : z.x0)) < 3;
        });
        if (z && wall) {
          const h = side === 'bottom' || side === 'top';
          const centre = h ? (z.x0 + z.x1) / 2 : (z.y0 + z.y1) / 2;
          const a = h ? wall.a.x : wall.a.y;
          const dir = Math.sign((h ? wall.b.x : wall.b.y) - a) || 1;
          // Clear any window there first.
          model.openings = model.openings.filter((o) => !(o.wallId === wall.id && Math.abs(o.offset - (centre - a) * dir) < 1500));
          const o: Opening = { id: ctx.newId('door'), label: 'Main door', wallId: wall.id, kind: 'door', offset: Math.round((centre - a) * dir), width: 1050, height: 2100, swingSide: 'left', hinge: 'start' };
          model.openings.push(o);
          setSwingInto(model, o, host);
        }
      }
      Object.assign(model, fitOutAll(model));
      // Stand the stair and lift again: beside a lobby if the layout has one, else near the foyer / living area.
      if (keepCores.length) {
        const lobby = model.rooms.find((r) => r.kind === 'lobby' && r.block);
        const near = args.zones.find((z) => z.name === 'Foyer') ?? args.zones.find((z) => z.name === 'Living') ?? args.zones[0];
        const px = near ? (near.x0 + near.x1) / 2 : 0;
        const py = near ? (near.y0 + near.y1) / 2 : 0;
        for (const c of keepCores) {
          c.at = { x: 0, y: 0 };
          let placed = !!lobby && placeByLobby(model, c, lobby, px, py);
          if (!placed) {
            const t = c.enclosure?.thickness ?? 0;
            for (const rot of [c.rotation, (c.rotation + 90) % 360]) {
              const fp0 = coreFootprint({ ...c, rotation: rot, at: { x: 0, y: 0 } });
              const spot = freeSpots(model, host, fp0.x1 - fp0.x0 + 2 * t, fp0.y1 - fp0.y0 + 2 * t).sort((a, b) => Math.hypot((a.x0 + a.x1) / 2 - px, (a.y0 + a.y1) / 2 - py) - Math.hypot((b.x0 + b.x1) / 2 - px, (b.y0 + b.y1) / 2 - py))[0];
              if (spot) {
                c.rotation = rot;
                c.roomId = host.id;
                c.at = { x: Math.round((spot.x0 + spot.x1) / 2), y: Math.round((spot.y0 + spot.y1) / 2) };
                settleCore(model, c);
                placed = true;
                break;
              }
            }
          }
          if (placed) model.cores = [...coresOf(model), c];
          else ctx.note(`There's no free space for the ${c.label.toLowerCase()} in this layout; add it again where you want it.`);
        }
      }
      ctx.touch(...model.rooms.map((r) => r.id));
      const beds = args.rooms.filter((r) => r.kind === 'bedroom').length;
      const toilets = args.rooms.filter((r) => r.kind === 'toilet').length;
      ctx.summary = `Laid out ${beds} bedroom${beds === 1 ? '' : 's'}, ${toilets} toilet${toilets === 1 ? '' : 's'}, ${args.rooms.filter((r) => !['bedroom', 'toilet'].includes(r.kind)).map((r) => r.name.toLowerCase()).join(', ')} with ${[...new Set(args.zones.map((z) => z.name.toLowerCase()))].join(', ')} as open space.`;
      break;
    }

    case 'set_structure': {
      const st = { ...(model.structure ?? {}) };
      const said: string[] = [];
      if (args.floors !== undefined) {
        st.floors = args.floors;
        said.push(`columns carry ${args.floors === 1 ? 'the ground floor only' : `G+${args.floors - 1}`}`);
      }
      if (args.sbc !== undefined) {
        st.sbc = args.sbc;
        said.push(`soil bearing ${args.sbc} kN/m²`);
      }
      if (args.resetColumns) {
        delete st.moved;
        delete st.removed;
        said.push('columns back to the automatic layout');
      }
      const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 400 && Math.abs(a.y - b.y) < 400;
      if (args.moveColumn) {
        const { from, to } = args.moveColumn;
        const before = generateStructure(model).columns.find((c) => near(c, from));
        if (!before) throw new ModelError('There is no column there.');
        // Re-point an earlier move of the same column instead of stacking moves.
        const moved = (st.moved ?? []).filter((m) => !near(m.to, from));
        const origin = (st.moved ?? []).find((m) => near(m.to, from))?.from ?? from;
        moved.push({ from: { x: Math.round(origin.x), y: Math.round(origin.y) }, to: { x: Math.round(to.x), y: Math.round(to.y) } });
        st.moved = moved;
        const after = generateStructure({ ...model, structure: st })
          .columns.filter((c) => c.moved === 'Moved by you')
          .sort((a, b) => Math.hypot(a.x - to.x, a.y - to.y) - Math.hypot(b.x - to.x, b.y - to.y))[0];
        said.push(`moved column ${before.id}${after ? ` to grid ${after.grid}` : ''}`);
      }
      if (args.removeColumn) {
        const p = args.removeColumn;
        const c = generateStructure(model).columns.find((x) => near(x, p));
        if (!c) throw new ModelError('There is no column there.');
        // A column the user moved is removed at where it came from, and the move is forgotten.
        const mv = (st.moved ?? []).find((m) => near(m.to, c));
        const at = mv ? mv.from : { x: Math.round(c.x), y: Math.round(c.y) };
        st.removed = [...(st.removed ?? []), at];
        st.moved = (st.moved ?? []).filter((m) => m !== mv);
        said.push(`removed column ${c.id}`);
      }
      model.structure = st;
      ctx.touch('structure');
      ctx.summary = `Structure: ${said.join('; ') || 'no change'}.`;
      break;
    }

    case 'set_costing': {
      const c = { ...(model.costing ?? {}) };
      if (args.grades) c.grades = { ...(c.grades ?? {}), ...args.grades };
      if (args.rates) {
        const rates = { ...(c.rates ?? {}) };
        for (const [k, v] of Object.entries(args.rates)) {
          if (v === null || v === undefined) delete rates[k];
          else rates[k] = v as number;
        }
        c.rates = rates;
      }
      if (args.budget !== undefined) {
        if (args.budget === null) delete c.budget;
        else c.budget = args.budget;
      }
      if (args.contingencyPct !== undefined) c.contingencyPct = args.contingencyPct;
      for (const id of Object.keys({ ...(args.grades ?? {}), ...(args.rates ?? {}) })) if (!RATE_CARD.some((it) => it.id === id)) throw new ModelError(`There is no cost item "${id}".`);
      model.costing = c;
      ctx.touch('costing');
      const said: string[] = [];
      for (const [k, v] of Object.entries(args.grades ?? {})) {
        const it = RATE_CARD.find((x) => x.id === k)!;
        said.push(`${it.label}: ${it.grades[v as 'basic'].name}`);
      }
      for (const [k, v] of Object.entries(args.rates ?? {})) said.push(`${RATE_CARD.find((x) => x.id === k)!.label}: ${v === null ? 'grade rate' : `₹${Number(v).toLocaleString('en-IN')} per unit`}`);
      if (args.budget !== undefined) said.push(args.budget === null ? 'budget cleared' : `budget ₹${Number(args.budget).toLocaleString('en-IN')}`);
      if (args.contingencyPct !== undefined) said.push(`contingency ${args.contingencyPct}%`);
      ctx.summary = `Cost: ${said.join('; ') || 'no change'}.`;
      break;
    }

    case 'set_brief': {
      const parsed = BriefSchema.parse({ items: (args.items as unknown[]).map((i) => Object.fromEntries(Object.entries(i as object).filter(([, v]) => v !== undefined && v !== ''))) });
      for (const it of parsed.items) if (it.type === 'min_size') { parseLength(it.width); parseLength(it.depth); }
      model.brief = parsed as BuildingModel['brief'];
      ctx.touch('brief');
      ctx.summary = parsed.items.length ? `Brief set: ${parsed.items.map((i) => briefLabel(i).toLowerCase()).join('; ')}.` : 'Brief cleared.';
      break;
    }

    case 'rotate_room': {
      const room = getRoom(model, args.roomId);
      if (!room.block) throw new ModelError(`${room.name} is fixed by walls; it can't be turned.`);
      const turns = args.degrees === '180' ? 2 : args.degrees === '-90' ? 3 : 1;
      const was = roomClearRect(model, room);
      for (let i = 0; i < turns; i++) rotateBlock(model, room);
      clampBlockInside(model, room);
      snapBlock(model, room);
      // Keep the clear size exactly (just turned), whatever walls it now sits against.
      const [cw, ch] = turns % 2 ? [was.y1 - was.y0, was.x1 - was.x0] : [was.x1 - was.x0, was.y1 - was.y0];
      setBlockClearSize(model, room, Math.round(cw), Math.round(ch));
      rehomeDoors(model, room, ctx);
      // A turned toilet or kitchen is fitted out again to suit its new window and door.
      if (room.kind === 'toilet' || room.kind === 'kitchen') {
        model.furniture = model.furniture.filter((f) => !(f.roomId === room.id && getCatalogueItem(f.catalogueId)?.category === 'sanitary'));
        fitOutRoom(model, room);
      }
      for (const f of model.furniture) if (f.roomId === room.id) ctx.touch(f.id);
      for (const c of coresOf(model)) if (c.roomId === room.id) ctx.touch(c.id);
      ctx.touch(room.id);
      ctx.summary = `Turned ${room.name} ${args.degrees}°; it is now ${roomSizeText(model, room)}.`;
      break;
    }

    case 'place_room_against': {
      const room = getRoom(model, args.roomId);
      if (!room.block) throw new ModelError(`${room.name} is fixed by walls; it can't be moved.`);
      const b = room.block;
      const side = compassToSide(args.side as Compass, model.northAngle);
      const outer = args.targetId === 'outer';
      const target = outer ? undefined : getRoom(model, args.targetId);
      if (target && !target.block) throw new ModelError(`${target.name} is open space; put the room against an outer wall or another room instead.`);
      const t = target ? target.block! : shellAxisRect(model);
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      let x0 = b.x0;
      let y0 = b.y0;
      // Across: share the target's wall line on that side (inside the outer walls for "outer").
      if (outer) {
        if (side === 'top') y0 = t.y0;
        if (side === 'bottom') y0 = t.y1 - h;
        if (side === 'left') x0 = t.x0;
        if (side === 'right') x0 = t.x1 - w;
      } else {
        if (side === 'top') y0 = t.y0 - h;
        if (side === 'bottom') y0 = t.y1;
        if (side === 'left') x0 = t.x0 - w;
        if (side === 'right') x0 = t.x1;
      }
      // Along: line up an edge, centre, or keep.
      if (args.align && args.align !== 'keep') {
        const horizontalWall = side === 'top' || side === 'bottom';
        if (args.align === 'centre') {
          if (horizontalWall) x0 = Math.round((t.x0 + t.x1) / 2 - w / 2);
          else y0 = Math.round((t.y0 + t.y1) / 2 - h / 2);
        } else {
          const edge = compassToSide(args.align as Compass, model.northAngle);
          if (edge === 'left') x0 = t.x0;
          if (edge === 'right') x0 = t.x1 - w;
          if (edge === 'top') y0 = t.y0;
          if (edge === 'bottom') y0 = t.y1 - h;
        }
      }
      const size0 = roomClearRect(model, room);
      translateBlock(model, room, Math.round(x0 - b.x0), Math.round(y0 - b.y0));
      const clamped = clampBlockInside(model, room);
      keepClearSize(model, room, size0, { x: x0 - b.x0 + clamped.dx, y: y0 - b.y0 + clamped.dy });
      rehomeDoors(model, room, ctx);
      for (const f of model.furniture) if (f.roomId === room.id) ctx.touch(f.id);
      for (const c of coresOf(model)) if (c.roomId === room.id) ctx.touch(c.id);
      ctx.touch(room.id);
      const where = outer ? `against the ${args.side} outer wall` : `against ${target!.name}'s ${args.side} wall`;
      ctx.summary = `Moved ${room.name} ${where}${args.align && args.align !== 'keep' ? `, lined up ${args.align === 'centre' ? 'on its centre' : `on the ${args.align}`}` : ''}.`;
      if (clamped.dx || clamped.dy) ctx.note('It would have stuck out of the building, so it stops at the outer wall.');
      break;
    }

    case 'add_door_between': {
      const a = getRoom(model, args.roomA);
      const b = getRoom(model, args.roomB);
      const area = (r: Room) => {
        const c = roomClearRect(model, r);
        return (c.x1 - c.x0) * (c.y1 - c.y0);
      };
      const openA = !a.block && model.rooms.some((x) => x.block);
      const openB = !b.block && model.rooms.some((x) => x.block);
      // The room the door belongs to (and opens into): the smaller private room.
      const [own, other] = openA ? [b, a] : openB ? [a, b] : area(a) <= area(b) ? [a, b] : [b, a];
      let wallId: string | undefined;
      let span: [number, number] | undefined;
      if (!other.block || !own.block) {
        // Into the open space: a free side of the block.
        const blk = own.block ? own : other;
        const free = SIDES4.filter((sd) => !fixedWallUnder(model, blk, sd) && coincidentSides(model, blk, sd).length === 0);
        const r = roomClearRect(model, blk);
        const len = (sd: PlanSide4) => (sd === 'top' || sd === 'bottom' ? r.x1 - r.x0 : r.y1 - r.y0);
        const sd = [...free].sort((x, y) => len(y) - len(x))[0];
        if (!sd) throw new ModelError(`${blk.name} has no side open to ${(blk === own ? other : own).name}.`);
        wallId = blk.bounds[sd];
      } else {
        const sd = SIDES4.find((x) => coincidentSides(model, own, x).some((c) => c.room.id === other.id));
        if (!sd) throw new ModelError(`${a.name} and ${b.name} don't share a wall. Put one against the other first.`);
        wallId = own.bounds[sd];
        // Centre on the part of the wall both rooms share.
        const ra = roomClearRect(model, own);
        const rb = roomClearRect(model, other);
        const horizontal = sd === 'top' || sd === 'bottom';
        span = horizontal ? [Math.max(ra.x0, rb.x0), Math.min(ra.x1, rb.x1)] : [Math.max(ra.y0, rb.y0), Math.min(ra.y1, rb.y1)];
      }
      const wall = getWall(model, wallId);
      const width = args.width ? ctx.length(args.width) : own.kind === 'toilet' || other.kind === 'toilet' ? 762 : 914;
      const d = wallDir(wall);
      const along = (v: number) => (isHorizontal(wall) ? (v - wall.a.x) * Math.sign(d.x) : (v - wall.a.y) * Math.sign(d.y));
      const offset = span ? Math.round(along((span[0] + span[1]) / 2)) : Math.round(wallLength(wall) / 2);
      if (span && span[1] - span[0] < width + 2 * JAMB_MIN) throw new ModelError(`${a.name} and ${b.name} share only ${formatLength(Math.max(0, span[1] - span[0]), model.displayUnits)} of wall; not enough for a door.`);
      ctx.checkOpeningFits(wall, offset, width, `${own.name} door`);
      const o: Opening = {
        id: ctx.newId('door'),
        label: `${own.name} door${own.block && other.block ? ` from ${other.name}` : ''}`,
        wallId,
        kind: args.kind ?? 'door',
        offset,
        width,
        height: 2100,
        swingSide: 'left',
        hinge: 'start',
      };
      model.openings.push(o);
      setSwingInto(model, o, own);
      // Slide it along the shared wall (and try the other hinge) to keep the swing clear of fixtures and furniture.
      {
        const clear = () => {
          const sw = doorSwingRect(model, o);
          return model.furniture.every((f) => !rectsOverlap(sw, itemFootprint(f), 5));
        };
        if (!clear()) {
          const lo = span ? along(span[0]) + width / 2 + JAMB_MIN : JAMB_MIN + width / 2;
          const hi = span ? along(span[1]) - width / 2 - JAMB_MIN : wallLength(wall) - JAMB_MIN - width / 2;
          const tries: number[] = [];
          for (let k = 1; k * 75 <= Math.abs(hi - lo) + 75; k++) tries.push(offset - k * 75, offset + k * 75);
          let found = false;
          for (const at of tries) {
            if (at < Math.min(lo, hi) || at > Math.max(lo, hi)) continue;
            for (const hinge of ['start', 'end'] as const) {
              o.offset = Math.round(at);
              o.hinge = hinge;
              if (clear()) {
                found = true;
                break;
              }
            }
            if (found) break;
          }
          if (!found) {
            o.offset = offset;
            o.hinge = 'start';
            // Fixtures may be laid out again below.
          }
        }
      }
      // A toilet now reached from a bedroom no longer needs its door to the open living area.
      let droppedLiving = false;
      if (own.kind === 'toilet' && other.kind === 'bedroom') {
        const dropped = model.openings.filter((x) => x.id !== o.id && x.kind === 'door' && parseBlockWallId(x.wallId)?.roomId === own.id && !SIDES4.some((sd) => x.wallId === own.bounds[sd] && coincidentSides(model, own, sd).length > 0));
        if (dropped.length) {
          model.openings = model.openings.filter((x) => !dropped.includes(x));
          ctx.note(`Removed ${own.name}'s door to the living area, since it is now attached to ${other.name}. Undo to keep both.`);
          droppedLiving = true;
        }
      }
      // Still clashing: lay the toilet or kitchen fixtures out again around the new door.
      {
        const sw = doorSwingRect(model, o);
        const clash = model.furniture.some((f) => f.roomId === own.id && rectsOverlap(sw, itemFootprint(f), 5));
        const fixtures = model.furniture.filter((f) => f.roomId === own.id && getCatalogueItem(f.catalogueId)?.category === 'sanitary');
        if (clash && fixtures.length) {
          model.furniture = model.furniture.filter((f) => !fixtures.includes(f));
          const placed = fitOutRoom(model, own);
          if (placed.length) {
            placed.forEach((f) => ctx.touch(f.id));
            ctx.note(`Rearranged the fixtures in ${own.name} to clear the new door.`);
          } else {
            model.furniture.push(...fixtures);
          }
        }
      }
      void droppedLiving;
      ctx.touch(o.id, own.id, other.id);
      ctx.summary = `Added a ${formatLength(width, model.displayUnits)} door between ${a.name} and ${b.name}, opening into ${own.name}.`;
      break;
    }

    case 'edit_door': {
      const o = ctx.opening(args.openingId);
      const bits: string[] = [];
      if (args.opensInto) {
        const r = getRoom(model, args.opensInto);
        setSwingInto(model, o, r);
        bits.push(`opens into ${r.name}`);
      }
      if (args.flipHinge) {
        o.hinge = o.hinge === 'start' ? 'end' : 'start';
        bits.push('hinged on the other side');
      }
      if (args.width) {
        const w = ctx.length(args.width);
        ctx.checkOpeningFits(getWall(model, o.wallId), o.offset, w, o.label);
        o.width = w;
        bits.push(`${formatLength(w, model.displayUnits)} wide`);
      }
      if (!bits.length) throw new ModelError('Say what to change: which room it opens into, the hinge side, or the width.');
      ctx.touch(o.id);
      ctx.summary = `${o.label} now ${bits.join(', ')}.`;
      break;
    }

    case 'set_room_size': {
      const room = getRoom(model, args.roomId);
      if (!room.block) throw new ModelError(`${room.name} isn't a room block; move its walls to resize it.`);
      const u = model.displayUnits;
      setBlockClearSize(model, room, args.width ? ctx.length(args.width) : undefined, args.depth ? ctx.length(args.depth) : undefined);
      const pulled = clampBlockInside(model, room);
      if (pulled.dx || pulled.dy) ctx.note('Shifted to stay inside the outer walls.');
      // Keep furniture and fixtures inside.
      const nr = roomClearRect(model, room);
      for (const f of model.furniture) {
        if (f.roomId !== room.id) continue;
        const fr = itemFootprint(f);
        const hw = (fr.x1 - fr.x0) / 2;
        const hh = (fr.y1 - fr.y0) / 2;
        f.at = { x: Math.round(Math.min(Math.max(f.at.x, nr.x0 + hw), nr.x1 - hw)), y: Math.round(Math.min(Math.max(f.at.y, nr.y0 + hh), nr.y1 - hh)) };
        ctx.touch(f.id);
      }
      ctx.touch(room.id);
      ctx.summary = `${room.name} is now ${roomSizeText(model, room)} (clear).`;
      if (!args.width && !args.depth) throw new ModelError(`Give a width or depth for ${room.name}.`);
      void u;
      break;
    }

    case 'remove_room': {
      const room = getRoom(model, args.roomId);
      if (!room.block) throw new ModelError(`${room.name} is fixed by walls or is the open space; it can't be removed.`);
      const gone = new Set(SIDES4.map((sd) => room.bounds[sd]));
      // Its own windows on the outer walls go too.
      const own = new Set(SIDES4.flatMap((sd) => (fixedWallUnder(model, room, sd) ? roomOpeningsOn(model, room, sd) : [])).filter((o) => o.label.startsWith(`${room.name} `)).map((o) => o.id));
      model.openings = model.openings.filter((o) => !gone.has(o.wallId) && !own.has(o.id));
      model.furniture = model.furniture.filter((f) => f.roomId !== room.id);
      model.rooms = model.rooms.filter((r) => r.id !== room.id);
      for (const c of coresOf(model)) if (c.roomId === room.id) settleCore(model, c);
      ctx.touch(room.id);
      ctx.summary = `Removed ${room.name}; its space is open again.`;
      break;
    }

    case 'fit_out': {
      const room = getRoom(model, args.roomId);
      const items = fitOutRoom(model, room);
      if (items.length === 0) throw new ModelError(`${room.name} already has fixtures, or there's no free wall for them.`);
      ctx.touch(room.id, ...items.map((f) => f.id));
      ctx.summary = `Fitted out ${room.name}: ${items.map((f) => f.label.toLowerCase()).join(', ')}.`;
      ctx.note('Each fixture can be dragged, turned or removed like furniture.');
      break;
    }

    case 'set_room_use': {
      const room = getRoom(model, args.roomId);
      const before = room.name;
      room.name = args.name;
      room.kind = args.kind as Room['kind'];
      room.wet = room.kind === 'toilet' || room.kind === 'kitchen' || room.kind === 'service';
      for (const o of model.openings) {
        if (o.label.startsWith(`${before} `)) {
          o.label = `${args.name}${o.label.slice(before.length)}`;
          ctx.touch(o.id);
        }
      }
      ctx.touch(room.id);
      ctx.summary = `${before} is now ${args.name}.`;
      break;
    }

    case 'add_toilet': {
      const room = getRoom(model, args.roomId);
      const length = args.length ? ctx.length(args.length) : 2134;
      if (!room.block && model.rooms.some((x) => x.block)) {
        // Open space: a common toilet block against an outer wall.
        const width = args.width ? ctx.length(args.width) : 1524;
        const name = uniqueName(model, `Toilet ${model.rooms.filter((x) => x.kind === 'toilet').length + 1}`);
        const t = placeFreeBlock(model, ctx, room, width, length, name, 'toilet');
        addBlockDoorAndVent(model, ctx, t);
        fitOutRoom(model, model.rooms.find((x) => x.id === t.id)!).forEach((f) => ctx.touch(f.id));
        ctx.touch(t.id);
        ctx.summary = `Added ${name} off ${room.name}: ${roomSizeText(model, t)}.`;
        ctx.note('Placed against an outer wall in free space; drag it where you want it.');
        break;
      }
      const widths = args.width ? [ctx.length(args.width)] : [1524, 1372, 1220];
      let r: ReturnType<typeof attachToilet> | undefined;
      let last: unknown;
      for (const w of widths) {
        try {
          r = attachToilet(model, room, w, length);
          break;
        } catch (err) {
          last = err;
        }
      }
      if (!r && room.block && args.beside !== false) {
        // Too small to give up space: a new toilet block beside it, sharing a wall, with a door between.
        const t = attachToiletBlock(model, ctx, room, args.width ? ctx.length(args.width) : 1524, length);
        if (t) {
          ctx.summary = `Added ${t.name} beside ${room.name}, sharing a wall, with a door from ${room.name}: ${roomSizeText(model, t)}.`;
          break;
        }
      }
      if (!r) throw last;
      Object.assign(model, r.model);
      const added = model.rooms.find((x) => x.kind === 'toilet' && r!.changed.includes(x.id) && !input.rooms.some((y) => y.id === x.id));
      if (added) fitOutRoom(model, added).forEach((f) => r!.changed.push(f.id));
      ctx.touch(...r.changed);
      ctx.summary = r.summary;
      r.notes.forEach((n) => ctx.note(n));
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
    const blocked = (r: Rect) => blockOuterRects(this.model, room.id).some((b) => rectsOverlap(b, r, 5));
    if (corner) {
      placeInCorner(this.model, c, room, corner);
      if (!blocked(enclosureOf(this.model, c).outer)) return;
    }
    let last: unknown;
    for (const k of CORNERS) {
      try {
        placeInCorner(this.model, c, room, k);
        const outer = enclosureOf(this.model, c).outer;
        const others = coresOf(this.model).filter((o) => o.id !== c.id);
        if (others.every((o) => !rectsOverlap(enclosureOf(this.model, o).outer, outer, 5)) && !blocked(outer)) return;
      } catch (err) {
        last = err;
      }
    }
    // Open space with room blocks in its corners: find a free spot against a wall.
    const t = c.enclosure?.thickness ?? 0;
    for (const rot of [c.rotation, (c.rotation + 90) % 360]) {
      c.rotation = rot;
      const fp = coreFootprint({ ...c, at: { x: 0, y: 0 } });
      const spot = freeSpots(this.model, room, fp.x1 - fp.x0 + 2 * t, fp.y1 - fp.y0 + 2 * t)[0];
      if (!spot) continue;
      c.roomId = room.id;
      c.at = { x: Math.round((spot.x0 + spot.x1) / 2), y: Math.round((spot.y0 + spot.y1) / 2) };
      settleCore(this.model, c);
      return;
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
    const v = parseBlockWallId(wall.id);
    if (v) {
      // A block's side: resize it, and any block sharing that line moves its side too.
      const room = getRoom(this.model, v.roomId);
      const partners = coincidentSides(this.model, room, v.side);
      resizeBlockSide(this.model, room, v.side, delta);
      this.touch(room.id, wall.id);
      for (const p of partners) {
        resizeBlockSide(this.model, p.room, p.side, delta);
        this.touch(p.room.id);
      }
      return;
    }
    // Room blocks lying on this wall keep to it.
    const riders = this.model.rooms.flatMap((r) => (r.block ? SIDES4.filter((sd) => fixedWallUnder(this.model, r, sd)?.id === wall.id).map((sd) => ({ r, sd })) : []));
    this.moveFixedWall(wall, delta);
    // A room against this wall moves with it (keeping its size), unless it spans to the opposite wall too.
    const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const;
    for (const { r, sd } of riders) {
      const spans = !!fixedWallUnder(this.model, r, opposite[sd]);
      if (spans) resizeBlockSide(this.model, r, sd, delta);
      else translateBlock(this.model, r, sd === 'left' || sd === 'right' ? delta : 0, sd === 'top' || sd === 'bottom' ? delta : 0);
      for (const f of this.model.furniture) if (f.roomId === r.id) this.touch(f.id);
      this.touch(r.id);
    }
  }

  private moveFixedWall(wall: Wall, delta: number) {
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
  for (const r of model.rooms) {
    if (r.block) r.block = { ...r.block, x0: X(r.block.x0), x1: X(r.block.x1), y0: Y(r.block.y0), y1: Y(r.block.y1) };
  }
  for (const o of model.openings) {
    const w = getWall(model, o.wallId);
    const s = (horizontalBefore.get(w.id) ?? isHorizontal(w)) ? sx : sy;
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
  replaceClashingCores(model, ctx);

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
 * After a resize, a stair or lift that now clashes with another or no longer
 * fits its room is put in a free corner of its room, else of the living room.
 */
function replaceClashingCores(model: BuildingModel, ctx: Ctx) {
  const cores = coresOf(model);
  cores.forEach((c, i) => {
    const room = model.rooms.find((r) => r.id === c.roomId);
    if (!room) return;
    const rr = roomClearRect(model, room);
    const outer = enclosureOf(model, c).outer;
    const outside = outer.x0 < rr.x0 - 5 || outer.x1 > rr.x1 + 5 || outer.y0 < rr.y0 - 5 || outer.y1 > rr.y1 + 5;
    const clash = cores.slice(0, i).some((d) => rectsOverlap(outer, enclosureOf(model, d).outer, 5));
    if (!outside && !clash) return;
    const saved = { at: c.at, rotation: c.rotation, roomId: c.roomId };
    const others = model.rooms.filter((r) => r.id !== room.id && (r.kind === 'living' || r.kind === 'lobby'));
    for (const target of [room, ...others]) {
      try {
        ctx.placeCore(c, target);
        const ok = cores.slice(0, i).every((d) => !rectsOverlap(enclosureOf(model, c).outer, enclosureOf(model, d).outer, 5));
        if (!ok) throw new ModelError('clash');
        ctx.touch(c.id);
        if (target.id !== room.id) ctx.note(`The ${c.label.toLowerCase()} didn't fit ${room.name} at this size; put in ${target.name}. Drag it where you want it.`);
        return;
      } catch {
        Object.assign(c, saved);
      }
    }
  });
}

const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const;
const SIDES4 = ['top', 'bottom', 'left', 'right'] as const;

function uniqueName(m: BuildingModel, base: string): string {
  const used = new Set(m.rooms.map((r) => r.name));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}


/** Make a door's leaf swing into a room (the side of the wall the room's centre is on). */
function setSwingInto(model: BuildingModel, o: Opening, room: Room) {
  const wall = getWall(model, o.wallId);
  const d = wallDir(wall);
  const p = pointOnWall(wall, o.offset);
  // On a block's own wall: into that block, or away from it for any other room.
  const owner = parseBlockWallId(o.wallId);
  const ref = owner ? model.rooms.find((r) => r.id === owner.roomId)! : room;
  const c = roomClearRect(model, ref);
  const sign = owner && owner.roomId !== room.id ? -1 : 1;
  const toRoom = { x: ((c.x0 + c.x1) / 2 - p.x) * sign, y: ((c.y0 + c.y1) / 2 - p.y) * sign };
  // Same normal the plan drawing uses for swingSide 'left'.
  const nLeft = { x: d.y, y: -d.x };
  o.swingSide = toRoom.x * nLeft.x + toRoom.y * nLeft.y > 0 ? 'left' : 'right';
}

/** After a room block moves or turns: a door of its own now on an outer wall moves to a side facing into the building. */
function rehomeDoors(model: BuildingModel, room: Room, ctx: Ctx) {
  const free = SIDES4.filter((sd) => !fixedWallUnder(model, room, sd) && coincidentSides(model, room, sd).length === 0);
  for (const o of model.openings) {
    const p = parseBlockWallId(o.wallId);
    if (p?.roomId !== room.id || o.kind === 'window' || /main/i.test(o.label)) continue;
    const f = fixedWallUnder(model, room, p.side);
    if (!f || f.kind !== 'external') continue;
    const r = roomClearRect(model, room);
    const len = (sd: PlanSide4) => (sd === 'top' || sd === 'bottom' ? r.x1 - r.x0 : r.y1 - r.y0);
    const to = [...free].sort((a, b) => len(b) - len(a))[0];
    if (!to) continue;
    o.wallId = room.bounds[to];
    const [s0, s1] = ctx.roomSpanAlongWall(room, getWall(model, o.wallId));
    o.offset = Math.round((s0 + s1) / 2);
    setSwingInto(model, o, room);
    ctx.touch(o.id);
    ctx.note(`${o.label} moved to the ${planSideCompass(to, model.northAngle)} side, since its wall is now an outer wall.`);
  }
}

/**
 * Room-block designs: make the outer walls fill the buildable area. Rooms keep
 * their sizes; rooms against an outer wall move with it; anything that would
 * end up outside is pulled back in. The building sits in the buildable area.
 */
function fitShell(model: BuildingModel, ctx: Ctx): { before: Rect; after: Rect } {
  const site = ctx.site();
  const b = buildableRect(site);
  const before = buildingOuterRect(model);
  const W = b.x1 - b.x0;
  const H = b.y1 - b.y0;
  if (W < 3000 || H < 3000) throw new ModelError('The setbacks leave too little room to build; reduce them or enlarge the plot.');
  const ext = model.walls.filter((w) => w.kind === 'external');
  const vertical = ext.filter((w) => Math.abs(w.a.x - w.b.x) < 1);
  const horizontal = ext.filter((w) => Math.abs(w.a.y - w.b.y) < 1);
  const east = [...vertical].sort((p, q) => q.a.x - p.a.x)[0];
  const south = [...horizontal].sort((p, q) => q.a.y - p.a.y)[0];
  if (!east || !south) throw new ModelError('The outer walls could not be found.');
  const dW = Math.round(W - (before.x1 - before.x0));
  const dH = Math.round(H - (before.y1 - before.y0));
  if (dW) ctx.moveWall(east, dW);
  if (dH) ctx.moveWall(south, dH);
  // Rooms now sticking out come back in; stairs and lifts too.
  for (const r of model.rooms) {
    if (!r.block) continue;
    const pulled = clampBlockInside(model, r);
    if (pulled.dx || pulled.dy) {
      ctx.touch(r.id);
      ctx.note(`${r.name} moved in to stay inside the smaller building.`);
    }
  }
  for (const c of coresOf(model)) {
    const room = model.rooms.find((r) => r.id === c.roomId);
    if (!room) continue;
    const rr = roomClearRect(model, room);
    const fp = coreFootprint(c);
    const dx = fp.x1 > rr.x1 ? rr.x1 - fp.x1 : fp.x0 < rr.x0 ? rr.x0 - fp.x0 : 0;
    const dy = fp.y1 > rr.y1 ? rr.y1 - fp.y1 : fp.y0 < rr.y0 ? rr.y0 - fp.y0 : 0;
    if (dx || dy) {
      c.at = { x: Math.round(c.at.x + dx), y: Math.round(c.at.y + dy) };
      ctx.touch(c.id);
    }
  }
  const after = buildingOuterRect(model);
  const f = footprintOnPlot(model, site);
  site.buildingOffset = { x: Math.round(site.buildingOffset.x + b.x0 - f.x0), y: Math.round(site.buildingOffset.y + b.y0 - f.y0) };
  for (const w of model.walls) ctx.touch(w.id);
  ctx.touch('site');
  return { before, after };
}

/** After a plot or setback change: block designs follow it at once; older layouts are told how. */
function followSite(model: BuildingModel, ctx: Ctx) {
  const u = model.displayUnits;
  if (model.rooms.some((r) => r.block) || model.walls.every((w) => w.kind === 'external')) {
    const { before, after } = fitShell(model, ctx);
    const same = Math.abs(after.x1 - after.x0 - (before.x1 - before.x0)) < 1 && Math.abs(after.y1 - after.y0 - (before.y1 - before.y0)) < 1;
    if (!same) {
      ctx.note(`Outer walls now ${formatLength(after.x1 - after.x0, u)} × ${formatLength(after.y1 - after.y0, u)} (were ${formatLength(before.x1 - before.x0, u)} × ${formatLength(before.y1 - before.y0, u)}), filling the buildable area. Rooms kept their sizes.`);
    }
    return;
  }
  ctx.note('This layout has fixed walls, so it was not resized. Use "Fit layout to plinth" to resize it to the new buildable area.');
}

/** A moved room keeps its clear size even when a side lands on (or leaves) a thicker outer wall. */
function keepClearSize(model: BuildingModel, room: Room, size: Rect, moved: { x: number; y: number }) {
  // The side trailing the move gives; the leading side stays where it was put.
  for (let i = 0; i < 3; i++) {
    const now = roomClearRect(model, room);
    for (const axis of ['x', 'y'] as const) {
      const want = axis === 'x' ? size.x1 - size.x0 : size.y1 - size.y0;
      const have = axis === 'x' ? now.x1 - now.x0 : now.y1 - now.y0;
      const delta = Math.round(want - have);
      if (Math.abs(delta) < 1) continue;
      const [lo, hi] = axis === 'x' ? (['left', 'right'] as const) : (['top', 'bottom'] as const);
      const m = moved[axis];
      if (m > 0) resizeBlockSide(model, room, lo, -delta);
      else if (m < 0) resizeBlockSide(model, room, hi, delta);
      else setBlockClearSize(model, room, axis === 'x' ? Math.round(want) : undefined, axis === 'y' ? Math.round(want) : undefined);
    }
  }
}

/**
 * A new toilet block in the open space right against a room block: along one of
 * its free sides (not an outer wall, no other room there, clear of its doors),
 * inside the building and clear of other rooms, stairs and lifts. Prefers a spot
 * on an outer wall (ventilator, pipes). Adds the connecting door and fixtures.
 */
function attachToiletBlock(model: BuildingModel, ctx: Ctx, room: Room, tw: number, tl: number): Room | undefined {
  const T = 115;
  const b = room.block!;
  const shell = shellAxisRect(model);
  const others = model.rooms.filter((r) => r.block && r.id !== room.id).map((r) => {
    const o = r.block!;
    return { x0: o.x0, x1: o.x1, y0: o.y0, y1: o.y1 };
  });
  const coreRects = [...coresOf(model).map((c) => enclosureOf(model, c).outer), ...model.furniture.filter((f) => f.roomId !== room.id).map((f) => itemFootprint(f))];
  const doorsOfRoom = SIDES4.flatMap((sd) => roomOpeningsOn(model, room, sd).filter((o) => o.kind !== 'window').map((o) => ({ sd, p: pointOnWall(getWall(model, o.wallId), o.offset), w: o.width })));
  type Opt = { rect: Rect; score: number };
  const opts: Opt[] = [];
  for (const sd of SIDES4) {
    if (fixedWallUnder(model, room, sd) || coincidentSides(model, room, sd).length) continue;
    const horizontal = sd === 'top' || sd === 'bottom';
    for (const [along, across] of [[tl, tw], [tw, tl]] as const) {
      const ax = along + T; // axis extents (clear + one wall)
      const ac = across + T;
      const span = horizontal ? [b.x0, b.x1] : [b.y0, b.y1];
      for (const pos of [span[0]!, span[1]! - ax, (span[0]! + span[1]! - ax) / 2]) {
        const rect = horizontal
          ? { x0: pos, x1: pos + ax, y0: sd === 'top' ? b.y0 - ac : b.y1, y1: sd === 'top' ? b.y0 : b.y1 + ac }
          : { x0: sd === 'left' ? b.x0 - ac : b.x1, x1: sd === 'left' ? b.x0 : b.x1 + ac, y0: pos, y1: pos + ax };
        if (rect.x0 < shell.x0 - 1 || rect.x1 > shell.x1 + 1 || rect.y0 < shell.y0 - 1 || rect.y1 > shell.y1 + 1) continue;
        if (others.some((o) => rectsOverlap(o, rect, 5))) continue;
        if (coreRects.some((o) => rectsOverlap(o, rect, 5))) continue;
        // Don't wall up the room's own door on that side.
        if (doorsOfRoom.some((d) => d.sd === sd && (horizontal ? d.p.x + d.w / 2 > rect.x0 && d.p.x - d.w / 2 < rect.x1 : d.p.y + d.w / 2 > rect.y0 && d.p.y - d.w / 2 < rect.y1))) continue;
        const outer = Number(Math.abs(rect.x0 - shell.x0) < 2) + Number(Math.abs(rect.x1 - shell.x1) < 2) + Number(Math.abs(rect.y0 - shell.y0) < 2) + Number(Math.abs(rect.y1 - shell.y1) < 2);
        opts.push({ rect, score: outer * 10 - (pos === span[0] || pos === span[1]! - ax ? 0 : 1) });
      }
    }
  }
  const pick = opts.sort((a, c) => c.score - a.score)[0];
  if (!pick) return undefined;
  const name = uniqueName(model, `Toilet ${model.rooms.filter((r) => r.kind === 'toilet').length + 1}`);
  const t: Room = { id: ctx.newId('r'), name, kind: 'toilet', wet: true, bounds: blockBounds('x'), block: { ...pick.rect, thickness: T } };
  t.bounds = blockBounds(t.id);
  model.rooms.push(t);
  const withDoor = applyOperation(model, parseOp('add_door_between', { roomA: room.id, roomB: t.id }));
  Object.assign(model, withDoor.model);
  addBlockDoorAndVent(model, ctx, model.rooms.find((x) => x.id === t.id)!);
  // addBlockDoorAndVent adds a door to the open space too; an attached toilet doesn't need it.
  model.openings = model.openings.filter((o) => !(o.label === `${name} door` && parseBlockWallId(o.wallId)?.roomId === t.id));
  fitOutRoom(model, model.rooms.find((x) => x.id === t.id)!).forEach((f) => ctx.touch(f.id));
  ctx.touch(t.id, room.id);
  return model.rooms.find((x) => x.id === t.id);
}

/** Standard clear sizes for new room blocks. */
const ROOM_DEFAULTS: Partial<Record<Room['kind'], { w: number; h: number }>> = {
  bedroom: { w: 3353, h: 3658 }, // 11' × 12'
  toilet: { w: 1524, h: 2438 }, // 5' × 8'
  kitchen: { w: 2743, h: 3048 }, // 9' × 10'
  lobby: { w: 2438, h: 3048 }, // 8' × 10'
  pooja: { w: 1219, h: 1524 }, // 4' × 5'
  service: { w: 1524, h: 2438 },
  balcony: { w: 1219, h: 3048 },
  dining: { w: 3048, h: 3658 },
  other: { w: 1524, h: 1829 }, // store 5' × 6'
};

function defaultRoomName(model: BuildingModel, kind: Room['kind']): string {
  const count = (k: Room['kind']) => model.rooms.filter((r) => r.kind === k).length + 1;
  const base: Partial<Record<Room['kind'], string>> = {
    bedroom: `Bed ${count('bedroom')}`,
    toilet: `Toilet ${count('toilet')}`,
    kitchen: 'Kitchen',
    lobby: 'Lobby',
    pooja: 'Pooja',
    service: 'Utility',
    balcony: 'Balcony',
    dining: 'Dining',
    other: 'Store',
  };
  return uniqueName(model, base[kind] ?? 'Room');
}

/** The room at a plan point: a block if one is there, else the room around it. */
function roomAtPoint(model: BuildingModel, x?: number, y?: number): Room {
  if (x === undefined || y === undefined) throw new ModelError('Say which room, or where to put it.');
  const hits = model.rooms.filter((r) => {
    const c = roomClearRect(model, r);
    return x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1;
  });
  const room = hits.find((r) => r.block) ?? hits[0];
  if (!room) throw new ModelError('That point is outside the building.');
  return room;
}

/**
 * Stand a stair or lift in the open space against a lobby, its entry facing
 * the lobby: on the lobby side nearest (x, y) first, then the others. False if
 * there's no room around the lobby.
 */
function placeByLobby(model: BuildingModel, c: CoreElement, lobby: Room, x: number, y: number): boolean {
  const open = model.rooms.find((r) => !r.block && (r.kind === 'living' || r.kind === 'dining'));
  if (!open || !lobby.block) return false;
  const lb = lobby.block;
  const t = c.enclosure?.thickness ?? 0;
  const area = roomClearRect(model, open);
  // Door leaves sweep a square in front of the door, both ways (kept clear for the lobby's own door too).
  const swings = model.openings
    .filter((o) => o.kind === 'door' || o.kind === 'opening')
    .map((o) => {
      const w = getWall(model, o.wallId);
      const pt = pointOnWall(w, o.offset);
      const along = o.width / 2 + 50;
      const deep = o.width + w.thickness / 2 + 10;
      return Math.abs(w.a.y - w.b.y) < 1 ? { x0: pt.x - along, x1: pt.x + along, y0: pt.y - deep, y1: pt.y + deep } : { x0: pt.x - deep, x1: pt.x + deep, y0: pt.y - along, y1: pt.y + along };
    });
  const taken = [...blockOuterRects(model), ...swings, ...coresOf(model).filter((o) => o.id !== c.id).map((o) => { const f = coreFootprint(o); const ot = o.enclosure?.thickness ?? 0; return { x0: f.x0 - ot, x1: f.x1 + ot, y0: f.y0 - ot, y1: f.y1 + ot }; })];
  // Rotation that turns the entry towards the lobby, for the core on each side of it.
  const sides: { side: PlanSide4; rot: number }[] = [
    { side: 'top', rot: 0 },
    { side: 'bottom', rot: 180 },
    { side: 'left', rot: 270 },
    { side: 'right', rot: 90 },
  ];
  const cx = (lb.x0 + lb.x1) / 2;
  const cy = (lb.y0 + lb.y1) / 2;
  sides.sort((a, b) => {
    const d = (s: PlanSide4) => (s === 'top' ? Math.abs(y - lb.y0) : s === 'bottom' ? Math.abs(y - lb.y1) : s === 'left' ? Math.abs(x - lb.x0) : Math.abs(x - lb.x1));
    return d(a.side) - d(b.side);
  });
  for (const { side, rot } of sides) {
    const fp = coreFootprint({ ...c, rotation: rot, at: { x: 0, y: 0 } });
    const w = fp.x1 - fp.x0;
    const h = fp.y1 - fp.y0;
    const half = lobby.block.thickness / 2;
    // Positions along the lobby side: the end nearer the drop point, the other end (leaving room
    // for the next unit), then the drop point itself and the middle.
    const horiz = side === 'top' || side === 'bottom';
    const ends = horiz ? [lb.x0 + half + t + w / 2, lb.x1 - half - t - w / 2] : [lb.y0 + half + t + h / 2, lb.y1 - half - t - h / 2];
    const p = horiz ? x : y;
    ends.sort((a, b) => Math.abs(a - p) - Math.abs(b - p));
    const along = [...ends, p, horiz ? cx : cy];
    for (const a of along) {
      const at =
        side === 'top' ? { x: a, y: lb.y0 - half - t - h / 2 } : side === 'bottom' ? { x: a, y: lb.y1 + half + t + h / 2 } : side === 'left' ? { x: lb.x0 - half - t - w / 2, y: a } : { x: lb.x1 + half + t + w / 2, y: a };
      // Close to an outer wall: sit flush against it (its own wall there isn't needed).
      if (horiz) {
        if (at.x + w / 2 > area.x1 - t - 1) at.x = area.x1 - w / 2;
        if (at.x - w / 2 < area.x0 + t + 1) at.x = area.x0 + w / 2;
      } else {
        if (at.y + h / 2 > area.y1 - t - 1) at.y = area.y1 - h / 2;
        if (at.y - h / 2 < area.y0 + t + 1) at.y = area.y0 + h / 2;
      }
      // The entry must face the lobby itself, so the core has to overlap the lobby along that side.
      const overlap = side === 'top' || side === 'bottom' ? Math.min(at.x + w / 2, lb.x1) - Math.max(at.x - w / 2, lb.x0) : Math.min(at.y + h / 2, lb.y1) - Math.max(at.y - h / 2, lb.y0);
      if (overlap < Math.min(w, h) * 0.6) continue;
      const flush = (v: number, edge: number) => Math.abs(v - edge) < 2;
      const outer = {
        x0: at.x - w / 2 - (flush(at.x - w / 2, area.x0) ? 0 : t),
        x1: at.x + w / 2 + (flush(at.x + w / 2, area.x1) ? 0 : t),
        y0: at.y - h / 2 - (flush(at.y - h / 2, area.y0) ? 0 : t),
        y1: at.y + h / 2 + (flush(at.y + h / 2, area.y1) ? 0 : t),
      };
      if (at.x - w / 2 < area.x0 - 1 || at.x + w / 2 > area.x1 + 1 || at.y - h / 2 < area.y0 - 1 || at.y + h / 2 > area.y1 + 1) continue;
      // Its own walls must stay inside the building too.
      if (outer.x0 < area.x0 - 1 || outer.x1 > area.x1 + 1 || outer.y0 < area.y0 - 1 || outer.y1 > area.y1 + 1) continue;
      if (taken.some((q) => outer.x0 < q.x1 - 2 && outer.x1 > q.x0 + 2 && outer.y0 < q.y1 - 2 && outer.y1 > q.y0 + 2)) continue;
      c.rotation = rot;
      c.roomId = open.id;
      c.at = { x: Math.round(at.x), y: Math.round(at.y) };
      // Loose furniture in the way (a dining table, say) makes room.
      const gone = model.furniture.filter((f) => f.roomId === open.id && rectsOverlap(itemFootprint(f), outer, 5));
      if (gone.length) model.furniture = model.furniture.filter((f) => !gone.includes(f));
      return true;
    }
  }
  return false;
}

/** Put a new stair or lift centred at a point (inside its room), then let it settle against a wall. */
function dropCore(model: BuildingModel, c: CoreElement, roomIn: Room, x: number, y: number) {
  let room = roomIn;
  // Dropped on (or added for) a lobby: it goes beside the lobby and opens into it.
  if (room.kind === 'lobby' && placeByLobby(model, c, room, x, y)) return;
  const lobby = model.rooms.find((r) => r.kind === 'lobby' && r.block);
  if (lobby && room.block && room.kind !== 'stair' && room.kind !== 'lift' && placeByLobby(model, c, lobby, x, y)) return;
  const fitsIn = (rm: Room) => {
    const rr = roomClearRect(model, rm);
    const fp0 = coreFootprint({ ...c, at: { x: 0, y: 0 } });
    const a = fp0.x1 - fp0.x0;
    const b = fp0.y1 - fp0.y0;
    const W = rr.x1 - rr.x0;
    const H = rr.y1 - rr.y0;
    return (a <= W + 1 && b <= H + 1) || (b <= W + 1 && a <= H + 1);
  };
  if (room.block && (!fitsIn(room) || (room.kind !== 'stair' && room.kind !== 'lift'))) {
    // A stair or lift is its own unit, never inside a lobby or other room (and some are too big anyway):
    // stand it in the nearest free spot of the open space.
    const open = model.rooms.find((r) => !r.block && (r.kind === 'living' || r.kind === 'dining'));
    if (open) {
      room = open;
      const t = c.enclosure?.thickness ?? 0;
      for (const rot of [c.rotation, (c.rotation + 90) % 360]) {
        const fp0 = coreFootprint({ ...c, rotation: rot, at: { x: 0, y: 0 } });
        const spots = freeSpots(model, open, fp0.x1 - fp0.x0 + 2 * t, fp0.y1 - fp0.y0 + 2 * t);
        const near = spots.sort((a, b) => Math.hypot((a.x0 + a.x1) / 2 - x, (a.y0 + a.y1) / 2 - y) - Math.hypot((b.x0 + b.x1) / 2 - x, (b.y0 + b.y1) / 2 - y))[0];
        if (near) {
          c.rotation = rot;
          x = (near.x0 + near.x1) / 2;
          y = (near.y0 + near.y1) / 2;
          break;
        }
      }
    }
  }
  const r = roomClearRect(model, room);
  const fp = coreFootprint({ ...c, at: { x: 0, y: 0 } });
  const hw = (fp.x1 - fp.x0) / 2;
  const hh = (fp.y1 - fp.y0) / 2;
  if (hw * 2 > r.x1 - r.x0 + 1 || hh * 2 > r.y1 - r.y0 + 1) c.rotation = (c.rotation + 90) % 360;
  const fp2 = coreFootprint({ ...c, at: { x: 0, y: 0 } });
  const w2 = (fp2.x1 - fp2.x0) / 2;
  const h2 = (fp2.y1 - fp2.y0) / 2;
  c.roomId = room.id;
  c.at = { x: Math.round(Math.min(Math.max(x, r.x0 + w2), r.x1 - w2)), y: Math.round(Math.min(Math.max(y, r.y0 + h2), r.y1 - h2)) };
  settleCore(model, c);
}

/** A new block of clear size w × h centred at a point, kept inside the building, lined up with nearby walls. */
function placeBlockAt(model: BuildingModel, ctx: Ctx, host: Room, w: number, h: number, name: string, kind: Room['kind'], x: number, y: number): Room {
  const T = 115;
  const a = roomAxisRect(model, host);
  const hw = (w + T) / 2;
  const hh = (h + T) / 2;
  if (hw * 2 > a.x1 - a.x0 + 1 || hh * 2 > a.y1 - a.y0 + 1) throw new ModelError(`A ${formatLength(w, model.displayUnits)} × ${formatLength(h, model.displayUnits)} room doesn't fit in the building.`);
  const cx = Math.min(Math.max(x, a.x0 + hw), a.x1 - hw);
  const cy = Math.min(Math.max(y, a.y0 + hh), a.y1 - hh);
  const room: Room = {
    id: ctx.newId('r'),
    name,
    kind,
    wet: kind === 'toilet' || kind === 'kitchen' || kind === 'service',
    bounds: blockBounds('x'),
    block: { x0: Math.round(cx - hw), x1: Math.round(cx + hw), y0: Math.round(cy - hh), y1: Math.round(cy + hh), thickness: T },
  };
  room.bounds = blockBounds(room.id);
  model.rooms.push(room);
  // A drop is imprecise: line up with a wall within about 3', and keep the asked-for clear size.
  snapBlock(model, room, 900);
  setBlockClearSize(model, room, w, h);
  return room;
}

/** A door on a block's side that faces open space, and a ventilator on an outer wall it touches. */
function addBlockDoorAndVent(model: BuildingModel, ctx: Ctx, room: Room) {
  const sides = SIDES4.filter((sd) => !fixedWallUnder(model, room, sd) && coincidentSides(model, room, sd).length === 0);
  const r = roomClearRect(model, room);
  const len = (sd: PlanSide4) => (sd === 'top' || sd === 'bottom' ? r.x1 - r.x0 : r.y1 - r.y0);
  const doorSide = [...sides].sort((a, b) => len(b) - len(a))[0];
  if (doorSide) {
    const res = applyOperation(model, parseOp('add_opening', { wallId: room.bounds[doorSide], kind: 'door', width: '2\'6"', label: `${room.name} door`, roomId: room.id }));
    Object.assign(model, res.model);
  } else ctx.note(`${room.name} has no free side for a door; move it a little.`);
  // A toilet prefers a ventilator on its short outer wall.
  const extSides = SIDES4.filter((sd) => fixedWallUnder(model, room, sd)?.kind === 'external').sort((a, b) => len(a) - len(b));
  const extSide = room.kind === 'toilet' ? extSides[0] : extSides[0];
  const ext = extSide ? fixedWallUnder(model, room, extSide) : undefined;
  const win = room.kind === 'toilet' ? { w: "2'", label: 'ventilator' } : room.kind === 'bedroom' ? { w: "5'", label: 'window' } : room.kind === 'kitchen' ? { w: "4'", label: 'window' } : undefined;
  if (ext && win) {
    for (const width of [win.w, "3'", "2'"]) {
      try {
        const res = applyOperation(model, parseOp('add_opening', { wallId: ext.id, kind: 'window', width, label: `${room.name} ${win.label}`, roomId: room.id }));
        Object.assign(model, res.model);
        // On a toilet's long wall the ventilator goes to the corner away from the door (the WC goes under it).
        const other = extSide === 'top' || extSide === 'bottom' ? r.y1 - r.y0 : r.x1 - r.x0;
        if (room.kind === 'toilet' && extSide && len(extSide) > other + 1) {
          const v = model.openings[model.openings.length - 1]!;
          const h = extSide === 'top' || extSide === 'bottom';
          const door = model.openings.find((o) => o.kind === 'door' && o.wallId === room.bounds[doorSide ?? 'top']);
          const dp = door ? pointOnWall(getWall(model, door.wallId), door.offset) : undefined;
          const [lo, hi] = h ? [r.x0, r.x1] : [r.y0, r.y1];
          const ends = [lo + v.width / 2 + 150, hi - v.width / 2 - 150];
          const d = dp ? (h ? dp.x : dp.y) : lo;
          const centre = Math.abs(ends[0]! - d) >= Math.abs(ends[1]! - d) ? ends[0]! : ends[1]!;
          const a = h ? ext.a.x : ext.a.y;
          const dir = Math.sign((h ? ext.b.x : ext.b.y) - a) || 1;
          v.offset = Math.round((centre - a) * dir);
        }
        break;
      } catch {
        /* try narrower */
      }
    }
  }
}

/** The wall two rooms share face to face, or undefined. */
export function sharedWall(model: BuildingModel, a: Room, b: Room): string | undefined {
  const side = SIDES4.find((x) => a.bounds[x] === b.bounds[OPPOSITE[x]]);
  if (side) return a.bounds[side];
  // Blocks: b's side that lies on one of a's sides.
  if (a.block && b.block) {
    for (const x of SIDES4) if (coincidentSides(model, a, x).some((c) => c.room.id === b.id)) return b.bounds[OPPOSITE[x]];
  }
  if (b.block && !a.block) {
    for (const x of SIDES4) {
      const f = fixedWallUnder(model, b, OPPOSITE[x]);
      if (f && a.bounds[x] === f.id) return b.bounds[OPPOSITE[x]];
    }
  }
  return undefined;
}

/**
 * Put a new block of clear size w × h in free space of a host room: against an
 * outer wall, clear of other blocks, stairs, lifts, furniture and door swings.
 */
/** Space to keep clear on both sides of every doorway (sliding windows on outer walls excluded). */
function doorZones(model: BuildingModel): Rect[] {
  const out: Rect[] = [];
  for (const o of model.openings) {
    const wall = getWall(model, o.wallId);
    if (o.kind === 'window' || (o.kind === 'sliding' && wall.kind === 'external')) continue;
    const p = pointOnWall(wall, o.offset);
    const along = o.width / 2 + 150;
    const deep = o.width + 300;
    out.push(isHorizontal(wall) ? { x0: p.x - along, x1: p.x + along, y0: p.y - deep, y1: p.y + deep } : { x0: p.x - deep, x1: p.x + deep, y0: p.y - along, y1: p.y + along });
  }
  return out;
}

/** Outer rectangles (with walls) of all room blocks other than one. */
function blockOuterRects(model: BuildingModel, exceptId?: string): Rect[] {
  return model.rooms
    .filter((r) => r.block && r.id !== exceptId)
    .map((r) => {
      const b = r.block!;
      return { x0: b.x0 - b.thickness / 2, x1: b.x1 + b.thickness / 2, y0: b.y0 - b.thickness / 2, y1: b.y1 + b.thickness / 2 };
    });
}

/**
 * Free rectangles of outer size ow × oh in a room, against at least one of its
 * walls, clear of room blocks, stairs, lifts, furniture and doorways. Best first.
 */
function freeSpots(model: BuildingModel, host: Room, ow: number, oh: number): Rect[] {
  const hr = roomClearRect(model, host);
  const occupied: Rect[] = [...blockOuterRects(model, host.id)];
  for (const c of coresOf(model)) occupied.push(enclosureOf(model, c).outer);
  for (const f of model.furniture) occupied.push(itemFootprint(f));
  occupied.push(...doorZones(model));
  const out: { rect: Rect; score: number }[] = [];
  const step = 150;
  for (let x = hr.x0; x + ow <= hr.x1 + 1; x += step) {
    for (let y = hr.y0; y + oh <= hr.y1 + 1; y += step) {
      const rect = { x0: x, x1: x + ow, y0: y, y1: y + oh };
      if (occupied.some((o) => rectsOverlap(o, rect, 5))) continue;
      const touches = Number(x - hr.x0 < step || hr.x1 - rect.x1 < step) + Number(y - hr.y0 < step || hr.y1 - rect.y1 < step);
      if (touches === 0) continue;
      out.push({ rect, score: touches });
    }
  }
  return out.sort((a, b) => b.score - a.score).map((o) => o.rect);
}

function placeFreeBlock(model: BuildingModel, ctx: Ctx, host: Room, w: number, h: number, name: string, kind: Room['kind'], corner?: Corner): Room {
  const T = 115;
  const hr = roomClearRect(model, host);
  const occupied: Rect[] = [...blockOuterRects(model, host.id)];
  for (const c of coresOf(model)) occupied.push(enclosureOf(model, c).outer);
  for (const f of model.furniture) occupied.push(itemFootprint(f));
  occupied.push(...doorZones(model));
  const sizes: [number, number][] = [[w, h], [h, w]];
  const cands: { rect: Rect; score: number }[] = [];
  const step = 150;
  for (const [cw, ch] of sizes) {
    const ow = cw + T;
    const oh = ch + T;
    for (let x = hr.x0 - T / 2; x + ow <= hr.x1 + T / 2 + 1; x += step) {
      for (let y = hr.y0 - T / 2; y + oh <= hr.y1 + T / 2 + 1; y += step) {
        // Axis rect: against the host's clear edge, the block's wall lies on the outer wall line.
        const axis = { x0: x + T / 2, x1: x + ow - T / 2, y0: y + T / 2, y1: y + oh - T / 2 };
        const outer = { x0: x, x1: x + ow, y0: y, y1: y + oh };
        if (occupied.some((o) => rectsOverlap(o, outer, 5))) continue;
        const touchL = Math.abs(outer.x0 - (hr.x0 - T / 2)) < step;
        const touchR = Math.abs(outer.x1 - (hr.x1 + T / 2)) < step;
        const touchT = Math.abs(outer.y0 - (hr.y0 - T / 2)) < step;
        const touchB = Math.abs(outer.y1 - (hr.y1 + T / 2)) < step;
        const touches = Number(touchL || touchR) + Number(touchT || touchB);
        if (touches === 0) continue;
        let score = touches * 10;
        if (corner) {
          const [a, b] = corner.split('-') as [Compass, Compass];
          const want = [compassToSide(a, model.northAngle), compassToSide(b, model.northAngle)];
          const has = { left: touchL, right: touchR, top: touchT, bottom: touchB };
          score += want.filter((sd) => has[sd as 'left']).length * 100;
        }
        cands.push({ rect: axis, score });
      }
    }
  }
  if (cands.length === 0) throw new ModelError(`There's no free spot in ${host.name} for a ${formatLength(w, model.displayUnits)} × ${formatLength(h, model.displayUnits)} room.`);
  cands.sort((a, b) => b.score - a.score);
  const pick = cands[0]!.rect;
  const room: Room = {
    id: ctx.newId('r'),
    name,
    kind,
    wet: kind === 'toilet' || kind === 'kitchen' || kind === 'service',
    bounds: blockBounds('x'),
    block: { ...pick, thickness: T },
  };
  room.bounds = blockBounds(room.id);
  model.rooms.push(room);
  snapBlock(model, room);
  setBlockClearSize(model, room, w, h);
  return room;
}

/** Openings on a room's wall that fall within the room's span. */
export function roomOpeningsOn(model: BuildingModel, room: Room, side: PlanSide4): Opening[] {
  const r = roomClearRect(model, room);
  // The side's own wall, plus for a block: the fixed wall it lies on and any block side on the same line.
  const ids = new Set([room.bounds[side]]);
  if (room.block) {
    const f = fixedWallUnder(model, room, side);
    if (f) ids.add(f.id);
    for (const c of coincidentSides(model, room, side)) ids.add(c.room.bounds[c.side]);
  }
  const horizontal = side === 'top' || side === 'bottom';
  return model.openings.filter((o) => {
    if (!ids.has(o.wallId)) return false;
    const p = pointOnWall(getWall(model, o.wallId), o.offset);
    return horizontal ? p.x > r.x0 && p.x < r.x1 : p.y > r.y0 && p.y < r.y1;
  });
}

/** True when a toilet opens directly off this room. */
export function hasAttachedToilet(model: BuildingModel, room: Room): boolean {
  return model.rooms.some((t) => {
    if (t.kind !== 'toilet') return false;
    const w = sharedWall(model, room, t);
    if (!w) return false;
    const side = SIDES4.find((x) => t.bounds[x] === w)!;
    return roomOpeningsOn(model, t, side).some((o) => o.kind === 'door' || o.kind === 'opening');
  });
}

/**
 * Carve a toilet out of a room along a wall that has neither the room's door
 * nor its window, keeping the room at a usable size. The toilet goes at the
 * end on an outer wall (for a ventilator); spare length becomes a dress area.
 */
function attachToilet(input: BuildingModel, room: Room, width: number, length: number) {
  let m = input;
  const changed = new Set<string>();
  const notes: string[] = [];
  const run = (name: string, a: Record<string, unknown>) => {
    const r = applyOperation(m, parseOp(name, a));
    m = r.model;
    r.changedIds.forEach((i) => changed.add(i));
    return r;
  };
  const T = 115;
  const u = input.displayUnits;
  const minKeep = room.kind === 'bedroom' ? 2700 : room.kind === 'living' || room.kind === 'dining' ? 3000 : 1500;
  const r = roomClearRect(m, room);
  const wallOf = (side: PlanSide4) => getWall(m, room.bounds[side]);
  const ends = (side: PlanSide4): PlanSide4[] => (side === 'top' || side === 'bottom' ? ['left', 'right'] : ['top', 'bottom']);
  const options = SIDES4.flatMap((side) => {
    const on = roomOpeningsOn(m, room, side);
    if (on.length > 0) return [];
    const horizontal = side === 'top' || side === 'bottom';
    const across = horizontal ? r.y1 - r.y0 : r.x1 - r.x0;
    const along = horizontal ? r.x1 - r.x0 : r.y1 - r.y0;
    const keep = across - width - T;
    if (keep < minKeep || along < length) return [];
    const ext = ends(side).filter((e) => wallOf(e).kind === 'external' && roomOpeningsOn(m, room, e).every((o) => o.kind !== 'door'));
    const end = ext[0] ?? ends(side)[0]!;
    const score = (ext.length ? 2 : 0) + (wallOf(side).kind === 'plumbing' ? 1 : 0) + keep / 10000;
    return [{ side, end, along, outer: ext.length > 0, score }];
  }).sort((a, b) => b.score - a.score);
  const pick = options[0];
  if (!pick) {
    throw new ModelError(
      `${room.name} has no wall free of its door and windows with room for a ${formatLength(width, u)} × ${formatLength(length, u)} toilet while keeping ${room.name} at least ${formatLength(minKeep, u)} wide.`,
    );
  }
  const compass = (s: PlanSide4) => planSideCompass(s, m.northAngle);
  const used = new Set(m.rooms.map((x) => x.name));
  let n = m.rooms.filter((x) => x.kind === 'toilet').length + 1;
  while (used.has(`Toilet ${n}`)) n++;
  const toiletName = `Toilet ${n}`;
  run('split_room', { roomId: room.id, side: compass(pick.side), size: `${Math.round(width)} mm`, name: toiletName, kind: 'toilet' });
  const toilet = m.rooms.find((x) => x.name === toiletName)!;
  const spare = pick.along - length - T;
  let dress: Room | undefined;
  if (spare >= 900) {
    const dressName = room.kind === 'bedroom' ? `${room.name} dress` : uniqueName(m, 'Wash');
    run('split_room', { roomId: toilet.id, side: compass(OPPOSITE[pick.end]), size: `${Math.round(spare)} mm`, name: dressName, kind: 'other' });
    dress = m.rooms.find((x) => x.name === dressName);
  }
  const host = m.rooms.find((x) => x.id === room.id)!;
  // The room's own doors (and a window it would otherwise lose) on the end walls
  // that now open into the toilet or dress area go back into the room.
  {
    const hostRect = roomClearRect(m, host);
    const fully = (o: Opening) => {
      const w = getWall(m, o.wallId);
      const p = pointOnWall(w, o.offset);
      const horizontal = isHorizontal(w);
      const [lo, hi] = horizontal ? [hostRect.x0, hostRect.x1] : [hostRect.y0, hostRect.y1];
      const c = horizontal ? p.x : p.y;
      return c - o.width / 2 >= lo - 1 && c + o.width / 2 <= hi + 1;
    };
    const windowsLeft = SIDES4.flatMap((sd) => roomOpeningsOn(m, host, sd)).filter((o) => (o.kind === 'window' || o.kind === 'sliding') && fully(o)).length;
    for (const e of ends(pick.side)) {
      for (const was of roomOpeningsOn(input, room, e)) {
        const o = m.openings.find((x) => x.id === was.id);
        if (!o) continue;
        const stillOurs = roomOpeningsOn(m, host, e).some((x) => x.id === o.id) && fully(o);
        if (stillOurs) continue;
        const isWindow = o.kind === 'window' || o.kind === 'sliding';
        if (isWindow && windowsLeft > 0) continue;
        const blk = parseBlockWallId(o.wallId);
        if (blk && blk.roomId !== host.id) o.wallId = host.bounds[e];
        run('centre_opening', { openingId: o.id, roomId: host.id });
        notes.push(`${o.label} moved along its wall so it still opens into ${room.name}.`);
      }
    }
  }
  run('add_opening', { wallId: sharedWall(m, host, toilet)!, kind: 'door', width: '2\'6"', label: `${toiletName} door`, roomId: toilet.id });
  if (dress) {
    if (room.kind !== 'bedroom') run('set_room_use', { roomId: dress.id, name: dress.name, kind: 'service' });
    run('add_opening', { wallId: sharedWall(m, host, dress)!, kind: 'opening', width: '3\'', label: `${dress.name} opening`, roomId: dress.id });
  }
  if (pick.outer) {
    try {
      const tNow = m.rooms.find((x) => x.id === toilet.id)!;
      const facade = fixedWallUnder(m, tNow, pick.end)?.id ?? tNow.bounds[pick.end];
      run('add_opening', { wallId: facade, kind: 'window', width: '2\'', label: `${toiletName} ventilator`, roomId: toilet.id });
    } catch {
      notes.push(`No room for a ventilator on ${toiletName}'s outer wall.`);
    }
  } else {
    notes.push(`${toiletName} has no outer wall; plan a duct or exhaust for ventilation.`);
  }
  // Keep the room's furniture in the room.
  const keepRect = roomClearRect(m, host);
  for (const f of m.furniture) {
    if (f.roomId !== toilet.id && f.roomId !== dress?.id) continue;
    f.roomId = host.id;
    const fr = itemFootprint(f);
    const hw = (fr.x1 - fr.x0) / 2;
    const hh = (fr.y1 - fr.y0) / 2;
    f.at = { x: Math.round(Math.min(Math.max(f.at.x, keepRect.x0 + hw), keepRect.x1 - hw)), y: Math.round(Math.min(Math.max(f.at.y, keepRect.y0 + hh), keepRect.y1 - hh)) };
    changed.add(f.id);
  }
  const ts = roomClearRect(m, toilet);
  const summary = `Added ${toiletName} ${room.kind === 'bedroom' ? 'attached to' : 'off'} ${room.name}: ${formatLength(ts.x1 - ts.x0, u)} × ${formatLength(ts.y1 - ts.y0, u)}${dress ? (room.kind === 'bedroom' ? ', with a dress area' : `, with a ${dress.name.toLowerCase()} area`) : ''}.`;
  notes.push(`Carved from ${room.name} along its ${compass(pick.side)} side; ${room.name} is now ${roomSizeText(m, host)}.`);
  return { model: m, changed: [...changed], summary, notes };
}


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
  // Which of the two rooms the main door opens into (it follows that room's use).
  const serves = (room: Room, o: Opening) => SIDES4.some((side) => roomOpeningsOn(model, room, side).some((x) => x.id === o.id));
  const main = model.openings.find((o) => /^main door$/i.test(o.label));
  const mainWith = main ? (serves(a, main) ? a : serves(b, main) ? b : undefined) : undefined;
  const mainName = mainWith?.name;
  const otherName = mainWith ? (mainWith === a ? b.name : a.name) : undefined;
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
    ctx.touch(c.id);
  }
  // Stairs and lifts that now stick out, clash or face a wall go to a free corner.
  for (const c of coresOf(model)) {
    if (c.roomId !== a.id && c.roomId !== b.id) continue;
    const dest = c.roomId === a.id ? a : b;
    const rr = roomClearRect(model, dest);
    const enc = enclosureOf(model, c);
    const o = enc.outer;
    const outside = o.x0 < rr.x0 - 5 || o.x1 > rr.x1 + 5 || o.y0 < rr.y0 - 5 || o.y1 > rr.y1 + 5;
    const clash = coresOf(model).some((d) => d.id !== c.id && rectsOverlap(o, enclosureOf(model, d).outer, 5));
    if (!outside && !clash && !enc.entryBlocked) continue;
    const saved = { at: c.at, rotation: c.rotation };
    try {
      ctx.placeCore(c, dest);
    } catch {
      Object.assign(c, saved);
      ctx.note(`The ${c.label.toLowerCase()} doesn't fit well in ${dest.name}'s new space; drag it or resize the room.`);
    }
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
  // The room that had the main door now sits where the other room was: its door
  // there becomes the main door, and the old main door goes with the other room.
  if (main && mainName && otherName) {
    const newMain = model.openings.find((o) => o.label === `${mainName} door`);
    if (newMain) {
      newMain.label = main.label;
      main.label = `${otherName} door`;
      ctx.touch(newMain.id, main.id);
      ctx.note(`The main door is now the door into ${mainName}'s new place.`);
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

/** Floor area (mm²) of an open room left around the room blocks. */
export function openArea(model: BuildingModel, room: Room): number {
  const c = roomClearRect(model, room);
  const { w, h } = rectSize(c);
  let area = w * h;
  for (const r of model.rooms) {
    const b = r.block;
    if (!b) continue;
    const t = b.thickness / 2;
    const ix = Math.max(0, Math.min(c.x1, b.x1 + t) - Math.max(c.x0, b.x0 - t));
    const iy = Math.max(0, Math.min(c.y1, b.y1 + t) - Math.max(c.y0, b.y0 - t));
    area -= ix * iy;
  }
  return area;
}

/** Room size as displayed: clear dimensions, plan width × plan depth. */
export function roomSizeText(model: BuildingModel, room: Room): string {
  const c = roomClearRect(model, room);
  const { w, h } = rectSize(c);
  if (!room.block && model.rooms.some((r) => r.block)) {
    const area = openArea(model, room);
    const sq = area / 92903.04;
    return model.displayUnits === 'ft-in' ? `≈ ${Math.round(sq).toLocaleString('en-IN')} sq ft open` : `≈ ${(area / 1e6).toFixed(1)} m² open`;
  }
  return `${formatLength(w, model.displayUnits)} × ${formatLength(h, model.displayUnits)}`;
}

export function itemRect(f: FurnitureItem): Rect {
  return itemFootprint(f);
}
