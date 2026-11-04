/**
 * Compact, LLM-facing description of the model plus a deterministic reference
 * resolver. The full model is never sent to the LLM.
 */
import { getCatalogueItem, matchCatalogue, CATALOGUE } from './catalogue';
import { runChecks } from './checks';
import { planSideCompass, vectorToCompass, wallDir, type Compass } from './geometry';
import { describeNorth, roomSizeText } from './kernel';
import type { BuildingModel, PlanSide, Room, Wall } from './model';
import { PLAN_SIDES, boundaryGaps, eastWestIsPlanX, sideToCompass } from './site';
import { formatLength } from './units';

export function wallCompassForRoom(model: BuildingModel, room: Room, wallId: string): Compass | undefined {
  const side = (Object.keys(room.bounds) as (keyof Room['bounds'])[]).find((k) => room.bounds[k] === wallId);
  return side ? planSideCompass(side, model.northAngle) : undefined;
}

function wallRuns(model: BuildingModel, w: Wall): string {
  const c = vectorToCompass(wallDir(w), model.northAngle);
  return c === 'north' || c === 'south' ? 'N–S' : 'E–W';
}

export function modelSummary(model: BuildingModel): string {
  const u = model.displayUnits;
  const lines: string[] = [];
  lines.push(`Design: ${model.name} · ${model.levelName} · revision ${model.revision}`);
  lines.push(`Orientation: ${describeNorth(model)}. Units shown: ${u === 'ft-in' ? 'feet-inches' : 'mm'}. Room sizes are CLEAR (inside face to inside face).`);
  lines.push('');
  lines.push('ROOMS (id: name, kind, clear size width×depth on plan; walls by compass side):');
  for (const r of model.rooms) {
    const sides = (['top', 'bottom', 'left', 'right'] as const)
      .map((s) => `${planSideCompass(s, model.northAngle)}=${r.bounds[s]}`)
      .join(' ');
    lines.push(`- ${r.id}: ${r.name} (${r.kind}${r.wet ? ', wet' : ''}) ${roomSizeText(model, r)}; walls ${sides}`);
  }
  lines.push('');
  lines.push('WALLS (id: runs, thickness, kind, rooms it bounds):');
  for (const w of model.walls) {
    const rooms = model.rooms
      .filter((r) => Object.values(r.bounds).includes(w.id))
      .map((r) => `${r.name}'s ${wallCompassForRoom(model, r, w.id)}`)
      .join(', ');
    lines.push(`- ${w.id}: ${wallRuns(model, w)}, ${formatLength(w.thickness, u)} ${w.kind}${rooms ? `; ${rooms} wall` : ''}`);
  }
  lines.push('');
  lines.push('DOORS & WINDOWS (id: label, kind, width, wall):');
  for (const o of model.openings) {
    lines.push(`- ${o.id}: ${o.label} (${o.kind}, ${formatLength(o.width, u)}) on ${o.wallId}`);
  }
  lines.push('');
  lines.push('FURNITURE (id: label, catalogue, room):');
  if (model.furniture.length === 0) lines.push('- none');
  for (const f of model.furniture) {
    const cat = getCatalogueItem(f.catalogueId);
    const hand = cat?.handed ? `, extension on ${f.mirrored ? 'left' : 'right'}` : '';
    lines.push(`- ${f.id}: ${f.label} (${f.catalogueId}${hand}) in ${f.roomId}`);
  }
  lines.push('');
  lines.push(siteSummary(model));
  const issues = runChecks(model);
  lines.push('');
  lines.push(`OPEN CHECKS: ${issues.length === 0 ? 'none' : ''}`);
  for (const i of issues) lines.push(`- [${i.severity}] ${i.message}`);
  return lines.join('\n');
}

export interface EntityMatch {
  id: string;
  type: 'room' | 'wall' | 'opening' | 'furniture';
  label: string;
  score: number;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'room', 'wall', 'door', 'window', 'between', 'and', 'my', 'that', 'this', 'it']);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

/**
 * Deterministic resolver: "the Bed 2 door", "wall between Bed 2 and study",
 * "the sofa". Returns ranked matches; the agent asks the user when the top two
 * are tied.
 */
export function findEntities(model: BuildingModel, text: string): EntityMatch[] {
  const q = text.toLowerCase();
  const qt = new Set(tokens(text));
  const wantsDoor = /\bdoor\b/.test(q);
  const wantsWindow = /\bwindow\b/.test(q);
  const wantsWall = /\bwall\b/.test(q);
  const out: EntityMatch[] = [];

  const overlap = (label: string) => {
    const lt = tokens(label);
    if (lt.length === 0) return 0;
    const hit = lt.filter((t) => qt.has(t)).length;
    return hit / lt.length;
  };

  for (const r of model.rooms) {
    const s = overlap(r.name);
    if (s > 0 && !wantsDoor && !wantsWindow && !wantsWall) out.push({ id: r.id, type: 'room', label: r.name, score: s });
  }
  for (const o of model.openings) {
    let s = overlap(o.label);
    if (wantsDoor && o.kind !== 'window') s += 0.5;
    if (wantsWindow && o.kind === 'window') s += 0.5;
    if ((wantsDoor && o.kind === 'window') || (wantsWindow && o.kind !== 'window')) s = 0;
    if (s > 0.5) out.push({ id: o.id, type: 'opening', label: o.label, score: s });
  }
  if (wantsWall) {
    // "wall between A and B": walls bounding every named room.
    const named = model.rooms.filter((r) => overlap(r.name) === 1);
    const compass = (['north', 'south', 'east', 'west'] as const).find((c) => q.includes(c));
    for (const w of model.walls) {
      const bounded = named.filter((r) => Object.values(r.bounds).includes(w.id));
      if (bounded.length === 0) continue;
      let s = bounded.length;
      if (compass && bounded.some((r) => wallCompassForRoom(model, r, w.id) === compass)) s += 1;
      // A wall "between" two rooms is on opposite sides of them (one's east is the other's west).
      const sides = new Set(bounded.map((r) => wallCompassForRoom(model, r, w.id)));
      const opposite = (sides.has('east') && sides.has('west')) || (sides.has('north') && sides.has('south'));
      if (bounded.length >= 2 && opposite) s += 2;
      else if (bounded.length >= 2 && /\bbetween\b/.test(q)) s -= 1;
      const label = bounded.map((r) => `${r.name} ${wallCompassForRoom(model, r, w.id)}`).join(' / ') + ' wall';
      out.push({ id: w.id, type: 'wall', label, score: s });
    }
  }
  for (const f of model.furniture) {
    const cat = getCatalogueItem(f.catalogueId);
    const words = [f.label, ...(cat?.aliases ?? [])];
    const s = Math.max(...words.map((wd) => (q.includes(wd.toLowerCase()) ? 1 : overlap(wd))));
    if (s > 0.5) out.push({ id: f.id, type: 'furniture', label: f.label, score: s });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

export function findCatalogue(text: string) {
  const best = matchCatalogue(text);
  const others = CATALOGUE.filter((c) => c.id !== best?.id && c.aliases.some((a) => text.toLowerCase().includes(a.split(' ')[0]!)));
  return [best, ...others].filter(Boolean).slice(0, 4).map((c) => ({ id: c!.id, name: c!.name, width: c!.width, depth: c!.depth, handed: !!c!.handed }));
}


/** Site description for the LLM: plot, setbacks, access, trees, building gaps. */
export function siteSummary(model: BuildingModel): string {
  const site = model.site;
  if (!site) return 'SITE: no plot entered yet (use set_plot first).';
  const u = model.displayUnits;
  const xIsEW = eastWestIsPlanX(model.northAngle);
  const ew = xIsEW ? site.plot.width : site.plot.depth;
  const ns = xIsEW ? site.plot.depth : site.plot.width;
  const gaps = boundaryGaps(model, site);
  const bySide = (f: (s: PlanSide) => string) => PLAN_SIDES.map((s) => `${sideToCompass(s, model.northAngle)} ${f(s)}`).join(', ');
  const lines = [
    `SITE: plot ${formatLength(ew, u)} E–W × ${formatLength(ns, u)} N–S.`,
    `Setbacks required: ${bySide((s) => formatLength(site.setbacks[s], u))}.`,
    `Building outer face to boundary: ${bySide((s) => formatLength(Math.round(gaps[s]), u))}.`,
    `Access: ${site.access.length ? site.access.map((a) => `${a.kind} on ${sideToCompass(a.side, model.northAngle)}, ${formatLength(a.width, u)}`).join('; ') : 'none recorded'}.`,
    `Trees (id: label): ${site.trees.length ? site.trees.map((t) => `${t.id}: ${t.label}${t.keep ? ' (keep)' : ''}`).join('; ') : 'none'}.`,
  ];
  return lines.join('\n');
}
