import { getRevisionModel, labelRevision } from '@/lib/designs';
import { readJson, revNumber, withUser } from '@/lib/http';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; n: string }> };

export const GET = withUser<Ctx>(async (user, _req, ctx) => {
  const { id, n } = await ctx.params;
  return { model: await getRevisionModel(user.id, id, revNumber(n)) };
});

/** { label } — name a revision, e.g. "Option 2". Empty label clears it. */
export const POST = withUser<Ctx>(async (user, req, ctx) => {
  const { id, n } = await ctx.params;
  await labelRevision(user.id, id, revNumber(n), (await readJson(req)).label);
  return { ok: true };
});
