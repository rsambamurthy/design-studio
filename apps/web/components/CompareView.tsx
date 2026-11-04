'use client';

import { useMemo } from 'react';
import { diffModels, formatLength, revisionLetter, runChecks, type BuildingModel } from '@ds/core';
import AppShell from './AppShell';
import PlanView from './PlanView';

interface Side {
  number: number;
  label: string | null;
  summary: string;
  model: BuildingModel;
}

export default function CompareView({ email, designId, name, a, b }: { email: string; designId: string; name: string; a: Side; b: Side }) {
  const diff = useMemo(() => diffModels(a.model, b.model), [a.model, b.model]);
  const hotB = useMemo(() => new Set([...diff.changed, ...diff.added]), [diff]);
  const hotA = useMemo(() => new Set([...diff.changed, ...diff.removed]), [diff]);
  const u = b.model.displayUnits;
  const sqft = (mm2: number) => (mm2 / 92903.04).toFixed(1);
  const title = (s: Side) => `Rev ${revisionLetter(s.number)}${s.label ? ` · ${s.label}` : ''}`;
  const items = (ids: string[], m: BuildingModel) =>
    ids
      .map((id) => m.furniture.find((f) => f.id === id)?.label ?? m.openings.find((o) => o.id === id)?.label ?? null)
      .filter(Boolean)
      .join(', ');

  return (
    <AppShell email={email} chip={name} active="versions" designId={designId} onNav={() => (window.location.href = `/d/${designId}`)}>
      <h1>Compare {title(a)} ↔ {title(b)}</h1>
      <p className="sa-subtitle">
        <a className="linkish" href={`/d/${designId}`}>← Back to {name}</a> · changed items are highlighted on both plans
      </p>

      <div className="compare-grid">
        {[{ s: a, hot: hotA }, { s: b, hot: hotB }].map(({ s, hot }) => (
          <section key={s.number} className="card plan-card">
            <div className="card-title">{title(s)}</div>
            <p className="card-desc">{s.summary}</p>
            <PlanView model={s.model} changedIds={hot} issues={runChecks(s.model)} />
          </section>
        ))}
      </div>

      <section className="card compare-table">
        <div className="card-title">What changed</div>
        {diff.rooms.length === 0 && diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 ? (
          <p className="card-desc">These two revisions are identical.</p>
        ) : (
          <>
            {diff.rooms.length > 0 && (
              <div className="ent-page-table">
                <table>
                  <thead>
                    <tr><th>Room</th><th>{title(a)} (clear)</th><th>{title(b)} (clear)</th><th>Area change</th></tr>
                  </thead>
                  <tbody>
                    {diff.rooms.map((r) => (
                      <tr key={r.id}>
                        <td>{r.name}</td>
                        <td>{r.before ? `${formatLength(r.before.w, u)} × ${formatLength(r.before.h, u)}` : '—'}</td>
                        <td>{r.after ? `${formatLength(r.after.w, u)} × ${formatLength(r.after.h, u)}` : '—'}</td>
                        <td>{((r.after?.area ?? 0) - (r.before?.area ?? 0)) >= 0 ? '+' : ''}{sqft((r.after?.area ?? 0) - (r.before?.area ?? 0))} sq ft</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <ul className="issue-list plain">
              {diff.added.length > 0 && <li>Added in {title(b)}: {items(diff.added, b.model) || `${diff.added.length} item(s)`}</li>}
              {diff.removed.length > 0 && <li>Removed since {title(a)}: {items(diff.removed, a.model) || `${diff.removed.length} item(s)`}</li>}
              {items(diff.changed, b.model) && <li>Moved or resized: {items(diff.changed, b.model)}</li>}
              <li>Total clear area change: {diff.areaDelta >= 0 ? '+' : ''}{sqft(diff.areaDelta)} sq ft</li>
            </ul>
          </>
        )}
      </section>
    </AppShell>
  );
}
