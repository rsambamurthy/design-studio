'use client';

import { useMemo } from 'react';
import { buildingOuterRect, formatLength, revisionLetter, roomClearRect, roomSizeText, type BuildingModel } from '@ds/core';
import PlanView from './PlanView';

export default function SharedView({ name, revision, pinned, model }: { name: string; revision: number; pinned: boolean; model: BuildingModel }) {
  const empty = useMemo(() => new Set<string>(), []);
  const outer = buildingOuterRect(model);
  const u = model.displayUnits;
  const carpet = model.rooms
    .filter((r) => r.kind !== 'lobby')
    .reduce((s, r) => {
      const c = roomClearRect(model, r);
      return s + (c.x1 - c.x0) * (c.y1 - c.y0);
    }, 0);

  return (
    <div className="sa-shell">
      <header className="sa-header">
        <span className="sa-logo">Integrata</span>
        <div className="sa-assoc-chip">🏢 {name}</div>
      </header>
      <main className="sa-main shared-main">
        <h1>{name}</h1>
        <p className="sa-subtitle">
          {model.levelName} · Rev {revisionLetter(revision)}{pinned ? '' : ' (latest)'} · {formatLength(outer.x1 - outer.x0, u)} × {formatLength(outer.y1 - outer.y0, u)} outside · view only
        </p>
        <section className="card plan-card">
          <PlanView model={model} changedIds={empty} issues={[]} />
          <div className="checks">
            <span className="badge badge-purple">Advisory only · not for construction or approval</span>
          </div>
        </section>
        <section className="card compare-table">
          <div className="card-title">Rooms (clear sizes)</div>
          <div className="ent-page-table">
            <table>
              <thead><tr><th>Room</th><th>Size</th></tr></thead>
              <tbody>
                {model.rooms.map((r) => (
                  <tr key={r.id}><td>{r.name}</td><td>{roomSizeText(model, r)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="card-desc">Carpet area (clear, excluding lobby): {Math.round(carpet / 92903.04).toLocaleString('en-IN')} sq ft</p>
        </section>
        <p className="shared-foot">Made with Design Studio by Integrata</p>
      </main>
    </div>
  );
}
