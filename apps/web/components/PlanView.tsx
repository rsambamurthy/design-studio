'use client';

/**
 * 2D plan, rendered as SVG directly from the model (plan units = mm).
 * Zoom/pan come from ZoomSvg (on-screen buttons first). When `onEdit` is given,
 * walls, doors, windows, furniture, stairs and lifts can be dragged; each drag
 * becomes the same typed operations as chat, snapped to whole inches.
 */
import { useMemo, useState, type PointerEvent } from 'react';
import {
  coreFootprint,
  itemFootprint,
  enclosureOf,
  blockWallRects,
  formatFtIn,
  formatLength,
  getCatalogueItem,
  getWall,
  pointOnWall,
  roomClearRect,
  roomSizeText,
  vectorToCompass,
  wallDir,
  type BuildingModel,
  type CoreElement,
  type FurnitureItem,
  type Issue,
  type Opening,
  type Room,
  type Point,
} from '@ds/core';
import ZoomSvg, { useDrag, type Vec } from './ZoomSvg';

export interface EditOp {
  op: string;
  args: Record<string, unknown>;
}

interface Props {
  model: BuildingModel;
  changedIds: Set<string>;
  issues: Issue[];
  /** Enables dragging; called once per finished drag. */
  onEdit?: (request: string, ops: EditOp[]) => void;
}

const PAD = 1800;
const INCH = 25.4;

export default function PlanView({ model, changedIds, issues, onEdit }: Props) {
  const bounds = useMemo(() => {
    const xs = model.walls.flatMap((w) => [w.a.x, w.b.x]);
    const ys = model.walls.flatMap((w) => [w.a.y, w.b.y]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }, [model.walls]);
  return (
    <ZoomSvg bounds={bounds} pad={PAD} label={`Plan of ${model.name}`} editable={!!onEdit}>
      <PlanContent model={model} changedIds={changedIds} issues={issues} onEdit={onEdit} bounds={bounds} />
    </ZoomSvg>
  );
}

/** Snap to whole inches; returns 0 below half an inch. */
function snap(v: number): number {
  return Math.round(v / INCH) * INCH;
}

function PlanContent({ model, changedIds, issues, onEdit, bounds }: Props & { bounds: { x0: number; y0: number; x1: number; y1: number } }) {
  const begin = useDrag();
  const [preview, setPreview] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const u = model.displayUnits;
  const font = 300;
  const compass = (v: Vec) => vectorToCompass(v, model.northAngle);
  const shift = (id: string) => (preview?.id === id ? `translate(${preview.dx} ${preview.dy})` : undefined);

  /** Start a drag whose movement is constrained by `project` (returns the allowed offset). */
  const startDrag = (e: PointerEvent<SVGElement>, id: string, project: (d: Vec) => Vec, finish: (d: Vec) => void) => {
    if (!begin || !onEdit) return;
    begin(e, {
      move: (d) => {
        const p = project(d);
        setPreview({ id, dx: p.x, dy: p.y });
      },
      end: (d) => {
        setPreview(null);
        finish(project(d));
      },
    });
  };

  /** Turn a free x/y offset into up to two compass moves. */
  const freeMoves = (d: Vec, label: string, make: (direction: string, distance: string) => EditOp) => {
    const ops: EditOp[] = [];
    const words: string[] = [];
    for (const axis of [{ x: 1, y: 0 }, { x: 0, y: 1 }]) {
      const amount = snap(d.x * axis.x + d.y * axis.y);
      if (Math.abs(amount) < INCH) continue;
      const dir = compass({ x: axis.x * Math.sign(amount), y: axis.y * Math.sign(amount) });
      const dist = formatFtIn(Math.abs(amount));
      ops.push(make(dir, dist));
      words.push(`${dist} ${dir}`);
    }
    if (ops.length) onEdit?.(`Dragged ${label} ${words.join(', ')}`, ops);
  };

  const dragWall = (e: PointerEvent<SVGElement>, wallId: string) => {
    const w = getWall(model, wallId);
    const d = wallDir(w);
    const n = { x: -d.y, y: d.x };
    startDrag(
      e,
      wallId,
      (v) => {
        const t = snap(v.x * n.x + v.y * n.y);
        return { x: n.x * t, y: n.y * t };
      },
      (v) => {
        const t = v.x * n.x + v.y * n.y;
        if (Math.abs(t) < INCH) return;
        const dir = compass({ x: n.x * Math.sign(t), y: n.y * Math.sign(t) });
        const dist = formatFtIn(Math.abs(t));
        onEdit?.(`Dragged a wall ${dist} ${dir}`, [{ op: 'move_wall', args: { wallId, direction: dir, distance: dist } }]);
      },
    );
  };

  const dragOpening = (e: PointerEvent<SVGElement>, o: Opening) => {
    const d = wallDir(getWall(model, o.wallId));
    startDrag(
      e,
      o.id,
      (v) => {
        const t = snap(v.x * d.x + v.y * d.y);
        return { x: d.x * t, y: d.y * t };
      },
      (v) => {
        const t = v.x * d.x + v.y * d.y;
        if (Math.abs(t) < INCH) return;
        const dir = compass({ x: d.x * Math.sign(t), y: d.y * Math.sign(t) });
        const dist = formatFtIn(Math.abs(t));
        onEdit?.(`Dragged ${o.label} ${dist} ${dir}`, [{ op: 'move_opening', args: { openingId: o.id, direction: dir, distance: dist } }]);
      },
    );
  };

  const free = (v: Vec) => ({ x: snap(v.x), y: snap(v.y) });

  /** Room under a point (clear area). */
  const roomAt = (p: Vec) =>
    model.rooms.find((r) => {
      const c = roomClearRect(model, r);
      return p.x >= c.x0 && p.x <= c.x1 && p.y >= c.y0 && p.y <= c.y1;
    });
  const [grab, setGrab] = useState<{ roomId: string; from: Vec } | null>(null);
  /** The room a dragged room would swap with: for blocks, another block under the dragged room's centre. */
  const dropOn = (roomId: string, p: Vec): Room | undefined => {
    const self = model.rooms.find((x) => x.id === roomId);
    if (self?.block) {
      return model.rooms.find((x) => {
        if (!x.block || x.id === roomId) return false;
        const c = roomClearRect(model, x);
        return p.x >= c.x0 && p.x <= c.x1 && p.y >= c.y0 && p.y <= c.y1;
      });
    }
    const t = roomAt(p);
    return t && t.id !== roomId ? t : undefined;
  };
  const dropTarget = (() => {
    if (!grab || !preview || preview.id !== `room:${grab.roomId}`) return undefined;
    const t = dropOn(grab.roomId, { x: grab.from.x + preview.dx, y: grab.from.y + preview.dy });
    return t;
  })();

  /**
   * Drag a room by its name. A room block moves (snapping to 1"); a room fixed
   * by walls (older designs) swaps places with the room it's dropped on.
   */
  const dragRoom = (e: PointerEvent<SVGElement>, r: Room, from: Vec) => {
    if (!onEdit) return;
    if (!r.block && (r.kind === 'living' || r.kind === 'dining') && model.rooms.some((x) => x.block)) return;
    setGrab({ roomId: r.id, from });
    if (r.block) {
      startDrag(e, `room:${r.id}`, free, (v) => {
        setGrab(null);
        const target = dropOn(r.id, { x: from.x + v.x, y: from.y + v.y });
        if (target) {
          onEdit(`Moved ${r.name} to where ${target.name} is`, [{ op: 'swap_rooms', args: { roomA: r.id, roomB: target.id } }]);
          return;
        }
        freeMoves(v, r.name, (direction, distance) => ({ op: 'move_room', args: { roomId: r.id, direction, distance } }));
      });
      return;
    }
    startDrag(e, `room:${r.id}`, (v) => v, (v) => {
      setGrab(null);
      const target = roomAt({ x: from.x + v.x, y: from.y + v.y });
      if (!target || target.id === r.id) return;
      onEdit(`Moved ${r.name} to where ${target.name} is`, [{ op: 'swap_rooms', args: { roomA: r.id, roomB: target.id } }]);
    });
  };

  return (
    <>
      {/* Rooms (fills only; labels are drawn last so furniture never hides them) */}
      {[...model.rooms].sort((a, b) => Number(!!a.block) - Number(!!b.block)).map((r) => {
        const c = roomClearRect(model, r);
        return <rect key={r.id} x={c.x0} y={c.y0} width={c.x1 - c.x0} height={c.y1 - c.y0} className={`room ${r.wet ? 'wet' : ''} ${r.kind === 'stair' || r.kind === 'lift' ? 'core-room' : ''} ${changedIds.has(r.id) ? 'hot' : ''}`} />;
      })}

      {/* Walls */}
      {model.walls.map((wl) => (
        <g key={wl.id} data-id={wl.id} transform={shift(wl.id)} className={onEdit ? 'drag' : undefined} onPointerDown={(e) => dragWall(e, wl.id)}>
          <title>{onEdit ? 'Drag to move this wall' : undefined}</title>
          <line x1={wl.a.x} y1={wl.a.y} x2={wl.b.x} y2={wl.b.y} strokeWidth={wl.thickness} strokeLinecap="square" className={`wall ${changedIds.has(wl.id) || preview?.id === wl.id ? 'hot' : ''}`} />
          {onEdit && <line x1={wl.a.x} y1={wl.a.y} x2={wl.b.x} y2={wl.b.y} strokeWidth={Math.max(wl.thickness, 360)} className="hit" />}
        </g>
      ))}

      {/* Room block walls (each block's own walls; drag one to resize the room) */}
      {blockWallRects(model).map(({ id, rect }) => (
        <g key={id} data-id={id} transform={shift(id)} className={onEdit ? 'drag' : undefined} onPointerDown={(e) => dragWall(e, id)}>
          <title>{onEdit ? 'Drag to resize this room' : undefined}</title>
          <rect x={rect.x0} y={rect.y0} width={rect.x1 - rect.x0} height={rect.y1 - rect.y0} className={`block-wall ${changedIds.has(id) || preview?.id === id ? 'hot' : ''}`} />
          {onEdit && (() => {
            const horizontal = rect.x1 - rect.x0 > rect.y1 - rect.y0;
            const pad = 120;
            return horizontal
              ? <rect x={rect.x0} y={rect.y0 - pad} width={rect.x1 - rect.x0} height={rect.y1 - rect.y0 + 2 * pad} className="hit" />
              : <rect x={rect.x0 - pad} y={rect.y0} width={rect.x1 - rect.x0 + 2 * pad} height={rect.y1 - rect.y0} className="hit" />;
          })()}
        </g>
      ))}

      {/* Ghost of a room block being dragged */}
      {grab && !dropTarget && preview?.id === `room:${grab.roomId}` && (() => {
        const r = model.rooms.find((x) => x.id === grab.roomId);
        if (!r?.block) return null;
        const b = r.block;
        return <rect x={b.x0 + preview.dx} y={b.y0 + preview.dy} width={b.x1 - b.x0} height={b.y1 - b.y0} className="block-ghost" />;
      })()}

      {/* Openings */}
      {model.openings.map((o) => (
        <g key={o.id} data-id={o.id} transform={shift(o.id)} className={onEdit ? 'drag' : undefined} onPointerDown={(e) => dragOpening(e, o)}>
          <OpeningShape model={model} o={o} hot={changedIds.has(o.id) || preview?.id === o.id} hit={!!onEdit} />
        </g>
      ))}

      {/* Stairs and lifts */}
      {(model.cores ?? []).map((c) => (
        <g
          key={c.id}
          data-id={c.id}
          transform={shift(c.id)}
          className={onEdit ? 'drag' : undefined}
          onPointerDown={(e) =>
            startDrag(e, c.id, free, (v) => freeMoves(v, `the ${c.label.toLowerCase()}`, (direction, distance) => ({ op: 'move_core', args: { coreId: c.id, direction, distance } })))
          }
        >
          <CoreShape model={model} c={c} hot={changedIds.has(c.id) || preview?.id === c.id} />
        </g>
      ))}

      {/* Furniture */}
      {model.furniture.map((f) => (
        <g
          key={f.id}
          data-id={f.id}
          transform={shift(f.id)}
          className={onEdit ? 'drag' : undefined}
          onPointerDown={(e) =>
            startDrag(e, f.id, free, (v) => freeMoves(v, f.label, (direction, distance) => ({ op: 'move_item', args: { itemId: f.id, direction, distance } })))
          }
        >
          <FurnitureShape f={f} hot={changedIds.has(f.id) || preview?.id === f.id} />
        </g>
      ))}

      {/* Drop target while a room is being dragged */}
      {dropTarget && (() => {
        const c = roomClearRect(model, dropTarget);
        return <rect x={c.x0} y={c.y0} width={c.x1 - c.x0} height={c.y1 - c.y0} className="drop-target" />;
      })()}

      {/* Room labels, scaled to fit small rooms, with a halo for legibility.
          Drag a room by its name onto another room to swap them. */}
      {model.rooms.map((r) => {
        const c = roomClearRect(model, r);
        const fs = Math.min(font, (c.x1 - c.x0) / 6.5, (c.y1 - c.y0) / 4);
        let cx = (c.x0 + c.x1) / 2;
        let cy = (c.y0 + c.y1) / 2;
        if (!r.block && model.rooms.some((x) => x.block)) [cx, cy] = openLabelPoint(model, r);
        const grabW = Math.min(c.x1 - c.x0, Math.max(r.name.length * fs * 0.62, fs * 4));
        return (
          <g
            key={`l-${r.id}`}
            className={`room-label ${onEdit ? 'room-grab' : ''}`}
            transform={shift(`room:${r.id}`)}
            onPointerDown={(e) => dragRoom(e, r, { x: cx, y: cy })}
          >
            {onEdit && (
              <rect x={cx - grabW / 2} y={cy - fs * 1.2} width={grabW} height={fs * 2.6} className="room-grab-hit">
                <title>{`Drag ${r.name} onto another room to swap them`}</title>
              </rect>
            )}
            <text x={cx} y={cy - fs * 0.2} className="room-name" fontSize={fs}>{r.name}</text>
            <text x={cx} y={cy + fs * 1.05} className="room-size" fontSize={fs * 0.78}>{roomSizeText(model, r)}</text>
          </g>
        );
      })}

      {/* Live dimension while dragging */}
      {preview && (Math.abs(preview.dx) >= INCH || Math.abs(preview.dy) >= INCH) && (
        <text className="drag-readout" x={(bounds.x0 + bounds.x1) / 2} y={bounds.y1 + 1100} fontSize={360}>
          {[preview.dx, preview.dy]
            .map((v, i) => (Math.abs(v) >= INCH ? `${formatFtIn(Math.abs(v))} ${compass(i === 0 ? { x: Math.sign(v), y: 0 } : { x: 0, y: Math.sign(v) })}` : null))
            .filter(Boolean)
            .join(', ')}
        </text>
      )}

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
    </>
  );
}

/** Staircase (treads, landing, up-arrow) or lift shaft (crossed box), in the core's local frame. */
function CoreShape({ model, c, hot }: { model: BuildingModel; c: CoreElement; hot: boolean }) {
  const W = c.width;
  const L = c.length;
  const x0 = -W / 2;
  const y0 = -L / 2;
  let body;
  if (c.kind === 'lift') {
    body = (
      <>
        <rect x={x0} y={y0} width={W} height={L} className="core-box" />
        <line x1={x0} y1={y0} x2={W / 2} y2={L / 2} className="core-line" />
        <line x1={x0} y1={L / 2} x2={W / 2} y2={y0} className="core-line" />
        <text x={0} y={110} fontSize={320} className="core-text">LIFT</text>
      </>
    );
  } else {
    const s = c.stair!;
    const landing = s.flightWidth;
    const treads: number[] = [];
    for (let y = y0 + landing + s.tread; y < L / 2 - 1; y += s.tread) treads.push(y);
    const dog = s.type === 'dog-legged';
    body = (
      <>
        <rect x={x0} y={y0} width={W} height={L} className="core-box" />
        <line x1={x0} y1={y0 + landing} x2={W / 2} y2={y0 + landing} className="core-line" />
        {treads.map((y) => (
          <line key={y} x1={x0} y1={y} x2={W / 2} y2={y} className="core-tread" />
        ))}
        {dog && <line x1={0} y1={y0 + landing} x2={0} y2={L / 2} className="core-line" />}
        <path d={`M ${dog ? -W / 4 : 0} ${L / 2 - 150} L ${dog ? -W / 4 : 0} ${y0 + landing + 200}`} className="core-arrow" />
        <text x={0} y={y0 + landing / 2 + 110} fontSize={300} className="core-text">{dog ? 'UP / DN' : 'UP'}</text>
      </>
    );
  }
  const enc = enclosureOf(model, c);
  const fp = enc.outer;
  return (
    <g className={`core ${hot ? 'hot' : ''}`}>
      <title>{`${c.stair ? `${c.label}: ${c.stair.type}, ${c.stair.risers} risers` : c.label} · drag to move`}</title>
      <rect x={fp.x0} y={fp.y0} width={fp.x1 - fp.x0} height={fp.y1 - fp.y0} className="core-hit" />
      <g transform={`translate(${c.at.x} ${c.at.y}) rotate(${c.rotation})`}>{body}</g>
      {enc.walls.map((w, k) => (
        <rect key={k} x={w.x0} y={w.y0} width={w.x1 - w.x0} height={w.y1 - w.y0} className="core-wall" />
      ))}
    </g>
  );
}

function OpeningShape({ model, o, hot, hit = false }: { model: BuildingModel; o: Opening; hot: boolean; hit?: boolean }) {
  const wall = getWall(model, o.wallId);
  const d = wallDir(wall);
  const side = o.swingSide === 'left' ? 1 : -1;
  const n = { x: d.y * side, y: -d.x * side };
  const p = pointOnWall(wall, o.offset);
  const half = o.width / 2;
  const j0 = { x: p.x - d.x * half, y: p.y - d.y * half };
  const j1 = { x: p.x + d.x * half, y: p.y + d.y * half };
  const cls = `opening ${o.kind} ${hot ? 'hot' : ''}`;
  const gap = (
    <>
      <line x1={j0.x} y1={j0.y} x2={j1.x} y2={j1.y} strokeWidth={wall.thickness + 10} className="opening-gap" />
      {hit && <line x1={j0.x} y1={j0.y} x2={j1.x} y2={j1.y} strokeWidth={Math.max(wall.thickness, 420)} className="hit opening-hit" />}
    </>
  );

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
  const nn = { x: d.y, y: -d.x };
  if (o.kind === 'opening') {
    // Plain gap: just the two jamb lines across the wall.
    const h = wall.thickness / 2;
    return (
      <g className={cls}>
        <title>{`${o.label} · ${formatLength(o.width, model.displayUnits)}`}</title>
        {gap}
        {[j0, j1].map((j, k) => (
          <line key={k} x1={j.x - nn.x * h} y1={j.y - nn.y * h} x2={j.x + nn.x * h} y2={j.y + nn.y * h} className="jamb-line" />
        ))}
      </g>
    );
  }
  const t = wall.thickness / 4;
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
    case 'wc-floor':
      body = (
        <>
          <rect x={x0} y={y0} width={W} height={220} rx={40} />
          <ellipse cx={0} cy={y0 + 220 + (D - 220) / 2} rx={W / 2} ry={(D - 220) / 2} />
          <ellipse cx={0} cy={y0 + 220 + (D - 220) / 2 + 20} rx={W / 2 - 70} ry={(D - 220) / 2 - 80} className="furn-detail" />
        </>
      );
      break;
    case 'wash-basin':
      body = (
        <>
          <rect x={x0} y={y0} width={W} height={D} rx={60} />
          <ellipse cx={0} cy={30} rx={W / 2 - 70} ry={D / 2 - 90} className="furn-detail" />
        </>
      );
      break;
    case 'shower':
      body = (
        <>
          <rect x={x0} y={y0} width={W} height={D} className="furn-detail" />
          <line x1={x0} y1={y0} x2={W / 2} y2={D / 2} className="furn-detail-line" />
          <line x1={x0} y1={D / 2} x2={W / 2} y2={y0} className="furn-detail-line" />
          <circle cx={0} cy={0} r={60} />
        </>
      );
      break;
    case 'kitchen-counter':
      body = (
        <>
          <rect x={x0} y={y0} width={W} height={D} />
          {/* Sink (double bowl) and hob (two burners) */}
          <rect x={x0 + 250} y={y0 + 100} width={350} height={380} rx={40} className="furn-detail" />
          <rect x={x0 + 650} y={y0 + 100} width={350} height={380} rx={40} className="furn-detail" />
          <circle cx={W / 2 - 450} cy={0} r={130} className="furn-detail" />
          <circle cx={W / 2 - 800} cy={0} r={130} className="furn-detail" />
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

/** Where to label an open room (living/dining): the free point farthest from any room block. */
function openLabelPoint(model: BuildingModel, room: Room): [number, number] {
  const c = roomClearRect(model, room);
  const blocks = model.rooms.filter((r) => r.block).map((r) => r.block!);
  const items = [...model.furniture.map((f) => itemFootprint(f)), ...(model.cores ?? []).map((k) => coreFootprint(k))];
  let best: [number, number] = [(c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2];
  let bestD = -1;
  const step = 300;
  for (let x = c.x0 + 600; x <= c.x1 - 600; x += step) {
    for (let y = c.y0 + 600; y <= c.y1 - 600; y += step) {
      const dist = (r: { x0: number; x1: number; y0: number; y1: number }) => {
        const dx = Math.max(r.x0 - x, 0, x - r.x1);
        const dy = Math.max(r.y0 - y, 0, y - r.y1);
        return Math.hypot(dx, dy);
      };
      const dBlocks = Math.min(Infinity, ...blocks.map(dist));
      const dItems = Math.min(Infinity, ...items.map(dist));
      const dWalls = Math.min(x - c.x0, c.x1 - x, y - c.y0, c.y1 - y);
      const d = Math.min(dBlocks, dWalls * 1.5) + Math.min(dItems, 900) * 0.5;
      if (dBlocks > 300 && d > bestD) [best, bestD] = [[x, y], d];
    }
  }
  return best;
}
