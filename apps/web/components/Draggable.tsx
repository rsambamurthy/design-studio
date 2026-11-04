'use client';

/**
 * A freely draggable group inside a ZoomSvg. On release the offset is snapped to
 * whole inches and turned into up to two compass moves (one per axis).
 */
import { useState, type ReactNode } from 'react';
import { formatFtIn, vectorToCompass } from '@ds/core';
import { useDrag } from './ZoomSvg';

const INCH = 25.4;
const snap = (v: number) => Math.round(v / INCH) * INCH;

export interface DragOp {
  op: string;
  args: Record<string, unknown>;
}

export default function Draggable({
  label,
  northAngle,
  onEdit,
  make,
  children,
}: {
  label: string;
  northAngle: number;
  onEdit?: (request: string, ops: DragOp[]) => void;
  make: (direction: string, distance: string) => DragOp;
  children: ReactNode;
}) {
  const begin = useDrag();
  const [d, setD] = useState<{ x: number; y: number } | null>(null);
  if (!begin || !onEdit) return <g>{children}</g>;
  return (
    <g
      className="drag"
      transform={d ? `translate(${d.x} ${d.y})` : undefined}
      onPointerDown={(e) =>
        begin(e, {
          move: (v) => setD({ x: snap(v.x), y: snap(v.y) }),
          end: (v) => {
            setD(null);
            const ops: DragOp[] = [];
            const words: string[] = [];
            for (const axis of [{ x: 1, y: 0 }, { x: 0, y: 1 }]) {
              const amount = snap(v.x * axis.x + v.y * axis.y);
              if (Math.abs(amount) < INCH) continue;
              const dir = vectorToCompass({ x: axis.x * Math.sign(amount), y: axis.y * Math.sign(amount) }, northAngle);
              const dist = formatFtIn(Math.abs(amount));
              ops.push(make(dir, dist));
              words.push(`${dist} ${dir}`);
            }
            if (ops.length) onEdit(`Dragged ${label} ${words.join(', ')}`, ops);
          },
        })
      }
    >
      {children}
    </g>
  );
}
