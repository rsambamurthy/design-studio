import { AuthError } from '@/lib/auth';
import { getDesign } from '@/lib/designs';
import { discardRun, getRun, keepRun, stopRun } from '@/lib/fixAgent';
import { readJson, withUser } from '@/lib/http';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; runId: string }> };

export const GET = withUser<Ctx>(async (user, _req, ctx) => {
  const { id, runId } = await ctx.params;
  return Response.json({ run: await getRun(user.id, id, runId) });
});

/** { action: 'stop' | 'keep' | 'discard' } */
export const POST = withUser<Ctx>(async (user, req, ctx) => {
  const { id, runId } = await ctx.params;
  const body = await readJson(req);
  const action = String(body.action ?? '');
  if (action === 'stop') return Response.json({ run: await stopRun(user.id, id, runId) });
  if (action === 'discard') return Response.json({ run: await discardRun(user.id, id, runId) });
  if (action === 'keep') {
    const { run, revision } = await keepRun(user.id, id, runId);
    return Response.json({ run, revision, design: await getDesign(user.id, id) });
  }
  throw new AuthError('Unknown action.');
});
