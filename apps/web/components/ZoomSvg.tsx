'use client';

/**
 * SVG frame with on-screen zoom and pan buttons (pinch-zoom is unreliable in
 * WhatsApp's in-app browser), plus drag-to-pan and wheel zoom as extras.
 * Content is drawn in model units (mm); `bounds` is what "Fit" shows.
 *
 * Children can start an element drag via useDrag(): the frame then reports the
 * pointer movement in model units instead of panning.
 */
import { createContext, useCallback, useContext, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from 'react';

interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Vec {
  x: number;
  y: number;
}

interface DragHandlers {
  move: (d: Vec) => void;
  end: (d: Vec) => void;
}

const DragContext = createContext<((e: PointerEvent<SVGElement>, h: DragHandlers) => void) | null>(null);

/** Returns a function to call from an element's onPointerDown, or null when the frame isn't editable. */
export function useDrag() {
  return useContext(DragContext);
}

export default function ZoomSvg({
  bounds,
  pad,
  label,
  editable = false,
  children,
}: {
  bounds: Bounds;
  pad: number;
  label: string;
  editable?: boolean;
  children: ReactNode;
}) {
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
  const panFrom = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ start: Vec; h: DragHandlers } | null>(null);

  const toModel = (clientX: number, clientY: number): Vec => {
    const svg = ref.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const beginDrag = useCallback((e: PointerEvent<SVGElement>, h: DragHandlers) => {
    drag.current = { start: toModel(e.clientX, e.clientY), h };
  }, []);

  const down = (e: PointerEvent<SVGSVGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!drag.current) panFrom.current = { x: e.clientX, y: e.clientY };
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current) {
      const p = toModel(e.clientX, e.clientY);
      drag.current.h.move({ x: p.x - drag.current.start.x, y: p.y - drag.current.start.y });
      return;
    }
    if (!panFrom.current || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const dx = (e.clientX - panFrom.current.x) / r.width;
    const dy = (e.clientY - panFrom.current.y) / r.height;
    panFrom.current = { x: e.clientX, y: e.clientY };
    pan(-dx, -dy);
  };
  const up = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current) {
      const p = toModel(e.clientX, e.clientY);
      const d = drag.current;
      drag.current = null;
      d.h.end({ x: p.x - d.start.x, y: p.y - d.start.y });
    }
    panFrom.current = null;
  };
  const cancel = () => {
    if (drag.current) {
      const d = drag.current;
      drag.current = null;
      d.h.end({ x: 0, y: 0 });
    }
    panFrom.current = null;
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
        className={`plan-svg ${editable ? 'editable' : ''}`}
        viewBox={`${view.cx - w / 2} ${view.cy - h / 2} ${w} ${h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onWheel={wheel}
        role="img"
        aria-label={label}
      >
        <DragContext.Provider value={editable ? beginDrag : null}>{children}</DragContext.Provider>
      </svg>
    </div>
  );
}
