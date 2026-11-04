# Design Studio

AI-native residential design tool, India-first. Describe a change in plain
language ("move the Bed 2 door 8 inches east"); the assistant turns it into a
typed edit on one building model, the checks re-run, and the plan redraws.
Styled to match SmartAppt.

**Status: slice 1 — building model + chat edits.** Elevations, 3D, schedules,
BOQ and server-side storage come in later slices.

## Run it

```bash
npm install
cp apps/web/.env.example apps/web/.env.local   # add ANTHROPIC_API_KEY (optional)
npm run dev                                     # http://localhost:3000
npm test                                        # core tests
```

Without an API key the app runs in **offline mode**: a deterministic parser
handles common edits (move / centre / add / flip / remove). With a key, the
Claude agent handles free-form requests and asks when a request is ambiguous.

The key is read on the server only (`apps/web/app/api/chat/route.ts`). Never
give it a `NEXT_PUBLIC_` prefix.

## Layout

```
packages/core   Deterministic design core (no UI, no LLM)
  model.ts      Building model: walls, openings, rooms, furniture; integer mm
  units.ts      ft-in / mm parsing and formatting (never left to the LLM)
  geometry.ts   Compass ↔ plan conversion via the north angle; room rectangles
  ops.ts        Typed operations (zod) — also exported as LLM tool schemas
  kernel.ts     Applies one operation → new model, summary, assumptions, changed ids
  history.ts    One user turn = one revision; undo / redo; revision letters
  checks.ts     Fit, overlaps, front clearances, door swings, room minimums
  summary.ts    Compact model summary for the LLM; plain-language reference resolver
  catalogue.ts  Starter catalogue (Indian-standard sizes)
  seed.ts       Sample 52'6" × 35' 3BHK flat

apps/web        Next.js app
  lib/agent.ts       Claude tool-use loop (server-side)
  lib/offline.ts     No-key fallback parser
  components/        Studio screen, SVG plan view with on-screen zoom/pan buttons
  app/smartappt-theme.css   Tokens extracted from smartapptgold.integratatech.ai
```

## Design rules carried from the reference project

- Everything lives in the model; drawings are outputs, never edited as images.
- Every edit reports what else it touched (`changedIds`) so knock-on effects show.
- Orientation and units are resolved in code, and every reply states the assumption.
- On-screen zoom buttons, no reliance on pinch-zoom (WhatsApp in-app browser).
- Small, exact, reversible steps: each turn is one undoable revision.
- Advisory only: outputs need sign-off by a registered architect / engineer.
