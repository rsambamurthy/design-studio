'use client';

import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  buildableRect,
  buildingOuterRect,
  diffModels,
  checkBrief,
  DEFAULT_STRUCTURE,
  generateStructure,
  type Structure,
  costPlan,
  fitBudget,
  formatInr,
  RATE_CARD,
  type BudgetPlan,
  layoutOptions,
  type LayoutOption,
  coincidentSides,
  fixedWallUnder,
  formatLength,
  getWall,
  revisionLetter,
  roomClearRect,
  runChecks,
  type BuildingModel,
  type Issue,
} from '@ds/core';
import AppShell, { type NavKey } from './AppShell';
import PlanView from './PlanView';
import SitePanel, { type ApplyResult, type OpInput } from './SitePanel';
import SitePlanView from './SitePlanView';
import StructureView from './StructureView';
import { api, when } from './DesignsHome';

export interface RevisionMeta {
  number: number;
  parent: number | null;
  label: string | null;
  request: string;
  summary: string;
  createdAt: string;
}

export interface DesignDetail {
  id: string;
  name: string;
  currentRev: number;
  model: BuildingModel;
  revisions: RevisionMeta[];
}

interface ChatEntry {
  role: 'user' | 'ai';
  text: string;
  assumptions?: string[];
  newIssues?: Issue[];
  saved?: number | null;
  options?: string[];
  offline?: boolean;
  error?: boolean;
}

interface Turn {
  reply: string;
  summaries: string[];
  assumptions: string[];
  changedIds: string[];
  newIssues: Issue[];
  question?: { text: string; options: string[] };
  mode: 'llm' | 'offline';
}

interface Share {
  token: string;
  revision: number | null;
  createdAt: string;
}

type Tab = 'assistant' | 'brief' | 'cost' | 'site' | 'versions' | 'share';

/** Example requests built from the design's own rooms, so they always make sense. */
function examplesFor(m: BuildingModel): string[] {
  const out: string[] = [];
  const horizontal = (wallId: string) => {
    try {
      const w = getWall(m, wallId);
      return Math.abs(w.a.y - w.b.y) < 1;
    } catch {
      return false;
    }
  };
  const block = m.rooms.find((r) => r.block && r.kind === 'bedroom');
  if (block) out.push(`Move ${block.name} 3' south`);
  const door = m.openings.find((o) => o.kind === 'door' && horizontal(o.wallId) && o.label !== 'Main door');
  if (door) out.push(`Move the ${door.label} 6 inches east`);
  if (m.rooms.some((r) => r.kind === 'living')) out.push('Add a sofa with chaise on the right in the living room against the west wall');
  return out.slice(0, 3);
}

export default function Studio({ email, initial }: { email: string; initial: DesignDetail }) {
  const [design, setDesign] = useState<DesignDetail>(initial);
  const [tab, setTab] = useState<Tab>('assistant');
  const [log, setLog] = useState<ChatEntry[]>([
    { role: 'ai', text: `Rev ${revisionLetter(initial.currentRev)} loaded. Describe a change in your own words; every change is saved and can be undone.` },
  ]);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [redo, setRedo] = useState<number[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedDoor, setSelectedDoor] = useState<string | null>(null);
  // "Fix the issues" agent run: while running or awaiting Keep/Discard, the plan shows its draft.
  const [run, setRun] = useState<AgentRunView | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const runActive = !!run && (run.status === 'running' || run.status === 'done');
  const [viewing, setViewing] = useState<{ number: number; model: BuildingModel } | null>(null);
  const [compare, setCompare] = useState<number[]>([]);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [labelEdit, setLabelEdit] = useState<{ n: number; text: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [planMode, setPlanMode] = useState<'plan' | 'site' | 'structure'>('plan');
  const [structSet, setStructSet] = useState({ floors: 2, sbc: 150 });
  const [editStatus, setEditStatus] = useState<{ text: string; error: boolean } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // "Give me options": layouts worked out in the browser; one may be previewed on the plan.
  const [options, setOptions] = useState<{ rev: number; list: LayoutOption[] } | null>(null);
  const [optionsBusy, setOptionsBusy] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const shownOptions = options && options.rev === design.currentRev ? options.list : null;
  const previewOpt = preview !== null && shownOptions ? shownOptions[preview] : undefined;
  const model = runActive ? run!.model : previewOpt ? previewOpt.model : viewing?.model ?? design.model;
  const selectedRoom = model.rooms.find((r) => r.id === selected && r.block);
  const selectedDoorObj = model.openings.find((o) => o.id === selectedDoor);
  const current = design.revisions.find((r) => r.number === design.currentRev);
  const issues = useMemo(() => runChecks(model), [model]);
  const structure = useMemo(() => (planMode === 'structure' ? generateStructure(model, { ...DEFAULT_STRUCTURE, ...structSet }) : null), [model, planMode, structSet]) as Structure;
  const counts = {
    error: issues.filter((i) => i.severity === 'error').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    advisory: issues.filter((i) => i.severity === 'advisory').length,
  };
  const carpetSqFt = useMemo(() => {
    const mm2 = model.rooms.filter((r) => r.kind !== 'lobby').reduce((s, r) => {
      const c = roomClearRect(model, r);
      return s + (c.x1 - c.x0) * (c.y1 - c.y0);
    }, 0);
    return Math.round(mm2 / 92903.04);
  }, [model]);
  const outer = buildingOuterRect(model);
  const overall = `${formatLength(outer.x1 - outer.x0, model.displayUnits)} × ${formatLength(outer.y1 - outer.y0, model.displayUnits)} outside`;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [log, busy]);
  useEffect(() => {
    if (tab === 'share' && shares === null) void loadShares();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Kept in step with the log so a run of instructions sends the latest conversation.
  const chatRef = useRef<ChatEntry[]>([]);
  function say(entry: ChatEntry) {
    chatRef.current = [...chatRef.current, entry];
    setLog((l) => [...l, entry]);
  }

  /** Direct edits (site form): same typed operations, saved as one revision. */
  async function applyOps(request: string, ops: OpInput[], showSite = true): Promise<ApplyResult> {
    if (busy) return { error: 'Please wait for the current change to finish.' };
    setBusy(true);
    try {
      const r = await api<{ revision: number | null; summaries: string[]; assumptions: string[]; changedIds: string[]; newIssues: Issue[]; design: DesignDetail }>(
        `/api/designs/${design.id}/ops`,
        { method: 'POST', json: { request, ops, baseRev: design.currentRev } },
      );
      setDesign(r.design);
      setChanged(new Set(r.changedIds));
      setRedo([]);
      setViewing(null);
      if (showSite) setPlanMode('site');
      setEditStatus({ text: `${r.summaries.join(' ')}${r.revision ? ` · saved as Rev ${revisionLetter(r.revision)}` : ''}`, error: false });
      say({ role: 'user', text: request });
      say({ role: 'ai', text: r.summaries.join(' '), assumptions: r.assumptions, newIssues: r.newIssues, saved: r.revision });
      return { summary: r.summaries.join(' '), assumptions: r.assumptions, newIssues: r.newIssues, revision: r.revision };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not save that change.';
      setEditStatus({ text: msg, error: true });
      return { error: msg };
    } finally {
      setBusy(false);
    }
  }

  async function makeOptions() {
    setOptionsBusy(true);
    setPreview(null);
    setSelected(null);
    setSelectedDoor(null);
    // Let the button show it is working before the (synchronous-heavy) layouts run.
    await new Promise((r) => setTimeout(r, 30));
    try {
      const list = await layoutOptions(design.model);
      setOptions({ rev: design.currentRev, list });
      setPreview(0);
    } catch (e) {
      setEditStatus({ text: e instanceof Error ? e.message : 'Could not work out options.', error: true });
    } finally {
      setOptionsBusy(false);
    }
  }

  async function useOption(o: LayoutOption) {
    const r = await applyOps(`Layout option: ${o.strategy.name}`, o.ops, false);
    if (!r.error) {
      setOptions(null);
      setPreview(null);
    }
  }

  /** A block from the palette dropped or tapped onto the plan. */
  function place(kind: string, p: { x: number; y: number }) {
    setPlacing(null);
    const item = PALETTE.find((b) => b.kind === kind);
    if (!item) return;
    const at = { x: Math.round(p.x), y: Math.round(p.y) };
    const op = kind === 'stair' ? { op: 'add_stair', args: at } : kind === 'lift' ? { op: 'add_lift', args: at } : { op: 'add_room', args: { kind, ...at } };
    void applyOps(`Added a ${item.label.toLowerCase()}`, [op], false);
  }

  /** Drag edits on the plan or site: saved like any other change; disabled while viewing old revisions. */
  const dragEdit = viewing || busy || runActive || previewOpt ? undefined : (request: string, ops: OpInput[]) => void applyOps(request, ops, false);

  // Pick up a run left open (e.g. after a reload), then follow it while it runs.
  useEffect(() => {
    api<{ run: AgentRunView | null }>(`/api/designs/${design.id}/agent`).then((r) => setRun(r.run)).catch(() => {});
  }, [design.id]);
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const t = setInterval(() => {
      api<{ run: AgentRunView }>(`/api/designs/${design.id}/agent/${run.id}`).then((r) => setRun(r.run)).catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [run?.id, run?.status, design.id]);

  async function startFix(kind: 'fix' | 'brief' = 'fix') {
    setRunBusy(true);
    setSelected(null);
    setSelectedDoor(null);
    try {
      const r = await api<{ run: AgentRunView }>(`/api/designs/${design.id}/agent`, { method: 'POST', json: { kind } });
      setRun(r.run);
    } catch (e) {
      say({ role: 'ai', text: e instanceof Error ? e.message : 'Could not start.', error: true });
    } finally {
      setRunBusy(false);
    }
  }

  async function runAction(action: 'stop' | 'keep' | 'discard') {
    if (!run) return;
    setRunBusy(true);
    try {
      const r = await api<{ run: AgentRunView; revision?: number | null; design?: DesignDetail }>(`/api/designs/${design.id}/agent/${run.id}`, {
        method: 'POST',
        json: { action },
      });
      if (action === 'keep' && r.design) {
        applyDesign(r.design);
        setRedo([]);
        setRun(null);
        say({ role: 'ai', text: run.kind === 'brief' ? `Kept the agent's changes for the brief.` : `Kept the agent's fixes.`, saved: r.revision ?? undefined });
      } else if (action === 'discard') {
        setRun(null);
      } else {
        setRun(r.run);
      }
    } catch (e) {
      say({ role: 'ai', text: e instanceof Error ? e.message : 'That did not work.', error: true });
      setEditStatus({ text: e instanceof Error ? e.message : 'That did not work.', error: true });
    } finally {
      setRunBusy(false);
    }
  }

  function applyDesign(next: DesignDetail) {
    setChanged(new Set(diffModels(design.model, next.model).changed));
    setDesign(next);
    setViewing(null);
  }

  /** One instruction as one turn. Returns false when the run of instructions should stop. */
  async function sendOne(message: string, step?: { n: number; of: number }): Promise<boolean> {
    say({ role: 'user', text: step ? `(${step.n}/${step.of}) ${message}` : message });
    try {
      const history = chatRef.current
        .filter((e) => e.text && !e.error)
        .slice(-16)
        .map((e) => ({ role: e.role, text: e.text, options: e.options }));
      const r = await api<{ turn: Turn; revision: number | null; design: DesignDetail }>(`/api/designs/${design.id}/chat`, {
        method: 'POST',
        json: { message, history },
      });
      if (r.revision) {
        setDesign(r.design);
        setChanged(new Set(r.turn.changedIds));
        setRedo([]);
        setViewing(null);
        if (r.turn.changedIds.includes('site')) setPlanMode('site');
      }
      say({
        role: 'ai',
        text: r.turn.reply,
        assumptions: r.turn.assumptions,
        newIssues: r.revision ? r.turn.newIssues : undefined,
        saved: r.revision,
        options: r.turn.question?.options,
        offline: r.turn.mode === 'offline',
      });
      // A question back, or nothing changed: stop so the user can answer or fix it.
      return !!r.revision && !r.turn.question;
    } catch (e) {
      say({ role: 'ai', text: e instanceof Error ? e.message : 'Something went wrong.', error: true });
      return false;
    }
  }

  /** Send one instruction, or several (one per line) that run in turn, each saved as its own revision. */
  async function send(text: string) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0 || busy) return;
    setInput('');
    if (lines.length === 1) {
      const message = lines[0]!;
      if (/^(undo|undo that|go back)$/i.test(message)) return void undo(message);
      if (/^redo$/i.test(message)) return void redoLast(message);
    }
    setEditStatus(null);
    setBusy(true);
    try {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const step = lines.length > 1 ? { n: i + 1, of: lines.length } : undefined;
        if (step && /^(undo|undo that|go back|redo)$/i.test(line)) {
          say({ role: 'ai', text: 'Undo and redo can\'t run inside a list of instructions; use the Undo and Redo buttons. Skipped that line.' });
          continue;
        }
        const ok = await sendOne(line, step);
        if (!ok && i < lines.length - 1) {
          const rest = lines.slice(i + 1);
          setInput(rest.join('\n'));
          say({ role: 'ai', text: `Stopped after step ${i + 1} of ${lines.length}. The remaining ${rest.length === 1 ? 'instruction is' : `${rest.length} instructions are`} back in the box; press Enter to carry on.` });
          break;
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function restore(target: number, kind: 'undo' | 'redo' | 'restore') {
    setEditStatus(null);
    const r = await api<{ revision: number | null; design: DesignDetail }>(`/api/designs/${design.id}/restore`, {
      method: 'POST',
      json: { revision: target, kind, baseRev: design.currentRev },
    });
    applyDesign(r.design);
    return r;
  }

  async function undo(said?: string) {
    if (said) say({ role: 'user', text: said });
    if (!current?.parent || busy) return say({ role: 'ai', text: 'Nothing to undo.' });
    setBusy(true);
    try {
      const undone = design.currentRev;
      const r = await restore(current.parent, 'undo');
      setRedo((s) => [...s, undone]);
      say({ role: 'ai', text: r.design.revisions[0]?.summary ?? 'Undone.', saved: r.revision });
    } catch (e) {
      say({ role: 'ai', text: e instanceof Error ? e.message : 'Undo failed.', error: true });
    } finally {
      setBusy(false);
    }
  }

  async function redoLast(said?: string) {
    if (said) say({ role: 'user', text: said });
    const target = redo[redo.length - 1];
    if (!target || busy) return say({ role: 'ai', text: 'Nothing to redo.' });
    setBusy(true);
    try {
      const r = await restore(target, 'redo');
      setRedo((s) => s.slice(0, -1));
      say({ role: 'ai', text: r.design.revisions[0]?.summary ?? 'Redone.', saved: r.revision });
    } catch (e) {
      say({ role: 'ai', text: e instanceof Error ? e.message : 'Redo failed.', error: true });
    } finally {
      setBusy(false);
    }
  }

  async function view(n: number) {
    if (n === design.currentRev) return setViewing(null);
    setBusy(true);
    try {
      const r = await api<{ model: BuildingModel }>(`/api/designs/${design.id}/revisions/${n}`);
      setViewing({ number: n, model: r.model });
      setChanged(new Set());
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not load that revision.');
    } finally {
      setBusy(false);
    }
  }

  async function restoreViewed() {
    if (!viewing || busy) return;
    setBusy(true);
    try {
      const r = await restore(viewing.number, 'restore');
      setRedo([]);
      say({ role: 'ai', text: `Restored Rev ${revisionLetter(viewing.number)} as Rev ${revisionLetter(r.revision ?? design.currentRev)}.`, saved: r.revision });
      setTab('assistant');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Restore failed.');
    } finally {
      setBusy(false);
    }
  }

  async function saveLabel(n: number, text: string) {
    try {
      await api(`/api/designs/${design.id}/revisions/${n}`, { method: 'POST', json: { label: text } });
      setDesign((d) => ({ ...d, revisions: d.revisions.map((r) => (r.number === n ? { ...r, label: text.trim() || null } : r)) }));
      setLabelEdit(null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not save the name.');
    }
  }

  async function loadShares() {
    try {
      setShares((await api<{ shares: Share[] }>(`/api/designs/${design.id}/shares`)).shares);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not load share links.');
    }
  }

  async function newShare(pinned: boolean) {
    setBusy(true);
    try {
      await api(`/api/designs/${design.id}/shares`, { method: 'POST', json: { revision: pinned ? design.currentRev : null } });
      await loadShares();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not create the link.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(token: string) {
    if (!window.confirm('Stop this link from working? Anyone you sent it to will lose access.')) return;
    await api(`/api/designs/${design.id}/shares?token=${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(() => undefined);
    await loadShares();
  }

  const shareUrl = (t: string) => `${typeof window === 'undefined' ? '' : window.location.origin}/s/${t}`;
  const onNav = (k: NavKey) => {
    setTab(k === 'versions' ? 'versions' : k === 'share' ? 'share' : k === 'site' ? 'site' : k === 'cost' ? 'cost' : 'assistant');
    if (k === 'site') setPlanMode('site');
  };
  const navActive: NavKey = tab === 'versions' ? 'versions' : tab === 'share' ? 'share' : tab === 'site' ? 'site' : tab === 'cost' ? 'cost' : 'studio';

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  // Enter sends; Alt+Enter (or Shift+Enter) adds a line. Each line runs as its own step.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const onInputKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.altKey || e.shiftKey) {
      e.preventDefault();
      // Insert in place so the caret stays put, however fast the typing.
      const el = e.currentTarget;
      el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end');
      setInput(el.value);
      return;
    }
    e.preventDefault();
    void send(input);
  };
  const lineCount = input.split('\n').filter((l) => l.trim()).length;

  return (
    <AppShell email={email} chip={design.name} active={navActive} designId={design.id} onNav={onNav}>
      <h1>{design.name}</h1>
      <p className="sa-subtitle">
        {model.levelName} · Rev {revisionLetter(viewing?.number ?? design.currentRev)}
        {current?.label && !viewing ? ` (${current.label})` : ''} · {overall} · north is {model.northAngle === 0 ? 'up' : `${model.northAngle}° from up`}
      </p>
      {notice && (
        <p className="form-error" role="alert">
          {notice} <button className="linkish" onClick={() => setNotice('')}>dismiss</button>
        </p>
      )}

      <div className="workspace">
        <section className="card side-card" aria-label="Assistant, versions and sharing">
          <div className="tabs side-tabs" role="tablist">
            {(['assistant', 'brief', 'cost', 'site', 'versions', 'share'] as Tab[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={`tab ${tab === t ? 'on' : ''}`}
                onClick={() => {
                  setTab(t);
                  if (t === 'site') setPlanMode('site');
                }}
              >
                {t === 'assistant' ? 'Assistant' : t === 'brief' ? 'Brief' : t === 'cost' ? 'Cost' : t === 'site' ? 'Site' : t === 'versions' ? `Versions (${design.revisions.length})` : 'Share'}
              </button>
            ))}
          </div>

          {tab === 'assistant' && (
            <div className="chat">
              <div className="chat-log" ref={logRef}>
                {log.map((m, i) => (
                  <div key={i} className={`msg ${m.role} ${m.error ? 'error' : ''}`}>
                    {m.text}
                    {m.assumptions && m.assumptions.length > 0 && <span className="assume">Assumed: {m.assumptions.join(' ')}</span>}
                    {m.newIssues && m.newIssues.length > 0 && <span className="delta warn">{m.newIssues.map((x) => `⚠ ${x.message}`).join(' ')}</span>}
                    {m.saved && m.newIssues?.length === 0 && <span className="delta">✓ All checks still pass</span>}
                    {m.saved && <span className="mode">Saved as Rev {revisionLetter(m.saved)}</span>}
                    {m.options && (
                      <span className="options">
                        {m.options.map((o) => (
                          <button key={o} className="btn-secondary" onClick={() => void send(o)} disabled={busy}>{o}</button>
                        ))}
                      </span>
                    )}
                    {m.offline && <span className="mode">offline mode · no API key set</span>}
                  </div>
                ))}
                {busy && <div className="msg ai typing">Working…</div>}
              </div>
              {log.length <= 1 && design.revisions.length <= 1 && (
                <div className="examples">
                  {examplesFor(design.model).map((e) => (
                    <button key={e} className="btn-secondary example" onClick={() => void send(e)} disabled={busy}>{e}</button>
                  ))}
                </div>
              )}
              <form className="chat-input" onSubmit={onSubmit}>
                <textarea
                  ref={inputRef}
                  value={input}
                  rows={Math.min(6, Math.max(1, input.split('\n').length))}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onInputKey}
                  placeholder={viewing ? 'Back to current to edit…' : 'Describe a change… (Alt+Enter for another line)'}
                  aria-label="Describe a change"
                  disabled={busy || !!viewing}
                />
                <button className="btn-primary" type="submit" disabled={busy || !input.trim() || !!viewing}>{lineCount > 1 ? `Run ${lineCount}` : 'Send'}</button>
              </form>
              <button type="button" className="link-btn chat-download" onClick={() => downloadChat(design.name, log)}>
                ⤓ Download chat
              </button>
              <p className="chat-hint">Enter sends · Alt+Enter adds another instruction; they run one after the other, each saved as its own revision.</p>
            </div>
          )}

          {tab === 'brief' && (
            <BriefPanel
              key={`${design.id}-${design.currentRev}`}
              model={design.model}
              draft={runActive && run!.kind === 'brief' ? run!.model : undefined}
              busy={busy || runBusy || !!viewing}
              running={runActive}
              onSave={(items) => void applyOps(items.length ? 'Updated the brief' : 'Cleared the brief', [{ op: 'set_brief', args: { items } }], false)}
              onMeet={() => void startFix('brief')}
              onOptions={() => void makeOptions()}
              optionsBusy={optionsBusy}
              options={shownOptions}
              preview={preview}
              onPreview={setPreview}
            />
          )}

          {tab === 'cost' && (
            <CostPanel
              key={`${design.id}-${design.currentRev}`}
              model={model}
              editable={!busy && !viewing && !runActive && !previewOpt}
              onOps={(request, ops) => void applyOps(request, ops, false)}
            />
          )}

          {tab === 'site' && (
            viewing ? (
              <p className="card-desc">You&apos;re viewing an old revision. Go back to current to edit the site.</p>
            ) : (
              <SitePanel model={design.model} busy={busy} apply={applyOps} revLabel={revisionLetter} />
            )
          )}

          {tab === 'versions' && (
            <div className="versions">
              <p className="card-desc">Tap a revision to view it. Tick two to compare.</p>
              {compare.length === 2 && (
                <a className="btn-primary btn-sm compare-go" href={`/d/${design.id}/compare?a=${Math.min(...compare)}&b=${Math.max(...compare)}`}>
                  Compare Rev {revisionLetter(Math.min(...compare))} ↔ Rev {revisionLetter(Math.max(...compare))}
                </a>
              )}
              <ul className="rev-list">
                {design.revisions.map((r) => {
                  const isCurrent = r.number === design.currentRev;
                  const isViewing = viewing?.number === r.number || (!viewing && isCurrent);
                  return (
                    <li key={r.number} className={`rev ${isViewing ? 'on' : ''}`}>
                      <input
                        type="checkbox"
                        aria-label={`Select Rev ${revisionLetter(r.number)} to compare`}
                        checked={compare.includes(r.number)}
                        onChange={(e) => setCompare((c) => (e.target.checked ? [...c, r.number].slice(-2) : c.filter((x) => x !== r.number)))}
                      />
                      <button className="rev-main" onClick={() => void view(r.number)} disabled={busy}>
                        <span className="rev-head">
                          <b>Rev {revisionLetter(r.number)}</b>
                          {r.label && <span className="badge badge-purple">{r.label}</span>}
                          {isCurrent && <span className="badge badge-green">current</span>}
                        </span>
                        <span className="rev-sum">{r.summary}</span>
                        <span className="rev-when">{when(r.createdAt)}</span>
                      </button>
                      {labelEdit?.n === r.number ? (
                        <form className="row rev-label" onSubmit={(e) => { e.preventDefault(); void saveLabel(r.number, labelEdit.text); }}>
                          <input value={labelEdit.text} onChange={(e) => setLabelEdit({ n: r.number, text: e.target.value })} placeholder="e.g. Option 2" maxLength={60} autoFocus aria-label="Revision name" />
                          <button className="btn-primary btn-sm">Save</button>
                        </form>
                      ) : (
                        <button className="linkish rev-name-btn" onClick={() => setLabelEdit({ n: r.number, text: r.label ?? '' })}>{r.label ? 'Rename' : 'Name it'}</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {tab === 'share' && (
            <div className="share">
              <p className="card-desc">View-only links: anyone with the link can see the plan, not edit it. They open fine inside WhatsApp.</p>
              <div className="row wrap">
                <button className="btn-primary btn-sm" onClick={() => void newShare(false)} disabled={busy}>New link (always latest)</button>
                <button className="btn-secondary btn-sm" onClick={() => void newShare(true)} disabled={busy}>New link (Rev {revisionLetter(design.currentRev)} only)</button>
              </div>
              {shares === null ? (
                <p className="card-desc">Loading…</p>
              ) : shares.length === 0 ? (
                <p className="card-desc">No links yet.</p>
              ) : (
                <ul className="share-list">
                  {shares.map((s) => (
                    <li key={s.token}>
                      <div className="share-what">{s.revision ? `Rev ${revisionLetter(s.revision)} only` : 'Always latest'} · {when(s.createdAt)}</div>
                      <input readOnly value={shareUrl(s.token)} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
                      <div className="row wrap">
                        <button className="btn-secondary btn-sm" onClick={() => void navigator.clipboard?.writeText(shareUrl(s.token)).then(() => setNotice('Link copied.'))}>Copy</button>
                        <a className="btn-secondary btn-sm" href={`https://wa.me/?text=${encodeURIComponent(`${design.name}: ${shareUrl(s.token)}`)}`} target="_blank" rel="noreferrer">WhatsApp</a>
                        <button className="btn-secondary btn-sm danger-text" onClick={() => void revoke(s.token)}>Stop link</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className="card plan-card" aria-label="Plan">
          <div className="canvas-head">
            <div className="tabs">
              <button type="button" className={`tab ${planMode === 'plan' ? 'on' : ''}`} onClick={() => setPlanMode('plan')}>Plan</button>
              <button type="button" className={`tab ${planMode === 'site' ? 'on' : ''}`} onClick={() => setPlanMode('site')}>Site</button>
              <button type="button" className={`tab ${planMode === 'structure' ? 'on' : ''}`} onClick={() => setPlanMode('structure')}>Structure</button>
              <span className="tab off" title="Coming soon">Elevation</span>
              <span className="tab off" title="Coming soon">3D</span>
            </div>
            <div className="history-btns">
              {viewing ? (
                <>
                  <button className="btn-secondary" onClick={() => setViewing(null)} disabled={busy}>Back to current</button>
                  <button className="btn-primary" onClick={() => void restoreViewed()} disabled={busy}>Restore Rev {revisionLetter(viewing.number)}</button>
                </>
              ) : (
                <>
                  <button className="btn-secondary" onClick={() => void undo()} disabled={!current?.parent || busy}>↶ Undo</button>
                  <button className="btn-secondary" onClick={() => void redoLast()} disabled={redo.length === 0 || busy}>↷ Redo</button>
                </>
              )}
            </div>
          </div>
          {viewing && <p className="viewing-banner">Viewing Rev {revisionLetter(viewing.number)} (read-only)</p>}
          {planMode === 'structure' ? (
            <>
              <p className="struct-banner">Preliminary structural layout from this plan, for a structural engineer to check, design and sign. Not for construction.</p>
              <StructureView model={model} structure={structure} />
              <StructurePanel structure={structure} settings={structSet} onSettings={setStructSet} />
            </>
          ) : planMode === 'site' ? (
            <SitePlanView model={model} issues={issues} hot={changed.has('site')} onEdit={dragEdit} />
          ) : (
            <>
              {!viewing && !runActive && !previewOpt && (
                <div className="palette" role="toolbar" aria-label="Room blocks">
                  <span className="palette-title">Drag into the plan</span>
                  {PALETTE.map((b) => (
                    <button
                      key={b.kind}
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', b.kind);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => setPlacing((k) => (k === b.kind ? null : b.kind))}
                      className={`block-chip ${b.kind} ${placing === b.kind ? 'on' : ''}`}
                      disabled={busy}
                      title={`Drag a ${b.label.toLowerCase()} into the plan, or tap here and then tap the plan`}
                    >
                      <span className="block-swatch" aria-hidden="true" />
                      {b.label}
                    </button>
                  ))}
                </div>
              )}
              {previewOpt && (
                <div className="draft-banner option-banner">
                  <span>
                    Option {preview! + 1} of {shownOptions!.length}: <b>{previewOpt.strategy.name}</b>, not saved yet.
                  </span>
                  <span className="option-banner-btns">
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setPreview(null)}>Back to my plan</button>
                    <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void useOption(previewOpt)}>Use this option</button>
                  </span>
                </div>
              )}
              {runActive && <p className="draft-banner">Agent draft, not saved yet. {run!.status === 'running' ? 'Working…' : 'Keep or discard it below the plan.'}</p>}
              {placing && <p className="placing-hint">Tap the plan where the {PALETTE.find((b) => b.kind === placing)?.label.toLowerCase()} goes. <button className="link-btn" onClick={() => setPlacing(null)}>Cancel</button></p>}
              <PlanView
                model={model}
                changedIds={changed}
                issues={issues}
                onEdit={dragEdit}
                onPlace={dragEdit ? place : undefined}
                placing={placing}
                selectedId={selected}
                onSelect={(id) => {
                  setSelected(id);
                  if (id) setSelectedDoor(null);
                }}
                selectedDoorId={selectedDoor}
                onSelectDoor={(id) => {
                  setSelectedDoor(id);
                  if (id) setSelected(null);
                }}
              />
              {selectedDoorObj && !viewing && (
                <DoorEditor
                  key={`${selectedDoorObj.id}-${design.currentRev}`}
                  model={model}
                  door={selectedDoorObj}
                  busy={busy}
                  onApply={(request, ops) => void applyOps(request, ops, false)}
                  onRemove={() => {
                    setSelectedDoor(null);
                    void applyOps(`Removed ${selectedDoorObj.label}`, [{ op: 'remove', args: { entityId: selectedDoorObj.id } }], false);
                  }}
                  onClose={() => setSelectedDoor(null)}
                />
              )}
              {selectedRoom && !viewing && (
                <RoomEditor
                  key={`${selectedRoom.id}-${design.currentRev}`}
                  model={model}
                  room={selectedRoom}
                  busy={busy}
                  onApply={(request, ops) => void applyOps(request, ops, false)}
                  onRemove={() => {
                    setSelected(null);
                    void applyOps(`Removed ${selectedRoom.name}`, [{ op: 'remove_room', args: { roomId: selectedRoom.id } }], false);
                  }}
                  onClose={() => setSelected(null)}
                />
              )}
            </>
          )}
          <p className={`edit-status ${editStatus?.error ? 'err' : ''}`} role="status">
            {editStatus ? editStatus.text : viewing ? 'Viewing an old revision: go back to current to edit.' : 'Tip: drag a room by its name to move it; drag its walls to resize it. Doors, windows, furniture, stairs and lifts drag too (snaps to 1").'}
          </p>
          {runActive && <AgentPanel run={run!} busy={runBusy} onAction={(a) => void runAction(a)} />}
          <div className="checks">
            {!runActive && !viewing && counts.error + counts.warning > 0 && (
              <button type="button" className="btn-primary btn-sm fix-btn" onClick={() => void startFix('fix')} disabled={runBusy || busy}>
                ✦ Fix the issues
              </button>
            )}
            <span className={`badge ${counts.error ? 'badge-red' : 'badge-green'}`}>{plural(counts.error, 'error')}</span>
            <span className={`badge ${counts.warning ? 'badge-yellow' : 'badge-green'}`}>{plural(counts.warning, 'warning')}</span>
            <span className="badge badge-gray">{plural(counts.advisory, 'advisory', 'advisories')}</span>
            <span className="badge badge-purple">Advisory only · needs professional sign-off</span>
          </div>
          {issues.length > 0 && (
            <ul className="issue-list">
              {issues.map((i, k) => (
                <li key={k} className={i.severity}>{i.message}</li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="stats">
        <div className="card stat-card"><div className="value">{carpetSqFt.toLocaleString('en-IN')} sq ft</div><div className="label">Carpet area (clear, excl. lobby)</div></div>
        <div className="card stat-card"><div className="value">Rev {revisionLetter(design.currentRev)}</div><div className="label">{design.revisions.length} saved revisions</div></div>
        <div className="card stat-card">
          <div className="value">{Math.round(((outer.x1 - outer.x0) * (outer.y1 - outer.y0)) / 92903.04).toLocaleString('en-IN')} sq ft</div>
          <div className="label">
            Plinth area
            {model.site
              ? (() => {
                  const b = buildableRect(model.site);
                  return ` · limit ${Math.round(((b.x1 - b.x0) * (b.y1 - b.y0)) / 92903.04).toLocaleString('en-IN')} sq ft`;
                })()
              : ''}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Room blocks that can be dragged into the plan. */
const PALETTE = [
  { kind: 'bedroom', label: 'Bedroom' },
  { kind: 'toilet', label: 'Bathroom' },
  { kind: 'kitchen', label: 'Kitchen' },
  { kind: 'lobby', label: 'Lobby' },
  { kind: 'stair', label: 'Stairs' },
  { kind: 'lift', label: 'Lift' },
  { kind: 'other', label: 'Store' },
  { kind: 'pooja', label: 'Pooja' },
];

/** Selected room block: name, clear width and depth, remove. */
function RoomEditor({
  model,
  room,
  busy,
  onApply,
  onRemove,
  onClose,
}: {
  model: BuildingModel;
  room: BuildingModel['rooms'][number];
  busy: boolean;
  onApply: (request: string, ops: OpInput[]) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const c = roomClearRect(model, room);
  const u = model.displayUnits;
  const [name, setName] = useState(room.name);
  const [w, setW] = useState(formatLength(Math.round(c.x1 - c.x0), u));
  const [h, setH] = useState(formatLength(Math.round(c.y1 - c.y0), u));
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const ops: OpInput[] = [];
    const wNow = formatLength(Math.round(c.x1 - c.x0), u);
    const hNow = formatLength(Math.round(c.y1 - c.y0), u);
    if (w.trim() !== wNow || h.trim() !== hNow) {
      ops.push({ op: 'set_room_size', args: { roomId: room.id, ...(w.trim() !== wNow ? { width: w.trim() } : {}), ...(h.trim() !== hNow ? { depth: h.trim() } : {}) } });
    }
    if (name.trim() && name.trim() !== room.name) ops.push({ op: 'rename_room', args: { roomId: room.id, name: name.trim() } });
    if (ops.length) onApply(`Changed ${room.name}`, ops);
  };
  // Rooms this one shares a wall with, plus the open space if a side faces it.
  const sides = ['top', 'bottom', 'left', 'right'] as const;
  const touching = sides.flatMap((sd) => coincidentSides(model, room, sd).map((c) => c.room));
  const open = model.rooms.find((r) => !r.block && (r.kind === 'living' || r.kind === 'dining'));
  const facesOpen = sides.some((sd) => !fixedWallUnder(model, room, sd) && coincidentSides(model, room, sd).length === 0);
  const neighbours = [...new Map([...touching, ...(open && facesOpen ? [open] : [])].map((r) => [r.id, r])).values()];
  const ew = model.northAngle === 0 ? ' (E–W)' : '';
  const ns = model.northAngle === 0 ? ' (N–S)' : '';
  return (
    <form className="room-editor" onSubmit={apply} aria-label={`Edit ${room.name}`}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Room name" />
      </label>
      <label>
        Width{ew}
        <input value={w} onChange={(e) => setW(e.target.value)} aria-label="Room width" />
      </label>
      <label>
        Depth{ns}
        <input value={h} onChange={(e) => setH(e.target.value)} aria-label="Room depth" />
      </label>
      <div className="room-editor-btns">
        <button className="btn-primary" type="submit" disabled={busy}>Apply</button>
        <button className="btn-secondary" type="button" disabled={busy} onClick={() => onApply(`Rotated ${room.name}`, [{ op: 'rotate_room', args: { roomId: room.id, degrees: '90' } }])}>
          ⟳ Rotate 90°
        </button>
        {neighbours.length > 0 && (
          <select
            aria-label="Add a door to"
            value=""
            disabled={busy}
            onChange={(e) => {
              const other = neighbours.find((n) => n.id === e.target.value);
              if (other) onApply(`Door between ${room.name} and ${other.name}`, [{ op: 'add_door_between', args: { roomA: room.id, roomB: other.id } }]);
            }}
          >
            <option value="">Add door to…</option>
            {neighbours.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </select>
        )}
        <button className="btn-secondary" type="button" onClick={onRemove} disabled={busy}>Remove room</button>
        <button className="link-btn" type="button" onClick={onClose}>Close</button>
      </div>
      <p className="room-editor-hint">Clear sizes, inside face to inside face. Sides against walls or other rooms stay put.</p>
    </form>
  );
}

/** Selected door: which room it opens into, hinge side, width, remove. */
function DoorEditor({
  model,
  door,
  busy,
  onApply,
  onRemove,
  onClose,
}: {
  model: BuildingModel;
  door: BuildingModel['openings'][number];
  busy: boolean;
  onApply: (request: string, ops: OpInput[]) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const u = model.displayUnits;
  const [w, setW] = useState(formatLength(door.width, u));
  // The rooms on either side of the door.
  const wall = getWall(model, door.wallId);
  const d = { x: wall.b.x - wall.a.x, y: wall.b.y - wall.a.y };
  const len = Math.hypot(d.x, d.y) || 1;
  const n = { x: d.y / len, y: -d.x / len };
  const p = { x: wall.a.x + (d.x / len) * door.offset, y: wall.a.y + (d.y / len) * door.offset };
  const at = (k: number) => {
    const q = { x: p.x + n.x * (wall.thickness / 2 + 150) * k, y: p.y + n.y * (wall.thickness / 2 + 150) * k };
    const hits = model.rooms.filter((r) => {
      const c = roomClearRect(model, r);
      return q.x >= c.x0 && q.x <= c.x1 && q.y >= c.y0 && q.y <= c.y1;
    });
    return hits.find((r) => r.block) ?? hits[0];
  };
  const sidesRooms = [at(1), at(-1)].filter((r): r is NonNullable<typeof r> => !!r);
  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (w.trim() && w.trim() !== formatLength(door.width, u)) onApply(`Changed ${door.label}`, [{ op: 'edit_door', args: { openingId: door.id, width: w.trim() } }]);
  };
  const isDoor = door.kind === 'door';
  return (
    <form className="room-editor" onSubmit={apply} aria-label={`Edit ${door.label}`}>
      <label>
        {door.label}
        <input value={w} onChange={(e) => setW(e.target.value)} aria-label="Door width" />
      </label>
      <div className="room-editor-btns">
        <button className="btn-primary" type="submit" disabled={busy}>Apply</button>
        {isDoor &&
          sidesRooms.map((r) => (
            <button
              key={r.id}
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => onApply(`${door.label} opens into ${r.name}`, [{ op: 'edit_door', args: { openingId: door.id, opensInto: r.id } }])}
            >
              Opens into {r.name}
            </button>
          ))}
        {isDoor && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => onApply(`Flipped the hinge of ${door.label}`, [{ op: 'edit_door', args: { openingId: door.id, flipHinge: true } }])}>
            ⇆ Flip hinge
          </button>
        )}
        <button className="btn-secondary" type="button" onClick={onRemove} disabled={busy}>Remove</button>
        <button className="link-btn" type="button" onClick={onClose}>Close</button>
      </div>
      <p className="room-editor-hint">Drag the door along its wall to move it.</p>
    </form>
  );
}

/** Save the conversation as a plain text file. */
function downloadChat(name: string, log: ChatEntry[]) {
  const lines: string[] = [`${name} — design chat`, `Saved ${new Date().toLocaleString('en-IN')}`, ''];
  for (const e of log) {
    lines.push(`${e.role === 'user' ? 'You' : 'Assistant'}: ${e.text}`);
    if (e.options?.length) lines.push(`  Options: ${e.options.join(' | ')}`);
    for (const a of e.assumptions ?? []) lines.push(`  Assumed: ${a}`);
    for (const i of e.newIssues ?? []) lines.push(`  ⚠ ${i.message}`);
    if (e.saved) lines.push(`  Saved as Rev ${revisionLetter(e.saved)}`);
    lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^\w\- ]+/g, '').trim() || 'design'} chat.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** What the browser sees of an agent run. */
interface AgentRunView {
  id: string;
  kind: 'fix' | 'brief';
  status: 'running' | 'done' | 'failed' | 'kept' | 'discarded';
  outcome: 'fixed' | 'stuck' | 'limit' | 'stopped' | 'nothing' | null;
  model: BuildingModel;
  steps: { n: number; why: string; summary: string; accepted: boolean; reason?: string; errors: number; warnings: number }[];
  before: { errors: number; warnings: number; briefMet?: number; briefTotal?: number } | null;
  after: { errors: number; warnings: number; briefMet?: number; briefTotal?: number } | null;
  remaining: { message: string; severity: string }[] | null;
  message: string | null;
  mode: string | null;
  stopRequested: boolean;
}

/** Live progress of "Fix the issues", then Keep / Discard. */
function AgentPanel({ run, busy, onAction }: { run: AgentRunView; busy: boolean; onAction: (a: 'stop' | 'keep' | 'discard') => void }) {
  const [showTried, setShowTried] = useState(false);
  const kept = run.steps.filter((s) => s.accepted);
  const tried = run.steps.length - kept.length;
  const running = run.status === 'running';
  const last = run.steps[run.steps.length - 1];
  const now = run.after ?? (last ? { errors: last.errors, warnings: last.warnings } : null);
  const brief = run.kind === 'brief';
  const headline = running
    ? run.stopRequested
      ? 'Stopping after this step…'
      : `${brief ? 'Working on the brief' : 'Fixing issues'}… ${kept.length} change${kept.length === 1 ? '' : 's'} so far`
    : run.outcome === 'fixed'
      ? brief
        ? 'Brief met, with no errors or warnings'
        : 'All errors and warnings fixed'
      : run.outcome === 'nothing'
        ? 'Nothing to fix'
        : run.outcome === 'stopped'
          ? 'Stopped'
          : run.outcome === 'limit'
            ? 'Stopped at the step limit'
            : kept.length
              ? 'Fixed what it could'
              : 'Could not find a fix';
  return (
    <div className={`agent-panel ${running ? 'running' : ''}`} role="status" aria-live="polite">
      <div className="agent-head">
        <strong>{headline}</strong>
        {run.before && now && (
          <span className="agent-counts">
            {brief && run.before.briefTotal ? `Brief ${run.before.briefMet ?? 0}/${run.before.briefTotal} → ${run.after?.briefMet ?? run.before.briefMet ?? 0}/${run.after?.briefTotal ?? run.before.briefTotal} · ` : ''}
            Errors {run.before.errors} → {now.errors} · Warnings {run.before.warnings} → {now.warnings}
          </span>
        )}
        <span className="agent-mode">{run.mode === 'claude' ? 'Claude + rules' : 'Rule-based (no API key)'}</span>
      </div>
      {kept.length > 0 && (
        <ol className="agent-steps">
          {kept.map((s) => (
            <li key={s.n}>
              <span className="ok">✓</span> {s.summary || s.why}
            </li>
          ))}
        </ol>
      )}
      {running && last && !last.accepted && <p className="agent-trying">Trying: {last.why}…</p>}
      {tried > 0 && (
        <button type="button" className="link-btn agent-tried-btn" onClick={() => setShowTried((v) => !v)}>
          {showTried ? 'Hide' : 'Show'} {tried} idea{tried === 1 ? '' : 's'} it tried and turned down
        </button>
      )}
      {showTried && (
        <ul className="agent-tried">
          {run.steps.filter((s) => !s.accepted).map((s) => (
            <li key={s.n}>
              ✗ {s.why} <em>({s.reason})</em>
            </li>
          ))}
        </ul>
      )}
      {!running && run.remaining && run.remaining.length > 0 && (
        <div className="agent-remaining">
          Still open (needs you):
          <ul>
            {run.remaining.map((r, k) => (
              <li key={k} className={r.severity}>{r.message}</li>
            ))}
          </ul>
        </div>
      )}
      {run.status === 'failed' && <p className="error-text">{run.message}</p>}
      <div className="agent-btns">
        {running ? (
          <button type="button" className="btn-secondary" disabled={busy || run.stopRequested} onClick={() => onAction('stop')}>
            ■ Stop
          </button>
        ) : (
          <>
            {kept.length > 0 && (
              <button type="button" className="btn-primary" disabled={busy} onClick={() => onAction('keep')}>
                Keep changes
              </button>
            )}
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => onAction('discard')}>
              {kept.length > 0 ? 'Discard' : 'Close'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

type BriefItemInput = { type: string; rooms: string; zone?: string; width?: string; depth?: string; other?: string; n?: number };

const ZONE_NAMES = ['north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'centre'];

/** The brief as a checklist: choose items, save (a revision), see what is met, run the agent. */
function BriefPanel({
  model,
  draft,
  busy,
  running,
  onSave,
  onMeet,
  onOptions,
  optionsBusy,
  options,
  preview,
  onPreview,
}: {
  model: BuildingModel;
  draft?: BuildingModel;
  busy: boolean;
  running: boolean;
  onSave: (items: BriefItemInput[]) => void;
  onMeet: () => void;
  onOptions: () => void;
  optionsBusy: boolean;
  options: LayoutOption[] | null;
  preview: number | null;
  onPreview: (i: number | null) => void;
}) {
  const saved = (model.brief?.items ?? []) as BriefItemInput[];
  const has = (type: string, rooms: string) => saved.find((i) => i.type === type && i.rooms === rooms);
  const [outer, setOuter] = useState(!!has('outer_wall', 'bedrooms'));
  const [windows, setWindows] = useState(!!has('window', 'bedrooms'));
  const [attached, setAttached] = useState(!!has('attached_toilet', 'bedrooms'));
  const [wet, setWet] = useState(!!has('outer_wall', 'wet rooms'));
  const [kitchen, setKitchen] = useState(has('zone', 'kitchen')?.zone ?? '');
  const [pooja, setPooja] = useState(has('zone', 'pooja')?.zone ?? '');
  const countOf = (rooms: string) => Number(has('count', rooms)?.n ?? 0);
  const [beds, setBeds] = useState(countOf('bedrooms'));
  const [toilets, setToilets] = useState(countOf('toilets'));
  const [kitchens, setKitchens] = useState(countOf('kitchen'));
  const [poojas, setPoojas] = useState(countOf('pooja'));
  const [stores, setStores] = useState(countOf('store'));
  const minItem = has('min_size', 'bedrooms');
  const [minOn, setMinOn] = useState(!!minItem);
  const [minW, setMinW] = useState(minItem?.width ?? "10'");
  const [minD, setMinD] = useState(minItem?.depth ?? "11'");

  const preset = (n: number) => {
    setBeds(n);
    setToilets(n);
    setKitchens(1);
    setPoojas(1);
    setOuter(true);
    setWindows(true);
    setAttached(true);
    setKitchen('south-east');
    setPooja('north-east');
  };
  const items: BriefItemInput[] = [
    ...(beds ? [{ type: 'count', rooms: 'bedrooms', n: beds }] : []),
    ...(toilets ? [{ type: 'count', rooms: 'toilets', n: toilets }] : []),
    ...(kitchens ? [{ type: 'count', rooms: 'kitchen', n: kitchens }] : []),
    ...(poojas ? [{ type: 'count', rooms: 'pooja', n: poojas }] : []),
    ...(stores ? [{ type: 'count', rooms: 'store', n: stores }] : []),
    ...(outer ? [{ type: 'outer_wall', rooms: 'bedrooms' }] : []),
    ...(windows ? [{ type: 'window', rooms: 'bedrooms' }] : []),
    ...(attached ? [{ type: 'attached_toilet', rooms: 'bedrooms' }] : []),
    ...(wet ? [{ type: 'outer_wall', rooms: 'wet rooms' }] : []),
    ...(kitchen ? [{ type: 'zone', rooms: 'kitchen', zone: kitchen }] : []),
    ...(pooja ? [{ type: 'zone', rooms: 'pooja', zone: pooja }] : []),
    ...(minOn ? [{ type: 'min_size', rooms: 'bedrooms', width: minW, depth: minD }] : []),
  ];
  const canon = (list: BriefItemInput[]) =>
    list
      .map((i) => Object.entries(i).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${String(v)}`).sort().join('&'))
      .sort()
      .join('|');
  const dirty = canon(items) !== canon(saved);
  const status = checkBrief(draft ?? model);
  const met = status.filter((r) => r.met).length;
  const missing = status.some((r) => r.item.type === 'count' && !r.met);
  const stepper = (label: string, v: number, set: (n: number) => void, max: number) => (
    <div className="brief-count">
      <span>{label}</span>
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} onClick={() => set(Math.max(0, v - 1))} disabled={v === 0}>−</button>
      <b aria-label={`${label} count`}>{v || '–'}</b>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => set(Math.min(max, v + 1))} disabled={v >= max}>+</button>
    </div>
  );
  const applicable = status.filter((r) => !r.empty).length;
  return (
    <div className="brief-panel">
      <p className="brief-intro">Say what the house needs and save it. The agent adds the missing rooms and rearranges the plan to meet the rest. You keep or discard the result.</p>
      <div className="brief-sub">Rooms the plan needs <span className="brief-presets">{[2, 3, 4].map((n) => <button key={n} type="button" onClick={() => preset(n)}>{n} BHK</button>)}</span></div>
      <div className="brief-counts">
        {stepper('Bedrooms', beds, setBeds, 6)}
        {stepper('Toilets', toilets, setToilets, 8)}
        {stepper('Kitchen', kitchens, setKitchens, 2)}
        {stepper('Pooja', poojas, setPoojas, 1)}
        {stepper('Store', stores, setStores, 2)}
      </div>
      <div className="brief-sub">What every room must have</div>
      <div className="brief-list">
        <label><input type="checkbox" checked={outer} onChange={(e) => setOuter(e.target.checked)} /> Every bedroom on an outer wall</label>
        <label><input type="checkbox" checked={windows} onChange={(e) => setWindows(e.target.checked)} /> Every bedroom has a window</label>
        <label><input type="checkbox" checked={attached} onChange={(e) => setAttached(e.target.checked)} /> Every bedroom has an attached toilet</label>
        <label><input type="checkbox" checked={wet} onChange={(e) => setWet(e.target.checked)} /> Toilets and kitchen on an outer wall (pipes)</label>
        <label className="brief-row">
          <input type="checkbox" checked={!!kitchen} onChange={(e) => setKitchen(e.target.checked ? 'south-east' : '')} /> Kitchen in the
          <select value={kitchen || 'south-east'} disabled={!kitchen} onChange={(e) => setKitchen(e.target.value)} aria-label="Kitchen zone">
            {ZONE_NAMES.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
        <label className="brief-row">
          <input type="checkbox" checked={!!pooja} onChange={(e) => setPooja(e.target.checked ? 'north-east' : '')} /> Pooja in the
          <select value={pooja || 'north-east'} disabled={!pooja} onChange={(e) => setPooja(e.target.value)} aria-label="Pooja zone">
            {ZONE_NAMES.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
        <label className="brief-row">
          <input type="checkbox" checked={minOn} onChange={(e) => setMinOn(e.target.checked)} /> Every bedroom at least
          <input value={minW} onChange={(e) => setMinW(e.target.value)} disabled={!minOn} aria-label="Minimum bedroom width" /> ×
          <input value={minD} onChange={(e) => setMinD(e.target.value)} disabled={!minOn} aria-label="Minimum bedroom depth" />
        </label>
      </div>
      <div className="brief-btns">
        <button type="button" className="btn-secondary btn-sm" disabled={busy || running || !dirty} onClick={() => onSave(items)}>
          Save brief
        </button>
        <button type="button" className="btn-primary btn-sm" disabled={busy || running || dirty || saved.length === 0 || (applicable > 0 && met === applicable)} onClick={onMeet} title={dirty ? 'Save the brief first' : undefined}>
          {missing ? '✦ Lay out the rooms' : '✦ Meet the brief'}
        </button>
        {missing && (
          <button type="button" className="btn-secondary btn-sm" disabled={busy || running || dirty || optionsBusy} onClick={onOptions} title="Three different layouts to compare">
            {optionsBusy ? 'Working out options…' : '✦ Give me options'}
          </button>
        )}
      </div>
      {options && (
        <div className="options" role="list" aria-label="Layout options">
          {options.map((o, i) => {
            const res = checkBrief(o.model);
            const metN = res.filter((r) => r.met).length;
            const tot = res.filter((r) => !r.empty).length;
            const sq = Math.round(o.openArea / 92903.04);
            return (
              <button key={o.strategy.id} type="button" role="listitem" className={`option-card ${preview === i ? 'on' : ''}`} onClick={() => onPreview(preview === i ? null : i)} aria-pressed={preview === i}>
                <MiniPlan model={o.model} />
                <span className="option-text">
                  <b>{i + 1}. {o.strategy.name}</b>
                  <span className="option-desc">{o.strategy.description}</span>
                  <span className="option-stats">
                    Brief {metN}/{tot} · {o.score.errors} error{o.score.errors === 1 ? '' : 's'} · {o.score.warnings} warning{o.score.warnings === 1 ? '' : 's'} · {model.displayUnits === 'ft-in' ? `${sq.toLocaleString('en-IN')} sq ft` : `${(o.openArea / 1e6).toFixed(1)} m²`} living
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {status.length > 0 && (
        <div className="brief-status">
          <div className="brief-status-head">
            {draft ? 'Agent draft: ' : ''}{met} of {applicable} met
          </div>
          <ul>
            {status.map((r, k) => (
              <li key={k} className={r.met ? 'met' : r.empty ? 'empty' : 'unmet'}>
                <span className="mark">{r.met ? '✓' : r.empty ? '–' : '✗'}</span> {r.label}
                {r.empty && <em> (no such rooms yet)</em>}
                {!r.met && r.failing.length > 0 && <div className="why">{(r.item.type === 'count' ? r.failing.slice(0, 1) : r.failing).map((f) => f.why).join('; ')}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const MINI_FILL: Partial<Record<string, string>> = { bedroom: '#fbe9e3', toilet: '#e3ecfb', kitchen: '#fdf3d8', pooja: '#fff1c7', lobby: '#ececf4', other: '#eef3e6' };

/** A small, schematic plan: outer walls and room blocks. */
function MiniPlan({ model }: { model: BuildingModel }) {
  const ext = model.walls.filter((w) => w.kind === 'external');
  const xs = ext.flatMap((w) => [w.a.x, w.b.x]);
  const ys = ext.flatMap((w) => [w.a.y, w.b.y]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  const pad = 400;
  return (
    <svg className="mini-plan" viewBox={`${x0 - pad} ${y0 - pad} ${w + 2 * pad} ${h + 2 * pad}`} aria-hidden="true">
      <rect x={x0} y={y0} width={w} height={h} fill="#fff" stroke="#1f2340" strokeWidth={230} />
      {model.rooms
        .filter((r) => r.block)
        .map((r) => {
          const b = r.block!;
          return <rect key={r.id} x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0} fill={MINI_FILL[r.kind] ?? '#f1f1f4'} stroke="#1f2340" strokeWidth={90} />;
        })}
      {model.rooms
        .filter((r) => r.block && r.kind !== 'toilet' && r.kind !== 'pooja')
        .map((r) => {
          const b = r.block!;
          return (
            <text key={r.id} x={(b.x0 + b.x1) / 2} y={(b.y0 + b.y1) / 2} fontSize={700} textAnchor="middle" dominantBaseline="middle" fill="#1f2340">
              {r.name.replace('Bed ', 'B').replace('Kitchen', 'K')}
            </text>
          );
        })}
    </svg>
  );
}

type CostOp = { op: 'set_costing'; args: Record<string, unknown> };

/** BOQ and cost: quantities from the plan, a grade (or custom rate) per item, budget and "Fit my budget". */
function CostPanel({ model, editable, onOps }: { model: BuildingModel; editable: boolean; onOps: (request: string, ops: CostOp[]) => void }) {
  const boq = costPlan(model);
  const [budgetText, setBudgetText] = useState(boq.budget ? String(Math.round(boq.budget / 1e5 * 10) / 10) : '');
  const [fit, setFit] = useState<BudgetPlan | null>(null);
  const [rateEdit, setRateEdit] = useState<{ id: string; text: string } | null>(null);
  const budgetInr = Math.round(parseFloat(budgetText) * 1e5);
  const budgetOk = Number.isFinite(budgetInr) && budgetInr > 0;
  const groups = [...new Set(boq.lines.map((l) => l.group))];
  const over = boq.budget ? boq.total - boq.budget : 0;
  const qtyText = (q: number, unit: string) => `${unit === 'no.' || unit === 'set' || unit === 'point' || unit === 'sq ft' ? Math.round(q).toLocaleString('en-IN') : q.toLocaleString('en-IN', { maximumFractionDigits: 1 })} ${unit}`;
  return (
    <div className="cost-panel">
      <div className="cost-total">
        <div>
          <div className="cost-big">{formatInr(boq.total)}</div>
          <div className="cost-sub">
            {boq.builtUpSqft.toLocaleString('en-IN')} sq ft built-up · ₹{boq.perSqft.toLocaleString('en-IN')} per sq ft · includes {boq.contingencyPct}% contingency
          </div>
        </div>
        {boq.budget ? (
          <div className={`cost-budget-tag ${over > 0 ? 'over' : 'ok'}`}>{over > 0 ? `${formatInr(over)} over budget` : `${formatInr(-over)} under budget`}</div>
        ) : null}
      </div>
      <div className="cost-budget">
        <label>
          Budget ₹ <input value={budgetText} onChange={(e) => { setBudgetText(e.target.value); setFit(null); }} inputMode="decimal" aria-label="Budget in lakhs" placeholder="e.g. 45" /> lakh
        </label>
        <button type="button" className="btn-secondary btn-sm" disabled={!editable || !budgetOk || budgetInr === boq.budget} onClick={() => onOps(`Budget ${formatInr(budgetInr)}`, [{ op: 'set_costing', args: { budget: budgetInr } }])}>
          Save budget
        </button>
        <button type="button" className="btn-primary btn-sm" disabled={!editable || !budgetOk} onClick={() => setFit(fitBudget(model, budgetInr))}>
          ✦ Fit my budget
        </button>
      </div>
      {fit && (
        <div className="cost-fit" aria-label="Budget suggestions">
          <div className="cost-fit-head">
            {fit.steps.length === 0
              ? fit.met
                ? `Already within ${formatInr(fit.budget)}; nothing to change.`
                : `Nothing more to step down.`
              : `${fit.steps.length} change${fit.steps.length === 1 ? '' : 's'}: ${formatInr(fit.before)} → ${formatInr(fit.after)}`}
          </div>
          <ul>
            {fit.steps.map((st) => (
              <li key={st.id}>
                <b>{st.label}:</b> {st.from} → {st.to} <span className="saves">saves {formatInr(st.saves)}</span>
              </li>
            ))}
          </ul>
          {!fit.met && (
            <p className="cost-fit-gap">
              Still {formatInr(fit.gap)} over with finishes at their simplest. That is about {fit.sqftToCut.toLocaleString('en-IN')} sq ft less built-up area, or a bigger budget.
            </p>
          )}
          <div className="brief-btns">
            {fit.steps.length > 0 && (
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={!editable}
                onClick={() => {
                  const grades = Object.fromEntries(fit.steps.map((st) => [st.id, fit.grades[st.id]]));
                  onOps(`Fit my budget (${formatInr(fit.budget)})`, [{ op: 'set_costing', args: { grades, budget: fit.budget } }]);
                }}
              >
                Use these choices
              </button>
            )}
            <button type="button" className="btn-secondary btn-sm" onClick={() => setFit(null)}>Close</button>
          </div>
        </div>
      )}
      <div className="cost-list" role="table" aria-label="Bill of quantities">
        {groups.map((grp) => (
          <div key={grp} className="cost-grp" role="rowgroup">
            <div className="cost-grp-head" role="row">
              <span>{grp}</span>
              <span>{formatInr(boq.lines.filter((l) => l.group === grp).reduce((a, l) => a + l.amount, 0))}</span>
            </div>
            {boq.lines
              .filter((l) => l.group === grp)
              .map((l) => {
                const item = RATE_CARD.find((x) => x.id === l.id)!;
                return (
                  <div key={l.id} className="cost-row" role="row">
                    <div className="cost-row-top">
                      <span>{l.label}</span>
                      <b>{formatInr(l.amount)}</b>
                    </div>
                    <div className="cost-row-sub">
                      {rateEdit?.id === l.id ? (
                        <form
                          className="rate-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const v = Math.round(Number(rateEdit.text.replace(/[,₹\s]/g, '')));
                            if (Number.isFinite(v) && v >= 0) onOps(`${l.label}: ₹${v.toLocaleString('en-IN')} per ${l.unit}`, [{ op: 'set_costing', args: { rates: { [l.id]: v } } }]);
                            setRateEdit(null);
                          }}
                        >
                          {qtyText(l.qty, l.unit)} × ₹
                          <input autoFocus value={rateEdit.text} onChange={(e) => setRateEdit({ id: l.id, text: e.target.value })} aria-label={`${l.label} rate`} />
                          <button type="submit" className="btn-primary btn-sm">Set</button>
                          <button type="button" className="link-btn" onClick={() => setRateEdit(null)}>Cancel</button>
                        </form>
                      ) : (
                        <span className="cost-calc">
                          {qtyText(l.qty, l.unit)} × ₹{l.rate.toLocaleString('en-IN')}/{l.unit}
                        </span>
                      )}
                      <select
                        aria-label={`${l.label} choice`}
                        value={l.custom ? 'custom' : l.grade}
                        disabled={!editable}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === 'custom') setRateEdit({ id: l.id, text: String(l.rate) });
                          else onOps(`${l.label}: ${item.grades[v as 'basic'].name}`, [{ op: 'set_costing', args: { grades: { [l.id]: v }, ...(l.custom ? { rates: { [l.id]: null } } : {}) } }]);
                        }}
                      >
                        {(['basic', 'standard', 'premium'] as const).map((gr) => (
                          <option key={gr} value={gr}>
                            {item.grades[gr].name}
                          </option>
                        ))}
                        <option value="custom">Custom rate…</option>
                      </select>
                    </div>
                  </div>
                );
              })}
          </div>
        ))}
        <div className="cost-grp-head" role="row">
          <span>Contingency {boq.contingencyPct}%</span>
          <span>{formatInr(boq.contingency)}</span>
        </div>
        <div className="cost-grand" role="row">
          <span>Total</span>
          <span>{formatInr(boq.total)}</span>
        </div>
      </div>
      <p className="cost-note">Indicative Chennai rates (2026) for an RCC framed house, measured from this plan with a 10' floor height. Choose a grade or set your own rate per item; changes are saved as revisions like any other edit. Get a contractor's quote before committing.</p>
    </div>
  );
}

/** Settings, schedules, quantities and notes for the structural layout. */
function StructurePanel({ structure, settings, onSettings }: { structure: Structure; settings: { floors: number; sbc: number }; onSettings: (s: { floors: number; sbc: number }) => void }) {
  const groupBy = <T,>(arr: T[], key: (t: T) => string) => {
    const m = new Map<string, T[]>();
    for (const t of arr) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
    return [...m.entries()];
  };
  const cols = groupBy(structure.columns, (c) => `${c.b} × ${c.d}`);
  const foots = groupBy(structure.columns, (c) => `${(c.footing / 1000).toFixed(1)} m × ${(c.footing / 1000).toFixed(1)} m`).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
  const beams = groupBy(structure.beams, (b) => `${b.width} × ${b.depth}`).sort((a, b) => parseFloat(a[0].split('×')[1]!) - parseFloat(b[0].split('×')[1]!));
  const q = structure.quantities;
  const ids = (xs: { id: string }[]) => (xs.length > 6 ? `${xs.length} no.` : xs.map((x) => x.id).join(', '));
  return (
    <div className="struct-panel">
      <div className="struct-settings">
        <label>
          Floors carried
          <select value={settings.floors} onChange={(e) => onSettings({ ...settings, floors: Number(e.target.value) })} aria-label="Floors carried">
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n === 1 ? 'Ground only' : `G + ${n - 1}`}</option>)}
          </select>
        </label>
        <label>
          Soil (safe bearing)
          <select value={settings.sbc} onChange={(e) => onSettings({ ...settings, sbc: Number(e.target.value) })} aria-label="Soil bearing capacity">
            {[100, 150, 200, 250].map((n) => <option key={n} value={n}>{n} kN/m²</option>)}
          </select>
        </label>
        <span className="struct-count">{structure.columns.length} columns · {structure.beams.length} beams · {structure.slabs.length} slab panels</span>
      </div>
      <div className="struct-grid-cards">
        <div className="struct-card">
          <h4>Columns</h4>
          {cols.map(([k, v]) => <div key={k}><b>{k} mm</b> <span>{ids(v)}</span></div>)}
        </div>
        <div className="struct-card">
          <h4>Footings (isolated)</h4>
          {foots.map(([k, v]) => <div key={k}><b>{k}</b> <span>{ids(v)}</span></div>)}
        </div>
        <div className="struct-card">
          <h4>Beams</h4>
          {beams.map(([k, v]) => <div key={k}><b>{k} mm</b> <span>{v.length} no., up to {(Math.max(...v.map((b) => b.span)) / 1000).toFixed(1)} m</span></div>)}
        </div>
        <div className="struct-card">
          <h4>Concrete and steel</h4>
          {q.parts.map((p) => <div key={p.label}><b>{p.label}</b> <span>{p.concreteM3} m³ · {(p.steelKg / 1000).toFixed(1)} t</span></div>)}
          <div className="struct-total"><b>Total</b> <span>{q.concreteM3} m³ · {(q.steelKg / 1000).toFixed(1)} t steel</span></div>
        </div>
      </div>
      {structure.notes.length > 0 && (
        <ul className="struct-notes">
          {structure.notes.map((n, i) => <li key={i} className={n.severity}>{n.message}</li>)}
        </ul>
      )}
      <p className="cost-note">Rule-of-thumb sizes: columns 230 mm wide, beams about span/12 deep, 125–150 mm slabs, isolated footings from each column&apos;s share of the floor at about 12 kN/m² per floor. Steel by typical kg per m³. Columns go at wall junctions and break spans over 4.5 m.</p>
    </div>
  );
}
