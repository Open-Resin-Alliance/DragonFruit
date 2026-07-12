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
  crossSectionLayerHeightMm: number;
  estimatedVolumeMlLabel: string;
  handleSliceRunStartedForPrinting: () => void;
  handlePrintingLayerPreviewGenerated: (payload: { layerIndex: number; totalLayers: number; pngBytes: Uint8Array }) => void;
  handleSlicingFinishedForPrinting: (payload: { totalLayers: number }) => void;
  handleSliceArtifactReady: (artifact: SliceExportArtifact) => void;
  handleSlicingBenchmarkComplete: (benchmark: SliceExportResult['benchmark']) => void;
  triggerSliceExportRef: React.MutableRefObject<(() => void) | null>;
  shouldAutoSliceOnExportEntry: boolean;
  shouldReturnToPrintingAfterSliceRef: React.MutableRefObject<boolean>;
  setIsSlicingBusy: (busy: boolean) => void;
  canSliceAndUpload: boolean;
  canSliceAndPrint: boolean;
  sliceIntentRef: React.MutableRefObject<SliceIntent>;
  handleBeforeSliceStart: (intent: SliceIntent) => Promise<boolean>;
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
  return (
    <>
      <ExportPanel
        key="export-main"
        models={scene.models}
        activeModel={scene.activeModel}
        activeModelId={scene.activeModelId}
        selectedModelIds={scene.selectedModelIds}
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
