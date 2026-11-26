"use client";

import React from 'react';
import * as THREE from 'three';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  ClipboardCopy,
  Eye,
  EyeOff,
  FileText,
  Loader2,
  ShieldPlus,
} from 'lucide-react';
import type { MessageDescriptor } from '@lingui/core';
import { Button, Card, CardHeader, IconButton } from '@/components/atoms';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import { isSupportEditInteractionActive } from '@/supports/interaction/gizmoInteractionLock';
import {
  classifyToppleRisk,
  clearModelToppleRisk,
  FLOATING_Z_THRESHOLD_MM,
  getFrameStressSnapshot,
  getModelMesh,
  HIGH_LEVERAGE_SPAN_MM,
  coverageCheckStatus,
  reinforceOverloadedFrameMembers,
  setHoveredStressLayerZ,
  setModelFrameStress,
  setModelPrintability,
  setModelToppleRisk,
  setStressOverlayEnabled,
  subscribeFrameStress,
  subscribeModelMesh,
  summarizeSupportStress,
  supportStressReportToText,
  type LayerPeelPoint,
  type PrintabilityReport,
  type SupportFrameStressReport,
  type SupportStressStatusLevel,
  type SupportStressSummary,
  type ToppleRiskReport,
} from '@/supports/autoSupport';
import { analyzeSupportState } from '@/supports/autoSupport/autoPlaceWorkerClient';
import { getHomeSupportCollectionsSnapshot } from '@/features/supports/supportSnapshotHelpers';
import { getSettings } from '@/supports/Settings/state';
import { getSnapshot, setSnapshot, subscribe as subscribeSupportState } from '@/supports/state';
import type { SupportState } from '@/supports/types';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import {
  captureSupportEditSnapshot,
  flushSupportEditHistory,
  pushSupportEditHistory,
} from '@/supports/history/supportEditHistory';
import type { SupportTypeId } from '@/supports/supportTypeRegistry';
import { AUTO_SUPPORT_SECTION_CARD } from './autoSupportPanelTabs';

const REINFORCE_HISTORY_LABEL = msg`Reinforce overloaded supports`;
const AUTO_REFRESH_DEBOUNCE_MS = 300;

interface SupportAnalysisUiState {
  running: boolean;
  phase: string;
  done: number;
  total: number;
  error: string | null;
}

const ANALYSIS_STEPS: ReadonlyArray<{ phase: string; label: MessageDescriptor }> = [
  { phase: 'Preparing model', label: msg`Model` },
  { phase: 'Sampling layers', label: msg`Layers` },
  { phase: 'Building support graph', label: msg`Supports` },
  { phase: 'Solving frame', label: msg`Frame` },
  { phase: 'Stability', label: msg`Stability` },
  { phase: 'Printability', label: msg`Coverage` },
];

interface StructuralRefs {
  roots: SupportState['roots'];
  trunks: SupportState['trunks'];
  branches: SupportState['branches'];
  leaves: SupportState['leaves'];
  braces: SupportState['braces'];
  knots: SupportState['knots'];
  stumps: SupportState['stumps'];
  kickstands: SupportState['kickstands'];
  sticks: SupportState['sticks'];
  twigs: SupportState['twigs'];
}

function captureStructuralRefs(snap: SupportState): StructuralRefs {
  return {
    roots: snap.roots,
    trunks: snap.trunks,
    branches: snap.branches,
    leaves: snap.leaves,
    braces: snap.braces,
    knots: snap.knots,
    stumps: snap.stumps,
    kickstands: snap.kickstands,
    sticks: snap.sticks,
    twigs: snap.twigs,
  };
}

function sameStructuralRefs(a: StructuralRefs, b: StructuralRefs): boolean {
  return (
    a.roots === b.roots
    && a.trunks === b.trunks
    && a.branches === b.branches
    && a.leaves === b.leaves
    && a.braces === b.braces
    && a.knots === b.knots
    && a.stumps === b.stumps
    && a.kickstands === b.kickstands
    && a.sticks === b.sticks
    && a.twigs === b.twigs
  );
}

const KIND_LABELS: Partial<Record<SupportTypeId, MessageDescriptor>> = {
  trunk: msg`Trunk`,
  branch: msg`Branch`,
  leaf: msg`Leaf`,
  brace: msg`Brace`,
  stump: msg`Stump`,
  kickstand: msg`Kickstand`,
  twig: msg`Twig`,
  stick: msg`Stick`,
};

type Translate = ReturnType<typeof useLingui>['_'];
type LocaleFmt = ReturnType<typeof useLocaleFormat>;

function utilizationColor(utilizationPct: number): string {
  if (utilizationPct > 100) return 'var(--danger)';
  if (utilizationPct >= 75) return '#f59e0b';
  return 'var(--success)';
}

function statusAccentColor(level: SupportStressStatusLevel): string {
  switch (level) {
    case 'critical':
      return 'var(--danger)';
    case 'attention':
      return '#f59e0b';
    case 'ready':
      return 'var(--success)';
    default:
      return 'var(--text-muted)';
  }
}

function statusBannerStyle(level: SupportStressStatusLevel): React.CSSProperties {
  if (level === 'unanalyzed') return AUTO_SUPPORT_SECTION_CARD;
  const accent = level === 'critical' ? '#ef4444' : level === 'attention' ? '#f59e0b' : '#22c55e';
  return {
    borderColor: `color-mix(in srgb, ${accent}, var(--border-subtle) 55%)`,
    background: `color-mix(in srgb, ${accent}, var(--surface-1) 89%)`,
  };
}

function StatusGlyph({ level, className = 'h-4 w-4 shrink-0' }: { level: SupportStressStatusLevel; className?: string }) {
  const color = statusAccentColor(level);
  if (level === 'critical') return <AlertCircle className={className} style={{ color }} />;
  if (level === 'attention') return <AlertTriangle className={className} style={{ color }} />;
  if (level === 'ready') return <CheckCircle2 className={className} style={{ color }} />;
  return <Activity className={className} style={{ color }} />;
}

// Module-scope formatting helpers so React Compiler never renames interpolated locals.
function formatStatusTitle(_: Translate, level: SupportStressStatusLevel): string {
  switch (level) {
    case 'ready':
      return _(msg`Checks Passed`);
    case 'attention':
      return _(msg`Needs Attention`);
    case 'critical':
      return _(msg`Action Needed`);
    case 'unanalyzed':
      return _(msg`Not Checked`);
  }
}

function formatPrimaryIssueSubtitle(
  _: Translate,
  fmt: LocaleFmt,
  summary: SupportStressSummary,
  printability?: PrintabilityReport,
  topple?: ToppleRiskReport,
  modelMinZMm?: number | null,
): string {
  switch (summary.primaryIssue) {
    case 'none':
      return '';
    case 'unanalyzed':
      return _(msg`Scan overhangs or generate supports to check printability.`);
    case 'notScanned':
      return _(msg`Support loads look OK; scan overhangs to check coverage.`);
    case 'floatingUnsupported': {
      if (typeof modelMinZMm === 'number') {
        const height = fmt.quantity(modelMinZMm, 1, 'mm');
        return _(msg`Model floats ${height} above the build plate with no supports.`);
      }
      return _(msg`Model floats above the build plate with no supports.`);
    }
    case 'overloadedSupports': {
      const count = summary.overloadedCount;
      const peak = fmt.quantity(summary.peakUtilizationPct, 0, 'percent');
      if (count === 1) return _(msg`1 support element exceeds limit (${peak}).`);
      return _(msg`${count} support elements exceed limit (${peak}).`);
    }
    case 'pastBearingEdge':
      return _(msg`Centre of mass sits past the bearing edge.`);
    case 'uncoveredOverhangs': {
      const area = fmt.quantity(printability?.uncoveredAreaMm2 ?? 0, 1, 'mm2');
      return _(msg`${area} of overhang surface is unsupported.`);
    }
    case 'highLoad': {
      const peak = fmt.quantity(summary.peakUtilizationPct, 0, 'percent');
      return _(msg`Peak support load reaches ${peak}.`);
    }
    case 'rocking': {
      const defl = fmt.quantity(topple?.complianceMm ?? 0, 2, 'mm');
      return _(msg`Part rocking (${defl}) exceeds the layer-shift limit.`);
    }
    case 'deficientRegions': {
      const regions = printability?.deficientRegions ?? 0;
      if (regions === 1) return _(msg`1 overhang region is short on support.`);
      return _(msg`${regions} overhang regions are short on support.`);
    }
    case 'longSpan': {
      const span = fmt.quantity(printability?.maxFreeSpanMm ?? 0, 1, 'mm');
      return _(msg`Long unsupported span (${span}).`);
    }
  }
}

function formatCoverageChecklistLabel(
  _: Translate,
  fmt: LocaleFmt,
  printability: PrintabilityReport,
): string {
  if (printability.uncoveredAreaMm2 > 0.02) {
    const area = fmt.quantity(printability.uncoveredAreaMm2, 1, 'mm2');
    return _(msg`${area} uncovered`);
  }
  if (printability.deficientRegions > 0) {
    const count = printability.deficientRegions;
    if (count === 1) return _(msg`1 short region`);
    return _(msg`${count} short regions`);
  }
  if (printability.maxFreeSpanMm >= HIGH_LEVERAGE_SPAN_MM) {
    const span = fmt.quantity(printability.maxFreeSpanMm, 1, 'mm');
    return _(msg`Span ${span}`);
  }
  return _(msg`All covered`);
}

function formatLoadChecklistLabel(
  _: Translate,
  fmt: LocaleFmt,
  report: SupportFrameStressReport | undefined,
  summary: SupportStressSummary,
): string {
  if (!report) return _(msg`No supports`);
  const peak = fmt.quantity(summary.peakUtilizationPct, 0, 'percent');
  if (summary.overloadedCount > 0) {
    const count = summary.overloadedCount;
    return _(msg`${peak} · ${count} over`);
  }
  return peak;
}

function formatStabilityChecklistLabel(
  _: Translate,
  fmt: LocaleFmt,
  topple: ToppleRiskReport,
  level: SupportStressStatusLevel,
): string {
  if (topple.outcome === 'pastEdge') return _(msg`May tip`);
  if (topple.outcome === 'rocking') {
    const defl = fmt.quantity(topple.complianceMm, 2, 'mm');
    return level === 'ready'
      ? _(msg`Elastic rotation · ${defl}`)
      : _(msg`Rocking · ${defl}`);
  }
  return _(msg`Stable`);
}

function formatOverloadedCount(_: Translate, count: number): string {
  if (count === 0) return _(msg`Within limit`);
  return _(msg`${count} overloaded`);
}

function formatDeflectionReadout(_: Translate, formattedDefl: string): string {
  return _(msg`Defl. ${formattedDefl}`);
}

function formatReinforcedFeedback(_: Translate, count: number): string {
  if (count === 1) return _(msg`Reinforced 1 weak member`);
  return _(msg`Reinforced ${count} weak members`);
}

function formatHotspotCountHint(_: Translate, count: number): string {
  if (count === 1) return _(msg`1 hotspot`);
  return _(msg`${count} hotspots`);
}

function formatHotspotReadout(
  _: Translate,
  kind: 'tip' | 'member',
  entityKind: SupportTypeId,
): string {
  const entity = KIND_LABELS[entityKind] ? _(KIND_LABELS[entityKind]) : entityKind;
  if (kind === 'tip') {
    return _(msg`${entity} tip`);
  }
  return _(msg`${entity} shaft`);
}

function formatLayerInspection(
  fmt: LocaleFmt,
  zMm: number,
  forceN: number,
): string {
  return `${fmt.quantity(zMm, 1, 'mm')} · ${fmt.quantity(forceN, 2, 'N')}`;
}

function coverageRowColor(printability: PrintabilityReport): string {
  const status = coverageCheckStatus(printability);
  if (status === 'fail') return 'var(--danger)';
  if (status === 'warn') return '#f59e0b';
  return 'var(--success)';
}

function stabilityRowColor(topple: ToppleRiskReport, level: SupportStressStatusLevel): string {
  if (topple.outcome === 'pastEdge') return 'var(--danger)';
  if (topple.outcome === 'rocking' && level !== 'ready') return '#f59e0b';
  return 'var(--success)';
}

function computeMeshMinZMm(mesh: THREE.Mesh | null | undefined): number | null {
  if (!mesh || !mesh.geometry) return null;
  const pos = mesh.geometry.getAttribute('position');
  if (!pos || pos.count === 0) return null;
  mesh.updateMatrixWorld();
  const e = mesh.matrixWorld.elements;
  const m2 = e[2];
  const m6 = e[6];
  const m10 = e[10];
  const m14 = e[14];
  let minZ = Infinity;
  for (let i = 0; i < pos.count; i++) {
    const z = m2 * pos.getX(i) + m6 * pos.getY(i) + m10 * pos.getZ(i) + m14;
    if (z < minZ) minZ = z;
  }
  return Number.isFinite(minZ) ? minZ : null;
}

interface StressGraphSvgProps {
  layers: readonly LayerPeelPoint[];
  hoveredIndex: number | null;
  onHoverIndex: (index: number | null) => void;
}

const SVG_W = 240;
const SVG_H = 72;
const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 8;
const PAD_B = 6;

function StressGraphSvg({ layers, hoveredIndex, onHoverIndex }: StressGraphSvgProps) {
  if (layers.length === 0) return null;

  const plotW = SVG_W - PAD_L - PAD_R;
  const plotH = SVG_H - PAD_T - PAD_B;
  let minZ = layers[0].zMm;
  let maxZ = layers[0].zMm;
  let maxForce = 0.05;
  for (const pt of layers) {
    if (pt.zMm < minZ) minZ = pt.zMm;
    if (pt.zMm > maxZ) maxZ = pt.zMm;
    if (pt.peelForceN > maxForce) maxForce = pt.peelForceN;
  }
  const zSpan = Math.max(1e-3, maxZ - minZ);

  const coords = layers.map((pt, i) => {
    const x = layers.length === 1
      ? PAD_L + plotW * 0.5
      : PAD_L + ((pt.zMm - minZ) / zSpan) * plotW;
    const y = PAD_T + plotH - (pt.peelForceN / maxForce) * plotH;
    const util = Math.max(pt.maxTipUtilPct, pt.maxMemberUtilPct);
    return { x, y, util, pt, i };
  });

  const linePath = coords.map((c, idx) => `${idx === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const firstX = coords[0].x.toFixed(1);
  const lastX = coords[coords.length - 1].x.toFixed(1);
  const baseY = (PAD_T + plotH).toFixed(1);
  const areaPath = `${linePath} L${lastX},${baseY} L${firstX},${baseY} Z`;

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * SVG_W;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (const c of coords) {
      const d = Math.abs(c.x - svgX);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = c.i;
      }
    }
    onHoverIndex(bestIdx);
  };

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="w-full h-[72px] select-none cursor-crosshair"
      onPointerMove={handlePointerMove}
      onPointerLeave={() => onHoverIndex(null)}
    >
      <defs>
        <linearGradient id="df-stress-peel-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      <line x1={PAD_L} y1={PAD_T + plotH * 0.5} x2={SVG_W - PAD_R} y2={PAD_T + plotH * 0.5} stroke="var(--border-subtle)" strokeWidth="0.6" strokeDasharray="2 2" />
      <line x1={PAD_L} y1={PAD_T + plotH} x2={SVG_W - PAD_R} y2={PAD_T + plotH} stroke="var(--border-subtle)" strokeWidth="0.8" />

      {coords.filter((c) => c.pt.critical).map((c) => (
        <line
          key={`crit-${c.i}`}
          x1={c.x}
          y1={PAD_T}
          x2={c.x}
          y2={PAD_T + plotH}
          stroke={utilizationColor(c.util)}
          strokeOpacity="0.55"
          strokeWidth="1.1"
          strokeDasharray="2 2"
        />
      ))}

      <path d={areaPath} fill="url(#df-stress-peel-fill)" />
      <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />

      {coords.map((c) => {
        const isHovered = hoveredIndex === c.i;
        if (!c.pt.critical && !isHovered) return null;
        return (
          <circle
            key={`dot-${c.i}`}
            cx={c.x}
            cy={c.y}
            r={isHovered ? 3.2 : 2.3}
            fill={utilizationColor(c.util)}
            stroke="var(--surface-1)"
            strokeWidth="0.9"
          />
        );
      })}
    </svg>
  );
}

type ReinforceFeedback =
  | { kind: 'reinforced'; count: number }
  | { kind: 'limit' };

/**
 * Peel force vs Z. Rendered from the solved report when one exists and from the
 * printability report's per-layer curve otherwise, so adhesion is visible on a
 * model with no supports at all.
 */
function PeelProfileGraph({
  layers,
  hoveredIndex,
  onHoverIndex,
  inspectedLayer,
  peakZMm,
  peakForceN,
  deflectionMm,
}: {
  layers: readonly LayerPeelPoint[];
  hoveredIndex: number | null;
  onHoverIndex: (index: number | null) => void;
  inspectedLayer: LayerPeelPoint | null;
  peakZMm: number;
  peakForceN: number;
  deflectionMm?: number;
}) {
  const { _ } = useLingui();
  const fmt = useLocaleFormat();
  return (
    <div className="rounded-md border p-2 space-y-1.5" style={AUTO_SUPPORT_SECTION_CARD}>
      <div className="flex items-center justify-between text-[10px]">
        <span className="font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          {_(msg`Peel Profile`)}
        </span>
        <span className="tabular-nums font-medium" style={{ color: 'var(--text-strong)' }}>
          {inspectedLayer
            ? formatLayerInspection(fmt, inspectedLayer.zMm, inspectedLayer.peelForceN)
            : formatLayerInspection(fmt, peakZMm, peakForceN)}
        </span>
      </div>

      {layers.length > 0 ? (
        <StressGraphSvg
          layers={layers}
          hoveredIndex={hoveredIndex}
          onHoverIndex={onHoverIndex}
        />
      ) : (
        <div className="py-3 text-center text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {_(msg`No representative layers sampled`)}
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
        {inspectedLayer ? (
          <>
            <span>{fmt.quantity(inspectedLayer.areaMm2, 0, 'mm2')}</span>
            {deflectionMm !== undefined && (
              <span>{fmt.quantity(Math.max(inspectedLayer.maxTipUtilPct, inspectedLayer.maxMemberUtilPct), 0, 'percent')}</span>
            )}
          </>
        ) : (
          <>
            <span>{fmt.quantity(layers[0]?.zMm ?? 0, 1, 'mm')}</span>
            {deflectionMm !== undefined && <span>{formatDeflectionReadout(_, fmt.quantity(deflectionMm, 2, 'mm'))}</span>}
            <span>{layers.length > 0 ? fmt.quantity(layers[layers.length - 1].zMm, 1, 'mm') : ''}</span>
          </>
        )}
      </div>
    </div>
  );
}

export interface SupportStressPanelProps {
  activeModelId?: string;
  /** True after an island/overhang scan has completed for the current model pose. */
  hasScanned?: boolean;
  /** Stable signature for the model pose so floating/topple checks track transforms. */
  poseKey?: string | null;
  /** Live island scan for the active model; absent when nothing has been scanned. */
  islands?: readonly DetectedIsland[];
  /** Pose drag total the scan reported, for the load budget's topple channel. */
  poseDragMomentMm3?: number;
  toppleCoverageNeeded?: boolean;
}

function SupportStressPanelImpl({
  activeModelId,
  hasScanned,
  poseKey,
  islands,
  poseDragMomentMm3,
  toppleCoverageNeeded,
}: SupportStressPanelProps) {
  const { _ } = useLingui();
  const fmt = useLocaleFormat();
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [showDetails, setShowDetails] = React.useState(false);
  const [showStressReport, setShowStressReport] = React.useState(false);
  const [copiedReport, setCopiedReport] = React.useState(false);
  const [hoveredIdx, setHoveredIdx] = React.useState<number | null>(null);
  const [reinforceFeedback, setReinforceFeedback] = React.useState<ReinforceFeedback | null>(null);
  const lastOwnReportRef = React.useRef<SupportFrameStressReport | null>(null);
  const lastSolvedRefsRef = React.useRef<StructuralRefs | null>(null);
  const autoRefreshTimerRef = React.useRef<number | null>(null);
  const analysisSeqRef = React.useRef(0);
  const [analysis, setAnalysis] = React.useState<SupportAnalysisUiState>({
    running: false,
    phase: '',
    done: 0,
    total: 0,
    error: null,
  });

  const stressSnap = React.useSyncExternalStore(
    subscribeFrameStress,
    getFrameStressSnapshot,
    getFrameStressSnapshot,
  );
  const report: SupportFrameStressReport | undefined = activeModelId
    ? stressSnap.byModelId[activeModelId]
    : undefined;
  const printability: PrintabilityReport | undefined = activeModelId
    ? stressSnap.printabilityByModelId[activeModelId]
    : undefined;
  // Topple risk follows the live solved deflection whenever support geometry changes.
  const toppleBase = activeModelId ? stressSnap.toppleRiskByModelId[activeModelId] : undefined;
  const toppleComplianceMm = report?.maxTipRockingMm ?? toppleBase?.complianceMm ?? 0;
  const topple = React.useMemo(
    () => (toppleBase
      ? {
        ...toppleBase,
        complianceMm: toppleComplianceMm,
        outcome: classifyToppleRisk(toppleBase.comDepthMm, toppleComplianceMm),
      }
      : undefined),
    [toppleBase, toppleComplianceMm],
  );
  const overlayEnabled = stressSnap.overlayEnabled;
  const modelMesh = React.useSyncExternalStore(
    subscribeModelMesh,
    () => (activeModelId ? getModelMesh(activeModelId) : null),
    () => null,
  );
  // `poseKey` is a recompute trigger, not an input: a pose change mutates the
  // mesh's matrixWorld in place, so the object identity alone cannot say the
  // lowest world Z moved.
  const modelMinZMm = React.useMemo(() => {
    void poseKey;
    return computeMeshMinZMm(modelMesh);
  }, [modelMesh, poseKey]);
  // Contact presence is read live: a pre-supported model whose first solve has
  // not landed yet is not "floating" — that banner is for a part hanging in the
  // air with nothing under it.
  const supportSnap = React.useSyncExternalStore(
    subscribeSupportState,
    getHomeSupportCollectionsSnapshot,
    getHomeSupportCollectionsSnapshot,
  );
  const hasModelContacts = React.useMemo(() => {
    if (!activeModelId) return false;
    return [supportSnap.trunks, supportSnap.branches, supportSnap.leaves,
      supportSnap.stumps, supportSnap.sticks, supportSnap.twigs]
      .some((collection) => Object.values(collection ?? {})
        .some((entity) => entity.modelId === activeModelId));
  }, [supportSnap, activeModelId]);
  const isFloatingUnsupported = Boolean(
    !report && !hasModelContacts && modelMinZMm !== null && modelMinZMm > FLOATING_Z_THRESHOLD_MM,
  );

  const islandsRef = React.useRef(islands);
  React.useEffect(() => {
    islandsRef.current = islands;
  }, [islands]);
  const islandsKey = React.useMemo(() => {
    const list = islands ?? [];
    return `${list.length}|${list
      .map((island) => `${island.id}:${(island.areaMm2 ?? 0).toFixed(3)}:${(island.overhangAngleDeg ?? 0).toFixed(2)}`)
      .join(',')}`;
  }, [islands]);

  /**
   * Evaluate the existing forest on the worker. The frame solve, representative
   * layer sampling, printability and topple pass were the main-thread chug on a
   * large model; the worker returns the three reports and this only commits them.
   */
  const runAnalysis = React.useCallback(async (reinforcedCount?: number) => {
    if (!activeModelId) return;
    const seq = ++analysisSeqRef.current;
    const snapshot = getSnapshot();
    const refs = captureStructuralRefs(snapshot);
    const pose = poseKey ?? null;
    setAnalysis({ running: true, phase: 'Preparing model', done: 0, total: 1, error: null });
    // Keep the async failure path out of a try/catch: the compiler skips a
    // component that owns one, which would drop the whole panel's memoisation.
    const outcome = await analyzeSupportState(
      activeModelId,
      islandsRef.current ?? [],
      {
        poseDragMomentMm3,
        toppleCoverageNeeded,
        areaPerSupportMm2: getSettings().autoSupport.areaPerSupportMm2,
      },
      (progress) => {
        if (analysisSeqRef.current !== seq) return;
        setAnalysis({
          running: true,
          phase: progress.phase,
          done: progress.done,
          total: progress.total,
          error: null,
        });
      },
    ).then(
      (result) => ({ result, error: null as unknown }),
      (error: unknown) => ({ result: null, error }),
    );
    if (analysisSeqRef.current !== seq) return;
    if (!outcome.result) {
      setAnalysis({
        running: false,
        phase: '',
        done: 0,
        total: 0,
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      });
      return;
    }
    const result = outcome.result;
    const currentRefs = captureStructuralRefs(getSnapshot());
    if (!sameStructuralRefs(currentRefs, refs) || (poseKey ?? null) !== pose) {
      // A newer edit or pose change already owns the panel; its result lands.
      return;
    }
    lastSolvedRefsRef.current = currentRefs;
    const nextReport: SupportFrameStressReport = reinforcedCount !== undefined
      ? {
          ...result.frame,
          reinforcedCount: (lastOwnReportRef.current?.reinforcedCount ?? 0) + reinforcedCount,
        }
      : result.frame;
    lastOwnReportRef.current = nextReport;
    setModelFrameStress(activeModelId, nextReport);
    setModelPrintability(activeModelId, result.printability);
    if (result.topple) setModelToppleRisk(activeModelId, result.topple);
    else clearModelToppleRisk(activeModelId);
    setAnalysis({ running: false, phase: '', done: 0, total: 0, error: null });
  }, [activeModelId, poseKey, poseDragMomentMm3, toppleCoverageNeeded]);

  // Evaluate the model, pose, or scan on the worker; support edits go through
  // the debounced subscription below.
  React.useEffect(() => {
    if (!activeModelId || !modelMesh) return;
    // The analysis is a worker request whose first write puts the panel into
    // its running state; it belongs to this effect, not a render body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runAnalysis();
  }, [activeModelId, poseKey, modelMesh, hasScanned, islandsKey, runAnalysis]);

  React.useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- a new report resets the
       per-report UI state; the report is the external value this effect syncs. */
    setHoveredIdx(null);
    setCopiedReport(false);
    if (!report || report !== lastOwnReportRef.current) {
      setReinforceFeedback(null);
    }
    if (report) {
      if (autoRefreshTimerRef.current !== null) {
        window.clearTimeout(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
      lastSolvedRefsRef.current = captureStructuralRefs(getSnapshot());
    } else {
      lastSolvedRefsRef.current = null;
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [activeModelId, report]);

  const handleReinforce = React.useCallback(() => {
    if (!activeModelId || !report || report.overloadedMembers === 0) return;
    const before = captureSupportEditSnapshot();
    const snap = getSnapshot();
    const mesh = getModelMesh(activeModelId);
    const reinforced = reinforceOverloadedFrameMembers(snap, report, mesh ?? undefined, activeModelId);
    if (!reinforced.changed) {
      setReinforceFeedback({ kind: 'limit' });
      return;
    }

    lastSolvedRefsRef.current = captureStructuralRefs(reinforced.snapshot);
    setSnapshot(reinforced.snapshot);
    pushSupportEditHistory(REINFORCE_HISTORY_LABEL, before, captureSupportEditSnapshot());
    flushSupportEditHistory();
    setReinforceFeedback({ kind: 'reinforced', count: reinforced.totalReinforced });
    void runAnalysis(reinforced.totalReinforced);
  }, [activeModelId, report, runAnalysis]);

  // Every structural support edit re-analyses on a debounce; never mid-drag.
  React.useEffect(() => {
    if (!activeModelId) return;
    let lastSeenRefs = captureStructuralRefs(getSnapshot());

    const clearTimer = () => {
      if (autoRefreshTimerRef.current !== null) {
        window.clearTimeout(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };

    const scheduleAnalysis = () => {
      clearTimer();
      autoRefreshTimerRef.current = window.setTimeout(() => {
        autoRefreshTimerRef.current = null;
        // Resizing/dragging a support writes structural state continuously; do
        // not block the gizmo with an analysis mid-drag. Re-arm until the edit
        // and its post-drag guard clear.
        if (isSupportEditInteractionActive()) {
          scheduleAnalysis();
          return;
        }
        const latestSnap = getSnapshot();
        const latestRefs = captureStructuralRefs(latestSnap);
        if (lastSolvedRefsRef.current && sameStructuralRefs(latestRefs, lastSolvedRefsRef.current)) {
          return;
        }
        void runAnalysis();
      }, AUTO_REFRESH_DEBOUNCE_MS);
    };

    const unsubscribe = subscribeSupportState(() => {
      const snap = getSnapshot();
      const nextRefs = captureStructuralRefs(snap);
      if (sameStructuralRefs(nextRefs, lastSeenRefs)) return;
      lastSeenRefs = nextRefs;

      const curStress = getFrameStressSnapshot();
      const shouldRefresh = Boolean(curStress.byModelId[activeModelId])
        || curStress.overlayEnabled
        || [snap.trunks, snap.branches, snap.leaves, snap.stumps, snap.sticks, snap.twigs]
          .some((collection) => Object.keys(collection).length > 0)
        || Boolean(islandsRef.current && islandsRef.current.length > 0);
      if (!shouldRefresh) return;
      if (lastSolvedRefsRef.current && sameStructuralRefs(nextRefs, lastSolvedRefsRef.current)) {
        return;
      }
      scheduleAnalysis();
    });

    return () => {
      unsubscribe();
      clearTimer();
    };
  }, [activeModelId, hasScanned, islandsKey, overlayEnabled, runAnalysis]);

  const layers = report && report.layerProfile.length > 0
    ? report.layerProfile
    : printability?.peelCurve ?? [];
  const inspectedLayer = hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < layers.length
    ? layers[hoveredIdx]
    : null;
  const inspectedZMm = inspectedLayer ? inspectedLayer.zMm : null;

  React.useEffect(() => {
    setHoveredStressLayerZ(inspectedZMm);
    return () => {
      setHoveredStressLayerZ(null);
    };
  }, [inspectedZMm]);

  const summary = React.useMemo(
    () => summarizeSupportStress({
      modelId: activeModelId,
      frame: report,
      printability,
      topple,
      floatingUnsupported: isFloatingUnsupported,
      modelMinZMm: modelMinZMm ?? undefined,
      hasScan: hasScanned,
    }),
    [activeModelId, report, printability, topple, isFloatingUnsupported, modelMinZMm, hasScanned],
  );

  const issueSubtitle = formatPrimaryIssueSubtitle(_, fmt, summary, printability, topple, modelMinZMm);

  const reportText = React.useMemo(
    () => (showStressReport
      ? supportStressReportToText({
        modelId: activeModelId,
        frame: report,
        printability,
        topple,
        floatingUnsupported: isFloatingUnsupported,
        modelMinZMm: modelMinZMm ?? undefined,
        hasScan: hasScanned,
      })
      : ''),
    [showStressReport, activeModelId, report, printability, topple, isFloatingUnsupported, modelMinZMm, hasScanned],
  );

  const handleCopyReport = React.useCallback(() => {
    if (!reportText) return;
    void navigator.clipboard?.writeText(reportText);
    setCopiedReport(true);
    window.setTimeout(() => setCopiedReport(false), 1800);
  }, [reportText]);

  const hasAnyData = Boolean(report || printability || topple || isFloatingUnsupported);
  const coverageMeasured = Boolean(printability && hasScanned !== false);
  const showCoverageRow = Boolean(coverageMeasured || hasScanned === false);
  const showStabilityRow = Boolean(topple || isFloatingUnsupported);
  const canReinforce = Boolean(report && report.overloadedMembers > 0);
  const overloadedTotal = summary.overloadedCount;
  const showHotspots = Boolean(
    report
    && report.hotspots.length > 0
    && (report.overloadedMembers > 0 || report.overloadedTips > 0 || report.hotspots[0].utilizationPct >= 75),
  );
  const modalTone = summary.level === 'critical'
    ? 'danger'
    : summary.level === 'attention'
      ? 'warning'
      : 'neutral';
  const peakForceForHeader = report?.peakLayerPeelForceN ?? printability?.peakPeelForceN ?? 0;
  const analysisStepIndex = ANALYSIS_STEPS.findIndex((step) => step.phase === analysis.phase);

  return (
    <>
      <Card>
        <CardHeader
          left={(
            <>
              <PanelCollapseToggle expanded={expanded} onToggle={() => setExpanded(!expanded)} />
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                {_(msg`Printability`)}
              </h3>
            </>
          )}
          right={(
            <div className="flex items-center gap-0.5">
              <IconButton
                onClick={() => setStressOverlayEnabled(!overlayEnabled)}
                aria-pressed={overlayEnabled}
                disabled={!hasAnyData}
                title={_(msg`Show unsupported areas and support stress on the model`)}
                className="!p-1.5 disabled:opacity-40"
              >
                {overlayEnabled
                  ? <Eye className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
                  : <EyeOff className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />}
              </IconButton>
              <IconButton
                onClick={() => setShowStressReport(true)}
                disabled={!hasAnyData}
                title={_(msg`Open the full Printability Report`)}
                className="!p-1.5 disabled:opacity-40"
              >
                <FileText className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
              </IconButton>
            </div>
          )}
        />

        {expanded && (
          <div className="px-2.5 pb-3 space-y-2">
            {/* 1. Hero Verdict Banner */}
            {hasAnyData && (
              <div
                className={`rounded-md border p-2.5 flex gap-2 ${issueSubtitle ? 'items-start' : 'items-center'}`}
                style={statusBannerStyle(summary.level)}
              >
                <StatusGlyph
                  level={summary.level}
                  className={`h-4 w-4 shrink-0${issueSubtitle ? ' mt-0.5' : ' -translate-y-px'}`}
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-xs font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    {formatStatusTitle(_, summary.level)}
                  </div>
                  {issueSubtitle && (
                    <div className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                      {issueSubtitle}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Worker analysis progress: the main thread only receives reports. */}
            {(analysis.running || analysis.error) && (
              <div className="rounded-md border p-2 space-y-1.5" style={AUTO_SUPPORT_SECTION_CARD}>
                <div className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    {_(msg`Analyzing`)}
                  </span>
                  <span
                    className="min-w-0 truncate tabular-nums"
                    style={{ color: analysis.error ? 'var(--danger)' : 'var(--text-muted)' }}
                    title={analysis.error ?? undefined}
                  >
                    {analysis.error
                      ?? `${_(msg`Frame, coverage and stability checks`)}${analysis.total > 1 ? ` ${analysis.done}/${analysis.total}` : ''}`}
                  </span>
                </div>
                <div className="flex items-start gap-1">
                  {ANALYSIS_STEPS.map((step, index) => {
                    const stepState = analysis.error
                      ? 'pending'
                      : index < analysisStepIndex
                        ? 'done'
                        : index === analysisStepIndex
                          ? 'active'
                          : 'pending';
                    return (
                      <div
                        key={step.phase}
                        className="flex min-w-0 flex-1 flex-col items-center gap-0.5"
                        title={_(step.label)}
                      >
                        {stepState === 'done' ? (
                          <Check className="h-3.5 w-3.5" style={{ color: 'var(--success)' }} />
                        ) : stepState === 'active' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--accent)' }} />
                        ) : (
                          <Circle className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                        )}
                        <span
                          className="w-full truncate text-center text-[9px]"
                          style={{ color: stepState === 'pending' ? 'var(--text-muted)' : 'var(--text-strong)' }}
                        >
                          {_(step.label)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 2. Unified 3-Row Status Checklist */}
            {hasAnyData && (
              <div
                className="rounded-md border text-[11px]"
                style={{
                  ...AUTO_SUPPORT_SECTION_CARD,
                  borderColor: 'var(--border-subtle)',
                }}
              >
                {showCoverageRow && (
                  <div className="px-2.5 py-1.5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-block h-2 w-2 rounded-full shrink-0"
                        style={{
                          backgroundColor: coverageMeasured && printability
                            ? coverageRowColor(printability)
                            : 'var(--text-muted)',
                        }}
                      />
                      <span style={{ color: 'var(--text-muted)' }}>{_(msg`Coverage`)}</span>
                    </div>
                    <span
                      className="font-medium tabular-nums truncate"
                      style={{
                        color: coverageMeasured && printability
                          ? coverageRowColor(printability)
                          : 'var(--text-muted)',
                      }}
                    >
                      {coverageMeasured && printability
                        ? formatCoverageChecklistLabel(_, fmt, printability)
                        : _(msg`Not scanned`)}
                    </span>
                  </div>
                )}

                <div
                  className={showCoverageRow
                    ? 'border-t px-2.5 py-1.5 flex items-center justify-between gap-2'
                    : 'px-2.5 py-1.5 flex items-center justify-between gap-2'}
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="inline-block h-2 w-2 rounded-full shrink-0"
                      style={{
                        backgroundColor: report
                          ? utilizationColor(summary.peakUtilizationPct)
                          : isFloatingUnsupported
                            ? 'var(--danger)'
                            : 'var(--text-muted)',
                      }}
                    />
                    <span style={{ color: 'var(--text-muted)' }}>{_(msg`Support load`)}</span>
                  </div>
                  <span
                    className="font-medium tabular-nums truncate"
                    style={{
                      color: report
                        ? utilizationColor(summary.peakUtilizationPct)
                        : isFloatingUnsupported
                          ? 'var(--danger)'
                          : 'var(--text-muted)',
                    }}
                  >
                    {formatLoadChecklistLabel(_, fmt, report, summary)}
                  </span>
                </div>

                {showStabilityRow && (
                  <div
                    className="border-t px-2.5 py-1.5 flex items-center justify-between gap-2"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-block h-2 w-2 rounded-full shrink-0"
                        style={{
                          backgroundColor: isFloatingUnsupported
                            ? 'var(--danger)'
                            : topple
                              ? stabilityRowColor(topple, summary.level)
                              : 'var(--text-muted)',
                        }}
                      />
                      <span style={{ color: 'var(--text-muted)' }}>{_(msg`Stability`)}</span>
                    </div>
                    <span
                      className="font-medium tabular-nums truncate"
                      style={{
                        color: isFloatingUnsupported
                          ? 'var(--danger)'
                          : topple
                            ? stabilityRowColor(topple, summary.level)
                            : 'var(--text-muted)',
                      }}
                    >
                      {isFloatingUnsupported
                        ? _(msg`Floating`)
                        : topple
                          ? formatStabilityChecklistLabel(_, fmt, topple, summary.level)
                          : ''}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* 3. Collapsible Details Disclosure */}
            {hasAnyData && (
              <div className="rounded-md border" style={AUTO_SUPPORT_SECTION_CARD}>
                <button
                  type="button"
                  onClick={() => setShowDetails((current) => !current)}
                  title={_(msg`Inspect peel loads, coverage, frame stress, stability metrics, and hotspots`)}
                  className="w-full flex items-center justify-between px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <span className="flex items-center gap-1.5">
                    <span>{_(msg`Details`)}</span>
                    {showDetails && report && (
                      <span className="normal-case font-normal tracking-normal" style={{ color: overloadedTotal > 0 ? 'var(--danger)' : 'var(--success)' }}>
                        {formatOverloadedCount(_, overloadedTotal)}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 tabular-nums normal-case tracking-normal font-normal">
                    <span>
                      {report && report.hotspots.length > 0
                        ? formatHotspotCountHint(_, report.hotspots.length)
                        : peakForceForHeader > 0
                          ? fmt.quantity(peakForceForHeader, 1, 'N')
                          : ''}
                    </span>
                    <ChevronDown
                      className="w-3 h-3 transition-transform"
                      style={{ transform: showDetails ? 'rotate(180deg)' : 'rotate(0deg)' }}
                    />
                  </span>
                </button>

                {showDetails && (
                  <div className="px-2.5 pb-2 space-y-2 text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {layers.length > 0 ? (
                      <PeelProfileGraph
                        layers={layers}
                        hoveredIndex={hoveredIdx}
                        onHoverIndex={setHoveredIdx}
                        inspectedLayer={inspectedLayer}
                        peakZMm={report?.peakLayerZMm ?? printability?.peakPeelLayerZMm ?? 0}
                        peakForceN={report?.peakLayerPeelForceN ?? printability?.peakPeelForceN ?? 0}
                        deflectionMm={report?.maxTipDeflectionMm}
                      />
                    ) : (
                      <div className="text-[10px] italic text-center py-1" style={{ color: 'var(--text-muted)' }}>
                        {_(msg`Generate supports or analyze existing ones to inspect peel loads.`)}
                      </div>
                    )}
                    {report && (
                      <div className="border-t pt-1.5 space-y-1" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="flex justify-between">
                          <span>{_(msg`Peak peel`)}</span>
                          <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(report.peakLayerPeelForceN, 2, 'N')}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{_(msg`Tip max`)}</span>
                          <span style={{ color: utilizationColor(report.maxTipUtilizationPct) }}>
                            {fmt.quantity(report.maxTipUtilizationPct, 0, 'percent')}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>{_(msg`Frame max`)}</span>
                          <span style={{ color: utilizationColor(report.maxMemberUtilizationPct) }}>
                            {fmt.quantity(report.maxMemberUtilizationPct, 0, 'percent')}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>{_(msg`Max deflection`)}</span>
                          <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(report.maxTipDeflectionMm, 2, 'mm')}</span>
                        </div>
                      </div>
                    )}

                    {coverageMeasured && printability && (
                      <div className="border-t pt-1.5 space-y-1" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="flex justify-between">
                          <span>{_(msg`Uncovered area`)}</span>
                          <span style={{ color: coverageRowColor(printability) }}>
                            {fmt.quantity(printability.uncoveredAreaMm2, 1, 'mm2')}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>{_(msg`Max span`)}</span>
                          <span style={{ color: printability.maxFreeSpanMm >= HIGH_LEVERAGE_SPAN_MM ? '#f59e0b' : 'var(--success)' }}>
                            {fmt.quantity(printability.maxFreeSpanMm, 1, 'mm')}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>{_(msg`Short regions`)}</span>
                          <span style={{ color: printability.deficientRegions > 0 ? 'var(--danger)' : 'var(--success)' }}>
                            {fmt.fixed(printability.deficientRegions, 0)}
                          </span>
                        </div>
                        {printability.worst && printability.worst.severity !== 'ok' && (
                          <div className="flex justify-between">
                            <span>{_(msg`Worst region`)}</span>
                            <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(printability.worst.uncoveredAreaMm2, 1, 'mm2')}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {topple && (
                      <div className="border-t pt-1.5 space-y-1" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="flex justify-between">
                          <span>{_(msg`Center of Mass depth`)}</span>
                          <span style={{ color: topple.comDepthMm > 0 ? 'var(--success)' : 'var(--danger)' }}>
                            {fmt.quantity(topple.comDepthMm, 1, 'mm')}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>{_(msg`Lift threshold`)}</span>
                          <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(topple.requiredAdhesionMpa, 3, 'MPa')}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>
                            {summary.level === 'ready' && topple.outcome === 'rocking'
                              ? _(msg`Elastic rotation`)
                              : _(msg`Rocking`)}
                          </span>
                          <span style={{ color: topple.outcome === 'rocking' && summary.level !== 'ready' ? '#f59e0b' : 'var(--success)' }}>
                            {fmt.quantity(topple.complianceMm, 2, 'mm')}
                          </span>
                        </div>
                      </div>
                    )}

                    {showHotspots && report && (
                      <div className="border-t pt-1.5 space-y-1" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                          {_(msg`Hotspots`)}
                        </div>
                        {report.hotspots.slice(0, 5).map((h, idx) => (
                          <div key={`${h.kind}-${h.entityId}-${idx}`} className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                                style={{ backgroundColor: utilizationColor(h.utilizationPct) }}
                              />
                              <span className="truncate" style={{ color: 'var(--text-strong)' }}>
                                {formatHotspotReadout(_, h.kind, h.entityKind)}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {h.peakStressMpa !== undefined && (
                                <span>{fmt.quantity(h.peakStressMpa, 1, 'MPa')}</span>
                              )}
                              <span className="font-semibold" style={{ color: utilizationColor(h.utilizationPct) }}>
                                {fmt.quantity(h.utilizationPct, 0, 'percent')}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {(canReinforce || reinforceFeedback) && (
              <>
                {canReinforce && (
                  <Button
                    onClick={handleReinforce}
                    title={_(msg`Thicken overloaded trunks, branches, leaves, and braces`)}
                    variant="tinted-warning"
                    size="auto"
                    className="w-full !h-8 text-[11px] gap-1.5"
                  >
                    <ShieldPlus className="h-3.5 w-3.5 shrink-0" />
                    <span>{_(msg`Reinforce`)}</span>
                  </Button>
                )}

                {reinforceFeedback && (
                  <div
                    className="text-[10px] text-center"
                    style={{ color: reinforceFeedback.kind === 'reinforced' ? 'var(--success)' : 'var(--text-muted)' }}
                  >
                    {reinforceFeedback.kind === 'reinforced'
                      ? formatReinforcedFeedback(_, reinforceFeedback.count)
                      : _(msg`Remaining hotspots are at clearance or size limit`)}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Card>

      <StructuredDialogModal
        open={showStressReport}
        ariaLabel={_(msg`Printability Report`)}
        title={_(msg`Printability Report`)}
        subtitle={issueSubtitle}
        icon={<StatusGlyph level={summary.level} className="h-4 w-4" />}
        iconTone={modalTone}
        maxWidthClassName="max-w-[56rem]"
        closeAriaLabel={_(msg`Close report`)}
        onClose={() => {
          setShowStressReport(false);
          setCopiedReport(false);
        }}
        onBackdropClick={() => {
          setShowStressReport(false);
          setCopiedReport(false);
        }}
        actions={(
          <>
            <Button
              onClick={handleCopyReport}
              disabled={!reportText}
              variant="secondary"
              size="md"
              title={_(msg`Copy the full printability report to the clipboard`)}
              className="gap-1.5"
            >
              {copiedReport ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
              <span>{copiedReport ? _(msg`Copied`) : _(msg`Copy`)}</span>
            </Button>
            <Button
              onClick={() => {
                setShowStressReport(false);
                setCopiedReport(false);
              }}
              variant="secondary"
              size="md"
              title={_(msg`Close the report`)}
            >
              {_(msg`Close`)}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border p-2.5" style={AUTO_SUPPORT_SECTION_CARD}>
              <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {_(msg`Status`)}
              </div>
              <div className="text-sm font-bold mt-0.5" style={{ color: statusAccentColor(summary.level) }}>
                {formatStatusTitle(_, summary.level)}
              </div>
            </div>
            <div className="rounded-md border p-2.5" style={AUTO_SUPPORT_SECTION_CARD}>
              <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {_(msg`Support load`)}
              </div>
              <div
                className="text-sm font-bold tabular-nums mt-0.5"
                style={{
                  color: report
                    ? utilizationColor(summary.peakUtilizationPct)
                    : isFloatingUnsupported
                      ? 'var(--danger)'
                      : 'var(--text-muted)',
                }}
              >
                {formatLoadChecklistLabel(_, fmt, report, summary)}
              </div>
            </div>
            <div className="rounded-md border p-2.5" style={AUTO_SUPPORT_SECTION_CARD}>
              <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {isFloatingUnsupported || (!coverageMeasured && topple) ? _(msg`Stability`) : _(msg`Coverage`)}
              </div>
              <div
                className="text-sm font-bold tabular-nums mt-0.5 truncate"
                style={{
                  color: isFloatingUnsupported
                    ? 'var(--danger)'
                    : coverageMeasured && printability
                      ? coverageRowColor(printability)
                      : topple
                        ? stabilityRowColor(topple, summary.level)
                        : 'var(--text-muted)',
                }}
              >
                {isFloatingUnsupported
                  ? _(msg`Floating`)
                  : coverageMeasured && printability
                    ? formatCoverageChecklistLabel(_, fmt, printability)
                    : topple
                      ? formatStabilityChecklistLabel(_, fmt, topple, summary.level)
                      : _(msg`Not scanned`)}
              </div>
            </div>
          </div>

          <div className="rounded-md border overflow-hidden" style={AUTO_SUPPORT_SECTION_CARD}>
            <pre
              className="px-3 py-2 text-[10px] leading-relaxed whitespace-pre-wrap break-words tabular-nums overflow-y-auto"
              style={{ color: 'var(--text-muted)', maxHeight: '62vh' }}
            >
              {reportText}
            </pre>
          </div>
        </div>
      </StructuredDialogModal>
    </>
  );
}

export const SupportStressPanel = React.memo(SupportStressPanelImpl);
