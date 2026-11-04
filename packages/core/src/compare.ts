/**
 * Compare two versions of a design: what was added, removed or changed, and
 * how every room's clear size moved. Used by the revision compare view.
 */
import { rectSize, roomClearRect } from './geometry';
import type { BuildingModel } from './model';

export interface RoomDelta {
  id: string;
  name: string;
  before: { w: number; h: number; area: number } | null;
  after: { w: number; h: number; area: number } | null;
}

export interface ModelDiff {
  added: string[];
  removed: string[];
  changed: string[];
  rooms: RoomDelta[];
  /** Change in total clear area, mm². */
  areaDelta: number;
}

type Keyed = { id: string };

function index<T extends Keyed>(xs: T[]): Map<string, T> {
  return new Map(xs.map((x) => [x.id, x]));
}

function collect(a: BuildingModel) {
  return [...a.walls, ...a.openings, ...a.rooms, ...a.furniture] as Keyed[];
}

export function diffModels(before: BuildingModel, after: BuildingModel): ModelDiff {
  const A = index(collect(before));
  const B = index(collect(after));
  const added = [...B.keys()].filter((k) => !A.has(k));
  const removed = [...A.keys()].filter((k) => !B.has(k));
  const changed = [...B.keys()].filter((k) => A.has(k) && JSON.stringify(A.get(k)) !== JSON.stringify(B.get(k)));

  const size = (m: BuildingModel, id: string) => {
    const r = m.rooms.find((x) => x.id === id);
    if (!r) return null;
    const { w, h } = rectSize(roomClearRect(m, r));
    return { w: Math.round(w), h: Math.round(h), area: Math.round(w * h) };
  };

  const roomIds = [...new Set([...before.rooms.map((r) => r.id), ...after.rooms.map((r) => r.id)])];
  const rooms: RoomDelta[] = [];
  let areaDelta = 0;
  for (const id of roomIds) {
    const b = size(before, id);
    const a = size(after, id);
    const nameChanged = before.rooms.find((r) => r.id === id)?.name !== after.rooms.find((r) => r.id === id)?.name;
    if (b && a && b.w === a.w && b.h === a.h && !nameChanged) continue;
    areaDelta += (a?.area ?? 0) - (b?.area ?? 0);
    rooms.push({ id, name: (after.rooms.find((r) => r.id === id) ?? before.rooms.find((r) => r.id === id))!.name, before: b, after: a });
    if (!changed.includes(id) && !added.includes(id) && !removed.includes(id)) changed.push(id);
  }
  return { added, removed, changed, rooms, areaDelta };
}
