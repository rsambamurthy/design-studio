/**
 * Saved designs and their append-only revision history. Every function checks
 * ownership. Models are produced on the server (by the kernel), never accepted
 * from the browser, so stored revisions always come from validated operations.
 */
import { parseOperation, startDesign, type BuildingModel, type Operation } from '@ds/core';
import { getDb, newId, type Db } from './db';
import { AuthError } from './auth';

export interface DesignSummary {
  id: string;
  name: string;
  currentRev: number;
  updatedAt: string;
  lastChange: string;
}

export interface RevisionMeta {
  number: number;
  /** The state this revision was derived from; "undo" goes back to it. Null for the first. */
  parent: number | null;
  label: string | null;
  request: string;
  summary: string;
  createdAt: string;
}

export interface DesignDetail {
  id: string;
  name: string;
  currentRev: number;
  model: BuildingModel;
  revisions: RevisionMeta[];
}

const MAX_NAME = 120;

function cleanName(input: unknown): string {
  const name = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new AuthError('Give the design a name.');
  return name.slice(0, MAX_NAME);
}

async function ownDesign(db: Db, userId: string, id: string, lock = false) {
  const { rows } = await db.query<{ id: string; name: string; current_rev: number }>(
    `SELECT id, name, current_rev FROM designs WHERE id = $1 AND owner_id = $2 AND archived = false${lock ? ' FOR UPDATE' : ''}`,
    [id, userId],
  );
  if (!rows[0]) throw new AuthError('Design not found.', 404);
  return rows[0];
}

export async function listDesigns(userId: string): Promise<DesignSummary[]> {
  const db = await getDb();
  const { rows } = await db.query<{ id: string; name: string; current_rev: number; updated_at: string; summary: string }>(
    `SELECT d.id, d.name, d.current_rev, d.updated_at, r.summary
     FROM designs d JOIN revisions r ON r.design_id = d.id AND r.number = d.current_rev
     WHERE d.owner_id = $1 AND d.archived = false ORDER BY d.updated_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, currentRev: r.current_rev, updatedAt: String(r.updated_at), lastChange: r.summary }));
}

export interface NewDesignInput {
  name?: unknown;
  template?: unknown;
  /** Site operations ({ op, args }) applied before saving Rev A, e.g. set_plot, set_setback. */
  siteOps?: unknown;
  /** 1–3 bedrooms (picks the layout when template is auto). */
  bedrooms?: unknown;
  /** Total toilets wanted. */
  toilets?: unknown;
}

export async function createDesign(userId: string, input: NewDesignInput): Promise<string> {
  const name = cleanName(input.name);
  const templateId = String(input.template ?? 'auto');
  const raw = Array.isArray(input.siteOps) ? input.siteOps.slice(0, 30) : [];
  let model: BuildingModel;
  let ops: Operation[];
  let notes: string[];
  try {
    const siteOps = raw.map((o: unknown) => {
      const { op, args } = (o ?? {}) as { op?: unknown; args?: unknown };
      const parsed = parseOperation(String(op), args);
      if (!['set_plot', 'set_setback', 'set_access', 'add_tree'].includes(parsed.op)) {
        throw new Error(`"${parsed.op}" can't be used when creating a design.`);
      }
      return parsed;
    });
    const count = (v: unknown, max: number) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= max ? n : undefined;
    };
    ({ model, ops, notes } = startDesign(templateId, siteOps, name, { bedrooms: count(input.bedrooms, 3), toilets: count(input.toilets, 4) }));
  } catch (err) {
    throw new AuthError(err instanceof Error ? err.message : String(err));
  }

  const db = await getDb();
  const id = newId(12);
  await db.tx(async (q) => {
    await q.query(`INSERT INTO designs (id, owner_id, name) VALUES ($1, $2, $3)`, [id, userId, name]);
    await q.query(
      `INSERT INTO revisions (design_id, number, request, summary, ops, model) VALUES ($1, 1, $2, $3, $4, $5)`,
      [id, 'New design', notes.join('; '), JSON.stringify(ops), JSON.stringify(model)],
    );
  });
  return id;
}

export async function duplicateDesign(userId: string, id: string, nameInput: unknown): Promise<string> {
  const db = await getDb();
  const src = await ownDesign(db, userId, id);
  const model = await revisionModel(db, id, src.current_rev);
  const name = cleanName(nameInput ?? `${src.name} (copy)`);
  const newDesignId = newId(12);
  await db.tx(async (q) => {
    await q.query(`INSERT INTO designs (id, owner_id, name) VALUES ($1, $2, $3)`, [newDesignId, userId, name]);
    await q.query(
      `INSERT INTO revisions (design_id, number, request, summary, model) VALUES ($1, 1, $2, $3, $4)`,
      [newDesignId, `Copied from ${src.name}`, `Copy of ${src.name} at Rev ${letter(src.current_rev)}`, JSON.stringify({ ...model, name, revision: 1 })],
    );
  });
  return newDesignId;
}

export async function renameDesign(userId: string, id: string, nameInput: unknown) {
  const name = cleanName(nameInput);
  const db = await getDb();
  await ownDesign(db, userId, id);
  await db.query(`UPDATE designs SET name = $1, updated_at = now() WHERE id = $2`, [name, id]);
}

export async function archiveDesign(userId: string, id: string) {
  const db = await getDb();
  await ownDesign(db, userId, id);
  await db.query(`UPDATE designs SET archived = true, updated_at = now() WHERE id = $1`, [id]);
  await db.query(`UPDATE shares SET revoked = true WHERE design_id = $1`, [id]);
}

export async function getDesign(userId: string, id: string): Promise<DesignDetail> {
  const db = await getDb();
  const d = await ownDesign(db, userId, id);
  return { id: d.id, name: d.name, currentRev: d.current_rev, model: await revisionModel(db, id, d.current_rev), revisions: await revisionList(db, id) };
}

export async function getRevisionModel(userId: string, id: string, n: number): Promise<BuildingModel> {
  const db = await getDb();
  await ownDesign(db, userId, id);
  return revisionModel(db, id, n);
}

/**
 * Append a revision produced by `produce` from the current model. Runs in a
 * transaction with the design row locked, so two tabs can't interleave edits.
 * `produce` returns null when nothing changed (no revision is written).
 */
export async function appendRevision(
  userId: string,
  id: string,
  produce: (
    current: BuildingModel,
    currentRev: number,
    q: Db,
  ) => Promise<{ request: string; summary: string; ops: Operation[]; model: BuildingModel; parent?: number | null; source?: number | null } | null>,
): Promise<{ revision: number | null }> {
  const db = await getDb();
  return db.tx(async (q) => {
    const d = await ownDesign(q, userId, id, true);
    const current = await revisionModel(q, id, d.current_rev);
    const out = await produce(current, d.current_rev, q);
    if (!out) return { revision: null };
    const n = d.current_rev + 1;
    await q.query(
      `INSERT INTO revisions (design_id, number, parent, source, request, summary, ops, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, n, out.parent === undefined ? d.current_rev : out.parent, out.source ?? null, out.request.slice(0, 2000), out.summary.slice(0, 2000), JSON.stringify(out.ops), JSON.stringify({ ...out.model, revision: n })],
    );
    await q.query(`UPDATE designs SET current_rev = $1, updated_at = now() WHERE id = $2`, [n, id]);
    return { revision: n };
  });
}

/** Make an earlier revision current again, as a new revision (history is never rewritten). */
export async function restoreRevision(userId: string, id: string, target: number, kind: 'undo' | 'redo' | 'restore') {
  return appendRevision(userId, id, async (_current, currentRev, q) => {
    if (target === currentRev) return null;
    const model = await revisionModel(q, id, target);
    const meta = async (n: number) =>
      (await q.query<{ summary: string; parent: number | null; source: number | null }>(
        `SELECT summary, parent, source FROM revisions WHERE design_id = $1 AND number = $2`,
        [id, n],
      )).rows[0];
    // A restored revision repeats an earlier state: it keeps that state's parent
    // (so undo keeps stepping back) and points at the original edit (its source).
    const t = await meta(target);
    const source = t?.source ?? target;
    const parent = t?.parent ?? null;
    // Describe the original edit being reversed / re-applied, never "Undid: Undid: …".
    const cur = await meta(currentRev);
    const original = async (n: number | null | undefined) => (n ? (await meta(n))?.summary ?? '' : '');
    const what = kind === 'undo' ? await original(cur?.source ?? currentRev) : await original(source);
    const summary =
      kind === 'undo' ? `Undid: ${what}` : kind === 'redo' ? `Redid: ${what}` : `Restored Rev ${letter(target)}`;
    return { request: kind === 'restore' ? `Restore Rev ${letter(target)}` : kind === 'undo' ? 'Undo' : 'Redo', summary, ops: [], model, parent, source };
  });
}

export async function labelRevision(userId: string, id: string, n: number, labelInput: unknown) {
  const label = String(labelInput ?? '').trim().slice(0, 60) || null;
  const db = await getDb();
  await ownDesign(db, userId, id);
  await db.query(`UPDATE revisions SET label = $1 WHERE design_id = $2 AND number = $3`, [label, id, n]);
}

// ---------- Sharing ----------

export async function createShare(userId: string, id: string, revision: number | null): Promise<string> {
  const db = await getDb();
  await ownDesign(db, userId, id);
  const token = newId(18);
  await db.query(`INSERT INTO shares (token, design_id, revision) VALUES ($1, $2, $3)`, [token, id, revision]);
  return token;
}

export async function listShares(userId: string, id: string) {
  const db = await getDb();
  await ownDesign(db, userId, id);
  const { rows } = await db.query<{ token: string; revision: number | null; created_at: string }>(
    `SELECT token, revision, created_at FROM shares WHERE design_id = $1 AND revoked = false ORDER BY created_at DESC`,
    [id],
  );
  return rows.map((r) => ({ token: r.token, revision: r.revision, createdAt: String(r.created_at) }));
}

export async function revokeShare(userId: string, id: string, token: string) {
  const db = await getDb();
  await ownDesign(db, userId, id);
  await db.query(`UPDATE shares SET revoked = true WHERE token = $1 AND design_id = $2`, [token, id]);
}

/** Public, read-only: no ownership check, but only via an unrevoked token. */
export async function getShared(token: string) {
  const db = await getDb();
  const { rows } = await db.query<{ design_id: string; revision: number | null; name: string; current_rev: number }>(
    `SELECT s.design_id, s.revision, d.name, d.current_rev FROM shares s JOIN designs d ON d.id = s.design_id
     WHERE s.token = $1 AND s.revoked = false AND d.archived = false`,
    [token],
  );
  const s = rows[0];
  if (!s) return null;
  const n = s.revision ?? s.current_rev;
  return { name: s.name, revision: n, pinned: s.revision !== null, model: await revisionModel(db, s.design_id, n) };
}

// ---------- Internals ----------

async function revisionModel(db: Db, id: string, n: number): Promise<BuildingModel> {
  const { rows } = await db.query<{ model: BuildingModel | string }>(`SELECT model FROM revisions WHERE design_id = $1 AND number = $2`, [id, n]);
  const m = rows[0]?.model;
  if (!m) throw new AuthError(`Revision ${letter(n)} not found.`, 404);
  return typeof m === 'string' ? (JSON.parse(m) as BuildingModel) : m;
}

async function revisionList(db: Db, id: string): Promise<RevisionMeta[]> {
  const { rows } = await db.query<{ number: number; parent: number | null; label: string | null; request: string; summary: string; created_at: string }>(
    `SELECT number, parent, label, request, summary, created_at FROM revisions WHERE design_id = $1 ORDER BY number DESC`,
    [id],
  );
  return rows.map((r) => ({ number: r.number, parent: r.parent, label: r.label, request: r.request, summary: r.summary, createdAt: String(r.created_at) }));
}

function letter(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}
