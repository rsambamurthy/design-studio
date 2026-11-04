'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { revisionLetter } from '@ds/core';
import AppShell from './AppShell';

interface DesignSummary {
  id: string;
  name: string;
  currentRev: number;
  updatedAt: string;
  lastChange: string;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Please sign in.');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export default function DesignsHome({ email }: { email: string }) {
  const [designs, setDesigns] = useState<DesignSummary[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  const load = () =>
    api<{ designs: DesignSummary[] }>('/api/designs')
      .then((r) => setDesigns(r.designs))
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  async function act(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const r = await api<{ id: string }>('/api/designs', { method: 'POST', json: { name: name || 'Untitled design' } });
      window.location.href = `/d/${r.id}`;
    });
  };

  return (
    <AppShell email={email} active="designs">
      <h1>My Designs</h1>
      <p className="sa-subtitle">Every change is saved as a revision. Open a design to keep editing.</p>

      <form className="card new-design" onSubmit={create}>
        <div className="card-title">New design</div>
        <p className="card-desc">Starts from the sample 52&apos;6&quot; × 35&apos; 3BHK flat; reshape it by conversation.</p>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lalitha Apartment Design 1" aria-label="Design name" maxLength={120} />
          <button className="btn-primary" disabled={busy}>Create</button>
        </div>
      </form>

      {error && <p className="form-error" role="alert">{error}</p>}

      {designs === null ? (
        <p className="sa-subtitle">Loading…</p>
      ) : designs.length === 0 ? (
        <p className="sa-subtitle empty">No designs yet. Create your first one above.</p>
      ) : (
        <div className="design-grid">
          {designs.map((d) => (
            <div key={d.id} className="card design-card">
              {renaming === d.id ? (
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      await api(`/api/designs/${d.id}`, { method: 'POST', json: { name: renameText } });
                      setRenaming(null);
                      await load();
                    });
                  }}
                >
                  <input value={renameText} onChange={(e) => setRenameText(e.target.value)} autoFocus aria-label="New name" maxLength={120} />
                  <button className="btn-primary" disabled={busy}>Save</button>
                  <button type="button" className="btn-secondary" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              ) : (
                <a className="design-open" href={`/d/${d.id}`}>
                  <div className="card-title">{d.name}</div>
                  <div className="card-desc">Rev {revisionLetter(d.currentRev)} · {when(d.updatedAt)}</div>
                  <div className="design-last">{d.lastChange}</div>
                </a>
              )}
              <div className="design-actions">
                <a className="btn-primary btn-sm" href={`/d/${d.id}`}>Open</a>
                <button className="btn-secondary btn-sm" disabled={busy} onClick={() => { setRenaming(d.id); setRenameText(d.name); }}>Rename</button>
                <button
                  className="btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const r = await api<{ id: string }>(`/api/designs/${d.id}`, { method: 'POST', json: { duplicate: true, name: `${d.name} (copy)` } });
                      window.location.href = `/d/${r.id}`;
                    })
                  }
                >
                  Duplicate
                </button>
                <button
                  className="btn-secondary btn-sm danger-text"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Archive "${d.name}"? It will disappear from this list and its share links will stop working.`)) return;
                    void act(async () => {
                      await api(`/api/designs/${d.id}`, { method: 'DELETE' });
                      await load();
                    });
                  }}
                >
                  Archive
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
