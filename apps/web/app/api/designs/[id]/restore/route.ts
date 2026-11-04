import { AuthError } from '@/lib/auth';
import { getDesign, restoreRevision } from '@/lib/designs';
import { readJson, revNumber, withUser } from '@/lib/http';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** { revision, kind: 'undo' | 'redo' | 'restore' } — makes that revision current, as a new revision. */
export const POST = withUser<Ctx>(async (user, req, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  const kind = body.kind === 'undo' || body.kind === 'redo' ? body.kind : 'restore';
  const target = revNumber(body.revision);
  if (typeof body.baseRev === 'number') {
    const now = await getDesign(user.id, id);
    if (now.currentRev !== body.baseRev) throw new AuthError('This design was changed elsewhere. Reload to see the latest.', 409);
  }
  const { revision } = await restoreRevision(user.id, id, target, kind);
  return { revision, design: await getDesign(user.id, id) };
});
