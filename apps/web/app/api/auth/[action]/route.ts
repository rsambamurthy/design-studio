import { NextResponse } from 'next/server';
import {
  authErrorResponse,
  currentUser,
  setPin,
  setSessionCookie,
  signInWithPin,
  signOut,
  startSignIn,
  verifyCode,
} from '@/lib/auth';

export const runtime = 'nodejs';

type Body = Record<string, unknown>;

export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* empty body is fine for logout */
  }
  try {
    switch (action) {
      case 'start':
        return NextResponse.json(await startSignIn(body.email, body.forgotPin === true));
      case 'verify':
        return NextResponse.json(await verifyCode(body.email, body.code));
      case 'set-pin': {
        const { user, token } = await setPin(body.setupToken, body.pin);
        await setSessionCookie(token);
        return NextResponse.json({ user });
      }
      case 'pin': {
        const { user, token } = await signInWithPin(body.email, body.pin);
        await setSessionCookie(token);
        return NextResponse.json({ user });
      }
      case 'logout':
        await signOut();
        return NextResponse.json({ ok: true });
      default:
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  } catch (err) {
    const { body: b, status } = authErrorResponse(err);
    return NextResponse.json(b, { status });
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action !== 'me') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    return NextResponse.json({ user: await currentUser() });
  } catch (err) {
    const { body, status } = authErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
