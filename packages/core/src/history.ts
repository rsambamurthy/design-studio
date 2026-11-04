/**
 * Revision history. One user turn = one revision, even if the agent applied
 * several operations, so "undo" always means exactly the last request.
 */
import type { BuildingModel } from './model';
import type { Operation } from './ops';

export interface Revision {
  revision: number;
  /** The user's request, verbatim. */
  request: string;
  ops: Operation[];
  summary: string;
  model: BuildingModel;
  at: string;
  /** Optional human name, e.g. "Option 2". */
  label?: string;
}

export interface History {
  past: Revision[];
  current: Revision;
  future: Revision[];
}

export function startHistory(model: BuildingModel): History {
  return {
    past: [],
    current: { revision: model.revision, request: 'Initial design', ops: [], summary: 'Initial design', model, at: new Date().toISOString() },
    future: [],
  };
}

export function commit(h: History, rev: Omit<Revision, 'revision' | 'at'>): History {
  return {
    past: [...h.past, h.current],
    current: { ...rev, revision: rev.model.revision, at: new Date().toISOString() },
    future: [],
  };
}

export function undo(h: History): History {
  const prev = h.past[h.past.length - 1];
  if (!prev) return h;
  return { past: h.past.slice(0, -1), current: prev, future: [h.current, ...h.future] };
}

export function redo(h: History): History {
  const next = h.future[0];
  if (!next) return h;
  return { past: [...h.past, h.current], current: next, future: h.future.slice(1) };
}

export function labelCurrent(h: History, label: string): History {
  return { ...h, current: { ...h.current, label } };
}

/** Revision letters like drawings use: 1→A, 26→Z, 27→AA. */
export function revisionLetter(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || '0';
}
