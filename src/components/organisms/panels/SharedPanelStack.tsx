import React from 'react';
import * as THREE from 'three';
import { VisualSettingsPanel } from '@/components/controls/VisualSettingsPanel';
import type { SliceExportArtifact, SliceExportResult } from '@/features/slicing/sliceExportOrchestrator';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { useSlicingManager } from '@/features/slicing/useSlicingManager';
import type { useTransformManager } from '@/features/transform/useTransformManager';

type DebugStamp = { perfMs: number; epochMs: number };
type Vec3Like = { x: number; y: number; z: number };

type TransformDebugStats = {
  activeModel: unknown;
  storeTransform: { position: THREE.Vector3; rotation: Vec3Like; scale: THREE.Vector3 } | null;
  liveTransform: { position: THREE.Vector3; rotation: Vec3Like; scale: THREE.Vector3 };
  posDelta: number;
  rotDelta: number;
  scaleDelta: number;
  dragGroupAutoUpdate: boolean | null;
  dragGroupPos: THREE.Vector3 | null;
  dragGroupScale: THREE.Vector3 | null;
  timeline: {
    lastOperation: string | null;
    dragReleasedAt: DebugStamp | null;
    liveCalculatedAt: DebugStamp | null;
    storeUpdateStartedAt: DebugStamp | null;
    storeUpdatedAt: DebugStamp | null;
    supportStoreUpdatedAt: DebugStamp | null;
    kickstandStoreUpdatedAt: DebugStamp | null;
    activeModelStoreObservedAt: DebugStamp | null;
    nowPerfMs: number;
  };
  historyCommit: {
    pendingModelId: string | null;
    pendingDescription: string | null;
    pendingHasAfter: boolean;
    pendingBeforeRotation: Vec3Like | null;
    pendingAfterRotation: Vec3Like | null;
    commitRequested: boolean;
    commitNonce: number;
    pendingResync: boolean;
    suppressNextPersistence: boolean;
    skipToken: { operation: string; modelId: string } | null;
    pendingRotateGizmoModelId: string | null;
    lastResult: string;
    lastReason: string;
    lastModelId: string | null;
    lastDescription: string | null;
    lastExpectedNonce: number | null;
    lastScheduledNonce: number | null;
    lastUndoCountBefore: number | null;
    lastUndoCountAfter: number | null;
    lastPushApplied: boolean | null;
    lastAt: DebugStamp | null;
  };
  supportCounts: {
    trunks: number;
    branches: number;
    leaves: number;
    twigs: number;
    sticks: number;
    braces: number;
    roots: number;
    knots: number;
    kickstands: number;
  };
};

type SupportDebugStats = {
  hoveredCategory: string | null;
  hoveredId: string | null;
  shaftHoveredSegmentId: string | null;
  shaftHoverPoint: Vec3Like | null;
  braceAltActive: boolean;
  braceStage: string;
  braceStartKind: string | null;
  braceStartSegmentId: string | null;
  braceSnapKind: string | null;
  braceSnapSegmentId: string | null;
  braceSnapLeafId: string | null;
  previewStart: Vec3Like | null;
  previewEnd: Vec3Like | null;
  hoveredVsSnapMismatch: boolean;
  supportInteractionSuppressed: boolean;
  disableSelectionAndHover: boolean;
  gizmoInteractionLockActive: boolean;
  knotGizmoDragging: boolean;
  jointGizmoDragging: boolean;
  knotGuardRemainingMs: number;
  knotOnlyGuardRemainingMs: number;
  jointOnlyGuardRemainingMs: number;
  immediateModelHoverId: string | null;
  externalHoverModelId: string | null;
  effectiveHoverModelId: string | null;
  sceneHoveredSupportId: string | null;
  marqueeHoveredSupportId: string | null;
  rawHoveredCategory: string | null;
  rawHoveredId: string | null;
  hoveredCategoryForVisual: string | null;
  hoveredIdForVisual: string | null;
};

type SupportEntityCounts = {
  trunks: number;
  branches: number;
  leaves: number;
  twigs: number;
  sticks: number;
  braces: number;
  roots: number;
  knots: number;
  kickstands: number;
};

export type SharedPanelStackProps = {
  scene: ReturnType<typeof useSceneCollectionManager>;
  slicing: ReturnType<typeof useSlicingManager>;
  transformMgr: ReturnType<typeof useTransformManager>;

  // VisualSettingsPanel
  handleSceneLayerScrubStart: React.ComponentProps<typeof VisualSettingsPanel>['onScrubStart'];
  handleSceneLayerScrubEnd: React.ComponentProps<typeof VisualSettingsPanel>['onScrubEnd'];
  isCrossSectionEnabled: boolean;
  handleToggleCrossSection: () => void;

  // Debug overlay
  isTransformDebugOverlayOpen: boolean;
  setIsTransformDebugOverlayOpen: (open: boolean) => void;
  displayActiveModelId: string | null;
  transformDebugStats: TransformDebugStats;
  supportDebugStats: SupportDebugStats;
  activeSupportEntityCounts: SupportEntityCounts;

  formatDebugVec3: (v: THREE.Vector3 | null | undefined) => string;
  formatDebugVec3Like: (v: Vec3Like | null | undefined) => string;
  formatDebugNumber: (value: number, digits?: number) => string;
  formatDebugTime: (stamp: DebugStamp | null, nowPerfMs: number) => string;
  formatDebugLatencyMs: (start: DebugStamp | null, end: DebugStamp | null) => string;

  // Printing debug state
  printingPreviewTotalLayers: number;
  printingSelectedLayer: number;
  printingDisplayedLayer: number;
  isPrintingLayerScrubbing: boolean;
  shouldShowScrubPreview: boolean;
  printingSendProgress: number;
  printingSendBusy: boolean;
  printingSendStageText: string | null;
  printingLayerPreviewUrls: Array<string | null>;
  printingArtifact: SliceExportArtifact | null;
  printingUploadDialogOpen: boolean;
  printingUploadDialogStage: 'uploading' | 'processing' | 'ready' | 'starting' | 'failed' | 'started';
  printingUploadDisplayProgress: number;
  printingReadyPlateId: number | null;
  printingPrintNowBusy: boolean;
  printingSendStatusText: string | null;
  printingSlicingBenchmark: SliceExportResult['benchmark'] | null;
};

/** Mode-shared floating panels: visual settings + the transform/support/printing debug overlay. */
export function SharedPanelStack({
  scene,
  slicing,
  transformMgr,
  handleSceneLayerScrubStart,
  handleSceneLayerScrubEnd,
  isCrossSectionEnabled,
  handleToggleCrossSection,
  isTransformDebugOverlayOpen,
  setIsTransformDebugOverlayOpen,
  displayActiveModelId,
  transformDebugStats,
  supportDebugStats,
  activeSupportEntityCounts,
  formatDebugVec3,
  formatDebugVec3Like,
  formatDebugNumber,
  formatDebugTime,
  formatDebugLatencyMs,
  printingPreviewTotalLayers,
  printingSelectedLayer,
  printingDisplayedLayer,
  isPrintingLayerScrubbing,
  shouldShowScrubPreview,
  printingSendProgress,
  printingSendBusy,
  printingSendStageText,
  printingLayerPreviewUrls,
  printingArtifact,
  printingUploadDialogOpen,
  printingUploadDialogStage,
  printingUploadDisplayProgress,
  printingReadyPlateId,
  printingPrintNowBusy,
  printingSendStatusText,
  printingSlicingBenchmark,
}: SharedPanelStackProps) {
  // Invoked inline by Home (not as <JSX/>) so FloatingPanelStack can flatten these keyed panels as direct children for its layout-profile positioning. 'use no memo' keeps React Compiler from injecting a useMemoCache hook (the conditional inline call must stay hook-free).
  'use no memo';
  return (
    <>
      {scene.models.length > 0 && scene.mode !== 'printing' && (
        <VisualSettingsPanel
          key="visual-settings"
          layerIndex={slicing.layerIndex}
          maxLayers={slicing.numLayers}
          onLayerIndexChange={slicing.setLayerIndex}
          onScrubStart={handleSceneLayerScrubStart}
          onScrubEnd={handleSceneLayerScrubEnd}
          onCrossSectionModeChange={slicing.setCrossSectionMode}
          currentHeightMm={slicing.currentHeightMm}
          maxHeightMm={slicing.heightMm}
          crossSectionMode={slicing.crossSectionMode}
          lowerLayerIndex={slicing.lowerLayerIndex}
          onLowerLayerIndexChange={slicing.setLowerLayerIndex}
          lowerCurrentHeightMm={slicing.lowerCurrentHeightMm}
          crossSectionEnabled={isCrossSectionEnabled}
          onToggleCrossSection={handleToggleCrossSection}
          layerHeightMm={slicing.layerHeightMm}
        />
      )}

      {isTransformDebugOverlayOpen && (
        <div
          key="transform-debug-overlay"
          className="rounded-lg border p-2.5 font-mono text-[10px] leading-tight shadow-xl"
          style={{
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-strong)',
            background: 'color-mix(in srgb, var(--surface-0), black 14%)',
            fontSize: '10px',
          }}
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold" style={{ fontFamily: 'var(--font-geist-mono)' }}>
              {scene.mode === 'printing' ? 'Printing Debug Overlay' : scene.mode === 'support' ? 'Support Debug Overlay' : 'Transform Debug Overlay'}
            </div>
            <button
              type="button"
              className="rounded border px-2 py-0.5 text-[10px]"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
              onClick={() => setIsTransformDebugOverlayOpen(false)}
            >
              Close
            </button>
          </div>

          {scene.mode === 'printing' ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <div style={{ color: 'var(--text-muted)' }}>Mode</div><div>{scene.mode}</div>
              <div style={{ color: 'var(--text-muted)' }}>Total layers</div><div>{printingPreviewTotalLayers}</div>
              <div style={{ color: 'var(--text-muted)' }}>Selected layer</div><div>{printingSelectedLayer}</div>
              <div style={{ color: 'var(--text-muted)' }}>Displayed layer</div><div>{printingDisplayedLayer}</div>
              <div style={{ color: 'var(--text-muted)' }}>Is scrubbing</div><div>{isPrintingLayerScrubbing ? 'true' : 'false'}</div>
              <div style={{ color: 'var(--text-muted)' }}>Show scrub preview</div><div>{shouldShowScrubPreview ? 'true' : 'false'}</div>
              <div style={{ color: 'var(--text-muted)' }}>Send progress</div><div>{(printingSendProgress * 100).toFixed(1)}%</div>
              <div style={{ color: 'var(--text-muted)' }}>Send busy</div><div>{printingSendBusy ? 'true' : 'false'}</div>
              <div style={{ color: 'var(--text-muted)' }}>Stage text</div><div className="truncate" title={printingSendStageText ?? 'none'}>{printingSendStageText ?? 'none'}</div>
            </div>
          ) : scene.mode === 'support' ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <div style={{ color: 'var(--text-muted)' }}>Mode</div><div>{scene.mode}</div>
              <div style={{ color: 'var(--text-muted)' }}>Active model</div><div>{scene.activeModelId ?? 'none'}</div>
              <div style={{ color: 'var(--text-muted)' }}>Hovered category</div><div>{supportDebugStats.hoveredCategory}</div>
              <div style={{ color: 'var(--text-muted)' }}>Hovered id</div><div>{supportDebugStats.hoveredId ?? 'none'}</div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <div style={{ color: 'var(--text-muted)' }}>Mode</div><div>{scene.mode}</div>
              <div style={{ color: 'var(--text-muted)' }}>Transform mode</div><div>{transformMgr.transformMode}</div>
              <div style={{ color: 'var(--text-muted)' }}>Active model</div><div>{scene.activeModelId ?? 'none'}</div>
              <div style={{ color: 'var(--text-muted)' }}>Display model</div><div>{displayActiveModelId ?? 'none'}</div>
              <div style={{ color: 'var(--text-muted)' }}>isTransforming</div><div>{transformMgr.isTransforming ? 'true' : 'false'}</div>
              <div style={{ color: 'var(--text-muted)' }}>Drag group auto</div><div>{String(transformDebugStats.dragGroupAutoUpdate)}</div>
            </div>
          )}

          {scene.mode === 'printing' && (
            <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Preview State
              </div>
              <div>Preview URLs loaded: {printingLayerPreviewUrls.filter(u => u !== null).length} / {printingPreviewTotalLayers}</div>
              <div>Selected URL exists: {(printingLayerPreviewUrls[printingSelectedLayer - 1] ?? null) ? 'true' : 'false'}</div>
              <div>Displayed URL exists: {(printingLayerPreviewUrls[printingDisplayedLayer - 1] ?? null) ? 'true' : 'false'}</div>
              <div>Artifact ready: {printingArtifact ? 'true' : 'false'}</div>
              <div>Artifact name: {printingArtifact?.outputName ?? 'none'}</div>
              <div>Upload dialog open: {printingUploadDialogOpen ? 'true' : 'false'}</div>
              <div>Upload stage: {printingUploadDialogStage}</div>
              <div>Display progress: {(printingUploadDisplayProgress * 100).toFixed(1)}%</div>
              <div>Ready plate ID: {printingReadyPlateId ?? 'none'}</div>
              <div>Print now busy: {printingPrintNowBusy ? 'true' : 'false'}</div>
              <div>Status text: {printingSendStatusText ?? 'none'}</div>

              {printingSlicingBenchmark && (
                <>
                  <div className="mt-2 mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Slicing Metrics
                  </div>
                  <div>Total time: {printingSlicingBenchmark.totalElapsedMs.toFixed(0)} ms</div>
                  {printingSlicingBenchmark.meshPrepMs !== null && (
                    <div>Mesh prep: {printingSlicingBenchmark.meshPrepMs.toFixed(0)} ms</div>
                  )}
                  {printingSlicingBenchmark.coreSlicingMs !== null && (
                    <div>Core slicing: {printingSlicingBenchmark.coreSlicingMs.toFixed(0)} ms</div>
                  )}
                  {printingSlicingBenchmark.totalLayers !== null && (
                    <div>Total layers: {printingSlicingBenchmark.totalLayers}</div>
                  )}
                  {printingSlicingBenchmark.layersPerSecond !== null && (
                    <div>Layers/sec: {printingSlicingBenchmark.layersPerSecond.toFixed(1)}</div>
                  )}
                </>
              )}
            </div>
          )}

          {scene.mode === 'support' && (
            <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Placement Lock Debug
              </div>
              <div>Hovered category/id: {supportDebugStats.hoveredCategory} / {supportDebugStats.hoveredId ?? 'none'}</div>
              <div>Shaft hovered segment: {supportDebugStats.shaftHoveredSegmentId ?? 'none'}</div>
              <div>Shaft hover point: {formatDebugVec3Like(supportDebugStats.shaftHoverPoint)}</div>
              <div>Brace Alt active: {supportDebugStats.braceAltActive ? 'true' : 'false'}</div>
              <div>Brace stage: {supportDebugStats.braceStage}</div>
              <div>Brace start: {supportDebugStats.braceStartKind ?? 'none'} / {supportDebugStats.braceStartSegmentId ?? 'n/a'}</div>
              <div>Brace snap: {supportDebugStats.braceSnapKind ?? 'none'} / {supportDebugStats.braceSnapSegmentId ?? supportDebugStats.braceSnapLeafId ?? 'n/a'}</div>
              <div>Preview start: {formatDebugVec3Like(supportDebugStats.previewStart)}</div>
              <div>Preview end: {formatDebugVec3Like(supportDebugStats.previewEnd)}</div>
              <div>Suppressed: {supportDebugStats.supportInteractionSuppressed ? 'true' : 'false'}</div>
              <div>disableSelectionAndHover: {supportDebugStats.disableSelectionAndHover ? 'true' : 'false'}</div>
              <div>Gizmo lock active: {supportDebugStats.gizmoInteractionLockActive ? 'true' : 'false'}</div>
              <div>Knot dragging: {supportDebugStats.knotGizmoDragging ? 'true' : 'false'}</div>
              <div>Joint dragging: {supportDebugStats.jointGizmoDragging ? 'true' : 'false'}</div>
              <div>Knot guard remaining: {supportDebugStats.knotGuardRemainingMs} ms</div>
              <div>Knot-only guard: {supportDebugStats.knotOnlyGuardRemainingMs} ms</div>
              <div>Joint-only guard: {supportDebugStats.jointOnlyGuardRemainingMs} ms</div>
              <div>Immediate hover model: {supportDebugStats.immediateModelHoverId ?? 'none'}</div>
              <div>External hover model: {supportDebugStats.externalHoverModelId ?? 'none'}</div>
              <div>Effective hover model: {supportDebugStats.effectiveHoverModelId ?? 'none'}</div>
              <div>Scene hovered support: {supportDebugStats.sceneHoveredSupportId ?? 'none'}</div>
              <div>Marquee hovered support: {supportDebugStats.marqueeHoveredSupportId ?? 'none'}</div>
              <div>Raw hovered category/id: {supportDebugStats.rawHoveredCategory ?? 'none'} / {supportDebugStats.rawHoveredId ?? 'none'}</div>
              <div>Visual hovered category/id: {supportDebugStats.hoveredCategoryForVisual ?? 'none'} / {supportDebugStats.hoveredIdForVisual ?? 'none'}</div>
              <div>
                Hover vs snap segment mismatch:{' '}
                <span style={{ color: supportDebugStats.hoveredVsSnapMismatch ? '#ff8a8a' : 'var(--text-strong)' }}>
                  {supportDebugStats.hoveredVsSnapMismatch ? 'YES' : 'no'}
                </span>
              </div>
            </div>
          )}

          {scene.mode !== 'support' && scene.mode !== 'printing' && (
            <>
              <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Transform Delta (live vs store)
                </div>
                <div>Δpos: {formatDebugNumber(transformDebugStats.posDelta)} mm</div>
                <div>Δrot max: {formatDebugNumber(transformDebugStats.rotDelta)} rad</div>
                <div>Δscale: {formatDebugNumber(transformDebugStats.scaleDelta)}</div>
              </div>

              <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Active Model Transform
                </div>
                <div>Store pos: {formatDebugVec3(transformDebugStats.storeTransform?.position)}</div>
                <div>Live pos: {formatDebugVec3(transformDebugStats.liveTransform.position)}</div>
                <div>Drag Δ pos: {formatDebugVec3(transformDebugStats.dragGroupPos)}</div>
                <div>Drag Δ scale: {formatDebugVec3(transformDebugStats.dragGroupScale)}</div>
              </div>
            </>
          )}

          <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Support Counts (all / active model)
            </div>
            <div>Trunks: {transformDebugStats.supportCounts.trunks} / {activeSupportEntityCounts.trunks}</div>
            <div>Branches: {transformDebugStats.supportCounts.branches} / {activeSupportEntityCounts.branches}</div>
            <div>Leaves: {transformDebugStats.supportCounts.leaves} / {activeSupportEntityCounts.leaves}</div>
            <div>Twigs: {transformDebugStats.supportCounts.twigs} / {activeSupportEntityCounts.twigs}</div>
            <div>Sticks: {transformDebugStats.supportCounts.sticks} / {activeSupportEntityCounts.sticks}</div>
            <div>Braces: {transformDebugStats.supportCounts.braces} / {activeSupportEntityCounts.braces}</div>
            <div>Roots: {transformDebugStats.supportCounts.roots} / {activeSupportEntityCounts.roots}</div>
            <div>Knots: {transformDebugStats.supportCounts.knots} / {activeSupportEntityCounts.knots}</div>
            <div>Kickstands: {transformDebugStats.supportCounts.kickstands} / {activeSupportEntityCounts.kickstands}</div>
          </div>

          {scene.mode !== 'support' && scene.mode !== 'printing' && (
            <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Transform Timeline
              </div>
              <div>Last op: {transformDebugStats.timeline.lastOperation ?? 'n/a'}</div>
              <div>Drag released: {formatDebugTime(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.nowPerfMs)}</div>
              <div>Live calculated: {formatDebugTime(transformDebugStats.timeline.liveCalculatedAt, transformDebugStats.timeline.nowPerfMs)}</div>
              <div>Store update start: {formatDebugTime(transformDebugStats.timeline.storeUpdateStartedAt, transformDebugStats.timeline.nowPerfMs)}</div>
              <div>Store updated: {formatDebugTime(transformDebugStats.timeline.storeUpdatedAt, transformDebugStats.timeline.nowPerfMs)}</div>
              <div>Support store updated: {formatDebugTime(transformDebugStats.timeline.supportStoreUpdatedAt, transformDebugStats.timeline.nowPerfMs)}</div>
              <div>Kickstand store updated: {formatDebugTime(transformDebugStats.timeline.kickstandStoreUpdatedAt, transformDebugStats.timeline.nowPerfMs)}</div>
              <div>Active model store observed: {formatDebugTime(transformDebugStats.timeline.activeModelStoreObservedAt, transformDebugStats.timeline.nowPerfMs)}</div>
              <div>Release → Live: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.liveCalculatedAt)}</div>
              <div>Live → Store start: {formatDebugLatencyMs(transformDebugStats.timeline.liveCalculatedAt, transformDebugStats.timeline.storeUpdateStartedAt)}</div>
              <div>Store start → Store updated: {formatDebugLatencyMs(transformDebugStats.timeline.storeUpdateStartedAt, transformDebugStats.timeline.storeUpdatedAt)}</div>
              <div>Release → Store updated: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.storeUpdatedAt)}</div>
              <div>Release → Support store: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.supportStoreUpdatedAt)}</div>
              <div>Release → Kickstand store: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.kickstandStoreUpdatedAt)}</div>
              <div>Release → Active model observed: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.activeModelStoreObservedAt)}</div>
            </div>
          )}

          {scene.mode !== 'support' && scene.mode !== 'printing' && (
            <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Transform History Commit
              </div>
              <div>Pending model: {transformDebugStats.historyCommit.pendingModelId ?? 'none'}</div>
              <div>Pending description: {transformDebugStats.historyCommit.pendingDescription ?? 'none'}</div>
              <div>Pending has after: {transformDebugStats.historyCommit.pendingHasAfter ? 'true' : 'false'}</div>
              <div>Pending before rot: {formatDebugVec3Like(transformDebugStats.historyCommit.pendingBeforeRotation)}</div>
              <div>Pending after rot: {formatDebugVec3Like(transformDebugStats.historyCommit.pendingAfterRotation)}</div>
              <div>Commit requested: {transformDebugStats.historyCommit.commitRequested ? 'true' : 'false'}</div>
              <div>Commit nonce: {transformDebugStats.historyCommit.commitNonce}</div>
              <div>Pending resync: {transformDebugStats.historyCommit.pendingResync ? 'true' : 'false'}</div>
              <div>Suppress next persistence: {transformDebugStats.historyCommit.suppressNextPersistence ? 'true' : 'false'}</div>
              <div>
                Skip token: {transformDebugStats.historyCommit.skipToken
                  ? `${transformDebugStats.historyCommit.skipToken.operation}:${transformDebugStats.historyCommit.skipToken.modelId}`
                  : 'none'}
              </div>
              <div>Pending rotate-gizmo model: {transformDebugStats.historyCommit.pendingRotateGizmoModelId ?? 'none'}</div>
              <div>Last result: {transformDebugStats.historyCommit.lastResult}</div>
              <div>Last reason: {transformDebugStats.historyCommit.lastReason}</div>
              <div>Last model: {transformDebugStats.historyCommit.lastModelId ?? 'none'}</div>
              <div>Last description: {transformDebugStats.historyCommit.lastDescription ?? 'none'}</div>
              <div>Last expected nonce: {transformDebugStats.historyCommit.lastExpectedNonce ?? 'n/a'}</div>
              <div>Last scheduled nonce: {transformDebugStats.historyCommit.lastScheduledNonce ?? 'n/a'}</div>
              <div>Last push applied: {transformDebugStats.historyCommit.lastPushApplied === null ? 'n/a' : (transformDebugStats.historyCommit.lastPushApplied ? 'true' : 'false')}</div>
              <div>Undo before → after: {transformDebugStats.historyCommit.lastUndoCountBefore ?? 'n/a'} → {transformDebugStats.historyCommit.lastUndoCountAfter ?? 'n/a'}</div>
              <div>Last attempt: {formatDebugTime(transformDebugStats.historyCommit.lastAt, transformDebugStats.timeline.nowPerfMs)}</div>
            </div>
          )}

          <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Toggle: Ctrl+Shift+X
          </div>
        </div>
      )}
    </>
  );
}
