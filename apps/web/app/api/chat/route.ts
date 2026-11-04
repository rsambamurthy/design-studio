import { NextResponse } from 'next/server';
import type { BuildingModel } from '@ds/core';
import { errorText, runTurn } from '@/lib/agent';
import { runOfflineTurn } from '@/lib/offline';

export const runtime = 'nodejs';

interface ChatRequest {
  message: string;
  model: BuildingModel;
  recent?: string[];
}

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body?.message || typeof body.message !== 'string' || !body.model || body.model.schema !== 1) {
    return NextResponse.json({ error: 'Expected { message, model }' }, { status: 400 });
  }
  const message = body.message.slice(0, 2000);
  const recent = Array.isArray(body.recent) ? body.recent.slice(-5).map(String) : [];

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(runOfflineTurn(body.model, message));
  }
  try {
    return NextResponse.json(await runTurn(body.model, message, recent));
  } catch (err) {
    console.error('[chat] LLM turn failed', err);
    // Degrade to the offline parser rather than failing the user's edit.
    const fallback = runOfflineTurn(body.model, message);
    return NextResponse.json({ ...fallback, reply: `${fallback.reply} (AI unavailable: ${errorText(err)})` });
  }
}
