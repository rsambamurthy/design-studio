'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  commit,
  formatLength,
  redo,
  revisionLetter,
  roomClearRect,
  runChecks,
  sampleModel,
  startHistory,
  undo,
  type History,
  type Issue,
} from '@ds/core';
import PlanView from './PlanView';

interface ChatEntry {
  role: 'user' | 'ai';
  text: string;
  assumptions?: string[];
  summaries?: string[];
  newIssues?: Issue[];
  options?: string[];
  offline?: boolean;
  error?: boolean;
}

interface TurnResponse {
  model: History['current']['model'];
  reply: string;
  ops: History['current']['ops'];
  summaries: string[];
  assumptions: string[];
  changedIds: string[];
  newIssues: Issue[];
  question?: { text: string; options: string[] };
  mode: 'llm' | 'offline';
  error?: string;
}

const STORAGE_KEY = 'design-studio:v1';
const EXAMPLES = [
  'Move the Bed 2 door 8 inches east',
  'Add a sofa with chaise on the right in the living room against the west wall',
  'Move the wall between Bed 2 and the kitchen 6" west',
];

export default function Studio() {
  const [history, setHistory] = useState<History>(() => startHistory(sampleModel()));
  const [log, setLog] = useState<ChatEntry[]>([
    { role: 'ai', text: 'Hi! Describe a change in your own words, e.g. "move the Bed 2 door 8 inches east". Every change can be undone.' },
  ]);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Restore / persist (per-browser convenience only; server storage comes next).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { history: History; log: ChatEntry[] };
        if (saved.history?.current?.model?.schema === 1) {
          setHistory(saved.history);
          setLog(saved.log ?? []);
        }
      }
    } catch {
      /* storage unavailable: start fresh */
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ history, log: log.slice(-60) }));
    } catch {
      /* ignore */
    }
  }, [history, log, loaded]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [log, busy]);

  const model = history.current.model;
  const issues = useMemo(() => runChecks(model), [model]);
  const counts = {
    error: issues.filter((i) => i.severity === 'error').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    advisory: issues.filter((i) => i.severity === 'advisory').length,
  };
  const carpetSqFt = useMemo(() => {
    const mm2 = model.rooms
      .filter((r) => r.kind !== 'lobby')
      .reduce((s, r) => {
        const c = roomClearRect(model, r);
        return s + (c.x1 - c.x0) * (c.y1 - c.y0);
      }, 0);
    return Math.round(mm2 / 92903.04);
  }, [model]);

  const xs = model.walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = model.walls.flatMap((w) => [w.a.y, w.b.y]);
  const overall = `${formatLength(Math.max(...xs) - Math.min(...xs), model.displayUnits)} × ${formatLength(Math.max(...ys) - Math.min(...ys), model.displayUnits)}`;

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');

    if (/^(undo|undo that|go back)$/i.test(message)) return doUndo(message);
    if (/^redo$/i.test(message)) return doRedo(message);

    setLog((l) => [...l, { role: 'user', text: message }]);
    setBusy(true);
    try {
      const recent = [...history.past.slice(-4), history.current].map((r) => r.request).filter((r) => r !== 'Initial design');
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, model, recent }),
      });
      const data = (await res.json()) as TurnResponse;
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (data.ops.length > 0) {
        setHistory((h) => commit(h, { request: message, ops: data.ops, summary: data.summaries.join(' '), model: data.model }));
        setChanged(new Set(data.changedIds));
      }
      setLog((l) => [
        ...l,
        {
          role: 'ai',
          text: data.reply,
          summaries: data.ops.length > 0 ? data.summaries : undefined,
          assumptions: data.assumptions,
          newIssues: data.newIssues,
          options: data.question?.options,
          offline: data.mode === 'offline',
        },
      ]);
    } catch (err) {
      setLog((l) => [...l, { role: 'ai', text: err instanceof Error ? err.message : 'Something went wrong.', error: true }]);
    } finally {
      setBusy(false);
    }
  }

  function doUndo(said?: string) {
    if (history.past.length === 0) {
      setLog((l) => [...l, ...(said ? [{ role: 'user' as const, text: said }] : []), { role: 'ai', text: 'Nothing to undo.' }]);
      return;
    }
    const undone = history.current;
    setHistory(undo(history));
    setChanged(new Set());
    setLog((l) => [...l, ...(said ? [{ role: 'user' as const, text: said }] : []), { role: 'ai', text: `Undone: ${undone.summary}` }]);
  }

  function doRedo(said?: string) {
    if (history.future.length === 0) {
      setLog((l) => [...l, ...(said ? [{ role: 'user' as const, text: said }] : []), { role: 'ai', text: 'Nothing to redo.' }]);
      return;
    }
    const next = history.future[0]!;
    setHistory(redo(history));
    setLog((l) => [...l, ...(said ? [{ role: 'user' as const, text: said }] : []), { role: 'ai', text: `Redone: ${next.summary}` }]);
  }

  function reset() {
    setHistory(startHistory(sampleModel()));
    setChanged(new Set());
    setLog([{ role: 'ai', text: 'Started a fresh copy of the sample design.' }]);
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  return (
    <div className="sa-shell">
      <header className="sa-header">
        <div className="sa-logo">Integrata</div>
        <div className="sa-search hide-sm"><input placeholder="Search designs..." aria-label="Search designs" /></div>
        <div className="sa-assoc-chip">🏢 {model.name}</div>
        <div className="sa-header-spacer" />
        <div className="sa-user hide-sm">
          <div className="sa-avatar">DS</div>
          <div>
            <div className="sa-user-name">Design Studio</div>
            <div className="sa-user-role">Preview</div>
          </div>
        </div>
      </header>

      <div className="sa-body">
        <aside className="sa-sidebar">
          <div className="sa-sb-head">Navigation</div>
          <a className="sa-sb-single active">⌂ Design Studio</a>
          {['Plot & Setbacks', 'Floor Plans', 'Elevations & 3D', 'Schedules', 'BOQ & Cost', 'Catalogue', 'Versions', 'Rule Checks'].map((label) => (
            <div key={label} className="sa-mg disabled" title="Coming in a later slice">
              <span className="sa-mg-ic">{label[0]}</span>
              {label}
              <span className="sa-mg-chev">soon</span>
            </div>
          ))}
        </aside>

        <main className="sa-main">
          <h1>{model.name}</h1>
          <p className="sa-subtitle">
            {model.levelName} · Rev {revisionLetter(history.past.length + 1)} · {overall} · north is {model.northAngle === 0 ? 'up' : `${model.northAngle}° from up`}
          </p>

          <div className="workspace">
            <section className="card chat" aria-label="Design assistant">
              <div className="card-title">Design assistant</div>
              <div className="chat-log" ref={logRef}>
                {log.map((m, i) => (
                  <div key={i} className={`msg ${m.role} ${m.error ? 'error' : ''}`}>
                    {m.text}
                    {m.assumptions && m.assumptions.length > 0 && (
                      <span className="assume">Assumed: {m.assumptions.join(' ')}</span>
                    )}
                    {m.newIssues && m.newIssues.length > 0 && (
                      <span className="delta warn">{m.newIssues.map((x) => `⚠ ${x.message}`).join(' ')}</span>
                    )}
                    {m.summaries && m.summaries.length > 0 && m.newIssues?.length === 0 && (
                      <span className="delta">✓ All checks still pass</span>
                    )}
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
              {log.length <= 2 && (
                <div className="examples">
                  {EXAMPLES.map((e) => (
                    <button key={e} className="btn-secondary example" onClick={() => void send(e)} disabled={busy}>{e}</button>
                  ))}
                </div>
              )}
              <form className="chat-input" onSubmit={onSubmit}>
                <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Describe a change…" aria-label="Describe a change" disabled={busy} />
                <button className="btn-primary" type="submit" disabled={busy || !input.trim()}>Send</button>
              </form>
            </section>

            <section className="card plan-card" aria-label="Plan">
              <div className="canvas-head">
                <div className="tabs">
                  <span className="tab on">Plan</span>
                  <span className="tab off" title="Coming soon">Elevation</span>
                  <span className="tab off" title="Coming soon">3D</span>
                  <span className="tab off" title="Coming soon">Schedules</span>
                </div>
                <div className="history-btns">
                  <button className="btn-secondary" onClick={() => doUndo()} disabled={history.past.length === 0 || busy}>↶ Undo</button>
                  <button className="btn-secondary" onClick={() => doRedo()} disabled={history.future.length === 0 || busy}>↷ Redo</button>
                </div>
              </div>
              <PlanView model={model} changedIds={changed} issues={issues} />
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
            <div className="card stat-card"><div className="value">{history.past.length}</div><div className="label">Revisions this session · <button className="linkish" onClick={reset}>reset sample</button></div></div>
            <div className="card stat-card"><div className="value">{model.furniture.length}</div><div className="label">Furniture items placed</div></div>
          </div>
        </main>
      </div>
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
