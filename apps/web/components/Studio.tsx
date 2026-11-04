'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  buildableRect,
  buildingOuterRect,
  diffModels,
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

type Tab = 'assistant' | 'site' | 'versions' | 'share';

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
  const [viewing, setViewing] = useState<{ number: number; model: BuildingModel } | null>(null);
  const [compare, setCompare] = useState<number[]>([]);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [labelEdit, setLabelEdit] = useState<{ n: number; text: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [planMode, setPlanMode] = useState<'plan' | 'site'>('plan');
  const [editStatus, setEditStatus] = useState<{ text: string; error: boolean } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const model = viewing?.model ?? design.model;
  const current = design.revisions.find((r) => r.number === design.currentRev);
  const issues = useMemo(() => runChecks(model), [model]);
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

  function say(entry: ChatEntry) {
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

  /** Drag edits on the plan or site: saved like any other change; disabled while viewing old revisions. */
  const dragEdit = viewing || busy ? undefined : (request: string, ops: OpInput[]) => void applyOps(request, ops, false);

  function applyDesign(next: DesignDetail) {
    setChanged(new Set(diffModels(design.model, next.model).changed));
    setDesign(next);
    setViewing(null);
  }

  /** One instruction as one turn. Returns false when the run of instructions should stop. */
  async function sendOne(message: string, step?: { n: number; of: number }): Promise<boolean> {
    say({ role: 'user', text: step ? `(${step.n}/${step.of}) ${message}` : message });
    try {
      const r = await api<{ turn: Turn; revision: number | null; design: DesignDetail }>(`/api/designs/${design.id}/chat`, {
        method: 'POST',
        json: { message },
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
    setTab(k === 'versions' ? 'versions' : k === 'share' ? 'share' : k === 'site' ? 'site' : 'assistant');
    if (k === 'site') setPlanMode('site');
  };
  const navActive: NavKey = tab === 'versions' ? 'versions' : tab === 'share' ? 'share' : tab === 'site' ? 'site' : 'studio';

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
            {(['assistant', 'site', 'versions', 'share'] as Tab[]).map((t) => (
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
                {t === 'assistant' ? 'Assistant' : t === 'site' ? 'Site' : t === 'versions' ? `Versions (${design.revisions.length})` : 'Share'}
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
              <p className="chat-hint">Enter sends · Alt+Enter adds another instruction; they run one after the other, each saved as its own revision.</p>
            </div>
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
          {planMode === 'site' ? (
            <SitePlanView model={model} issues={issues} hot={changed.has('site')} onEdit={dragEdit} />
          ) : (
            <PlanView model={model} changedIds={changed} issues={issues} onEdit={dragEdit} />
          )}
          <p className={`edit-status ${editStatus?.error ? 'err' : ''}`} role="status">
            {editStatus ? editStatus.text : viewing ? 'Viewing an old revision: go back to current to edit.' : 'Tip: drag a room by its name to move it; drag its walls to resize it. Doors, windows, furniture, stairs and lifts drag too (snaps to 1").'}
          </p>
          <div className="checks">
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
