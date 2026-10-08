import React from 'react';
import * as THREE from 'three';
import { ExportPanel } from '@/features/export/components/ExportPanel';
import { SlicingPanel, type SliceIntent } from '@/features/slicing/components/SlicingPanel';
import type { SliceExportArtifact, SliceExportResult } from '@/features/slicing/sliceExportOrchestrator';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { useSlicingManager } from '@/features/slicing/useSlicingManager';

export type ExportPanelStackProps = {
  scene: ReturnType<typeof useSceneCollectionManager>;
  slicing: ReturnType<typeof useSlicingManager>;

  supportsRef: React.RefObject<THREE.Group | null>;
  captureExportThumbnailPng: React.ComponentProps<typeof ExportPanel>['captureSceneThumbnailPng'];
  handleExportSuccess: React.ComponentProps<typeof ExportPanel>['onExportSuccess'];
  showOperationError: React.ComponentProps<typeof ExportPanel>['onExportError'];
  setIsExporting: (exporting: boolean) => void;

  estimatedSlicerLayerCount: number;
  excludedSliceModelIds: readonly string[];
  crossSectionLayerHeightMm: number;
  estimatedVolumeMlLabel: string;
  handleSliceRunStartedForPrinting: () => void;
  handlePrintingLayerPreviewGenerated: (payload: { layerIndex: number; totalLayers: number; pngBytes: Uint8Array }) => void;
  handleSlicingFinishedForPrinting: (payload: { totalLayers: number }) => void;
  /**
   * The sliced plate, handed on with the bed it came from: the printing workspace shows the
   * slice of the bed being worked on, so a batch of beds needs to say which is which.
   */
  handleSliceArtifactReady: (
    artifact: SliceExportArtifact,
    context?: { plateId?: string; totalLayers?: number },
  ) => void;
  handleSlicingBenchmarkComplete: (benchmark: SliceExportResult['benchmark']) => void;
  triggerSliceExportRef: React.MutableRefObject<(() => void) | null>;
  shouldAutoSliceOnExportEntry: boolean;
  shouldReturnToPrintingAfterSliceRef: React.MutableRefObject<boolean>;
  setIsSlicingBusy: (busy: boolean) => void;
  canSliceAndUpload: boolean;
  canSliceAndPrint: boolean;
  sliceIntentRef: React.MutableRefObject<SliceIntent>;
  handleBeforeSliceStart: (
    intent: SliceIntent,
    options?: { destinationDirectory?: string; baseName?: string },
  ) => Promise<boolean>;
  handlePreSliceSceneSave: () => Promise<void>;
  preSliceFileDestinationPathRef: React.MutableRefObject<string | null>;
};

/** EXPORT-mode floating panel group: export + slicing panels. */
export function ExportPanelStack({
  scene,
  slicing,
  supportsRef,
  captureExportThumbnailPng,
  handleExportSuccess,
  showOperationError,
  setIsExporting,
  estimatedSlicerLayerCount,
  excludedSliceModelIds,
  crossSectionLayerHeightMm,
  estimatedVolumeMlLabel,
  handleSliceRunStartedForPrinting,
  handlePrintingLayerPreviewGenerated,
  handleSlicingFinishedForPrinting,
  handleSliceArtifactReady,
  handleSlicingBenchmarkComplete,
  triggerSliceExportRef,
  shouldAutoSliceOnExportEntry,
  shouldReturnToPrintingAfterSliceRef,
  setIsSlicingBusy,
  canSliceAndUpload,
  canSliceAndPrint,
  sliceIntentRef,
  handleBeforeSliceStart,
  handlePreSliceSceneSave,
  preSliceFileDestinationPathRef,
}: ExportPanelStackProps) {
  // Invoked inline by Home (not as <JSX/>) so FloatingPanelStack can flatten these keyed panels as direct children for its layout-profile positioning. 'use no memo' keeps React Compiler from injecting a useMemoCache hook (the conditional inline call must stay hook-free).
  'use no memo';

  // The plates a slice can cover. Computed inline because this component is
  // deliberately hook-free: a slice is scoped to one plate, judged against that
  // plate's volume and shifted to the origin for the rasterizer, and a scene with
  // several plates can be sliced one file per plate.
  const plateSliceScopes = scene.plateFrames.length > 0
    ? scene.plateFrames.map((frame) => ({
        plateId: frame.id,
        plateName: scene.plates.find((plate) => plate.id === frame.id)?.name ?? '',
        modelIds: scene.models
          .filter((model) => scene.resolveModelPlateId(model) === frame.id)
          .map((model) => model.id),
        volumeBoundsMm: {
          minX: frame.minX,
          minY: frame.minY,
          maxX: frame.maxX,
          maxY: frame.maxY,
        },
        offsetMm: { dxMm: frame.dxMm, dyMm: frame.dyMm },
      }))
    : undefined;
  const activePlateSliceIndex = Math.max(
    0,
    scene.plateFrames.findIndex((frame) => frame.id === scene.activePlateId),
  );

  // The scene's plates that hold something, with the models standing on each, for the export
  // panel's plate scope and its per-plate export. Membership is resolved by the scene, so a
  // model that was dragged to another bed counts as being there rather than where it was
  // imported; a bed left empty is not offered, and does not make the scene look like it has
  // more than one plate to choose between. Names come through as they are: an unnamed plate's
  // placeholder is the panel's to phrase, and this component is deliberately hook-free so it
  // cannot translate one.
  const plateGroups = scene.plates
    .map((plate) => ({
      id: plate.id,
      name: plate.name,
      modelIds: scene.models
        .filter((model) => scene.resolveModelPlateId(model) === plate.id)
        .map((model) => model.id),
    }))
    .filter((plate) => plate.modelIds.length > 0);

  return (
    <>
      <ExportPanel
        key="export-main"
        models={scene.models}
        activeModel={scene.activeModel}
        activeModelId={scene.activeModelId}
        selectedModelIds={scene.selectedModelIds}
        plateGroups={plateGroups}
        activePlateId={scene.activePlateId}
        onActiveModelChange={scene.setActiveModelId}
        supportsRef={supportsRef}
        captureSceneThumbnailPng={captureExportThumbnailPng}
        onExportSuccess={handleExportSuccess}
        onExportError={showOperationError}
        onExportProgress={setIsExporting}
      />

      <SlicingPanel
        key="export-slicing"
        models={scene.models}
        plateSliceScopes={plateSliceScopes}
        activePlateSliceIndex={activePlateSliceIndex}
        excludedModelIds={excludedSliceModelIds}
        activeModel={scene.activeModel}
        estimatedLayerCountOverride={estimatedSlicerLayerCount}
        estimatedLayerHeightMmOverride={crossSectionLayerHeightMm}
        estimatedVolumeLabelOverride={estimatedVolumeMlLabel}
        captureSceneThumbnailPng={captureExportThumbnailPng}
        onSliceRunStarted={handleSliceRunStartedForPrinting}
        onLayerPreviewGenerated={handlePrintingLayerPreviewGenerated}
        onSlicingFinished={handleSlicingFinishedForPrinting}
        onSliceArtifactReady={handleSliceArtifactReady}
        onBenchmarkComplete={handleSlicingBenchmarkComplete}
        onSliceTriggerRef={triggerSliceExportRef}
        shouldAutoSlice={shouldAutoSliceOnExportEntry}
        skipThumbnailCapture={shouldReturnToPrintingAfterSliceRef.current}
        onSlicingBusyChange={setIsSlicingBusy}
        canUpload={canSliceAndUpload}
        canPrint={canSliceAndPrint}
        onSliceIntentChanged={(intent) => { sliceIntentRef.current = intent; }}
        onBeforeSliceStart={handleBeforeSliceStart}
        onBeforeSlicingRun={handlePreSliceSceneSave}
        resolveOutputPathForIntent={(intent) => (
          intent === 'file' || intent === 'uvtools'
            ? (preSliceFileDestinationPathRef.current?.trim() || null)
            : null
        )}
      />
    </>
  );
}
