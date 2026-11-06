'use client';

import { blockWallRects, formatLength, type BuildingModel, type Structure } from '@ds/core';
import ZoomSvg from './ZoomSvg';

const PAD = 2600;
const INK = '#2e2a7a';
const COL = '#8b2c1a';

/** Preliminary structural layout: grid, columns, footings, beams and slab panels over a faint plan. */
export default function StructureView({ model, structure }: { model: BuildingModel; structure: Structure }) {
  const ext = model.walls.filter((w) => w.kind === 'external');
  const xs = ext.flatMap((w) => [w.a.x, w.b.x]);
  const ys = ext.flatMap((w) => [w.a.y, w.b.y]);
  const bounds = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  const u = model.displayUnits;
  const gTop = bounds.y0 - 1700;
  const gLeft = bounds.x0 - 1700;
  const bubble = 330;
  return (
    <ZoomSvg bounds={bounds} pad={PAD} label={`Structural layout of ${model.name}`}>
      <g className="struct-plan" aria-hidden="true">
        {model.walls.map((w) => (
          <line key={w.id} x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke="#d5d8e3" strokeWidth={w.thickness} strokeLinecap="square" />
        ))}
        {blockWallRects(model).map(({ id, rect }) => (
          <rect key={id} x={rect.x0} y={rect.y0} width={rect.x1 - rect.x0} height={rect.y1 - rect.y0} fill="#e2e4ec" />
        ))}
      </g>
      {/* Grid */}
      <g className="struct-grid">
        {structure.gridX.map((g) => (
          <g key={`gx${g.label}`}>
            <line x1={g.x} y1={gTop + bubble} x2={g.x} y2={bounds.y1 + 600} stroke={INK} strokeWidth={14} strokeDasharray="300 120 60 120" opacity={0.6} />
            <circle cx={g.x} cy={gTop} r={bubble} fill="#fff" stroke={INK} strokeWidth={30} />
            <text x={g.x} y={gTop} fontSize={330} textAnchor="middle" dominantBaseline="central" fill={INK} fontWeight={700}>{g.label}</text>
          </g>
        ))}
        {structure.gridY.map((g) => (
          <g key={`gy${g.label}`}>
            <line x1={gLeft + bubble} y1={g.y} x2={bounds.x1 + 600} y2={g.y} stroke={INK} strokeWidth={14} strokeDasharray="300 120 60 120" opacity={0.6} />
            <circle cx={gLeft} cy={g.y} r={bubble} fill="#fff" stroke={INK} strokeWidth={30} />
            <text x={gLeft} y={g.y} fontSize={330} textAnchor="middle" dominantBaseline="central" fill={INK} fontWeight={700}>{g.label}</text>
          </g>
        ))}
        {structure.gridX.slice(1).map((g, i) => {
          const a = structure.gridX[i]!.x;
          return (
            <text key={`dx${g.label}`} x={(a + g.x) / 2} y={gTop - 30} fontSize={210} textAnchor="middle" fill={INK} opacity={0.85}>
              {formatLength(g.x - a, u)}
            </text>
          );
        })}
        {structure.gridY.slice(1).map((g, i) => {
          const a = structure.gridY[i]!.y;
          const cy = (a + g.y) / 2;
          return (
            <text key={`dy${g.label}`} x={gLeft + 20} y={cy} fontSize={210} textAnchor="middle" fill={INK} opacity={0.85} transform={`rotate(-90 ${gLeft + 20} ${cy})`}>
              {formatLength(g.y - a, u)}
            </text>
          );
        })}
      </g>
      {/* Slab panels */}
      {structure.slabs.map((s) => (
        <g key={s.id}>
          {!s.open && <rect x={s.x0 + 120} y={s.y0 + 120} width={s.x1 - s.x0 - 240} height={s.y1 - s.y0 - 240} fill="none" stroke="#7c86b8" strokeWidth={12} strokeDasharray="80 80" />}
          <text x={(s.x0 + s.x1) / 2} y={(s.y0 + s.y1) / 2 + 420} fontSize={190} textAnchor="middle" fill="#5a6390">
            {s.id} · {s.thickness} mm · {s.way}
          </text>
          <text x={(s.x0 + s.x1) / 2} y={(s.y0 + s.y1) / 2 + 160} fontSize={210} textAnchor="middle" fill="#9aa0bb">
            {s.room}
          </text>
        </g>
      ))}
      {/* Footings */}
      {structure.columns.map((c) => (
        <rect key={`f${c.id}`} x={c.x - c.footing / 2} y={c.y - c.footing / 2} width={c.footing} height={c.footing} fill="none" stroke={COL} strokeWidth={14} strokeDasharray="60 60" opacity={0.55} />
      ))}
      {/* Beams */}
      {structure.beams.map((b) => {
        const h = Math.abs(b.y1 - b.y0) < 1;
        const x = Math.min(b.x0, b.x1);
        const y = Math.min(b.y0, b.y1);
        return (
          <g key={b.id}>
            <rect x={h ? x : x - b.width / 2} y={h ? y - b.width / 2 : y} width={h ? b.span : b.width} height={h ? b.width : b.span} fill="rgba(46,42,122,0.08)" stroke={INK} strokeWidth={16} strokeDasharray="120 70" />
            {b.span > 1500 && (
              <text x={(b.x0 + b.x1) / 2 + (h ? 0 : 210)} y={(b.y0 + b.y1) / 2 + (h ? -200 : 0)} fontSize={170} textAnchor="middle" dominantBaseline="central" fill={INK} transform={h ? undefined : `rotate(-90 ${(b.x0 + b.x1) / 2 + 210} ${(b.y0 + b.y1) / 2})`}>
                {b.id} {b.width}×{b.depth}
              </text>
            )}
          </g>
        );
      })}
      {/* Columns */}
      {structure.columns.map((c) => (
        <g key={c.id}>
          <rect x={c.x - c.b / 2} y={c.y - c.d / 2} width={c.b} height={c.d} fill={COL} />
          <text x={c.x + c.b / 2 + 50} y={c.y - c.d / 2 - 40} fontSize={200} fill={COL} fontWeight={700}>
            {c.id}
          </text>
        </g>
      ))}
      {structure.notes
        .filter((n) => n.at && n.severity === 'warning')
        .map((n, i) => (
          <g key={`n${i}`} transform={`translate(${n.at!.x} ${n.at!.y - 600})`}>
            <path d="M0 -260 L240 160 L-240 160 Z" fill="#f59e0b" stroke="#fff" strokeWidth={30} />
            <text y={90} fontSize={240} textAnchor="middle" fill="#fff" fontWeight={800}>!</text>
            <title>{n.message}</title>
          </g>
        ))}
    </ZoomSvg>
  );
}
