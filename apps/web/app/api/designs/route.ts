import { createDesign, listDesigns } from '@/lib/designs';
import { readJson, withUser } from '@/lib/http';

export const runtime = 'nodejs';

export const GET = withUser(async (user) => ({ designs: await listDesigns(user.id) }));

export const POST = withUser(async (user, req) => {
  const body = await readJson(req);
  return { id: await createDesign(user.id, body.name) };
});
