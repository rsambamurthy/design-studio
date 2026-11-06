import { applyOperation, parseOperation, runChecks, type Operation } from '@ds/core';
import { AuthError } from '@/lib/auth';
import { diffIssues, errorText } from '@/lib/agent';
import { appendRevision, getDesign } from '@/lib/designs';
import { readJson, withUser } from '@/lib/http';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Direct edits from forms and the canvas: { request, baseRev, ops: [{ op, args }] }.
 * Same typed operations and kernel as chat, saved as one revision.
 */
export const POST = withUser<Ctx>(async (user, req, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  const raw = Array.isArray(body.ops) ? body.ops.slice(0, 200) : [];
  if (raw.length === 0) throw new AuthError('No changes to apply.');
  const request = String(body.request ?? '').trim().slice(0, 300) || 'Edit';

  let ops: Operation[];
  try {
    ops = raw.map((o: unknown) => {
      const { op, args } = (o ?? {}) as { op?: unknown; args?: unknown };
      return parseOperation(String(op), args);
    });
  } catch (err) {
    throw new AuthError(errorText(err));
  }

  const summaries: string[] = [];
  const assumptions: string[] = [];
  const changed = new Set<string>();
  let before: ReturnType<typeof runChecks> = [];
  let after: ReturnType<typeof runChecks> = [];
  const { revision } = await appendRevision(user.id, id, async (current, currentRev) => {
    if (typeof body.baseRev === 'number' && body.baseRev !== currentRev) {
      throw new AuthError('This design was changed in another tab or device. Reload to see the latest.', 409);
    }
    before = runChecks(current);
    let model = current;
    try {
      for (const op of ops) {
        const r = applyOperation(model, op);
        model = r.model;
        summaries.push(r.summary);
        assumptions.push(...r.assumptions);
        r.changedIds.forEach((x) => changed.add(x));
      }
    } catch (err) {
      throw new AuthError(errorText(err));
    }
    after = runChecks(model);
    return { request, summary: summaries.join(' '), ops, model };
  });

  return {
    revision,
    summaries,
    assumptions: [...new Set(assumptions)],
    changedIds: [...changed],
    newIssues: diffIssues(before, after),
    design: await getDesign(user.id, id),
  };
});
