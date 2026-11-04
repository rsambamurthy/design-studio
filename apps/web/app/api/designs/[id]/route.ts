import { archiveDesign, duplicateDesign, getDesign, renameDesign } from '@/lib/designs';
import { readJson, withUser } from '@/lib/http';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export const GET = withUser<Ctx>(async (user, _req, ctx) => getDesign(user.id, (await ctx.params).id));

/** Rename: { name }  ·  Duplicate: { duplicate: true, name? } */
export const POST = withUser<Ctx>(async (user, req, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  if (body.duplicate === true) return { id: await duplicateDesign(user.id, id, body.name) };
  await renameDesign(user.id, id, body.name);
  return { ok: true };
});

export const DELETE = withUser<Ctx>(async (user, _req, ctx) => {
  await archiveDesign(user.id, (await ctx.params).id);
  return { ok: true };
});
