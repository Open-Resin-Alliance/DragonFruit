import { DiagnosticsModal } from '@/components/modals/DiagnosticsModal';
import { HistoryDebugModal } from '@/components/modals/HistoryDebugModal';
import { SliceMetricsDebugModal } from '@/features/slicing/components/SliceMetricsDebugModal';
import { getSavedCameraProjectionSettings } from '@/components/settings/cameraProjectionPreferences';
import type { HistoryDebugEvent } from '@/history/types';
import type { SliceExportArtifact, SliceExportResult } from '@/features/slicing/sliceExportOrchestrator';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';

export type DiagnosticsModalsProps = {
  clearHistory: () => void;
  clearHistoryDebugEvents: () => void;
  handleHistoryCancelPreview: () => void;
  handleHistoryJumpToEvent: (event: HistoryDebugEvent) => void;
  historyDebugEvents: HistoryDebugEvent[];
  historyPreviewTargetEventId: number | null;
  historyStackCounts: { undo: number; redo: number; };
  isDiagnosticsOpen: boolean;
  isHistoryDebugOpen: boolean;
  isHistoryPreviewActive: boolean;
  isSliceMetricsDebugOpen: boolean;
  printingArtifact: SliceExportArtifact | null;
  printingOutputSizeLabel: string;
  printingSlicingBenchmark: SliceExportResult['benchmark'] | null;
  scene: ReturnType<typeof useSceneCollectionManager>;
  selectedPolygons: number;
  setIsDiagnosticsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsHistoryDebugOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsSliceMetricsDebugOpen: React.Dispatch<React.SetStateAction<boolean>>;
  totalPolygons: number;
};

/** Editor modal organism: DiagnosticsModal, HistoryDebugModal, SliceMetricsDebugModal. */
export function DiagnosticsModals({
  clearHistory,
  clearHistoryDebugEvents,
  handleHistoryCancelPreview,
  handleHistoryJumpToEvent,
  historyDebugEvents,
  historyPreviewTargetEventId,
  historyStackCounts,
  isDiagnosticsOpen,
  isHistoryDebugOpen,
  isHistoryPreviewActive,
  isSliceMetricsDebugOpen,
  printingArtifact,
  printingOutputSizeLabel,
  printingSlicingBenchmark,
  scene,
  selectedPolygons,
  setIsDiagnosticsOpen,
  setIsHistoryDebugOpen,
  setIsSliceMetricsDebugOpen,
  totalPolygons,
}: DiagnosticsModalsProps) {
  return (
    <>
      <DiagnosticsModal
        isOpen={isDiagnosticsOpen}
        onClose={() => setIsDiagnosticsOpen(false)}
        appMode={scene.mode}
        cameraProjectionMode={getSavedCameraProjectionSettings().mode}
        modelCount={scene.models.length}
        visibleModelCount={scene.models.filter((m) => m.visible).length}
        selectedModelCount={scene.selectedModelIds.length}
        totalPolygons={totalPolygons}
        selectedPolygons={selectedPolygons}
      />

      <HistoryDebugModal
        isOpen={isHistoryDebugOpen}
        onClose={() => setIsHistoryDebugOpen(false)}
        historyDebugEvents={historyDebugEvents}
        historyStackCounts={historyStackCounts}
        selectedPreviewEventId={historyPreviewTargetEventId}
        isPreviewActive={isHistoryPreviewActive}
        onJumpToEvent={handleHistoryJumpToEvent}
        onCancelPreview={handleHistoryCancelPreview}
        onClearEventLog={() => {
          clearHistoryDebugEvents();
        }}
        onClearUndoRedoStacks={() => {
          clearHistory();
        }}
        onClearAll={() => {
          clearHistory();
          clearHistoryDebugEvents();
        }}
      />

      <SliceMetricsDebugModal
        isOpen={isSliceMetricsDebugOpen}
        onClose={() => setIsSliceMetricsDebugOpen(false)}
        benchmark={printingSlicingBenchmark}
        outputName={printingArtifact?.outputName ?? null}
        outputSizeLabel={printingOutputSizeLabel}
      />
    </>
  );
}
