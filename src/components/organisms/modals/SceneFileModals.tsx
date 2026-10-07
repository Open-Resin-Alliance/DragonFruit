import React from 'react';
import { AlertTriangle, CheckCircle2, LayoutGrid, Trash2, X } from 'lucide-react';
import { BlockingOverlay, Button, IconButton, IconChip } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { ModelSupportsModal } from '@/components/modals/ModelSupportsModal';
import { ObsoleteVoxlVersionModal } from '@/components/modals/ObsoleteVoxlVersionModal';
import { SceneAutosaveRecoveryModal } from '@/components/scene/SceneAutosaveRecoveryModal';
import { ZipFilePickerModal } from '@/components/modals/ZipFilePickerModal';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';

export type SceneFileModalsProps = {
  arrangeOverlayContent: { title: string; detailLines: string[]; };
  arrangeOverlayElapsedLabel: string;
  arrangeOverlayModelCount: number | null;
  autosaveRecovery: { savedAt: string; voxlPath: string; origin: string } | null;
  closeUnsavedChangesBusy: "none" | "save_and_close" | "discard_and_close";
  newSceneBusy: "none" | "save_and_new" | "discard_and_new";
  handleAutosaveDiscard: () => Promise<void>;
  handleAutosaveRestore: () => Promise<void>;
  handleCancelPluginImportWarning: () => void;
  handleContinuePluginImportWarning: () => void;
  handleDiscardAndCloseProgram: () => void;
  handleDiscardAndNewScene: () => void;
  handleSaveAndCloseProgram: () => void;
  handleSaveAndNewScene: () => void;
  hasUnsavedSceneChanges: boolean;
  pluginImportWarningSkipFuture: boolean;
  pluginImportWarningTitle?: string | null;
  pluginImportWarningBody?: string | null;
  resolveSceneSaveChoice: (choice: "overwrite" | "save_as" | "cancel") => void;
  scene: ReturnType<typeof useSceneCollectionManager>;
  sceneSaveChoiceFileName: string | null;
  sceneSaveChoicePath: string | null;
  sceneSaveError?: { title: string; message: string; detail?: string | null } | null;
  dismissSceneSaveError?: () => void;
  setPluginImportWarningSkipFuture: React.Dispatch<React.SetStateAction<boolean>>;
  setShowCloseUnsavedChangesModal: React.Dispatch<React.SetStateAction<boolean>>;
  setShowNewSceneUnsavedChangesModal: React.Dispatch<React.SetStateAction<boolean>>;
  setSupportsInfoModelId: React.Dispatch<React.SetStateAction<string | null>>;
  setZipPickerState: React.Dispatch<React.SetStateAction<{ zipName: string; files: File[]; category: "mesh" | "scene" | "mixed"; defaultSelectionCategory: "mesh" | "scene"; } | null>>;
  showArrangeBlockingOverlay: boolean;
  showCloseUnsavedChangesModal: boolean;
  showNewSceneUnsavedChangesModal: boolean;
  showPluginImportWarningModal: boolean;
  showSceneSaveChoiceModal: boolean;
  supportsInfoModelId: string | null;
  zipPickerResolveRef: React.RefObject<((files: File[]) => void) | null>;
  zipPickerState: { zipName: string; files: File[]; category: "mesh" | "scene" | "mixed"; defaultSelectionCategory: "mesh" | "scene"; } | null;
};

type UnsavedChangesDialogProps = {
  open: boolean;
  busy: boolean;
  subtitle: string;
  body: React.ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
};

/**
 * Shared shell for the two unsaved-changes prompts: closing the program and
 * starting a new scene. Both offer the same three ways out (cancel, discard,
 * save first); only the body copy and the primary button's label differ.
 */
function UnsavedChangesDialog({
  open,
  busy,
  subtitle,
  body,
  confirmLabel,
  onCancel,
  onDiscard,
  onSave,
}: UnsavedChangesDialogProps) {
  return (
    <StructuredDialogModal
      open={open}
      ariaLabel="Unsaved changes"
      title="Unsaved Scene Changes"
      subtitle={subtitle}
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[220]"
      closeAriaLabel="Close unsaved changes modal"
      closeDisabled={busy}
      onClose={() => {
        if (busy) return;
        onCancel();
      }}
      onBackdropClick={() => {
        if (busy) return;
        onCancel();
      }}
      actions={(
        <>
          <Button
            variant="tinted-danger"
            className="w-full inline-flex items-center justify-center gap-1.5"
            disabled={busy}
            onClick={onDiscard}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Discard Changes
          </Button>
          <Button
            variant="secondary"
            className="w-full"
            disabled={busy}
            onClick={onSave}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {body}
    </StructuredDialogModal>
  );
}

/** Editor modal organism: ModelSupportsModal, sceneImportPlacementPrompt, autosaveRecovery, pluginImportWarning, zipPicker, StructuredDialog_closeUnsaved, StructuredDialog_newSceneUnsaved, sceneSaveChoice, arrangeBlockingOverlay, sceneSaveError. */
export function SceneFileModals({
  arrangeOverlayContent,
  arrangeOverlayElapsedLabel,
  arrangeOverlayModelCount,
  autosaveRecovery,
  closeUnsavedChangesBusy,
  newSceneBusy,
  handleAutosaveDiscard,
  handleAutosaveRestore,
  handleCancelPluginImportWarning,
  handleContinuePluginImportWarning,
  handleDiscardAndCloseProgram,
  handleDiscardAndNewScene,
  handleSaveAndCloseProgram,
  handleSaveAndNewScene,
  hasUnsavedSceneChanges,
  pluginImportWarningSkipFuture,
  pluginImportWarningTitle,
  pluginImportWarningBody,
  resolveSceneSaveChoice,
  scene,
  sceneSaveChoiceFileName,
  sceneSaveChoicePath,
  sceneSaveError = null,
  dismissSceneSaveError,
  setPluginImportWarningSkipFuture,
  setShowCloseUnsavedChangesModal,
  setShowNewSceneUnsavedChangesModal,
  setSupportsInfoModelId,
  setZipPickerState,
  showArrangeBlockingOverlay,
  showCloseUnsavedChangesModal,
  showNewSceneUnsavedChangesModal,
  showPluginImportWarningModal,
  showSceneSaveChoiceModal,
  supportsInfoModelId,
  zipPickerResolveRef,
  zipPickerState,
}: SceneFileModalsProps) {
  // Escape mirrors each dialog's backdrop click; the arrange overlay is a
  // blocking progress state, so it swallows the key instead.
  useEscapeToClose(Boolean(scene.sceneImportPlacementPrompt), () => scene.resolveSceneImportPlacementPrompt('load_as_is'));
  useEscapeToClose(showPluginImportWarningModal, handleCancelPluginImportWarning);
  useEscapeToClose(showSceneSaveChoiceModal, () => resolveSceneSaveChoice('cancel'));
  useEscapeToClose(showArrangeBlockingOverlay, undefined);

  return (
    <>
      <StructuredDialogModal
        open={sceneSaveError !== null}
        onClose={() => dismissSceneSaveError?.()}
        ariaLabel="Save Error"
        icon={<AlertTriangle className="h-5 w-5 text-amber-400" />}
        title={sceneSaveError?.title ?? 'Save error'}
        actions={
          <Button
            variant="tinted-accent"
            className="inline-flex items-center justify-center gap-1.5"
            onClick={() => dismissSceneSaveError?.()}
          >
            OK
          </Button>
        }
      >
        <div className="space-y-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          <p className="font-medium text-sm" style={{ color: 'var(--text-strong)' }}>
            {sceneSaveError?.message}
          </p>
          {sceneSaveError?.detail && (
            <pre className="mt-2 overflow-x-auto rounded bg-black/30 p-2 text-[11px] font-mono whitespace-pre-wrap">
              {sceneSaveError.detail}
            </pre>
          )}
        </div>
      </StructuredDialogModal>
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
                <IconChip
                  size="lg"
                  icon={LayoutGrid}
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                    color: 'var(--accent)',
                  }}
                />

                <div className="min-w-0 pr-2">
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Scene may be off-plate
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Choose how to place imported models.
                  </p>
                </div>
              </div>

              <IconButton
                variant="surface"
                size="md"
                aria-label="Close scene import placement prompt"
                onClick={() => scene.resolveSceneImportPlacementPrompt('load_as_is')}
              >
                <X className="w-4 h-4" />
              </IconButton>
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
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => scene.resolveSceneImportPlacementPrompt('load_as_is')}
                >
                  Load As-Is
                </Button>
                <Button
                  variant="tinted-accent"
                  className="w-full inline-flex items-center justify-center gap-1.5"
                  onClick={() => scene.resolveSceneImportPlacementPrompt('auto_arrange')}
                >
                  Auto-Arrange
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {scene.obsoleteVoxlScene && (
        <ObsoleteVoxlVersionModal
          isOpen
          fileName={scene.obsoleteVoxlScene.fileName}
          detected={scene.obsoleteVoxlScene.detected}
          onDismiss={scene.dismissObsoleteVoxlScene}
        />
      )}

      {autosaveRecovery && (
        <SceneAutosaveRecoveryModal
          savedAt={autosaveRecovery.savedAt}
          voxlPath={autosaveRecovery.voxlPath}
          origin={autosaveRecovery.origin}
          onRestore={handleAutosaveRestore}
          onDiscard={handleAutosaveDiscard}
        />
      )}

      {showPluginImportWarningModal && (
        <StructuredDialogModal
          open
          zIndexClassName="z-[220]"
          ariaLabel="Plugin import experimental warning"
          title={
            pluginImportWarningTitle
              ? `${pluginImportWarningTitle} is Experimental`
              : 'Plugin Import is Experimental'
          }
          subtitle="This feature is still under development."
          icon={<AlertTriangle className="h-4 w-4" />}
          iconTone="warning"
          closeAriaLabel="Close plugin import warning"
          onClose={handleCancelPluginImportWarning}
          onBackdropClick={handleCancelPluginImportWarning}
        >
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {pluginImportWarningBody
                  ?? 'Geometry, support placement, and transforms can import differently across scene variants, so unforeseen results are still possible.'}
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
                  <Button
                    variant="secondary"
                    onClick={handleCancelPluginImportWarning}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="secondary"
                    className="inline-flex items-center justify-center gap-1.5"
                    style={{
                      borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                      background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 86%)',
                      color: '#fde68a',
                    }}
                    onClick={handleContinuePluginImportWarning}
                  >
                    Continue
                  </Button>
                </div>
              </div>
        </StructuredDialogModal>
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

      <UnsavedChangesDialog
        open={showCloseUnsavedChangesModal}
        busy={closeUnsavedChangesBusy !== 'none'}
        subtitle={hasUnsavedSceneChanges
          ? 'You have unsaved edits in this scene.'
          : 'This scene is already saved.'}
        confirmLabel="Save & Close"
        onCancel={() => setShowCloseUnsavedChangesModal(false)}
        onDiscard={handleDiscardAndCloseProgram}
        onSave={handleSaveAndCloseProgram}
        body={(
          <>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {hasUnsavedSceneChanges
                ? 'You’re about to close DragonFruit with unsaved scene changes.'
                : 'Close DragonFruit now?'}
            </p>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              <strong>Please ensure you have saved any important work.</strong>
            </p>
          </>
        )}
      />

      <UnsavedChangesDialog
        open={showNewSceneUnsavedChangesModal}
        busy={newSceneBusy !== 'none'}
        subtitle={hasUnsavedSceneChanges
          ? 'You have unsaved edits in this scene.'
          : 'This scene is already saved.'}
        confirmLabel="Save & New Scene"
        onCancel={() => setShowNewSceneUnsavedChangesModal(false)}
        onDiscard={handleDiscardAndNewScene}
        onSave={handleSaveAndNewScene}
        body={(
          <>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {hasUnsavedSceneChanges
                ? 'You’re about to start a new scene with unsaved edits in this one.'
                : 'Start a new scene now?'}
            </p>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              <strong>Please ensure you have saved any important work.</strong>
            </p>
          </>
        )}
      />

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
                <IconChip
                  size="lg"
                  icon={CheckCircle2}
                  style={{
                    borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 55%)',
                    background: 'color-mix(in srgb, #22c55e, var(--surface-1) 90%)',
                    color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)',
                  }}
                />

                <div className="min-w-0 pr-2">
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Save Loaded Scene
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Choose where Ctrl+S should save this imported `.voxl` scene.
                  </p>
                </div>
              </div>

              <IconButton
                variant="surface"
                size="md"
                aria-label="Close save scene options"
                onClick={() => resolveSceneSaveChoice('cancel')}
              >
                <X className="w-4 h-4" />
              </IconButton>
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
                <Button
                  variant="secondary"
                  className="whitespace-nowrap"
                  onClick={() => resolveSceneSaveChoice('save_as')}
                >
                  Save as New Scene
                </Button>
                <Button
                  variant="tinted-accent"
                  className="whitespace-nowrap inline-flex items-center justify-center gap-1.5"
                  disabled={!sceneSaveChoicePath}
                  onClick={() => resolveSceneSaveChoice('overwrite')}
                >
                  Overwrite Loaded Scene
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showArrangeBlockingOverlay && (
        <BlockingOverlay
          zIndexClassName="z-[120]"
          title={arrangeOverlayContent.title}
          details={arrangeOverlayContent.detailLines}
          elapsed={`Elapsed: ${arrangeOverlayElapsedLabel}`}
          footnote={`Processing ${arrangeOverlayModelCount ?? 0} ${arrangeOverlayModelCount === 1 ? 'model' : 'models'}`}
          progress={null}
          progressLabel={arrangeOverlayContent.title}
        />
      )}
    </>
  );
}
