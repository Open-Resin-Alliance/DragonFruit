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
  ClipboardCopy,
  FileText,
  RefreshCw,
  ShieldPlus,
} from 'lucide-react';
import type { MessageDescriptor } from '@lingui/core';
import { Button, Card, CardHeader, IconButton } from '@/components/atoms';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import {
  buildSupportGraph,
  classifyToppleRisk,
  clearModelFrameStress,
  clearModelToppleRisk,
  evaluatePrintability,
  evaluateToppleRisk,
  FLOATING_Z_THRESHOLD_MM,
  getCachedRepresentativeLayers,
  getFrameStressSnapshot,
  getModelMesh,
  HIGH_LEVERAGE_SPAN_MM,
  reinforceOverloadedFrameMembers,
  setHoveredStressLayerZ,
  setModelFrameStress,
  setModelPrintability,
  setModelToppleRisk,
  setStressOverlayEnabled,
  solveSupportFrameStress,
  subscribeFrameStress,
  subscribeModelMesh,
  summarizeSupportStress,
  supportStressReportToText,
  toppleRiskNeedsCoverage,
  type LayerPeelPoint,
  type PrintabilityReport,
  type RepresentativeLayerProfile,
  type SupportFrameStressReport,
  type SupportStressStatusLevel,
  type SupportStressSummary,
  type ToppleRiskReport,
} from '@/supports/autoSupport';
import { measurePoseStability, posedPositions } from '@/supports/autoSupport/poseStability';
import { getRaftSettingsForModel } from '@/supports/Rafts/Crenelated/RaftState';
import { geometryCentroidMm } from '@/features/printing/modelResinVolume';
import { getSettings } from '@/supports/Settings/state';
import { getActiveMaterialProfile } from '@/features/profiles/profileStore';
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
const AUTO_REFRESH_DEBOUNCE_MS = 160;

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

const OVERLAY_ON_LABEL = msg({ message: 'Overlay ON', comment: 'Toggle button for 3D support beam stress color overlay. Keep short.' });
const OVERLAY_OFF_LABEL = msg({ message: 'Overlay OFF', comment: 'Toggle button for 3D support beam stress color overlay. Keep short.' });

/** Matches AutoSupportPresetRow's standard DragonFruit toggle treatment. */
const TOGGLE_ON_STYLE: React.CSSProperties = {
  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
  background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
  color: 'var(--text-strong)',
};

const TOGGLE_OFF_STYLE: React.CSSProperties = {
  background: 'var(--surface-1)',
};

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
      return _(msg`Coverage, support load, and stability are within limits.`);
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
      return _(msg`Deflection (${defl}) exceeds rocking limit.`);
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
): string {
  if (topple.outcome === 'pastEdge') return _(msg`May tip`);
  if (topple.outcome === 'rocking') {
    const defl = fmt.quantity(topple.complianceMm, 2, 'mm');
    return _(msg`Rocking · ${defl}`);
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
  if (printability.uncoveredAreaMm2 > 0.02 || printability.verdict === 'critical') return 'var(--danger)';
  if (printability.deficientRegions > 0 || printability.maxFreeSpanMm >= HIGH_LEVERAGE_SPAN_MM) return '#f59e0b';
  return 'var(--success)';
}

function stabilityRowColor(topple: ToppleRiskReport): string {
  if (topple.outcome === 'pastEdge') return 'var(--danger)';
  if (topple.outcome === 'rocking') return '#f59e0b';
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

function computeLiveToppleRisk(
  modelId: string,
  mesh: THREE.Mesh | null | undefined,
  profile: RepresentativeLayerProfile | undefined,
  deflectionMm: number,
  hasSupports: boolean,
): ToppleRiskReport | null {
  if (!mesh || !mesh.geometry) return null;
  const indexAttr = mesh.geometry.getIndex();
  const hasRaft = getRaftSettingsForModel(modelId).bottomMode !== 'off';
  const poseStability = measurePoseStability(
    posedPositions(mesh),
    indexAttr ? (indexAttr.array as ArrayLike<number>) : null,
    0,
    0,
    undefined,
    hasRaft,
  );
  if (!hasSupports && poseStability.plateZMm > FLOATING_Z_THRESHOLD_MM) {
    return null;
  }
  const edgeNormal = poseStability.worstEdgeNormal;
  if (
    !poseStability.worstEdgePoint
    || !edgeNormal
    || Math.hypot(edgeNormal.x, edgeNormal.y) <= 1e-6
    || poseStability.bearingAreaMm2 <= 0
  ) {
    return null;
  }
  const localCentroid = geometryCentroidMm(mesh.geometry);
  if (!localCentroid) return null;
  mesh.updateMatrixWorld();
  const worldCentroid = new THREE.Vector3(localCentroid.x, localCentroid.y, localCentroid.z)
    .applyMatrix4(mesh.matrixWorld);
  return evaluateToppleRisk({
    profile,
    centroid: { x: worldCentroid.x, y: worldCentroid.y },
    edge: { point: poseStability.worstEdgePoint, normal: edgeNormal },
    bearingAreaMm2: poseStability.bearingAreaMm2,
    contactDepthMm: poseStability.contactDepthMm,
    frameDeflectionMm: deflectionMm,
  });
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
  hasGeometry: boolean;
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

export function SupportStressPanel({
  activeModelId,
  hasGeometry,
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
  const toppleComplianceMm = report?.maxTipDeflectionMm ?? toppleBase?.complianceMm ?? 0;
  const topple = toppleBase
    ? {
      ...toppleBase,
      complianceMm: toppleComplianceMm,
      outcome: classifyToppleRisk(toppleBase.comDepthMm, toppleComplianceMm),
    }
    : undefined;
  const overlayEnabled = stressSnap.overlayEnabled;
  const modelMesh = React.useSyncExternalStore(
    subscribeModelMesh,
    () => (activeModelId ? getModelMesh(activeModelId) : null),
    () => null,
  );
  const modelMinZMm = React.useMemo(() => computeMeshMinZMm(modelMesh), [modelMesh, poseKey]);
  const isFloatingUnsupported = Boolean(
    !report && modelMinZMm !== null && modelMinZMm > FLOATING_Z_THRESHOLD_MM,
  );

  /**
   * Re-evaluate solved Stefan topple risk and live printability demand for the
   * current edit, sharing the cached representative layer profile.
   */
  const refreshDemandAndTopple = React.useCallback((
    modelId: string,
    snapshot: SupportState,
    mesh: THREE.Mesh | null | undefined,
    profile: RepresentativeLayerProfile | undefined,
    frameReport: SupportFrameStressReport | null,
  ): void => {
    const hasSupports = Boolean(frameReport && frameReport.tipCount > 0);
    const computedTopple = computeLiveToppleRisk(
      modelId,
      mesh,
      profile,
      frameReport?.maxTipDeflectionMm ?? 0,
      hasSupports,
    );
    if (computedTopple) {
      setModelToppleRisk(modelId, computedTopple);
    } else {
      clearModelToppleRisk(modelId);
    }
    const existingTopple = computedTopple ?? undefined;
    const effectiveToppleCoverage = existingTopple
      ? toppleRiskNeedsCoverage(existingTopple)
      : toppleCoverageNeeded;

    setModelPrintability(modelId, evaluatePrintability({
      islands: islands ?? [],
      snapshot,
      modelId,
      areaPerSupportMm2: getSettings().autoSupport.areaPerSupportMm2,
      profile,
      poseDragMomentMm3,
      toppleCoverageNeeded: effectiveToppleCoverage,
      frame: frameReport
        ? {
          maxTipUtilizationPct: frameReport.maxTipUtilizationPct,
          maxMemberUtilizationPct: frameReport.maxMemberUtilizationPct,
        }
        : undefined,
    }));
  }, [islands, poseDragMomentMm3, toppleCoverageNeeded]);

  // Evaluate Stefan peel demand + topple margin whenever the model, pose, or scan changes.
  React.useEffect(() => {
    if (!activeModelId || !modelMesh) return;
    const profile = getCachedRepresentativeLayers(modelMesh, getActiveMaterialProfile()?.layerHeightMm);
    refreshDemandAndTopple(
      activeModelId,
      getSnapshot(),
      modelMesh,
      profile,
      getFrameStressSnapshot().byModelId[activeModelId] ?? null,
    );
  }, [activeModelId, poseKey, modelMesh, hasScanned, refreshDemandAndTopple]);

  React.useEffect(() => {
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
  }, [activeModelId, report]);

  const runAnalyze = React.useCallback(() => {
    if (!activeModelId) return;
    setReinforceFeedback(null);
    const snap = getSnapshot();
    const mesh = getModelMesh(activeModelId);
    const profile = mesh ? getCachedRepresentativeLayers(mesh, getActiveMaterialProfile()?.layerHeightMm) : undefined;
    const graph = buildSupportGraph(snap, activeModelId);
    lastSolvedRefsRef.current = captureStructuralRefs(snap);
    if (graph.rootCount === 0 || graph.tipCount === 0) {
      lastOwnReportRef.current = null;
      clearModelFrameStress(activeModelId);
      refreshDemandAndTopple(activeModelId, snap, mesh, profile, null);
      return;
    }
    const auto = getSettings().autoSupport;
    const nextReport = solveSupportFrameStress(graph, profile, {
      areaPerSupportMm2: auto.areaPerSupportMm2,
    });
    lastOwnReportRef.current = nextReport;
    setModelFrameStress(activeModelId, nextReport);
    refreshDemandAndTopple(activeModelId, snap, mesh, profile, nextReport);
  }, [activeModelId, refreshDemandAndTopple]);

  const handleReinforce = React.useCallback(() => {
    if (!activeModelId || !report || report.overloadedMembers === 0) return;
    const before = captureSupportEditSnapshot();
    const snap = getSnapshot();
    const mesh = getModelMesh(activeModelId);
    const auto = getSettings().autoSupport;
    const reinforced = reinforceOverloadedFrameMembers(snap, report, mesh ?? undefined, activeModelId);
    if (!reinforced.changed) {
      setReinforceFeedback({ kind: 'limit' });
      return;
    }

    lastSolvedRefsRef.current = captureStructuralRefs(reinforced.snapshot);
    setSnapshot(reinforced.snapshot);
    pushSupportEditHistory(REINFORCE_HISTORY_LABEL, before, captureSupportEditSnapshot());
    flushSupportEditHistory();

    const profile = mesh ? getCachedRepresentativeLayers(mesh, getActiveMaterialProfile()?.layerHeightMm) : undefined;
    const graph = buildSupportGraph(reinforced.snapshot, activeModelId);
    const nextReport: SupportFrameStressReport = {
      ...solveSupportFrameStress(graph, profile, { areaPerSupportMm2: auto.areaPerSupportMm2 }),
      reinforcedCount: (report.reinforcedCount ?? 0) + reinforced.totalReinforced,
    };
    lastOwnReportRef.current = nextReport;
    setReinforceFeedback({ kind: 'reinforced', count: reinforced.totalReinforced });
    setModelFrameStress(activeModelId, nextReport);
    refreshDemandAndTopple(activeModelId, reinforced.snapshot, mesh, profile, nextReport);
  }, [activeModelId, refreshDemandAndTopple, report]);

  // Every structural support edit re-analyses on a 160 ms debounce.
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
        const latestSnap = getSnapshot();
        const latestRefs = captureStructuralRefs(latestSnap);
        if (lastSolvedRefsRef.current && sameStructuralRefs(latestRefs, lastSolvedRefsRef.current)) {
          return;
        }
        const graph = buildSupportGraph(latestSnap, activeModelId);
        const mesh = getModelMesh(activeModelId);
        const profile = mesh ? getCachedRepresentativeLayers(mesh, getActiveMaterialProfile()?.layerHeightMm) : undefined;
        let nextReport: SupportFrameStressReport | null = null;
        if (graph.rootCount > 0 && graph.tipCount > 0) {
          const auto = getSettings().autoSupport;
          nextReport = solveSupportFrameStress(graph, profile, {
            areaPerSupportMm2: auto.areaPerSupportMm2,
          });
          lastOwnReportRef.current = nextReport;
          setModelFrameStress(activeModelId, nextReport);
        } else {
          clearModelFrameStress(activeModelId);
        }
        lastSolvedRefsRef.current = latestRefs;
        refreshDemandAndTopple(activeModelId, latestSnap, mesh, profile, nextReport);
      }, AUTO_REFRESH_DEBOUNCE_MS);
    };

    const seedSnap = getSnapshot();
    if (islands && islands.length > 0) {
      const seedMesh = getModelMesh(activeModelId);
      refreshDemandAndTopple(
        activeModelId,
        seedSnap,
        seedMesh,
        seedMesh ? getCachedRepresentativeLayers(seedMesh, getActiveMaterialProfile()?.layerHeightMm) : undefined,
        getFrameStressSnapshot().byModelId[activeModelId] ?? null,
      );
    }

    const hasContacts = [seedSnap.trunks, seedSnap.branches, seedSnap.leaves, seedSnap.stumps, seedSnap.sticks, seedSnap.twigs]
      .some((collection) => Object.keys(collection).length > 0);
    if (hasContacts || getFrameStressSnapshot().byModelId[activeModelId] || getFrameStressSnapshot().overlayEnabled) {
      scheduleAnalysis();
    }

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
        || Boolean(islands && islands.length > 0);
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
  }, [activeModelId, islands, refreshDemandAndTopple]);

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
  const canAnalyze = Boolean(hasGeometry && activeModelId);
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
            <IconButton
              onClick={runAnalyze}
              disabled={!canAnalyze}
              title={_(msg`Re-run printability analysis`)}
              className="!p-1.5 disabled:opacity-40"
            >
              <RefreshCw className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
            </IconButton>
          )}
        />

        {expanded && (
          <div className="px-2.5 pb-3 space-y-2">
            {/* 1. Hero Verdict Banner */}
            {hasAnyData && (
              <div className="rounded-md border p-2.5 flex items-start gap-2" style={statusBannerStyle(summary.level)}>
                <StatusGlyph level={summary.level} className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-xs font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    {formatStatusTitle(_, summary.level)}
                  </div>
                  <div className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    {formatPrimaryIssueSubtitle(_, fmt, summary, printability, topple, modelMinZMm)}
                  </div>
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
                              ? stabilityRowColor(topple)
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
                            ? stabilityRowColor(topple)
                            : 'var(--text-muted)',
                      }}
                    >
                      {isFloatingUnsupported
                        ? _(msg`Floating`)
                        : topple
                          ? formatStabilityChecklistLabel(_, fmt, topple)
                          : ''}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* 3. Interactive Peel Profile Graph */}
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
            ) : !hasAnyData ? (
              <div className="text-[10px] italic text-center py-1" style={{ color: 'var(--text-muted)' }}>
                {_(msg`Generate supports or analyze existing ones to inspect peel loads.`)}
              </div>
            ) : null}

            {/* 4. Collapsible Details Disclosure */}
            {hasAnyData && (
              <div className="rounded-md border" style={AUTO_SUPPORT_SECTION_CARD}>
                <button
                  type="button"
                  onClick={() => setShowDetails((current) => !current)}
                  title={_(msg`Inspect detailed coverage, frame stress, stability metrics, and hotspots`)}
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
                          <span style={{ color: printability.uncoveredAreaMm2 > 0.02 ? 'var(--danger)' : 'var(--success)' }}>
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
                          <span>{_(msg`COM depth`)}</span>
                          <span style={{ color: topple.comDepthMm > 0 ? 'var(--success)' : 'var(--danger)' }}>
                            {fmt.quantity(topple.comDepthMm, 1, 'mm')}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>{_(msg`Lift threshold`)}</span>
                          <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(topple.requiredAdhesionMpa, 3, 'MPa')}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{_(msg`Rocking`)}</span>
                          <span style={{ color: topple.outcome === 'rocking' ? '#f59e0b' : 'var(--success)' }}>
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

            {/* 5. Printability Report Trigger */}
            {hasAnyData && (
              <button
                type="button"
                onClick={() => setShowStressReport(true)}
                title={_(msg`Open the full Printability Report`)}
                className="w-full rounded-md border px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wide flex items-center justify-between"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
              >
                <span className="flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  <span>{_(msg`Printability Report`)}</span>
                </span>
                <span className="text-[10px] normal-case tracking-normal font-medium" style={{ color: statusAccentColor(summary.level) }}>
                  {formatStatusTitle(_, summary.level)}
                </span>
              </button>
            )}

            {/* 6. Footer Action Bar */}
            {!report ? (
              printability ? (
                <div className="flex gap-1.5">
                  <Button
                    onClick={() => setStressOverlayEnabled(!overlayEnabled)}
                    aria-pressed={overlayEnabled}
                    title={_(msg`Show unsupported areas and support stress on the model`)}
                    variant="secondary"
                    size="auto"
                    className="min-w-0 flex-1 !h-8 px-2 text-[11px]"
                    style={overlayEnabled ? TOGGLE_ON_STYLE : TOGGLE_OFF_STYLE}
                  >
                    <span className="truncate">{_(overlayEnabled ? OVERLAY_ON_LABEL : OVERLAY_OFF_LABEL)}</span>
                  </Button>
                  <Button
                    onClick={runAnalyze}
                    disabled={!canAnalyze}
                    title={_(msg`Solve 3D support beam frame & rigid-body peel loads on existing supports`)}
                    variant="tinted-accent"
                    size="auto"
                    className="min-w-0 flex-1 !h-8 px-2 text-[11px] gap-1 disabled:opacity-50"
                  >
                    <Activity className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{_(msg`Analyze`)}</span>
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={runAnalyze}
                  disabled={!canAnalyze}
                  title={_(msg`Solve 3D support beam frame & rigid-body peel loads on existing supports`)}
                  variant="tinted-accent"
                  size="auto"
                  className="w-full !h-8 text-[11px] gap-1.5 disabled:opacity-50"
                >
                  <Activity className="h-3.5 w-3.5" />
                  <span>{_(msg`Analyze Supports`)}</span>
                </Button>
              )
            ) : (
              <>
                <div className="flex gap-1.5">
                  <Button
                    onClick={() => setStressOverlayEnabled(!overlayEnabled)}
                    aria-pressed={overlayEnabled}
                    title={_(msg`Show unsupported areas and support stress on the model`)}
                    variant="secondary"
                    size="auto"
                    className="min-w-0 flex-1 !h-8 px-2 text-[11px]"
                    style={overlayEnabled ? TOGGLE_ON_STYLE : TOGGLE_OFF_STYLE}
                  >
                    <span className="truncate">{_(overlayEnabled ? OVERLAY_ON_LABEL : OVERLAY_OFF_LABEL)}</span>
                  </Button>
                  <Button
                    onClick={handleReinforce}
                    disabled={!canReinforce}
                    title={_(msg`Thicken overloaded trunks, branches, leaves, and braces`)}
                    variant={canReinforce ? 'tinted-warning' : 'secondary'}
                    size="auto"
                    className="min-w-0 flex-1 !h-8 px-2 text-[11px] gap-1 disabled:opacity-45"
                  >
                    <ShieldPlus className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{_(msg`Reinforce`)}</span>
                  </Button>
                </div>

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
        subtitle={formatPrimaryIssueSubtitle(_, fmt, summary, printability, topple, modelMinZMm)}
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
                        ? stabilityRowColor(topple)
                        : 'var(--text-muted)',
                }}
              >
                {isFloatingUnsupported
                  ? _(msg`Floating`)
                  : coverageMeasured && printability
                    ? formatCoverageChecklistLabel(_, fmt, printability)
                    : topple
                      ? formatStabilityChecklistLabel(_, fmt, topple)
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
