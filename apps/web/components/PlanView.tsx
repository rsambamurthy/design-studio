'use client';

/**
 * 2D plan, rendered as SVG directly from the model (plan units = mm).
 * Zoom is driven by on-screen buttons first (pinch-zoom is unreliable in
 * WhatsApp's in-app browser), with drag-to-pan and wheel zoom as extras.
 */
import { useCallback, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import {
  formatLength,
  getCatalogueItem,
  getWall,
  pointOnWall,
  roomClearRect,
  roomSizeText,
  wallDir,
  type BuildingModel,
  type FurnitureItem,
  type Issue,
  type Opening,
  type Point,
} from '@ds/core';

interface Props {
  model: BuildingModel;
  changedIds: Set<string>;
  issues: Issue[];
}

interface View {
  cx: number;
  cy: number;
  scale: number;
}

const PAD = 1800;

export default function PlanView({ model, changedIds, issues }: Props) {
  const bounds = useMemo(() => {
    const xs = model.walls.flatMap((w) => [w.a.x, w.b.x]);
    const ys = model.walls.flatMap((w) => [w.a.y, w.b.y]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }, [model.walls]);

  const base = { w: bounds.x1 - bounds.x0 + PAD * 2, h: bounds.y1 - bounds.y0 + PAD * 2 };
  const fit: View = { cx: (bounds.x0 + bounds.x1) / 2, cy: (bounds.y0 + bounds.y1) / 2, scale: 1 };
  const [view, setView] = useState<View>(fit);
  const w = base.w / view.scale;
  const h = base.h / view.scale;
  const viewBox = `${view.cx - w / 2} ${view.cy - h / 2} ${w} ${h}`;

  const zoom = useCallback((f: number) => setView((v) => ({ ...v, scale: Math.min(8, Math.max(0.5, v.scale * f)) })), []);
  const pan = useCallback((dx: number, dy: number) => setView((v) => ({ ...v, cx: v.cx + (dx * base.w) / v.scale, cy: v.cy + (dy * base.h) / v.scale })), [base.w, base.h]);

  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = (e.clientX - drag.current.x) / rect.width;
    const dy = (e.clientY - drag.current.y) / rect.height;
    drag.current = { x: e.clientX, y: e.clientY };
    pan(-dx, -dy);
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e: WheelEvent<SVGSVGElement>) => zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);

  const u = model.displayUnits;
  const font = 300;

  return (
    <div className="plan-wrap">
      <div className="plan-toolbar" role="toolbar" aria-label="Plan zoom">
        <button className="btn-secondary" onClick={() => zoom(1.4)} aria-label="Zoom in">+</button>
        <button className="btn-secondary" onClick={() => zoom(1 / 1.4)} aria-label="Zoom out">−</button>
        <button className="btn-secondary" onClick={() => setView(fit)}>Fit</button>
        <span className="plan-toolbar-sep" />
        <button className="btn-secondary" onClick={() => pan(-0.15, 0)} aria-label="Pan left">◀</button>
        <button className="btn-secondary" onClick={() => pan(0, -0.15)} aria-label="Pan up">▲</button>
        <button className="btn-secondary" onClick={() => pan(0, 0.15)} aria-label="Pan down">▼</button>
        <button className="btn-secondary" onClick={() => pan(0.15, 0)} aria-label="Pan right">▶</button>
      </div>
      <svg
        ref={svgRef}
        className="plan-svg"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        role="img"
        aria-label={`Plan of ${model.name}`}
      >
        {/* Rooms (fills only; labels are drawn last so furniture never hides them) */}
        {model.rooms.map((r) => {
          const c = roomClearRect(model, r);
          return <rect key={r.id} x={c.x0} y={c.y0} width={c.x1 - c.x0} height={c.y1 - c.y0} className={`room ${r.wet ? 'wet' : ''} ${changedIds.has(r.id) ? 'hot' : ''}`} />;
        })}

        {/* Walls */}
        {model.walls.map((wl) => (
          <line key={wl.id} x1={wl.a.x} y1={wl.a.y} x2={wl.b.x} y2={wl.b.y} strokeWidth={wl.thickness} strokeLinecap="square" className={`wall ${changedIds.has(wl.id) ? 'hot' : ''}`} />
        ))}

        {/* Openings */}
        {model.openings.map((o) => (
          <OpeningShape key={o.id} model={model} o={o} hot={changedIds.has(o.id)} />
        ))}

        {/* Furniture */}
        {model.furniture.map((f) => (
          <FurnitureShape key={f.id} f={f} hot={changedIds.has(f.id)} />
        ))}

        {/* Room labels, scaled to fit small rooms, with a halo for legibility */}
        {model.rooms.map((r) => {
          const c = roomClearRect(model, r);
          const fs = Math.min(font, (c.x1 - c.x0) / 6.5, (c.y1 - c.y0) / 4);
          const cx = (c.x0 + c.x1) / 2;
          const cy = (c.y0 + c.y1) / 2;
          return (
            <g key={`l-${r.id}`} className="room-label">
              <text x={cx} y={cy - fs * 0.2} className="room-name" fontSize={fs}>{r.name}</text>
              <text x={cx} y={cy + fs * 1.05} className="room-size" fontSize={fs * 0.78}>{roomSizeText(model, r)}</text>
            </g>
          );
        })}

        {/* Issue markers */}
        {issues.filter((i) => i.at && i.space !== 'site').map((i, k) => (
          <g key={`${i.code}-${k}`} className={`issue ${i.severity}`}>
            <title>{i.message}</title>
            <circle cx={i.at!.x} cy={i.at!.y} r={230} />
            <text x={i.at!.x} y={i.at!.y + 105} fontSize={300}>!</text>
          </g>
        ))}

        {/* Overall dimensions (wall centre to centre) */}
        <g className="dim">
          <line x1={bounds.x0} y1={bounds.y0 - 900} x2={bounds.x1} y2={bounds.y0 - 900} />
          <line x1={bounds.x0} y1={bounds.y0 - 1100} x2={bounds.x0} y2={bounds.y0 - 700} />
          <line x1={bounds.x1} y1={bounds.y0 - 1100} x2={bounds.x1} y2={bounds.y0 - 700} />
          <text x={(bounds.x0 + bounds.x1) / 2} y={bounds.y0 - 1100} fontSize={font * 0.9}>{formatLength(bounds.x1 - bounds.x0, u)} c/c</text>
          <line x1={bounds.x0 - 900} y1={bounds.y0} x2={bounds.x0 - 900} y2={bounds.y1} />
          <text x={bounds.x0 - 1100} y={(bounds.y0 + bounds.y1) / 2} fontSize={font * 0.9} transform={`rotate(-90 ${bounds.x0 - 1100} ${(bounds.y0 + bounds.y1) / 2})`}>{formatLength(bounds.y1 - bounds.y0, u)} c/c</text>
        </g>

        {/* North arrow */}
        <g className="north" transform={`translate(${bounds.x1 + 900} ${bounds.y0 - 300}) rotate(${model.northAngle})`}>
          <polygon points="0,-520 240,260 0,120 -240,260" />
          <text y={620} fontSize={330}>N</text>
        </g>
      </svg>
    </div>
  );
}

function OpeningShape({ model, o, hot }: { model: BuildingModel; o: Opening; hot: boolean }) {
  const wall = getWall(model, o.wallId);
  const d = wallDir(wall);
  const side = o.swingSide === 'left' ? 1 : -1;
  const n = { x: d.y * side, y: -d.x * side };
  const p = pointOnWall(wall, o.offset);
  const half = o.width / 2;
  const j0 = { x: p.x - d.x * half, y: p.y - d.y * half };
  const j1 = { x: p.x + d.x * half, y: p.y + d.y * half };
  const cls = `opening ${o.kind} ${hot ? 'hot' : ''}`;
  const gap = <line x1={j0.x} y1={j0.y} x2={j1.x} y2={j1.y} strokeWidth={wall.thickness + 10} className="opening-gap" />;

  if (o.kind === 'door') {
    const face = wall.thickness / 2;
    const hingeAt = o.hinge === 'start' ? j0 : j1;
    const other = o.hinge === 'start' ? j1 : j0;
    const hinge = add(hingeAt, scale(n, face));
    const leafEnd = add(hinge, scale(n, o.width));
    const jamb = add(other, scale(n, face));
    const cross = (leafEnd.x - hinge.x) * (jamb.y - hinge.y) - (leafEnd.y - hinge.y) * (jamb.x - hinge.x);
    return (
      <g className={cls}>
        <title>{`${o.label} · ${formatLength(o.width, model.displayUnits)}`}</title>
        {gap}
        <line x1={hinge.x} y1={hinge.y} x2={leafEnd.x} y2={leafEnd.y} className="door-leaf" />
        <path d={`M ${leafEnd.x} ${leafEnd.y} A ${o.width} ${o.width} 0 0 ${cross > 0 ? 1 : 0} ${jamb.x} ${jamb.y}`} className="door-arc" />
      </g>
    );
  }
  const t = wall.thickness / 4;
  const nn = { x: d.y, y: -d.x };
  return (
    <g className={cls}>
      <title>{`${o.label} · ${formatLength(o.width, model.displayUnits)}`}</title>
      {gap}
      {[-t, 0, t].map((k) => (
        <line key={k} x1={j0.x + nn.x * k} y1={j0.y + nn.y * k} x2={j1.x + nn.x * k} y2={j1.y + nn.y * k} className="window-line" />
      ))}
    </g>
  );
}

function FurnitureShape({ f, hot }: { f: FurnitureItem; hot: boolean }) {
  const c = getCatalogueItem(f.catalogueId);
  const W = c?.width ?? 1000;
  const D = c?.depth ?? 600;
  const x0 = -W / 2;
  const y0 = -D / 2;
  // Local frame: front faces +y, back at -y. Sitting on it, your right is -x.
  const rightSign = f.mirrored ? 1 : -1;
  let body;
  switch (f.catalogueId) {
    case 'sofa-3-chaise': {
      const seatD = 900;
      const chaiseW = 900;
      const chaiseX = rightSign < 0 ? x0 : W / 2 - chaiseW;
      body = (
        <>
          <rect x={x0} y={y0} width={W} height={seatD} />
          <rect x={x0} y={y0} width={W} height={220} className="furn-detail" />
          <rect x={chaiseX} y={y0 + seatD} width={chaiseW} height={D - seatD} />
        </>
      );
      break;
    }
    case 'sofa-3':
      body = (
        <>
          <rect x={x0} y={y0} width={W} height={D} />
          <rect x={x0} y={y0} width={W} height={220} className="furn-detail" />
        </>
      );
      break;
    case 'bed-queen':
    case 'bed-king':
      body = (
        <>
          <rect x={x0} y={y0} width={W} height={D} />
          <rect x={x0 + 100} y={y0 + 100} width={W / 2 - 150} height={350} className="furn-detail" />
          <rect x={50} y={y0 + 100} width={W / 2 - 150} height={350} className="furn-detail" />
        </>
      );
      break;
    case 'dining-6':
    case 'dining-4':
      body = (
        <>
          <rect x={x0} y={y0} width={W} height={D} rx={60} />
          {[-0.33, 0, 0.33].filter((k) => W > 1500 || k !== 0).map((k) => (
            <g key={k}>
              <rect x={k * W - 220} y={y0 - 520} width={440} height={420} rx={60} className="furn-detail" />
              <rect x={k * W - 220} y={D / 2 + 100} width={440} height={420} rx={60} className="furn-detail" />
            </g>
          ))}
        </>
      );
      break;
    case 'wardrobe-3':
      body = (
        <>
          <rect x={x0} y={y0} width={W} height={D} />
          <line x1={x0} y1={y0} x2={W / 2} y2={D / 2} className="furn-detail-line" />
          <line x1={x0} y1={D / 2} x2={W / 2} y2={y0} className="furn-detail-line" />
        </>
      );
      break;
    default:
      body = <rect x={x0} y={y0} width={W} height={D} />;
  }
  return (
    <g className={`furniture ${hot ? 'hot' : ''}`} transform={`translate(${f.at.x} ${f.at.y}) rotate(${f.rotation})`}>
      <title>{f.label}</title>
      {body}
    </g>
  );
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}
function scale(a: Point, k: number): Point {
  return { x: a.x * k, y: a.y * k };
}
