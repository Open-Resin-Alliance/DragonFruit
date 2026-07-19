import React from 'react';
import { AlertTriangle, CheckCircle2, LayoutGrid, Trash2, X } from 'lucide-react';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { ModelSupportsModal } from '@/components/modals/ModelSupportsModal';
import { SceneAutosaveRecoveryModal } from '@/components/scene/SceneAutosaveRecoveryModal';
import { ZipFilePickerModal } from '@/components/modals/ZipFilePickerModal';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';

export type SceneFileModalsProps = {
  arrangeOverlayContent: { title: string; detailLines: string[]; };
  arrangeOverlayElapsedLabel: string;
  arrangeOverlayModelCount: number | null;
  autosaveRecovery: { savedAt: string; } | null;
  closeUnsavedChangesBusy: "none" | "save_and_close" | "discard_and_close";
  handleAutosaveDiscard: () => Promise<void>;
  handleAutosaveRestore: () => Promise<void>;
  handleCancelPluginImportWarning: () => void;
  handleContinuePluginImportWarning: () => void;
  handleDiscardAndCloseProgram: () => void;
  handleSaveAndCloseProgram: () => void;
  hasUnsavedSceneChanges: boolean;
  pluginImportWarningSkipFuture: boolean;
  resolveSceneSaveChoice: (choice: "overwrite" | "save_as" | "cancel") => void;
  scene: ReturnType<typeof useSceneCollectionManager>;
  sceneSaveChoiceFileName: string | null;
  sceneSaveChoicePath: string | null;
  setPluginImportWarningSkipFuture: React.Dispatch<React.SetStateAction<boolean>>;
  setShowCloseUnsavedChangesModal: React.Dispatch<React.SetStateAction<boolean>>;
  setSupportsInfoModelId: React.Dispatch<React.SetStateAction<string | null>>;
  setZipPickerState: React.Dispatch<React.SetStateAction<{ zipName: string; files: File[]; category: "mesh" | "scene" | "mixed"; defaultSelectionCategory: "mesh" | "scene"; } | null>>;
  showArrangeBlockingOverlay: boolean;
  showCloseUnsavedChangesModal: boolean;
  showPluginImportWarningModal: boolean;
  showSceneSaveChoiceModal: boolean;
  supportsInfoModelId: string | null;
  zipPickerResolveRef: React.RefObject<((files: File[]) => void) | null>;
  zipPickerState: { zipName: string; files: File[]; category: "mesh" | "scene" | "mixed"; defaultSelectionCategory: "mesh" | "scene"; } | null;
};

/** Editor modal organism: ModelSupportsModal, sceneImportPlacementPrompt, autosaveRecovery, pluginImportWarning, zipPicker, StructuredDialog_closeUnsaved, sceneSaveChoice, arrangeBlockingOverlay. */
export function SceneFileModals({
  arrangeOverlayContent,
  arrangeOverlayElapsedLabel,
  arrangeOverlayModelCount,
  autosaveRecovery,
  closeUnsavedChangesBusy,
  handleAutosaveDiscard,
  handleAutosaveRestore,
  handleCancelPluginImportWarning,
  handleContinuePluginImportWarning,
  handleDiscardAndCloseProgram,
  handleSaveAndCloseProgram,
  hasUnsavedSceneChanges,
  pluginImportWarningSkipFuture,
  resolveSceneSaveChoice,
  scene,
  sceneSaveChoiceFileName,
  sceneSaveChoicePath,
  setPluginImportWarningSkipFuture,
  setShowCloseUnsavedChangesModal,
  setSupportsInfoModelId,
  setZipPickerState,
  showArrangeBlockingOverlay,
  showCloseUnsavedChangesModal,
  showPluginImportWarningModal,
  showSceneSaveChoiceModal,
  supportsInfoModelId,
  zipPickerResolveRef,
  zipPickerState,
}: SceneFileModalsProps) {
  return (
    <>
      <ModelSupportsModal
        isOpen={supportsInfoModelId !== null}
        onClose={() => setSupportsInfoModelId(null)}
        model={scene.models.find((m) => m.id === supportsInfoModelId) ?? null}
      />

      {scene.sceneImportPlacementPrompt && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              scene.resolveSceneImportPlacementPrompt('load_as_is');
            }
          }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Scene import placement decision"
          >
            <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                    color: 'var(--accent)',
                  }}
                >
                  <LayoutGrid className="h-4 w-4" />
                </span>

                <div className="min-w-0 pr-2">
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Scene may be off-plate
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Choose how to place imported models.
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close scene import placement prompt"
                onClick={() => scene.resolveSceneImportPlacementPrompt('load_as_is')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Imported scene</div>
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={scene.sceneImportPlacementPrompt.fileName}>
                  {scene.sceneImportPlacementPrompt.fileName}
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {scene.sceneImportPlacementPrompt.offPlateModelCount.toLocaleString()} of {scene.sceneImportPlacementPrompt.modelCount.toLocaleString()} model{scene.sceneImportPlacementPrompt.modelCount === 1 ? '' : 's'} appear outside the build plate.
                </div>
              </div>

              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                <strong style={{ color: 'var(--text-strong)' }}>Auto-Arrange</strong> will reposition imported models onto free space on the plate.
                <span className="mt-1 block">
                  <strong style={{ color: 'var(--text-strong)' }}>Load As-Is</strong> keeps scene coordinates exactly as stored in the file.
                </span>
              </p>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                  onClick={() => scene.resolveSceneImportPlacementPrompt('load_as_is')}
                >
                  Load As-Is
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-accent !h-9 w-full px-3 text-xs"
                  onClick={() => scene.resolveSceneImportPlacementPrompt('auto_arrange')}
                >
                  Auto-Arrange
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {autosaveRecovery && (
        <SceneAutosaveRecoveryModal
          savedAt={autosaveRecovery.savedAt}
          onRestore={handleAutosaveRestore}
          onDiscard={handleAutosaveDiscard}
        />
      )}

      {showPluginImportWarningModal && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleCancelPluginImportWarning();
            }
          }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="LYS import experimental warning"
          >
            <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                    color: '#d97706',
                  }}
                >
                  <AlertTriangle className="h-4 w-4" />
                </span>

                <div className="min-w-0 pr-2">
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    LYS Import is Experimental
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    This feature is still under development.
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close LYS import warning"
                onClick={handleCancelPluginImportWarning}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Geometry, support placement, and transforms can import differently across `.lys` scene variants, so unforeseen results are still possible.
              </p>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <label className="inline-flex items-center gap-2 text-xs select-none" style={{ color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    checked={pluginImportWarningSkipFuture}
                    onChange={(event) => setPluginImportWarningSkipFuture(event.target.checked)}
                    className="h-3.5 w-3.5 rounded border"
                    style={{ accentColor: '#f59e0b' }}
                  />
                  <span>Do not remind again</span>
                </label>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                    onClick={handleCancelPluginImportWarning}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ui-button !h-9 px-3 text-xs"
                    style={{
                      borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                      background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 86%)',
                      color: '#fde68a',
                    }}
                    onClick={handleContinuePluginImportWarning}
                  >
                    Continue
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {zipPickerState && (
        <ZipFilePickerModal
          zipName={zipPickerState.zipName}
          files={zipPickerState.files}
          category={zipPickerState.category}
          defaultSelectionCategory={zipPickerState.defaultSelectionCategory}
          onConfirm={(selected) => {
            const resolve = zipPickerResolveRef.current;
            zipPickerResolveRef.current = null;
            setZipPickerState(null);
            resolve?.(selected);
          }}
          onCancel={() => {
            const resolve = zipPickerResolveRef.current;
            zipPickerResolveRef.current = null;
            setZipPickerState(null);
            resolve?.([]);
          }}
        />
      )}

      <StructuredDialogModal
        open={showCloseUnsavedChangesModal}
        ariaLabel="Unsaved changes"
        title="Unsaved Scene Changes"
        subtitle={hasUnsavedSceneChanges
          ? 'You have unsaved edits in this scene.'
          : 'This scene is already saved.'}
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        zIndexClassName="z-[220]"
        closeAriaLabel="Close unsaved changes modal"
        closeDisabled={closeUnsavedChangesBusy !== 'none'}
        onClose={() => {
          if (closeUnsavedChangesBusy !== 'none') return;
          setShowCloseUnsavedChangesModal(false);
        }}
        onBackdropClick={() => {
          if (closeUnsavedChangesBusy !== 'none') return;
          setShowCloseUnsavedChangesModal(false);
        }}
        actions={(
          <>
            <button
              type="button"
              className="ui-button !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                color: 'var(--danger)',
              }}
              disabled={closeUnsavedChangesBusy !== 'none'}
              onClick={handleDiscardAndCloseProgram}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Discard Changes
            </button>
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
              disabled={closeUnsavedChangesBusy !== 'none'}
              onClick={handleSaveAndCloseProgram}
            >
              Save &amp; Close
            </button>
          </>
        )}
      >
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {hasUnsavedSceneChanges
            ? 'You’re about to close DragonFruit with unsaved scene changes.'
            : 'Close DragonFruit now?'}
        </p>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <strong>Please ensure you have saved any important work.</strong>
        </p>
      </StructuredDialogModal>

      {showSceneSaveChoiceModal && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              resolveSceneSaveChoice('cancel');
            }
          }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Save scene options"
          >
            <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 55%)',
                    background: 'color-mix(in srgb, #22c55e, var(--surface-1) 90%)',
                    color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)',
                  }}
                >
                  <CheckCircle2 className="h-4 w-4" />
                </span>

                <div className="min-w-0 pr-2">
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Save Loaded Scene
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Choose where Ctrl+S should save this imported `.voxl` scene.
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close save scene options"
                onClick={() => resolveSceneSaveChoice('cancel')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5 p-5">
              <div
                className="rounded-lg border px-3 py-2.5"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'color-mix(in srgb, var(--surface-1), black 8%)',
                }}
              >
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Loaded file
                </div>
                <div className="mt-1 text-sm font-semibold leading-tight" style={{ color: 'var(--text-strong)' }} title={sceneSaveChoiceFileName ?? ''}>
                  {sceneSaveChoiceFileName ?? 'Loaded scene'}
                </div>
                <div className="mt-1 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }} title={sceneSaveChoicePath ?? ''}>
                  {sceneSaveChoicePath ?? 'Original file path unavailable (overwrite disabled)'}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-0.5">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs whitespace-nowrap"
                  onClick={() => resolveSceneSaveChoice('save_as')}
                >
                  Save as New Scene
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-accent !h-9 px-3 text-xs whitespace-nowrap"
                  disabled={!sceneSaveChoicePath}
                  onClick={() => resolveSceneSaveChoice('overwrite')}
                >
                  Overwrite Loaded Scene
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showArrangeBlockingOverlay && (
        <div className="absolute inset-0 z-[120] flex items-center justify-center bg-black/45 backdrop-blur-[1px]">
          <div
            className="w-[min(520px,92vw)] rounded-xl border px-5 py-4 shadow-xl"
            style={{
              background: 'color-mix(in srgb, var(--surface-0), black 10%)',
              borderColor: 'var(--border-subtle)',
            }}
            role="dialog"
            aria-modal="true"
            aria-live="polite"
          >
            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              {arrangeOverlayContent.title}
            </div>
            <div className="mt-1 space-y-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {arrangeOverlayContent.detailLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>

            <div className="mt-2 text-[11px] font-medium tracking-wide" style={{ color: 'var(--accent)' }}>
              Elapsed: {arrangeOverlayElapsedLabel}
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Processing {arrangeOverlayModelCount ?? 0} {arrangeOverlayModelCount === 1 ? 'model' : 'models'}
            </div>

            <div
              className="ui-loading-track mt-3 h-2.5 w-full rounded-full"
              style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
            >
              <div
                className="ui-loading-indicator"
                style={{ background: 'linear-gradient(90deg, var(--accent), #ff79c6)' }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
