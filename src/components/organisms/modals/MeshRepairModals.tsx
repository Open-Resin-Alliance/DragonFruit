import { AlertTriangle, Loader2, Wrench, X } from 'lucide-react';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { MeshRepairConfirmModal } from '@/components/scene/MeshRepairConfirmModal';
import { MeshRepairReportModal } from '@/components/scene/MeshRepairReportModal';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';

export type MeshRepairModalsProps = {
  isManualRepairing: boolean;
  manualRepairModelId: string | null;
  scene: ReturnType<typeof useSceneCollectionManager>;
  setIsManualRepairing: React.Dispatch<React.SetStateAction<boolean>>;
  setManualRepairModelId: React.Dispatch<React.SetStateAction<string | null>>;
  setShowDamagedModelDialog: React.Dispatch<React.SetStateAction<boolean>>;
  showDamagedModelDialog: boolean;
};

/** Editor modal organism: StructuredDialog_damagedModel, meshRepairConfirmPrompt, manualRepairModelId, meshRepairReports. */
export function MeshRepairModals({
  isManualRepairing,
  manualRepairModelId,
  scene,
  setIsManualRepairing,
  setManualRepairModelId,
  setShowDamagedModelDialog,
  showDamagedModelDialog,
}: MeshRepairModalsProps) {
  return (
    <>
      <StructuredDialogModal
        open={showDamagedModelDialog}
        ariaLabel="Mesh boolean operation failed"
        title="Mesh quality too low"
        subtitle="Boolean operation requires a manifold mesh"
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="danger"
        closeDisabled
        onClose={() => setShowDamagedModelDialog(false)}
        actions={(
          <button
            type="button"
            className="ui-button ui-button-accent !h-9 px-3 text-xs"
            onClick={() => setShowDamagedModelDialog(false)}
          >
            Got it
          </button>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            This mesh contains too many self-intersecting triangles and
            non-manifold edges for boolean operations to succeed.
            The import repair pass reduced but could not fully resolve
            all issues in the geometry.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            We recommend repairing the mesh in a dedicated 3D modeling
            program such as <strong>Blender</strong> or{' '}
            <strong>Netfabb</strong> before importing it into DragonFruit.
          </p>
        </div>
      </StructuredDialogModal>

      {scene.meshRepairConfirmPrompt && (
        <MeshRepairConfirmModal
          prompt={scene.meshRepairConfirmPrompt}
          onRepair={(allowHullRescue) => scene.resolveMeshRepairConfirmPrompt('repair', allowHullRescue)}
          onLoadAsIs={() => scene.resolveMeshRepairConfirmPrompt('load_as_is')}
          onCancelImport={() => scene.resolveMeshRepairConfirmPrompt('cancel_import')}
        />
      )}

      {manualRepairModelId && (() => {
        const repairModel = scene.models.find(m => m.id === manualRepairModelId);
        if (!repairModel) return null;
        return (
          <div
            className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !isManualRepairing) {
                setManualRepairModelId(null);
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
              aria-label="Repair mesh"
            >
              <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                    style={{
                      borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 45%)',
                      background: 'color-mix(in srgb, #d97706, var(--surface-1) 88%)',
                      color: '#d97706',
                    }}
                  >
                    <AlertTriangle className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 pr-2">
                    <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                      Repair this mesh?
                    </h2>
                    <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                      DragonFruit will try to fix common geometry issues before you keep working.
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
                  aria-label="Close repair mesh dialog"
                  disabled={isManualRepairing}
                  onClick={() => setManualRepairModelId(null)}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4 p-5">
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Model</div>
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={repairModel.name}>
                    {repairModel.name}
                  </div>
                </div>

                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Repair can help with holes, broken surfaces, and other mesh problems that may lead to slicing or print issues.
                </p>

                <div
                  className="rounded-md border px-3 py-2"
                  style={{
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 40%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-1) 92%)',
                  }}
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: '#d97706' }} />
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      <strong style={{ color: 'var(--text-strong)' }}>Heads up:</strong> The repaired result will replace this model in your current scene. Large or badly damaged meshes can take longer, and some files may still need manual cleanup afterward.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                    disabled={isManualRepairing}
                    onClick={() => setManualRepairModelId(null)}
                  >
                    Keep Original
                  </button>
                  <button
                    type="button"
                    className="ui-button ui-button-accent !h-9 w-full px-3 text-xs flex items-center justify-center gap-1.5 disabled:opacity-60"
                    disabled={isManualRepairing}
                    onClick={() => {
                      const id = manualRepairModelId;
                      setIsManualRepairing(true);
                      void scene.repairModelInPlace(id).finally(() => {
                        setIsManualRepairing(false);
                        setManualRepairModelId(null);
                      });
                    }}
                  >
                    {isManualRepairing
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Repairing…</>
                      : <><Wrench className="h-3.5 w-3.5" />Repair</>
                    }
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {scene.meshRepairReports.length > 0 && (
        <MeshRepairReportModal
          reports={scene.meshRepairReports}
          presentation={scene.meshRepairReportPresentation}
          onDismiss={scene.dismissMeshRepairReports}
        />
      )}
    </>
  );
}
