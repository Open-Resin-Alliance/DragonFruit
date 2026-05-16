'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Pencil, Plus, Trash2, X, RotateCcw, TrendingUp } from 'lucide-react';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

// ── Public types ──────────────────────────────────────────────────────────────

export interface CurvePoint {
  /** 0 = outermost gradient pixel (receding from solid), 1 = innermost (adjacent to solid). */
  x: number;
  /** 0 = 0 % alpha output, 1 = 100 % alpha output. */
  y: number;
}

export interface SavedCurve {
  id: string;
  name: string;
  points: CurvePoint[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default control points — linear ramp matching the opaque preset (55 % → 90 %). */
export const DEFAULT_CUSTOM_CURVE: CurvePoint[] = [
  { x: 0, y: 0.55 },
  { x: 1, y: 0.90 },
];

export const DEFAULT_SAVED_CURVES: SavedCurve[] = [
  { id: 'default', name: 'My Curve', points: DEFAULT_CUSTOM_CURVE },
];

// ── Math utilities ────────────────────────────────────────────────────────────

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function clampRange(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Monotone cubic Hermite spline (Fritsch-Carlson algorithm).
 * Guarantees no overshoot / undershoot — safe for alpha LUT usage.
 */
function makeSpline(pts: CurvePoint[]): (x: number) => number {
  const n = pts.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => pts[0].y;

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const d: number[] = [];
  const m: number[] = new Array(n);

  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);

  m[0] = d[0];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] + d[i]) / 2;
  m[n - 1] = d[n - 2];

  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-10) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = Math.sqrt(a * a + b * b);
    if (h > 3) {
      m[i] = (3 * a / h) * d[i];
      m[i + 1] = (3 * b / h) * d[i];
    }
  }

  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const hx = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / hx;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[lo]
      + (t3 - 2 * t2 + t) * hx * m[lo]
      + (-2 * t3 + 3 * t2) * ys[hi]
      + (t3 - t2) * hx * m[hi]
    );
  };
}

// ── Canvas layout ─────────────────────────────────────────────────────────────

const VW = 560;
const VH = 250;
const PL = 46; // left (Y-axis labels)
const PT = 18; // top
const PR_C = 16; // right
const PB = 34; // bottom (X-axis labels)
const IX0 = PL;
const IX1 = VW - PR_C;
const IY0 = PT;
const IY1 = VH - PB;
const IW_C = IX1 - IX0;
const IH_C = IY1 - IY0;

function toSvgC(x: number, y: number): [number, number] {
  return [IX0 + x * IW_C, IY0 + (1 - y) * IH_C];
}

function fromSvgC(sx: number, sy: number): [number, number] {
  return [
    clamp01((sx - IX0) / IW_C),
    clamp01(1 - (sy - IY0) / IH_C),
  ];
}

function buildCurvePath(spline: (x: number) => number, steps = 200): string {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const [sx, sy] = toSvgC(t, clamp01(spline(t)));
    return `${i === 0 ? 'M' : 'L'} ${sx.toFixed(2)} ${sy.toFixed(2)}`;
  }).join(' ');
}

// ── Inner curve canvas (used inside the modal) ─────────────────────────────────

interface CurveCanvasProps {
  points: CurvePoint[];
  onChange: (pts: CurvePoint[]) => void;
  selectedIdx: number | null;
  onSelectPoint: (idx: number | null) => void;
}

function CurveCanvas({ points, onChange, selectedIdx, onSelectPoint }: CurveCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingIdx = useRef(-1);
  const didDrag = useRef(false);
  const [hoverPos, setHoverPos] = useState<[number, number] | null>(null);

  const spline = makeSpline(points);
  const curvePath = buildCurvePath(spline);
  const [ax0, ay0] = toSvgC(0, 0);
  const [ax1] = toSvgC(1, 0);
  const areaPath = `${curvePath} L ${ax1.toFixed(2)} ${ay0.toFixed(2)} L ${ax0.toFixed(2)} ${ay0.toFixed(2)} Z`;

  const getSvgCoords = useCallback((e: React.MouseEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [
      (e.clientX - r.left) * VW / r.width,
      (e.clientY - r.top) * VH / r.height,
    ];
  }, []);

  const onPointMouseDown = useCallback((idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingIdx.current = idx;
    didDrag.current = false;
    onSelectPoint(idx);
  }, [onSelectPoint]);

  const onMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const [sx, sy] = getSvgCoords(e);
    const [nx, ny] = fromSvgC(sx, sy);
    setHoverPos([nx, ny]);

    const idx = draggingIdx.current;
    if (idx < 0) return;
    didDrag.current = true;
    const updated = points.map((p, i) => {
      if (i !== idx) return p;
      if (i === 0) return { x: 0, y: ny };
      if (i === points.length - 1) return { x: 1, y: ny };
      const minX = points[i - 1].x + 0.02;
      const maxX = points[i + 1].x - 0.02;
      return { x: clampRange(nx, minX, maxX), y: ny };
    });
    onChange(updated);
  }, [getSvgCoords, onChange, points]);

  const onMouseUp = useCallback(() => {
    draggingIdx.current = -1;
  }, []);

  const onMouseLeave = useCallback(() => {
    draggingIdx.current = -1;
    setHoverPos(null);
  }, []);

  const onSvgClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (didDrag.current) { didDrag.current = false; return; }
    const [sx, sy] = getSvgCoords(e);
    const [nx, ny] = fromSvgC(sx, sy);
    if (points.some((p) => Math.abs(p.x - nx) < 0.05)) {
      onSelectPoint(null);
      return;
    }
    const next = [...points, { x: nx, y: ny }].sort((a, b) => a.x - b.x);
    const newIdx = next.findIndex((p) => Math.abs(p.x - nx) < 1e-9);
    onChange(next);
    onSelectPoint(newIdx >= 0 ? newIdx : null);
  }, [getSvgCoords, onChange, onSelectPoint, points]);

  const onPointDblClick = useCallback((idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (points.length <= 2) return;
    const pt = points[idx];
    if (pt.x === 0 || pt.x === 1) return;
    onChange(points.filter((_, i) => i !== idx));
    onSelectPoint(null);
  }, [onChange, onSelectPoint, points]);

  const gridVals = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VW} ${VH}`}
      className="w-full rounded-lg"
      style={{
        background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        cursor: 'crosshair',
        userSelect: 'none',
        display: 'block',
      }}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
      onClick={onSvgClick}
    >
      {/* Y-axis grid + labels */}
      {gridVals.map((v) => {
        const [, gy] = toSvgC(0, v);
        const isBound = v === 0 || v === 1;
        return (
          <React.Fragment key={`y-${v}`}>
            <line
              x1={IX0} y1={gy} x2={IX1} y2={gy}
              stroke={isBound ? 'var(--border-default)' : 'var(--border-subtle)'}
              strokeWidth={isBound ? 0.75 : 0.5}
              strokeDasharray={isBound ? '' : '3 4'}
            />
            <text
              x={IX0 - 6} y={gy + 3.5}
              fontSize={9} fill="var(--text-muted)"
              textAnchor="end"
            >{v === 0 ? '0%' : v === 1 ? '100%' : `${Math.round(v * 100)}%`}</text>
          </React.Fragment>
        );
      })}

      {/* X-axis labels */}
      {gridVals.map((v) => {
        const [gx] = toSvgC(v, 0);
        return (
          <React.Fragment key={`x-${v}`}>
            {v !== 0 && v !== 1 && (
              <line
                x1={gx} y1={IY0} x2={gx} y2={IY1}
                stroke="var(--border-subtle)" strokeWidth={0.5} strokeDasharray="3 4"
              />
            )}
            <text x={gx} y={IY1 + 14} fontSize={9} fill="var(--text-muted)" textAnchor="middle">
              {v === 0 ? 'Outer' : v === 1 ? 'Inner' : `${Math.round(v * 100)}%`}
            </text>
          </React.Fragment>
        );
      })}

      {/* Rotated Y-axis title */}
      <text
        x={11} y={(IY0 + IY1) / 2}
        fontSize={9} fill="var(--text-muted)" textAnchor="middle"
        transform={`rotate(-90,11,${(IY0 + IY1) / 2})`}
      >Alpha Output</text>

      {/* X-axis title */}
      <text x={(IX0 + IX1) / 2} y={VH - 3} fontSize={9} fill="var(--text-muted)" textAnchor="middle">
        Gradient Position
      </text>

      {/* Hover crosshair */}
      {hoverPos && draggingIdx.current < 0 && (
        <>
          <line
            x1={IX0 + hoverPos[0] * IW_C} y1={IY0}
            x2={IX0 + hoverPos[0] * IW_C} y2={IY1}
            stroke="var(--text-muted)" strokeWidth={0.6} opacity={0.35}
          />
          <line
            x1={IX0} y1={IY0 + (1 - hoverPos[1]) * IH_C}
            x2={IX1} y2={IY0 + (1 - hoverPos[1]) * IH_C}
            stroke="var(--text-muted)" strokeWidth={0.6} opacity={0.35}
          />
          <text
            x={IX1 - 4} y={IY0 + (1 - hoverPos[1]) * IH_C - 4}
            fontSize={8} fill="var(--text-muted)" textAnchor="end" opacity={0.8}
          >{`${Math.round(hoverPos[0] * 100)}% → ${Math.round(hoverPos[1] * 100)}%`}</text>
        </>
      )}

      {/* Area fill */}
      <path d={areaPath} fill="var(--accent-secondary-action-border)" opacity={0.10} />

      {/* Curve */}
      <path
        d={curvePath} fill="none"
        stroke="var(--accent-secondary-action-border)"
        strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      />

      {/* Control points */}
      {points.map((pt, idx) => {
        const [px, py] = toSvgC(pt.x, pt.y);
        const isSelected = idx === selectedIdx;
        const isEndpoint = pt.x === 0 || pt.x === 1;
        const r = isSelected ? 8 : 6;
        return (
          <React.Fragment key={idx}>
            {isSelected && (
              <circle cx={px} cy={py} r={r + 5}
                fill="var(--accent-secondary-action-border)" opacity={0.18}
              />
            )}
            <circle
              cx={px} cy={py} r={r}
              fill={isSelected ? 'var(--accent-secondary-action-border)' : 'var(--surface-0)'}
              stroke="var(--accent-secondary-action-border)"
              strokeWidth={isEndpoint ? 2.5 : 2}
              style={{ cursor: isEndpoint ? 'ns-resize' : 'grab' }}
              onMouseDown={(ev) => onPointMouseDown(idx, ev)}
              onDoubleClick={(ev) => onPointDblClick(idx, ev)}
            />
            {/* Value badge */}
            <text
              x={px} y={py - r - 4}
              fontSize={8}
              fill={isSelected ? 'var(--accent-secondary-action-border)' : 'var(--text-muted)'}
              textAnchor="middle"
              pointerEvents="none"
            >{Math.round(pt.y * 100)}%</text>
          </React.Fragment>
        );
      })}
    </svg>
  );
}

// ── LutCurveSelector — inline dropdown + action buttons ───────────────────────

interface LutCurveSelectorProps {
  savedCurves: SavedCurve[];
  selectedCurveId: string;
  onSelectCurve: (id: string) => void;
  /** id = edit that curve, null = create new */
  onOpenEditor: (id: string | null) => void;
}

export function LutCurveSelector({
  savedCurves, selectedCurveId, onSelectCurve, onOpenEditor,
}: LutCurveSelectorProps) {
  const effectiveId = savedCurves.some((c) => c.id === selectedCurveId)
    ? selectedCurveId
    : (savedCurves[0]?.id ?? '');
  const hasCurve = effectiveId.length > 0;
  const canEdit = hasCurve;

  const dropdownOptions = savedCurves.map((c) => ({ value: c.id, label: c.name }));

  const handleSelectCurve = useCallback((id: string) => {
    onSelectCurve(id);
  }, [onSelectCurve]);

  return (
    <div className="mt-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <SelectDropdown
            value={effectiveId}
            options={dropdownOptions}
            onChange={handleSelectCurve}
            className="space-y-0"
            selectClassName="!h-8 !px-2.5 text-[12px] w-full"
            ariaLabel="Select LUT curve"
            menuFooterAction={{
              label: 'Create new curve',
              onClick: () => onOpenEditor(null),
              icon: <Plus className="h-3.5 w-3.5" />,
              tone: 'accent',
            }}
          />
        </div>

        <button
          type="button"
          title="Edit selected curve"
          disabled={!canEdit}
          onClick={() => {
            if (canEdit) onOpenEditor(effectiveId);
          }}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors hover:bg-white/5 disabled:opacity-35 disabled:cursor-not-allowed"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
          aria-label="Edit selected curve"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── LutCurveEditorModal — full-featured modal editor ─────────────────────────

interface LutCurveEditorModalProps {
  isOpen: boolean;
  /** Pass the curve to edit, or null to create a new one. */
  editingCurve: SavedCurve | null;
  onSave: (curve: SavedCurve) => void;
  onDelete?: (curveId: string) => void;
  onClose: () => void;
}

export function LutCurveEditorModal({ isOpen, editingCurve, onSave, onDelete, onClose }: LutCurveEditorModalProps) {
  const [draftPoints, setDraftPoints] = useState<CurvePoint[]>(DEFAULT_CUSTOM_CURVE);
  const [draftName, setDraftName] = useState('My Curve');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const initialSnapshotRef = useRef<{ name: string; points: CurvePoint[] } | null>(null);

  const normalizeDraftName = useCallback((name: string) => name.trim() || 'Untitled Curve', []);

  const pointsEqual = useCallback((a: CurvePoint[], b: CurvePoint[]) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].x - b[i].x) > 1e-9 || Math.abs(a[i].y - b[i].y) > 1e-9) return false;
    }
    return true;
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const initialName = editingCurve?.name ?? 'My Curve';
    const initialPoints = editingCurve ? [...editingCurve.points] : [...DEFAULT_CUSTOM_CURVE];
    setDraftPoints(initialPoints);
    setDraftName(initialName);
    setSelectedIdx(null);
    setShowDiscardConfirm(false);
    setShowDeleteConfirm(false);
    initialSnapshotRef.current = {
      name: normalizeDraftName(initialName),
      points: initialPoints.map((p) => ({ ...p })),
    };
  }, [editingCurve, isOpen, normalizeDraftName]);

  const isDirty = useMemo(() => {
    const initialSnapshot = initialSnapshotRef.current;
    if (!initialSnapshot) return false;
    return (
      normalizeDraftName(draftName) !== initialSnapshot.name
      || !pointsEqual(draftPoints, initialSnapshot.points)
    );
  }, [draftName, draftPoints, normalizeDraftName, pointsEqual]);

  const requestClose = useCallback(() => {
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }, [isDirty, onClose]);

  const handleConfirmDiscardClose = useCallback(() => {
    setShowDiscardConfirm(false);
    onClose();
  }, [onClose]);

  const handleCancelDiscardClose = useCallback(() => {
    setShowDiscardConfirm(false);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (!editingCurve || !onDelete) return;
    setShowDeleteConfirm(false);
    onDelete(editingCurve.id);
  }, [editingCurve, onDelete]);

  const handleCancelDelete = useCallback(() => {
    setShowDeleteConfirm(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (showDeleteConfirm) {
        handleCancelDelete();
        return;
      }
      if (showDiscardConfirm) {
        handleCancelDiscardClose();
        return;
      }
      requestClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleCancelDelete, handleCancelDiscardClose, isOpen, requestClose, showDeleteConfirm, showDiscardConfirm]);

  const selectedPoint = selectedIdx !== null ? draftPoints[selectedIdx] ?? null : null;
  const isEndpoint = selectedPoint ? (selectedPoint.x === 0 || selectedPoint.x === 1) : false;

  const handleSave = useCallback(() => {
    onSave({
      id: editingCurve?.id ?? crypto.randomUUID(),
      name: normalizeDraftName(draftName),
      points: draftPoints,
    });
  }, [draftName, draftPoints, editingCurve, normalizeDraftName, onSave]);

  const handleResetDraft = useCallback(() => {
    const initialSnapshot = initialSnapshotRef.current;
    if (!initialSnapshot) return;
    setDraftName(initialSnapshot.name);
    setDraftPoints(initialSnapshot.points.map((p) => ({ ...p })));
    setSelectedIdx(null);
    setShowDeleteConfirm(false);
  }, []);

  const handleRemoveSelected = useCallback(() => {
    if (selectedIdx === null || draftPoints.length <= 2) return;
    if (isEndpoint) return;
    setDraftPoints(draftPoints.filter((_, i) => i !== selectedIdx));
    setSelectedIdx(null);
  }, [draftPoints, isEndpoint, selectedIdx]);

  const handleInspectorChange = useCallback((axis: 'x' | 'y', rawPct: number) => {
    if (selectedIdx === null) return;
    const value = clamp01(rawPct / 100);
    setDraftPoints((prev) => prev.map((p, i) => {
      if (i !== selectedIdx) return p;
      if (axis === 'y') return { ...p, y: value };
      if (isEndpoint) return p;
      const minX = i > 0 ? prev[i - 1].x + 0.01 : 0;
      const maxX = i < prev.length - 1 ? prev[i + 1].x - 0.01 : 1;
      return { ...p, x: clampRange(value, minX, maxX) };
    }));
  }, [isEndpoint, selectedIdx]);

  const outerAlpha = Math.round((draftPoints[0]?.y ?? 0) * 100);
  const innerAlpha = Math.round((draftPoints[draftPoints.length - 1]?.y ?? 0) * 100);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[135] flex items-center justify-center bg-black/55 px-4 py-5"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (showDiscardConfirm) {
          handleCancelDiscardClose();
          return;
        }
        requestClose();
      }}
    >
      <div
        className="w-full max-w-3xl overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 20px 48px rgba(0,0,0,0.44)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={editingCurve ? 'Edit LUT Curve' : 'New LUT Curve'}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between gap-4 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex items-center gap-3">
            <span
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%)',
                color: 'var(--accent-secondary)',
              }}
            >
              <TrendingUp className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                {editingCurve ? 'Edit LUT Curve' : 'New LUT Curve'}
              </h2>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {editingCurve
                  ? 'Refine your cure-window alpha response'
                  : 'Create a custom alpha response profile'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          <div className="rounded-md border p-3 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="flex items-center gap-2">
              <label className="text-[11px] font-medium shrink-0" style={{ color: 'var(--text-muted)' }}>
                Curve Name
              </label>
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                maxLength={48}
                placeholder="Curve name…"
                className="flex-1 h-8 rounded-md border bg-transparent px-2.5 text-[12px] outline-none"
                style={{
                  borderColor: 'var(--border-subtle)',
                  color: 'var(--text-strong)',
                  background: 'var(--surface-0)',
                }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex h-6 items-center rounded border px-2 text-[10px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', color: 'var(--text-muted)' }}>
                Outer {outerAlpha}%
              </span>
              <span className="inline-flex h-6 items-center rounded border px-2 text-[10px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', color: 'var(--text-muted)' }}>
                Inner {innerAlpha}%
              </span>
              <span className="inline-flex h-6 items-center rounded border px-2 text-[10px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', color: 'var(--text-muted)' }}>
                Monotone spline
              </span>
            </div>
          </div>

          <div className="rounded-md border p-3 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                Curve Canvas
              </span>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Click to add · Drag to move · Double-click to remove
              </span>
            </div>

            <CurveCanvas
              points={draftPoints}
              onChange={setDraftPoints}
              selectedIdx={selectedIdx}
              onSelectPoint={setSelectedIdx}
            />
          </div>

          {/* Inspector */}
          <div
            className="rounded-md border p-3 min-h-[52px]"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
          >
            {selectedPoint !== null ? (
              <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2">
                <span className="text-[11px] font-medium shrink-0" style={{ color: 'var(--text-muted)' }}>
                  Point {selectedIdx! + 1}
                  {isEndpoint && <span className="ml-1 opacity-60">(endpoint)</span>}
                </span>

                <div className="flex items-center gap-2">
                  <label className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>Position</label>
                  <input
                    type="number" min={0} max={100} step={1}
                    disabled={isEndpoint}
                    value={Math.round(selectedPoint.x * 100)}
                    onChange={(e) => handleInspectorChange('x', Number(e.target.value))}
                    className="w-16 h-7 rounded border bg-transparent px-1.5 text-[12px] text-center disabled:opacity-50 outline-none"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-strong)', background: 'var(--surface-0)' }}
                  />
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>%</span>
                </div>

                <div className="flex items-center gap-2">
                  <label className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>Alpha</label>
                  <input
                    type="number" min={0} max={100} step={1}
                    value={Math.round(selectedPoint.y * 100)}
                    onChange={(e) => handleInspectorChange('y', Number(e.target.value))}
                    className="w-16 h-7 rounded border bg-transparent px-1.5 text-[12px] text-center outline-none"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-strong)', background: 'var(--surface-0)' }}
                  />
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>%</span>
                </div>

                <button
                  type="button"
                  onClick={handleRemoveSelected}
                  disabled={isEndpoint || draftPoints.length <= 2}
                  className="ml-auto inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] font-medium transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                  style={{
                    borderColor: (isEndpoint || draftPoints.length <= 2) ? 'var(--border-subtle)' : 'color-mix(in srgb, var(--danger), var(--border-subtle) 52%)',
                    background: (isEndpoint || draftPoints.length <= 2) ? 'var(--surface-0)' : 'color-mix(in srgb, var(--danger), var(--surface-1) 92%)',
                    color: (isEndpoint || draftPoints.length <= 2) ? 'var(--text-muted)' : 'color-mix(in srgb, var(--danger), var(--text-muted) 26%)',
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </button>
              </div>
            ) : (
              <p className="text-[11px] w-full text-center" style={{ color: 'var(--text-muted)' }}>
                Click a point to inspect · Drag to move · Double-click to remove · Click canvas to add
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-3 border-t px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          {editingCurve && onDelete ? (
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                color: 'var(--danger)',
              }}
              title="Delete this curve preset"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete Curve
            </button>
          ) : <div />}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleResetDraft}
              disabled={!isDirty}
              className="ui-button ui-button-secondary inline-flex items-center gap-1.5 !h-9 px-3 text-[12px] disabled:opacity-45 disabled:cursor-not-allowed"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!isDirty}
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed"
              style={{
                borderColor: 'var(--accent-secondary-action-border)',
                background: 'var(--accent-secondary-action-bg-92)',
                color: 'var(--accent-secondary-action-color)',
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>

      <StructuredDialogModal
        open={showDiscardConfirm}
        ariaLabel="Discard unsaved LUT curve changes"
        title="Do you wanna quit?"
        subtitle="You have unsaved LUT curve edits."
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        zIndexClassName="z-[136]"
        maxWidthClassName="max-w-md"
        closeAriaLabel="Close discard changes confirmation"
        onClose={handleCancelDiscardClose}
        onBackdropClick={handleCancelDiscardClose}
        actions={(
          <>
            <button
              type="button"
              onClick={handleCancelDiscardClose}
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
            >
              Keep Editing
            </button>
            <button
              type="button"
              onClick={handleConfirmDiscardClose}
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                color: 'var(--danger)',
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Quit Without Saving
            </button>
          </>
        )}
      >
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          If you quit now, your unsaved LUT curve changes will be lost.
        </p>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={showDeleteConfirm}
        ariaLabel="Confirm delete LUT curve"
        title="Delete Curve Preset"
        subtitle={editingCurve ? `Delete “${editingCurve.name}”?` : 'Delete this curve preset?'}
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        zIndexClassName="z-[137]"
        maxWidthClassName="max-w-md"
        closeAriaLabel="Close delete confirmation"
        onClose={handleCancelDelete}
        onBackdropClick={handleCancelDelete}
        actions={(
          <>
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={handleCancelDelete}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                color: 'var(--danger)',
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </>
        )}
      >
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          This action cannot be undone. The selected LUT curve preset will be permanently removed.
        </p>
      </StructuredDialogModal>
    </div>
  );
}

// ── LUT sampling ──────────────────────────────────────────────────────────────

/**
 * Sample a curve defined by control points into a 256-element LUT (u8 values
 * 0–255). Index 0 (void pixels) is always 0; index 255 (solid pixels) is
 * always 255. Indices 1–254 are sampled from the monotone cubic spline.
 */
export function sampleCurveToLut(points: CurvePoint[]): number[] {
  const spline = makeSpline(points);
  const lut = new Array<number>(256);
  lut[0] = 0;
  lut[255] = 255;
  for (let i = 1; i <= 254; i++) {
    const x = (i - 1) / 253;
    lut[i] = Math.round(clamp01(spline(x)) * 255);
  }
  return lut;
}
