'use client';

/**
 * SVG frame with on-screen zoom and pan buttons (pinch-zoom is unreliable in
 * WhatsApp's in-app browser), plus drag-to-pan and wheel zoom as extras.
 * Content is drawn in model units (mm); `bounds` is what "Fit" shows.
 */
import { useCallback, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from 'react';

interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export default function ZoomSvg({ bounds, pad, label, children }: { bounds: Bounds; pad: number; label: string; children: ReactNode }) {
  const base = { w: bounds.x1 - bounds.x0 + pad * 2, h: bounds.y1 - bounds.y0 + pad * 2 };
  const fit = { cx: (bounds.x0 + bounds.x1) / 2, cy: (bounds.y0 + bounds.y1) / 2, scale: 1 };
  const [view, setView] = useState(fit);
  const w = base.w / view.scale;
  const h = base.h / view.scale;

  const zoom = useCallback((f: number) => setView((v) => ({ ...v, scale: Math.min(8, Math.max(0.5, v.scale * f)) })), []);
  const pan = useCallback(
    (dx: number, dy: number) => setView((v) => ({ ...v, cx: v.cx + (dx * base.w) / v.scale, cy: v.cy + (dy * base.h) / v.scale })),
    [base.w, base.h],
  );

  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const down = (e: PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag.current || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const dx = (e.clientX - drag.current.x) / r.width;
    const dy = (e.clientY - drag.current.y) / r.height;
    drag.current = { x: e.clientX, y: e.clientY };
    pan(-dx, -dy);
  };
  const up = () => {
    drag.current = null;
  };
  const wheel = (e: WheelEvent<SVGSVGElement>) => zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);

  return (
    <div className="plan-wrap">
      <div className="plan-toolbar" role="toolbar" aria-label="Zoom">
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
        ref={ref}
        className="plan-svg"
        viewBox={`${view.cx - w / 2} ${view.cy - h / 2} ${w} ${h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={wheel}
        role="img"
        aria-label={label}
      >
        {children}
      </svg>
    </div>
  );
}
