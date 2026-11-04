'use client';

/**
 * Site plan: plot boundary, setback band and buildable line, road/passage,
 * trees (trunk, protection zone, canopy), the building footprint with its walls,
 * and the actual gap to each boundary (red when short of the setback).
 */
import {
  boundaryGaps,
  buildableRect,
  formatLength,
  footprintOnPlot,
  sideToCompass,
  type BuildingModel,
  type Issue,
  type PlanSide,
} from '@ds/core';
import ZoomSvg from './ZoomSvg';

export default function SitePlanView({ model, issues, hot }: { model: BuildingModel; issues: Issue[]; hot: boolean }) {
  const site = model.site;
  if (!site) {
    return (
      <div className="plan-wrap site-empty">
        <p>No plot yet. Enter the plot size in the <b>Site</b> tab, or tell the assistant, e.g. “plot is 60&apos; east–west by 40&apos; north–south”.</p>
      </div>
    );
  }
  const u = model.displayUnits;
  const W = site.plot.width;
  const D = site.plot.depth;
  const b = buildableRect(site);
  const f = footprintOnPlot(model, site);
  const gaps = boundaryGaps(model, site);
  const font = Math.max(260, Math.min(W, D) / 45);
  const off = site.buildingOffset;
  const mid = { x: (f.x0 + f.x1) / 2, y: (f.y0 + f.y1) / 2 };

  // Gap dimension lines from the building's outer face to each boundary.
  const gapLine = (side: PlanSide) => {
    const g = gaps[side];
    const short = g < site.setbacks[side] - 1;
    const cls = `gap ${short ? 'short' : ''}`;
    const text = formatLength(Math.max(Math.round(g), 0), u);
    const shift = (Math.min(f.x1 - f.x0, f.y1 - f.y0) / 2) * 0.55;
    if (side === 'top' || side === 'bottom') {
      const x = mid.x + shift;
      const [y0, y1] = side === 'top' ? [0, f.y0] : [f.y1, D];
      return (
        <g key={side} className={cls}>
          <line x1={x} y1={y0} x2={x} y2={y1} />
          <text x={x + font * 0.3} y={(y0 + y1) / 2 + font * 0.35} fontSize={font * 0.85} textAnchor="start">{text}</text>
        </g>
      );
    }
    const y = mid.y + shift;
    const [x0, x1] = side === 'left' ? [0, f.x0] : [f.x1, W];
    return (
      <g key={side} className={cls}>
        <line x1={x0} y1={y} x2={x1} y2={y} />
        <text x={(x0 + x1) / 2} y={y - font * 0.35} fontSize={font * 0.85} textAnchor="middle">{text}</text>
      </g>
    );
  };

  // Setback labels in the band on each side.
  const setbackLabel = (side: PlanSide) => {
    const s = site.setbacks[side];
    if (s <= 0) return null;
    const c = sideToCompass(side, model.northAngle);
    const txt = `${c} setback ${formatLength(s, u)}`;
    if (side === 'top' || side === 'bottom') {
      const y = side === 'top' ? s / 2 : D - s / 2;
      return <text key={side} className="setback-label" x={W * 0.2} y={y + font * 0.3} fontSize={font * 0.8} textAnchor="middle">{txt}</text>;
    }
    const x = side === 'left' ? s / 2 : W - s / 2;
    const y = D * 0.72;
    return (
      <text key={side} className="setback-label" x={x} y={y} fontSize={font * 0.8} textAnchor="middle" transform={`rotate(-90 ${x} ${y})`}>
        {txt}
      </text>
    );
  };

  const accessBand = (a: (typeof site.access)[number]) => {
    const wdt = a.width;
    const r =
      a.side === 'top' ? { x: 0, y: 0, w: W, h: wdt } : a.side === 'bottom' ? { x: 0, y: D - wdt, w: W, h: wdt } : a.side === 'left' ? { x: 0, y: 0, w: wdt, h: D } : { x: W - wdt, y: 0, w: wdt, h: D };
    const horizontal = a.side === 'top' || a.side === 'bottom';
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const label = `${a.kind === 'road' ? 'Road' : 'Passage'} ${formatLength(wdt, u)}`;
    return (
      <g key={a.side} className={`access ${a.kind}`}>
        <rect x={r.x} y={r.y} width={r.w} height={r.h} />
        <text x={horizontal ? W * 0.62 : cx} y={horizontal ? cy + font * 0.35 : D * 0.3} fontSize={font} textAnchor="middle" transform={horizontal ? undefined : `rotate(-90 ${cx} ${D * 0.3})`}>
          {label}
        </text>
      </g>
    );
  };

  return (
    <ZoomSvg bounds={{ x0: 0, y0: 0, x1: W, y1: D }} pad={Math.max(W, D) * 0.12} label={`Site plan of ${model.name}`}>
      <defs>
        <pattern id="setback-hatch" width="400" height="400" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="400" className="hatch-line" />
        </pattern>
      </defs>

      {/* Plot and setback band */}
      <rect x={0} y={0} width={W} height={D} className="plot-band" />
      <rect x={b.x0} y={b.y0} width={Math.max(b.x1 - b.x0, 0)} height={Math.max(b.y1 - b.y0, 0)} className="buildable" />
      {b.x1 > b.x0 && b.y1 > b.y0 && (
        <text x={b.x0 + font * 0.4} y={b.y1 - font * 0.5} fontSize={font * 0.85} className="plinth-label">
          Plinth limit {formatLength(b.x1 - b.x0, u)} × {formatLength(b.y1 - b.y0, u)}
        </text>
      )}
      {site.access.map(accessBand)}
      <rect x={0} y={0} width={W} height={D} className={`plot-line ${hot ? 'hot' : ''}`} />
      {(['top', 'bottom', 'left', 'right'] as PlanSide[]).map(setbackLabel)}

      {/* Trees: canopy, protection zone, trunk */}
      {site.trees.map((t) => (
        <g key={t.id} className={`tree ${t.keep ? 'keep' : ''}`}>
          <title>{`${t.label}${t.keep ? ' (to keep)' : ''}`}</title>
          <circle cx={t.at.x} cy={t.at.y} r={t.canopyRadius} className="canopy" />
          <circle cx={t.at.x} cy={t.at.y} r={t.protectRadius} className="protect" />
          <circle cx={t.at.x} cy={t.at.y} r={180} className="trunk" />
          <text x={t.at.x} y={t.at.y + t.protectRadius + font * 1.1} fontSize={font * 0.85} textAnchor="middle">{t.label}</text>
        </g>
      ))}

      {/* Building footprint with its walls */}
      <rect x={f.x0} y={f.y0} width={f.x1 - f.x0} height={f.y1 - f.y0} className={`footprint ${hot ? 'hot' : ''}`} />
      <g transform={`translate(${off.x} ${off.y})`}>
        {model.walls.map((w) => (
          <line key={w.id} x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} strokeWidth={w.thickness} strokeLinecap="square" className="site-wall" />
        ))}
      </g>
      <text x={mid.x} y={mid.y} fontSize={font * 1.1} textAnchor="middle" className="footprint-label">
        Building {formatLength(f.x1 - f.x0, u)} × {formatLength(f.y1 - f.y0, u)}
      </text>

      {(['top', 'bottom', 'left', 'right'] as PlanSide[]).map(gapLine)}

      {/* Plot dimensions */}
      <g className="dim">
        <line x1={0} y1={-font * 2} x2={W} y2={-font * 2} />
        <line x1={0} y1={-font * 2.6} x2={0} y2={-font * 1.4} />
        <line x1={W} y1={-font * 2.6} x2={W} y2={-font * 1.4} />
        <text x={W / 2} y={-font * 2.5} fontSize={font} textAnchor="middle">
          Plot {formatLength(W, u)} ({sideToCompass('left', model.northAngle)[0]!.toUpperCase()}–{sideToCompass('right', model.northAngle)[0]!.toUpperCase()})
        </text>
        <line x1={-font * 2} y1={0} x2={-font * 2} y2={D} />
        <text x={-font * 2.5} y={D / 2} fontSize={font} textAnchor="middle" transform={`rotate(-90 ${-font * 2.5} ${D / 2})`}>
          Plot {formatLength(D, u)}
        </text>
      </g>

      {/* Issue markers in site coordinates */}
      {issues.filter((i) => i.space === 'site' && i.at).map((i, k) => (
        <g key={k} className={`issue ${i.severity}`}>
          <title>{i.message}</title>
          <circle cx={i.at!.x} cy={i.at!.y} r={font * 0.8} />
          <text x={i.at!.x} y={i.at!.y + font * 0.38} fontSize={font * 1.05}>!</text>
        </g>
      ))}

      <g className="north" transform={`translate(${W + font * 3} ${font * 1.5}) rotate(${model.northAngle})`}>
        <polygon points={`0,${-font * 1.6} ${font * 0.75},${font * 0.8} 0,${font * 0.4} ${-font * 0.75},${font * 0.8}`} />
        <text y={font * 2} fontSize={font} textAnchor="middle">N</text>
      </g>
    </ZoomSvg>
  );
}
