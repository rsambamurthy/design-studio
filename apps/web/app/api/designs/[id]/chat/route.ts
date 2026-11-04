import { AuthError } from '@/lib/auth';
import { errorText, runTurn, type TurnResult } from '@/lib/agent';
import { appendRevision, getDesign } from '@/lib/designs';
import { readJson, withUser } from '@/lib/http';
import { runOfflineTurn } from '@/lib/offline';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export const POST = withUser<Ctx>(async (user, req, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  const message = String(body.message ?? '').trim().slice(0, 2000);
  if (!message) throw new AuthError('Type a change first.');

  const design = await getDesign(user.id, id);
  const recent = design.revisions
    .slice(0, 5)
    .reverse()
    .map((r) => r.request)
    .filter((r) => r !== 'New design');

  // The LLM call happens outside any database lock.
  let turn: TurnResult;
  if (!process.env.ANTHROPIC_API_KEY) {
    turn = runOfflineTurn(design.model, message);
  } else {
    try {
      turn = await runTurn(design.model, message, recent);
    } catch (err) {
      console.error('[chat] LLM turn failed', err);
      const fallback = runOfflineTurn(design.model, message);
      turn = { ...fallback, reply: `${fallback.reply} (AI unavailable: ${errorText(err)})` };
    }
  }

  let revision: number | null = null;
  if (turn.ops.length > 0) {
    ({ revision } = await appendRevision(user.id, id, async (_current, currentRev) => {
      if (currentRev !== design.currentRev) {
        throw new AuthError('This design was changed in another tab or device. Reload to see the latest, then try again.', 409);
      }
      return { request: message, summary: turn.summaries.join(' '), ops: turn.ops, model: turn.model };
    }));
  }

  return { turn: { ...turn, model: undefined }, revision, design: await getDesign(user.id, id) };
});
