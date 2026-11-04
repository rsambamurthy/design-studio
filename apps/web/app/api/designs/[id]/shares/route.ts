import { createShare, listShares, revokeShare } from '@/lib/designs';
import { readJson, revNumber, withUser } from '@/lib/http';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export const GET = withUser<Ctx>(async (user, _req, ctx) => ({ shares: await listShares(user.id, (await ctx.params).id) }));

/** { revision?: number } — omit to always show the latest revision. */
export const POST = withUser<Ctx>(async (user, req, ctx) => {
  const body = await readJson(req);
  const revision = body.revision == null ? null : revNumber(body.revision);
  return { token: await createShare(user.id, (await ctx.params).id, revision) };
});

export const DELETE = withUser<Ctx>(async (user, req, ctx) => {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  await revokeShare(user.id, (await ctx.params).id, token);
  return { ok: true };
});
