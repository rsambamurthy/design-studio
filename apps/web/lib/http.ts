import { NextResponse } from 'next/server';
import { AuthError, authErrorResponse, requireUser, type User } from './auth';

/** Wrap a route handler: require a signed-in user and map errors to JSON. */
export function withUser<C>(fn: (user: User, req: Request, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C) => {
    try {
      const user = await requireUser();
      const result = await fn(user, req, ctx);
      return result instanceof Response ? result : NextResponse.json(result ?? { ok: true });
    } catch (err) {
      const { body, status } = authErrorResponse(err);
      return NextResponse.json(body, { status });
    }
  };
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function revNumber(input: unknown): number {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1) throw new AuthError('Bad revision number.');
  return n;
}
