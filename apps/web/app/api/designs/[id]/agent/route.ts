import { openRun, startFixRun } from '@/lib/fixAgent';
import { withUser } from '@/lib/http';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** The run in progress or waiting for Keep/Discard, if any. */
export const GET = withUser<Ctx>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  return Response.json({ run: await openRun(user.id, id) });
});

/** Start "Fix the issues". Returns at once; poll the run for progress. */
export const POST = withUser<Ctx>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  return Response.json({ run: await startFixRun(user.id, id) });
});
