'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Download, Edit3, Pencil, Plus, Trash2, Upload, X, RotateCcw, TrendingUp } from 'lucide-react';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';
import { pickSavePathWithNativeDialogOptions, writeBytesToNativePath } from '@/features/slicing/tauri/nativeSlicerBridge';

const DRAGONFRUIT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';

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

type NewCurvePreset = 'opaque' | 'clear' | 'custom';
type AlphaUnitMode = 'percent' | 'u8';

type LutCurveProfileExchangeHeader = {
  kind: 'dragonfruit-lut-curve-profile';
  formatVersion: 1;
  exportedAt: string;
  generator: 'DragonFruit';
  appVersion?: string;
};

type LutCurveProfileExchangeDocument = {
  header: LutCurveProfileExchangeHeader;
  curve: {
    name: string;
    points: CurvePoint[];
  };
};

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default control points — linear ramp matching the opaque preset (55 % → 90 %). */
export const DEFAULT_CUSTOM_CURVE: CurvePoint[] = [
  { x: 0, y: 0.55 },
  { x: 1, y: 0.90 },
];

export const DEFAULT_SAVED_CURVES: SavedCurve[] = [
  { id: 'default', name: 'My Curve', points: DEFAULT_CUSTOM_CURVE },
];

const LUT_ALPHA_UNIT_MODE_STORAGE_KEY = 'dragonfruit.lut-editor.alpha-unit-mode';

const NEW_CURVE_OPAQUE_POINTS: CurvePoint[] = [
  { x: 0, y: 0.55 },
  { x: 1, y: 0.90 },
];

const NEW_CURVE_CLEAR_POINTS: CurvePoint[] = [
  { x: 0, y: 0.55 },
  { x: 1, y: 0.65 },
];

/**
 * Compact 10-point control curve derived from Aaron's UVTools EXP_120-230 LUT.
 *
 * Sampling indices (0-based) from the 256-entry LUT:
 * [1, 29, 57, 85, 113, 142, 170, 198, 226, 254]
 * Values:
 * [120, 125, 130, 135, 142, 151, 162, 178, 199, 230]
 */
export const DEFAULT_OPAQUE_EXP_120_230_CURVE: CurvePoint[] = [
  { x: 0 / 253, y: 120 / 255 },
  { x: 28 / 253, y: 125 / 255 },
  { x: 56 / 253, y: 130 / 255 },
  { x: 84 / 253, y: 135 / 255 },
  { x: 112 / 253, y: 142 / 255 },
  { x: 141 / 253, y: 151 / 255 },
  { x: 169 / 253, y: 162 / 255 },
  { x: 197 / 253, y: 178 / 255 },
  { x: 225 / 253, y: 199 / 255 },
  { x: 253 / 253, y: 230 / 255 },
];

/**
 * Compact 10-point control curve using Aaron's EXP-100 shape remapped for
 * clear resin windowing (roughly 100..166 PWM, i.e. ~39%..65%).
 *
 * Source EXP-100 samples at indices [1,29,57,85,113,142,170,198,226,254]:
 * [100,107,114,121,131,143,159,180,210,252]
 * Remapped to clear window:
 * [100,103,106,109,113,119,126,135,148,166]
 */
export const DEFAULT_CLEAR_EXP_100_CURVE: CurvePoint[] = [
  { x: 0 / 253, y: 100 / 255 },
  { x: 28 / 253, y: 103 / 255 },
  { x: 56 / 253, y: 106 / 255 },
  { x: 84 / 253, y: 109 / 255 },
  { x: 112 / 253, y: 113 / 255 },
  { x: 141 / 253, y: 119 / 255 },
  { x: 169 / 253, y: 126 / 255 },
  { x: 197 / 253, y: 135 / 255 },
  { x: 225 / 253, y: 148 / 255 },
  { x: 253 / 253, y: 166 / 255 },
];

// ── Math utilities ────────────────────────────────────────────────────────────

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function clampRange(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function normalizedAlphaToDisplayValue(alpha01: number, unitMode: AlphaUnitMode): number {
  const clamped = clamp01(alpha01);
  return unitMode === 'u8'
    ? Math.round(clamped * 255)
    : Math.round(clamped * 100);
}

function formatAlphaValueForUnit(alpha01: number, unitMode: AlphaUnitMode): string {
  const value = normalizedAlphaToDisplayValue(alpha01, unitMode);
  return unitMode === 'u8' ? `${value}` : `${value}%`;
}

function alphaDisplayValueToNormalized(displayValue: number, unitMode: AlphaUnitMode): number {
  const numeric = Number.isFinite(displayValue) ? displayValue : 0;
  return unitMode === 'u8'
    ? clamp01(numeric / 255)
    : clamp01(numeric / 100);
}

function alphaDisplayValueToPercent(displayValue: number, unitMode: AlphaUnitMode): number {
  const numeric = Number.isFinite(displayValue) ? displayValue : 0;
  return unitMode === 'u8'
    ? clampRange((numeric / 255) * 100, 0, 100)
    : clampRange(numeric, 0, 100);
}

function normalizeImportedCurvePoints(rawPoints: unknown): CurvePoint[] {
  if (!Array.isArray(rawPoints)) return [...DEFAULT_CUSTOM_CURVE];

  const parsed = rawPoints
    .map((point) => {
      const candidate = point as Partial<CurvePoint>;
      const x = Number(candidate?.x);
      const y = Number(candidate?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x: clamp01(x), y: clamp01(y) };
    })
    .filter((point): point is CurvePoint => point !== null)
    .sort((a, b) => a.x - b.x);

  if (parsed.length < 2) return [...DEFAULT_CUSTOM_CURVE];

  const deduped: CurvePoint[] = [];
  for (const point of parsed) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.x - point.x) < 1e-6) {
      deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  }

  if (deduped.length < 2) return [...DEFAULT_CUSTOM_CURVE];

  const withBounds = deduped.map((point) => ({ ...point }));
  if (withBounds[0].x > 0) {
    withBounds.unshift({ x: 0, y: withBounds[0].y });
  } else {
    withBounds[0].x = 0;
  }

  const lastIndex = withBounds.length - 1;
  if (withBounds[lastIndex].x < 1) {
    withBounds.push({ x: 1, y: withBounds[lastIndex].y });
  } else {
    withBounds[lastIndex].x = 1;
  }

  return withBounds;
}

function deriveImportedCurveName(fileNameHint?: string): string {
  const raw = (fileNameHint ?? '').trim();
  if (!raw) return 'Imported Curve';
  const withoutPath = raw.replace(/^.*[\\/]/, '');
  const withoutExt = withoutPath.replace(/(\.lutcurve\.json|\.lut|\.json)$/i, '');
  const normalized = withoutExt.trim();
  return normalized || 'Imported Curve';
}

function parseUvToolsLutArray(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length !== 256) return null;
  const parsed = raw.map((value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.max(0, Math.min(255, Math.round(num)));
  });
  if (parsed.some((value) => value == null)) return null;
  return parsed as number[];
}

function convertUvToolsLutToCurvePoints(lut: number[]): CurvePoint[] {
  // Re-interpret UVTools' 256-sample LUT into a compact spline control set.
  // We keep exactly 10 points (including endpoints) spaced across [1..254].
  // This keeps editor UX clean while preserving overall curve intent.
  const UVTOOLS_CONTROL_POINT_COUNT = 10;
  const candidatePoints: CurvePoint[] = [];
  for (let p = 0; p < UVTOOLS_CONTROL_POINT_COUNT; p++) {
    const t = UVTOOLS_CONTROL_POINT_COUNT <= 1 ? 0 : p / (UVTOOLS_CONTROL_POINT_COUNT - 1);
    const lutIndex = Math.max(1, Math.min(254, 1 + Math.round(t * 253)));
    candidatePoints.push({
      x: (lutIndex - 1) / 253,
      y: (lut[lutIndex] ?? 0) / 255,
    });
  }

  // Guard against occasional non-monotone noise in source LUTs so monotone
  // spline interpolation remains physically meaningful for alpha ramps.
  for (let i = 1; i < candidatePoints.length; i++) {
    if (candidatePoints[i].y < candidatePoints[i - 1].y) {
      candidatePoints[i].y = candidatePoints[i - 1].y;
    }
  }

  return normalizeImportedCurvePoints(candidatePoints);
}

export function exportLutCurveProfileToJson(params: {
  name: string;
  points: CurvePoint[];
  appVersion?: string;
}): string {
  const doc: LutCurveProfileExchangeDocument = {
    header: {
      kind: 'dragonfruit-lut-curve-profile',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      generator: 'DragonFruit',
      appVersion: params.appVersion?.trim() || undefined,
    },
    curve: {
      name: params.name.trim() || 'Imported Curve',
      points: normalizeImportedCurvePoints(params.points),
    },
  };

  return JSON.stringify(doc, null, 2);
}

export function exportLutCurveProfileToUvToolsLut(params: {
  points: CurvePoint[];
}): string {
  const lut = sampleCurveToLut(normalizeImportedCurvePoints(params.points));
  return `${JSON.stringify(lut, null, 2)}\n`;
}

function resolveLutCurveExportTargetFromPath(path: string): 'dragonfruit-json' | 'uvtools-lut' {
  const lowered = path.trim().toLowerCase();
  return lowered.endsWith('.lut') ? 'uvtools-lut' : 'dragonfruit-json';
}

export function importLutCurveProfileFromJson(jsonText: string, options?: { fileNameHint?: string }): {
  name: string;
  points: CurvePoint[];
} {
  const parsed = JSON.parse(jsonText) as Partial<LutCurveProfileExchangeDocument> | unknown;

  const uvToolsLut = parseUvToolsLutArray(parsed);
  if (uvToolsLut) {
    return {
      name: deriveImportedCurveName(options?.fileNameHint),
      points: convertUvToolsLutToCurvePoints(uvToolsLut),
    };
  }

  const dragonfruitDoc = parsed as Partial<LutCurveProfileExchangeDocument>;
  if (dragonfruitDoc?.header?.kind !== 'dragonfruit-lut-curve-profile' || dragonfruitDoc?.header?.formatVersion !== 1) {
    throw new Error('Unsupported LUT profile format. Use a DragonFruit .lutcurve.json file or a UVTools 256-value .lut/.json LUT array.');
  }

  const name = (dragonfruitDoc.curve?.name ?? '').trim() || deriveImportedCurveName(options?.fileNameHint);
  const points = normalizeImportedCurvePoints(dragonfruitDoc.curve?.points);
  return { name, points };
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
  alphaUnitMode: AlphaUnitMode;
}

function CurveCanvas({ points, onChange, selectedIdx, onSelectPoint, alphaUnitMode }: CurveCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingIdx = useRef(-1);
  const dragStarted = useRef(false);
  const dragStartClient = useRef<[number, number] | null>(null);
  const didDrag = useRef(false);
  const [hoverPos, setHoverPos] = useState<[number, number] | null>(null);
  const [isPointerDragging, setIsPointerDragging] = useState(false);
  const DRAG_THRESHOLD_PX = 4;

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
    dragStarted.current = false;
    dragStartClient.current = [e.clientX, e.clientY];
    didDrag.current = false;
    setIsPointerDragging(true);
    onSelectPoint(idx);
  }, [onSelectPoint]);

  const onMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const [sx, sy] = getSvgCoords(e);
    const [nx, ny] = fromSvgC(sx, sy);
    setHoverPos([nx, ny]);

    const idx = draggingIdx.current;
    if (idx < 0) return;

    if (!dragStarted.current) {
      const start = dragStartClient.current;
      if (start) {
        const dx = e.clientX - start[0];
        const dy = e.clientY - start[1];
        if ((dx * dx + dy * dy) < (DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX)) {
          return;
        }
      }
      dragStarted.current = true;
      didDrag.current = true;
    }

    const updated = points.map((p, i) => {
      if (i !== idx) return p;
      if (i === 0) return { x: 0, y: ny };
      if (i === points.length - 1) return { x: 1, y: ny };
      const minX = points[i - 1].x + 0.02;
      const maxX = points[i + 1].x - 0.02;
      return { x: clampRange(nx, minX, maxX), y: ny };
    });
    onChange(updated);
  }, [DRAG_THRESHOLD_PX, getSvgCoords, onChange, points]);

  const onMouseUp = useCallback(() => {
    draggingIdx.current = -1;
    dragStarted.current = false;
    dragStartClient.current = null;
    setIsPointerDragging(false);
  }, []);

  const onMouseLeave = useCallback(() => {
    draggingIdx.current = -1;
    dragStarted.current = false;
    dragStartClient.current = null;
    setHoverPos(null);
    setIsPointerDragging(false);
  }, []);

  const onSvgContextMenu = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
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

  const gridVals = [0, 0.25, 0.5, 0.75, 1];
  const yAxisLabels = alphaUnitMode === 'u8'
    ? ['0', '64', '128', '192', '255']
    : ['0%', '25%', '50%', '75%', '100%'];

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VW} ${VH}`}
      className="w-full"
      style={{
        cursor: 'crosshair',
        userSelect: 'none',
        display: 'block',
      }}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
      onContextMenu={onSvgContextMenu}
    >
      {/* Y-axis grid + labels */}
      {gridVals.map((v, idx) => {
        const [, gy] = toSvgC(0, v);
        const isBound = v === 0 || v === 1;
        const yLabelY = v === 0 ? gy - 4 : gy + 3.5;
        return (
          <React.Fragment key={`y-${v}`}>
            <line
              x1={IX0} y1={gy} x2={IX1} y2={gy}
              stroke={isBound
                ? 'color-mix(in srgb, var(--text-muted), white 6%)'
                : 'color-mix(in srgb, var(--text-muted), white 2%)'}
              strokeWidth={isBound ? 0.85 : 0.5}
              strokeDasharray={isBound ? '' : '3 4'}
              opacity={isBound ? 0.68 : 0.36}
            />
            <text
              x={IX0 - 8} y={yLabelY}
              fontSize={9} fill="color-mix(in srgb, var(--text-muted), white 5%)"
              textAnchor="end"
            >{yAxisLabels[idx]}</text>
          </React.Fragment>
        );
      })}

      {/* X-axis labels */}
      {gridVals.map((v) => {
        const [gx] = toSvgC(v, 0);
        const isBound = v === 0 || v === 1;
        const xLabelX = v === 0 ? gx + 4 : v === 1 ? gx - 4 : gx;
        const xLabelAnchor = v === 0 ? 'start' : v === 1 ? 'end' : 'middle';
        return (
          <React.Fragment key={`x-${v}`}>
            <line
              x1={gx} y1={IY0} x2={gx} y2={IY1}
              stroke={isBound
                ? 'color-mix(in srgb, var(--text-muted), white 6%)'
                : 'color-mix(in srgb, var(--text-muted), white 2%)'}
              strokeWidth={isBound ? 0.85 : 0.5}
              strokeDasharray={isBound ? '' : '3 4'}
              opacity={isBound ? 0.68 : 0.36}
            />
            <text x={xLabelX} y={IY1 + 16} fontSize={9} fill="color-mix(in srgb, var(--text-muted), white 5%)" textAnchor={xLabelAnchor}>
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
      {hoverPos && !isPointerDragging && (
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
          >{`${Math.round(hoverPos[0] * 100)}% → ${formatAlphaValueForUnit(hoverPos[1], alphaUnitMode)}`}</text>
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
        const isLeftEndpoint = idx === 0;
        const isRightEndpoint = idx === points.length - 1;
        const labelX = isLeftEndpoint ? px + 10 : isRightEndpoint ? px - 10 : px;
        const labelY = Math.max(IY0 + 9, py - r - 4);
        const labelAnchor: 'start' | 'middle' | 'end' = isLeftEndpoint
          ? 'start'
          : isRightEndpoint
            ? 'end'
            : 'middle';
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
            />
            {/* Value badge */}
            <text
              x={labelX} y={labelY}
              fontSize={8}
              fill={isSelected ? 'var(--accent-secondary-action-border)' : 'var(--text-muted)'}
              textAnchor={labelAnchor}
              pointerEvents="none"
            >{formatAlphaValueForUnit(pt.y, alphaUnitMode)}</text>
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
    <div className="mt-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <SelectDropdown
            value={effectiveId}
            options={dropdownOptions}
            onChange={handleSelectCurve}
            className="space-y-0"
            selectClassName="!h-8 !px-2.5 text-[12px] w-full"
            selectStyle={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-strong)',
            }}
            ariaLabel="Select LUT curve"
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
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-0)',
            color: 'var(--text-strong)',
          }}
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
  savedCurves: SavedCurve[];
  selectedCurveId: string;
  onSelectCurve: (id: string) => void;
  onImportCurve: (curve: SavedCurve) => void;
  /** Pass the curve to edit, or null to create a new one. */
  editingCurve: SavedCurve | null;
  onSave: (curve: SavedCurve) => void;
  onDelete?: (curveId: string) => void;
  onClose: () => void;
}

export function LutCurveEditorModal({
  isOpen,
  savedCurves,
  selectedCurveId,
  onSelectCurve,
  onImportCurve,
  editingCurve,
  onSave,
  onDelete,
  onClose,
}: LutCurveEditorModalProps) {
  const [draftPoints, setDraftPoints] = useState<CurvePoint[]>(DEFAULT_CUSTOM_CURVE);
  const [draftName, setDraftName] = useState('My Curve');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [draftRenameName, setDraftRenameName] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [draftCreateName, setDraftCreateName] = useState('New Curve');
  const [draftCreatePreset, setDraftCreatePreset] = useState<NewCurvePreset>('opaque');
  const [draftCreateCustomMin, setDraftCreateCustomMin] = useState<number>(55);
  const [draftCreateCustomMax, setDraftCreateCustomMax] = useState<number>(90);
  const [alphaUnitMode, setAlphaUnitMode] = useState<AlphaUnitMode>(() => {
    if (typeof window === 'undefined') return 'percent';
    try {
      const saved = window.localStorage.getItem(LUT_ALPHA_UNIT_MODE_STORAGE_KEY);
      return saved === 'u8' ? 'u8' : 'percent';
    } catch {
      return 'percent';
    }
  });
  const initialSnapshotRef = useRef<{ name: string; points: CurvePoint[] } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LUT_ALPHA_UNIT_MODE_STORAGE_KEY, alphaUnitMode);
    } catch {
      // Ignore storage failures (private mode / restricted environments).
    }
  }, [alphaUnitMode]);

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
    setShowRenameDialog(false);
    setDraftRenameName('');
    setShowCreateDialog(false);
    setDraftCreateName('New Curve');
    setDraftCreatePreset('opaque');
    setDraftCreateCustomMin(55);
    setDraftCreateCustomMax(90);
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

  const handleCancelRename = useCallback(() => {
    setShowRenameDialog(false);
  }, []);

  const handleCancelCreate = useCallback(() => {
    setShowCreateDialog(false);
  }, []);

  const handleOpenRename = useCallback(() => {
    setDraftRenameName(normalizeDraftName(draftName));
    setShowRenameDialog(true);
  }, [draftName, normalizeDraftName]);

  const handleConfirmRename = useCallback(() => {
    setDraftName(normalizeDraftName(draftRenameName));
    setShowRenameDialog(false);
  }, [draftRenameName, normalizeDraftName]);

  const handleConfirmCreate = useCallback(() => {
    const normalizedName = normalizeDraftName(draftCreateName);
    const clampPercent = (value: number) => {
      const numeric = Number.isFinite(value) ? value : 0;
      return Math.max(0, Math.min(100, numeric));
    };

    let points: CurvePoint[];
    if (draftCreatePreset === 'clear') {
      points = NEW_CURVE_CLEAR_POINTS.map((point) => ({ ...point }));
    } else if (draftCreatePreset === 'custom') {
      const minPct = clampPercent(draftCreateCustomMin);
      const maxPct = clampPercent(draftCreateCustomMax);
      const lo = Math.min(minPct, maxPct) / 100;
      const hi = Math.max(minPct, maxPct) / 100;
      points = [
        { x: 0, y: lo },
        { x: 1, y: hi },
      ];
    } else {
      points = NEW_CURVE_OPAQUE_POINTS.map((point) => ({ ...point }));
    }

    const newCurve: SavedCurve = {
      id: crypto.randomUUID(),
      name: normalizedName,
      points,
    };

    onImportCurve(newCurve);
    onSelectCurve(newCurve.id);
    setShowCreateDialog(false);
  }, [
    draftCreateCustomMax,
    draftCreateCustomMin,
    draftCreateName,
    draftCreatePreset,
    normalizeDraftName,
    onImportCurve,
    onSelectCurve,
  ]);

  const nudgeSelectedPoint = useCallback((dx: number, dy: number) => {
    if (selectedIdx === null) return;
    setDraftPoints((prev) => prev.map((p, i) => {
      if (i !== selectedIdx) return p;
      const nextY = clamp01(p.y + dy);
      const isCurrentEndpoint = i === 0 || i === prev.length - 1;
      if (isCurrentEndpoint) return { ...p, y: nextY };
      const minX = i > 0 ? prev[i - 1].x + 0.01 : 0;
      const maxX = i < prev.length - 1 ? prev[i + 1].x - 0.01 : 1;
      return {
        ...p,
        x: clampRange(p.x + dx, minX, maxX),
        y: nextY,
      };
    }));
  }, [selectedIdx]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isTypingTarget = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || !!target?.isContentEditable;

      if (e.key === 'Escape') {
        e.preventDefault();
        if (showRenameDialog) {
          handleCancelRename();
          return;
        }
        if (showCreateDialog) {
          handleCancelCreate();
          return;
        }
        if (showDeleteConfirm) {
          handleCancelDelete();
          return;
        }
        if (showDiscardConfirm) {
          handleCancelDiscardClose();
          return;
        }
        requestClose();
        return;
      }

      if (showCreateDialog || showRenameDialog || showDeleteConfirm || showDiscardConfirm || isTypingTarget || selectedIdx === null) return;

      const step = e.shiftKey ? 0.05 : 0.01;
      const key = e.key;
      const code = e.code;
      switch (key) {
        case 'ArrowLeft':
        case 'Left':
          e.preventDefault();
          nudgeSelectedPoint(-step, 0);
          break;
        case 'ArrowRight':
        case 'Right':
          e.preventDefault();
          nudgeSelectedPoint(step, 0);
          break;
        case 'ArrowUp':
        case 'Up':
          e.preventDefault();
          nudgeSelectedPoint(0, step);
          break;
        case 'ArrowDown':
        case 'Down':
          e.preventDefault();
          nudgeSelectedPoint(0, -step);
          break;
        default:
          if (code === 'ArrowLeft') {
            e.preventDefault();
            nudgeSelectedPoint(-step, 0);
            return;
          }
          if (code === 'ArrowRight') {
            e.preventDefault();
            nudgeSelectedPoint(step, 0);
            return;
          }
          if (code === 'ArrowUp') {
            e.preventDefault();
            nudgeSelectedPoint(0, step);
            return;
          }
          if (code === 'ArrowDown') {
            e.preventDefault();
            nudgeSelectedPoint(0, -step);
            return;
          }
          break;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [
    handleCancelDelete,
    handleCancelDiscardClose,
    handleCancelCreate,
    handleCancelRename,
    handleConfirmRename,
    isOpen,
    nudgeSelectedPoint,
    requestClose,
    selectedIdx,
    showCreateDialog,
    showRenameDialog,
    showDeleteConfirm,
    showDiscardConfirm,
  ]);

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

  const handleInspectorChange = useCallback((axis: 'x' | 'y', rawValue: number) => {
    if (selectedIdx === null) return;
    setDraftPoints((prev) => prev.map((p, i) => {
      if (i !== selectedIdx) return p;
      if (axis === 'y') {
        return { ...p, y: alphaDisplayValueToNormalized(rawValue, alphaUnitMode) };
      }
      const value = clamp01(rawValue / 100);
      if (isEndpoint) return p;
      const minX = i > 0 ? prev[i - 1].x + 0.01 : 0;
      const maxX = i < prev.length - 1 ? prev[i + 1].x - 0.01 : 1;
      return { ...p, x: clampRange(value, minX, maxX) };
    }));
  }, [alphaUnitMode, isEndpoint, selectedIdx]);

  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const activeCurveId = editingCurve?.id ?? selectedCurveId;

  const curveDropdownOptions = useMemo(() => {
    const draftLabel = normalizeDraftName(draftName);
    const editingCurveId = editingCurve?.id ?? null;
    return savedCurves.map((curve) => {
      const label = editingCurveId && curve.id === activeCurveId && curve.id === editingCurveId
        ? draftLabel
        : curve.name;
      return { value: curve.id, label };
    });
  }, [activeCurveId, draftName, editingCurve?.id, normalizeDraftName, savedCurves]);

  const handleSelectCurveFromModal = useCallback((curveId: string) => {
    onSelectCurve(curveId);
  }, [onSelectCurve]);

  const handleOpenCreateDialog = useCallback(() => {
    setDraftCreateName('New Curve');
    setDraftCreatePreset('opaque');
    setDraftCreateCustomMin(55);
    setDraftCreateCustomMax(90);
    setShowCreateDialog(true);
  }, []);

  useEffect(() => {
    if (!showRenameDialog) return;
    const id = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [showRenameDialog]);

  const handleExportCurve = useCallback(() => {
    if (typeof window === 'undefined') return;

    void (async () => {
      try {
        const exportName = normalizeDraftName(draftName);
        const safeName = exportName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'dragonfruit-lut-curve';
        const defaultFilename = `${safeName}.lutcurve.json`;

        try {
          const selectedPath = await pickSavePathWithNativeDialogOptions(defaultFilename, {
            filters: [
              { name: 'DragonFruit LUT Curve', extensions: ['lutcurve.json', 'json'] },
              { name: 'UVTools LUT', extensions: ['lut'] },
            ],
          });

          const trimmedPath = selectedPath.trim();
          if (!trimmedPath) return;

          const selectedTarget = resolveLutCurveExportTargetFromPath(trimmedPath);
          const selectedPayload = selectedTarget === 'uvtools-lut'
            ? exportLutCurveProfileToUvToolsLut({ points: draftPoints })
            : exportLutCurveProfileToJson({
                name: exportName,
                points: draftPoints,
                appVersion: DRAGONFRUIT_VERSION,
              });

          const hasExplicitExtension = /\.[^\\/]+$/.test(trimmedPath);
          const destinationPath = hasExplicitExtension
            ? trimmedPath
            : `${trimmedPath}${selectedTarget === 'uvtools-lut' ? '.lut' : '.lutcurve.json'}`;

          const selectedBytes = new TextEncoder().encode(selectedPayload);
          await writeBytesToNativePath(destinationPath, selectedBytes);
          return;
        } catch (nativeError) {
          const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError ?? '');
          const loweredNativeMessage = nativeMessage.toLowerCase();
          if (loweredNativeMessage.includes('cancel')) return;

          const nativeUnavailable = loweredNativeMessage.includes('only available in dragonfruit desktop')
            || loweredNativeMessage.includes('tauri runtime');
          if (!nativeUnavailable) {
            throw nativeError;
          }
        }

        const exportPayload = exportLutCurveProfileToJson({
          name: exportName,
          points: draftPoints,
          appVersion: DRAGONFRUIT_VERSION,
        });
        const fileName = `${safeName}.lutcurve.json`;

        const blob = new Blob([exportPayload], { type: 'application/json;charset=utf-8' });
        const blobUrl = window.URL.createObjectURL(blob);

        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        window.URL.revokeObjectURL(blobUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown export error';
        window.alert(`Failed to export LUT curve profile. ${message}`);
      }
    })();
  }, [draftName, draftPoints, normalizeDraftName]);

  const handleImportCurveFile = useCallback(async (file: File) => {
    const rawJson = await file.text();
    const imported = importLutCurveProfileFromJson(rawJson, { fileNameHint: file.name });
    const importedCurve: SavedCurve = {
      id: crypto.randomUUID(),
      name: imported.name,
      points: imported.points,
    };
    onImportCurve(importedCurve);
    onSelectCurve(importedCurve.id);
  }, [onImportCurve, onSelectCurve]);

  const handleImportInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void handleImportCurveFile(file).catch((error) => {
      const message = error instanceof Error ? error.message : 'Failed to import LUT profile.';
      if (typeof window !== 'undefined') window.alert(message);
    });
  }, [handleImportCurveFile]);

  const handleImportCurve = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[135] flex items-center justify-center bg-black/55 px-4 py-5"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (showCreateDialog) {
          handleCancelCreate();
          return;
        }
        if (showRenameDialog) {
          handleCancelRename();
          return;
        }
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
          <div className="flex items-center gap-2">
            <div
              className="inline-flex rounded-md border p-0.5"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
              role="group"
              aria-label="Alpha value display mode"
            >
              <button
                type="button"
                onClick={() => setAlphaUnitMode('percent')}
                className="rounded px-2 py-1 text-[10px] font-semibold transition-colors"
                aria-pressed={alphaUnitMode === 'percent'}
                title="Show alpha as 0-100%"
                style={alphaUnitMode === 'percent'
                  ? {
                    color: 'var(--accent-secondary-action-color)',
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 22%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), transparent 94%)',
                    boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent-secondary), transparent 78%) inset',
                  }
                  : {
                    color: 'var(--text-muted)',
                    background: 'transparent',
                  }}
              >
                0-100%
              </button>
              <button
                type="button"
                onClick={() => setAlphaUnitMode('u8')}
                className="rounded px-2 py-1 text-[10px] font-semibold transition-colors"
                aria-pressed={alphaUnitMode === 'u8'}
                title="Show alpha as 0-255"
                style={alphaUnitMode === 'u8'
                  ? {
                    color: 'var(--accent-secondary-action-color)',
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 22%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), transparent 94%)',
                    boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent-secondary), transparent 78%) inset',
                  }
                  : {
                    color: 'var(--text-muted)',
                    background: 'transparent',
                  }}
              >
                0-255
              </button>
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
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          <div className="rounded-md border p-3 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,.lut,.lutcurve.json,application/json,text/plain"
              onChange={handleImportInputChange}
              className="hidden"
            />

            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[11px] font-medium shrink-0" style={{ color: 'var(--text-muted)' }}>
                Profile
              </label>
              <div className="min-w-0 flex-1">
                <SelectDropdown
                  value={activeCurveId}
                  options={curveDropdownOptions}
                  onChange={handleSelectCurveFromModal}
                  className="space-y-0"
                  selectClassName="!h-8 !px-2.5 text-[12px] w-full"
                  ariaLabel="Select curve profile to edit"
                  menuFooterAction={{
                    label: 'New Curve',
                    onClick: handleOpenCreateDialog,
                    icon: <Plus className="h-3.5 w-3.5" />,
                    tone: 'accent',
                  }}
                />
              </div>
              <button
                type="button"
                onClick={handleOpenRename}
                className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-[11px]"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={handleExportCurve}
                className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-[11px] inline-flex items-center gap-1"
                title="Export selected curve"
              >
                <Download className="h-3.5 w-3.5" />
                Export
              </button>
              <button
                type="button"
                onClick={handleImportCurve}
                className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-[11px] inline-flex items-center gap-1"
              >
                <Upload className="h-3.5 w-3.5" />
                Import
              </button>
            </div>

          </div>

          <div className="rounded-md border p-3 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                Curve Canvas
              </span>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Right-click to add · Drag to move · Use inspector to remove
              </span>
            </div>

            <CurveCanvas
              points={draftPoints}
              onChange={setDraftPoints}
              selectedIdx={selectedIdx}
              onSelectPoint={setSelectedIdx}
              alphaUnitMode={alphaUnitMode}
            />
          </div>

          {/* Inspector */}
          <div
            className="rounded-md border h-[62px] px-3"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
          >
            {selectedPoint !== null ? (
              <div className="flex h-full w-full items-center gap-2">
                <div className="inline-flex h-9 min-w-0 flex-1 items-center gap-1.5">
                  <label className="text-[10px] shrink-0 font-medium" style={{ color: 'var(--text-muted)' }}>Position</label>
                  <ScrollableNumberField
                    value={Math.round(selectedPoint.x * 100)}
                    onChange={(nextValue) => handleInspectorChange('x', nextValue)}
                    min={0}
                    max={100}
                    step={1}
                    unit="%"
                    ariaLabel="Selected point position"
                    decreaseTitle="Decrease point position"
                    increaseTitle="Increase point position"
                    disabled={isEndpoint}
                    className="min-w-0 flex-1"
                    inputClassName="!h-8 !text-[12px]"
                  />
                </div>

                <span className="h-4 w-px" style={{ background: 'var(--border-subtle)' }} />

                <div className="inline-flex h-9 min-w-0 flex-1 items-center gap-1.5">
                  <label className="text-[10px] shrink-0 font-medium" style={{ color: 'var(--text-muted)' }}>Alpha</label>
                  <ScrollableNumberField
                    value={normalizedAlphaToDisplayValue(selectedPoint.y, alphaUnitMode)}
                    onChange={(nextValue) => handleInspectorChange('y', nextValue)}
                    min={0}
                    max={alphaUnitMode === 'u8' ? 255 : 100}
                    step={1}
                    unit={alphaUnitMode === 'percent' ? '%' : undefined}
                    ariaLabel="Selected point alpha"
                    decreaseTitle="Decrease point alpha"
                    increaseTitle="Increase point alpha"
                    className="min-w-0 flex-1"
                    inputClassName="!h-8 !text-[12px]"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleRemoveSelected}
                  disabled={isEndpoint || draftPoints.length <= 2}
                  className="ml-auto ui-button !h-8 px-3 text-xs inline-flex items-center justify-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed"
                  style={{
                    borderColor: (isEndpoint || draftPoints.length <= 2)
                      ? 'var(--border-subtle)'
                      : 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                    background: (isEndpoint || draftPoints.length <= 2)
                      ? 'var(--surface-0)'
                      : 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                    color: (isEndpoint || draftPoints.length <= 2)
                      ? 'var(--text-muted)'
                      : 'var(--danger)',
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </button>
              </div>
            ) : (
              <p className="h-full w-full inline-flex items-center justify-center text-[11px] text-center" style={{ color: 'var(--text-muted)' }}>
                Click a point to inspect · Drag to move · Right-click canvas to add · Use inspector to remove
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
        open={showCreateDialog}
        ariaLabel="Create new LUT curve profile"
        title="Create New Curve"
        subtitle="Start from Opaque, Clear, or your own custom min/max alpha values."
        icon={<Plus className="h-4 w-4" />}
        iconTone="accent"
        zIndexClassName="z-[136]"
        maxWidthClassName="max-w-md"
        closeAriaLabel="Close create curve profile dialog"
        onClose={handleCancelCreate}
        onBackdropClick={handleCancelCreate}
        actions={(
          <>
            <button
              type="button"
              onClick={handleCancelCreate}
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmCreate}
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'var(--accent-secondary-action-border)',
                background: 'var(--accent-secondary-action-bg-92)',
                color: 'var(--accent-secondary-action-color)',
              }}
            >
              <Check className="h-3.5 w-3.5" />
              Create
            </button>
          </>
        )}
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Curve name
            </label>
            <input
              type="text"
              value={draftCreateName}
              onChange={(event) => setDraftCreateName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleConfirmCreate();
                }
              }}
              maxLength={48}
              className="ui-input h-9 w-full text-xs"
              placeholder="New Curve"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Preset
            </label>
            <div
              className="inline-flex w-full rounded-md border p-1"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}
            >
              {(['opaque', 'clear', 'custom'] as const).map((preset) => {
                const active = draftCreatePreset === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setDraftCreatePreset(preset)}
                    className="flex-1 rounded-sm border px-2 py-1 text-[11px] font-semibold transition-colors"
                    style={active
                      ? {
                        color: 'var(--accent-secondary-action-color)',
                        borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 22%)',
                        background: 'color-mix(in srgb, var(--accent-secondary), transparent 94%)',
                        boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent-secondary), transparent 78%) inset',
                      }
                      : {
                        color: 'var(--text-muted)',
                        borderColor: 'var(--border-subtle)',
                        background: 'transparent',
                      }}
                  >
                    {preset === 'opaque' ? 'Opaque' : preset === 'clear' ? 'Clear' : 'Custom'}
                  </button>
                );
              })}
            </div>
          </div>

          {draftCreatePreset === 'custom' ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Min alpha {alphaUnitMode === 'u8' ? '(0-255)' : '(%)'}
                </label>
                <ScrollableNumberField
                  value={alphaUnitMode === 'u8'
                    ? Math.round(clampRange(draftCreateCustomMin, 0, 100) * 255 / 100)
                    : Math.round(clampRange(draftCreateCustomMin, 0, 100))}
                  onChange={(nextValue) => setDraftCreateCustomMin(alphaDisplayValueToPercent(nextValue, alphaUnitMode))}
                  min={0}
                  max={alphaUnitMode === 'u8' ? 255 : 100}
                  step={1}
                  unit={alphaUnitMode === 'percent' ? '%' : undefined}
                  ariaLabel="Custom minimum alpha"
                  decreaseTitle="Decrease minimum alpha"
                  increaseTitle="Increase minimum alpha"
                  className="w-full"
                  inputClassName="!h-9 !text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Max alpha {alphaUnitMode === 'u8' ? '(0-255)' : '(%)'}
                </label>
                <ScrollableNumberField
                  value={alphaUnitMode === 'u8'
                    ? Math.round(clampRange(draftCreateCustomMax, 0, 100) * 255 / 100)
                    : Math.round(clampRange(draftCreateCustomMax, 0, 100))}
                  onChange={(nextValue) => setDraftCreateCustomMax(alphaDisplayValueToPercent(nextValue, alphaUnitMode))}
                  min={0}
                  max={alphaUnitMode === 'u8' ? 255 : 100}
                  step={1}
                  unit={alphaUnitMode === 'percent' ? '%' : undefined}
                  ariaLabel="Custom maximum alpha"
                  decreaseTitle="Decrease maximum alpha"
                  increaseTitle="Increase maximum alpha"
                  className="w-full"
                  inputClassName="!h-9 !text-xs"
                />
              </div>
            </div>
          ) : (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {draftCreatePreset === 'opaque'
                ? 'Opaque starts at 55% and ramps to 90%.'
                : 'Clear starts at 55% and ramps to 65%.'}
            </p>
          )}
        </div>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={showRenameDialog}
        ariaLabel="Rename LUT curve profile"
        title="Rename Curve Profile"
        subtitle="Update the display name for this LUT curve profile."
        icon={<Edit3 className="h-4 w-4" />}
        iconTone="accent"
        zIndexClassName="z-[137]"
        maxWidthClassName="max-w-md"
        closeAriaLabel="Close rename curve profile dialog"
        onClose={handleCancelRename}
        onBackdropClick={handleCancelRename}
        actions={(
          <>
            <button
              type="button"
              onClick={handleCancelRename}
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmRename}
              disabled={draftRenameName.trim().length === 0}
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed"
              style={{
                borderColor: 'var(--accent-secondary-action-border)',
                background: 'var(--accent-secondary-action-bg-92)',
                color: 'var(--accent-secondary-action-color)',
              }}
            >
              <Check className="h-3.5 w-3.5" />
              Save Name
            </button>
          </>
        )}
      >
        <div className="space-y-2">
          <label className="block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Curve name
          </label>
          <input
            ref={renameInputRef}
            type="text"
            value={draftRenameName}
            onChange={(event) => setDraftRenameName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draftRenameName.trim().length > 0) {
                event.preventDefault();
                handleConfirmRename();
              }
            }}
            maxLength={48}
            className="ui-input h-9 w-full text-xs"
            placeholder="Curve name"
          />
        </div>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={showDiscardConfirm}
        ariaLabel="Discard unsaved LUT curve changes"
        title="Do you wanna quit?"
        subtitle="You have unsaved LUT curve edits."
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        zIndexClassName="z-[138]"
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
        zIndexClassName="z-[139]"
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
