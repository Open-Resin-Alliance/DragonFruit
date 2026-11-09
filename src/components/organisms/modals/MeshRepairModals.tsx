import * as React from 'react';
import { useLingui } from '@lingui/react';
import { msg, plural } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle, Wrench, X } from 'lucide-react';
import { Button, IconButton, IconChip, Spinner } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { MeshRepairConfirmModal } from '@/components/scene/MeshRepairConfirmModal';
import { MeshRepairReportModal } from '@/components/scene/MeshRepairReportModal';
import { translateRepairStage } from '@/components/scene/repairProgressMessages';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import { cancelMeshRepair } from '@/utils/meshRepair';
import type { MeshRepairProgress } from '@/utils/meshRepair';

/** A manual repair in flight: when it started, which model it is on, and what that model's run has reported. */
type ManualRepairState = {
  startedAt: number;
  modelName: string | null;
  modelIndex: number;
  modelCount: number;
  stage: MeshRepairProgress | null;
  stages: MeshRepairProgress[];
};

type Translate = ReturnType<typeof useLingui>['_'];

// Built at module level: a placeholder in a message built inside the component is left raw in
// production builds (Lingui × React Compiler).
function formatRepairMeshesTitle(translate: Translate, count: number): string {
  return translate(msg`${plural(count, { one: 'Repair Mesh', other: 'Repair # Meshes' })}`);
}

function formatRepairModelPosition(translate: Translate, position: number, count: number, modelName: string): string {
  return translate(msg`Model ${position} of ${count}: ${modelName}`);
}

/**
 * How full the progress bar is, 0..1.
 *
 * The stage count is not known in advance: the pipeline branches on what it finds in
 * the mesh, so a percentage of the stages would be invented. A saturating function of
 * the count always moves and never claims the work is nearly done, which is the honest
 * thing to show when the total is unknown.
 */
function repairProgressFraction(state: ManualRepairState): number {
  const modelFraction = state.stage ? 0.1 + 0.8 * (1 - Math.exp(-state.stages.length / 6)) : 0.06;
  // Each model of a selection takes an equal share of the bar.
  return (state.modelIndex + modelFraction) / Math.max(1, state.modelCount);
}

/** `0:04.2`, which is a duration a person reads at a glance. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

/** The bar, the stage it is on, and how long it has been going. */
function RepairProgressPanel({
  state,
  elapsedMs,
  cancelling,
}: {
  state: ManualRepairState;
  elapsedMs: number;
  cancelling: boolean;
}) {
  const { _ } = useLingui();
  const stageLabel = cancelling
    ? _(msg`Stopping at the end of this step…`)
    : translateRepairStage(state.stage?.name, _);

  return (
    <div className="space-y-3">
      {state.modelCount > 1 && state.modelName && (
        <div className="mx-1.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {formatRepairModelPosition(_, state.modelIndex + 1, state.modelCount, state.modelName)}
        </div>
      )}
      <div className="mx-1.5 flex items-baseline justify-between gap-3">
        <div className="min-w-0 truncate text-[11px] font-medium" style={{ color: 'var(--text-strong)' }}>
          {stageLabel}
        </div>
        <div className="shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
          {formatElapsed(elapsedMs)}
        </div>
      </div>

      {/* The row and the bar share one inset: the stage name and the elapsed time are set in from the
          dialog edge by the same amount the bar is, so the three of them line up. */}
      <div
        className="mx-1.5 h-1.5 overflow-hidden rounded-full"
        style={{ background: 'var(--surface-2)' }}
        role="progressbar"
        aria-label={_(msg`Repair progress`)}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${Math.round(repairProgressFraction(state) * 100)}%`, background: '#d97706' }}
        />
      </div>
    </div>
  );
}

export type MeshRepairModalsProps = {
  isManualRepairing: boolean;
  manualRepairModelIds: string[] | null;
  /** A repair that must begin as soon as its model is set, without the dialog's own confirm step. */
  autoStartRepair: boolean;
  setAutoStartRepair: React.Dispatch<React.SetStateAction<boolean>>;
  scene: ReturnType<typeof useSceneCollectionManager>;
  setIsManualRepairing: React.Dispatch<React.SetStateAction<boolean>>;
  setManualRepairModelIds: React.Dispatch<React.SetStateAction<string[] | null>>;
  setShowDamagedModelDialog: React.Dispatch<React.SetStateAction<boolean>>;
  showDamagedModelDialog: boolean;
};

/** Editor modal organism: StructuredDialog_damagedModel, meshRepairConfirmPrompt, manualRepairModelIds, meshRepairReports. */
export function MeshRepairModals({
  isManualRepairing,
  manualRepairModelIds,
  autoStartRepair,
  setAutoStartRepair,
  scene,
  setIsManualRepairing,
  setManualRepairModelIds,
  setShowDamagedModelDialog,
  showDamagedModelDialog,
}: MeshRepairModalsProps) {
  const { _ } = useLingui();
  const [manualRepair, setManualRepair] = React.useState<ManualRepairState | null>(null);
  const [repairToken, setRepairToken] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState(false);
  const [tick, setTick] = React.useState(0);

  // The elapsed clock only runs while a repair does.
  React.useEffect(() => {
    if (!isManualRepairing) return undefined;
    const timer = window.setInterval(() => setTick(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, [isManualRepairing]);

  const runRepair = React.useCallback(() => {
    const ids = manualRepairModelIds?.filter(id => scene.models.some(m => m.id === id)) ?? [];
    if (ids.length === 0) return;
    setIsManualRepairing(true);
    setCancelling(false);
    setManualRepair({ startedAt: performance.now(), modelName: null, modelIndex: 0, modelCount: ids.length, stage: null, stages: [] });
    void scene.repairModelsInPlace(ids, {
      onToken: setRepairToken,
      onModelStart: (modelId, index, total) => setManualRepair((previous) => (
        previous
          ? {
              ...previous,
              modelName: scene.models.find(m => m.id === modelId)?.name ?? null,
              modelIndex: index,
              modelCount: total,
              stage: null,
              stages: [],
            }
          : previous
      )),
      onProgress: (progress) => setManualRepair((previous) => (
        previous
          ? { ...previous, stage: progress, stages: [...previous.stages, progress] }
          : previous
      )),
    }).finally(() => {
      setIsManualRepairing(false);
      setManualRepairModelIds(null);
      setManualRepair(null);
      setRepairToken(null);
      setCancelling(false);
    });
  }, [manualRepairModelIds, scene, setIsManualRepairing, setManualRepairModelIds]);

  // Repair Now: the model arrives with the flag already set, so the repair starts here rather
  // than waiting for a click on a Repair button the user has effectively already pressed.
  const autoStartedModelIdsRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!autoStartRepair || !manualRepairModelIds) return;
    const key = manualRepairModelIds.join('\0');
    if (autoStartedModelIdsRef.current === key) return;
    autoStartedModelIdsRef.current = key;
    runRepair();
  }, [autoStartRepair, manualRepairModelIds, runRepair]);

  // Every way out of the dialog clears the flag, so the next repair opened by hand waits.
  React.useEffect(() => {
    if (manualRepairModelIds === null) setAutoStartRepair(false);
  }, [manualRepairModelIds, setAutoStartRepair]);

  // Escape mirrors the backdrop click: it cannot leave mid-repair.
  useEscapeToClose(
    manualRepairModelIds !== null,
    isManualRepairing ? undefined : () => setManualRepairModelIds(null),
  );

  return (
    <>
      <StructuredDialogModal
        open={showDamagedModelDialog}
        ariaLabel={_(msg`Mesh boolean operation failed`)}
        title={_(msg`Mesh quality too low`)}
        subtitle={_(msg`Boolean operation requires a manifold mesh`)}
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="danger"
        closeDisabled
        onClose={() => setShowDamagedModelDialog(false)}
        actions={(
          <Button
            variant="tinted-accent"
            className="inline-flex items-center justify-center gap-1.5"
            onClick={() => setShowDamagedModelDialog(false)}
          >
            <Trans>Got it</Trans>
          </Button>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <Trans>
              This mesh contains too many self-intersecting triangles and
              non-manifold edges for boolean operations to succeed.
              The import repair pass reduced but could not fully resolve
              all issues in the geometry.
            </Trans>
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <Trans>
              We recommend repairing the mesh in a dedicated 3D modeling
              program such as <strong>Blender</strong> or{' '}
              <strong>Netfabb</strong> before importing it into DragonFruit.
            </Trans>
          </p>
        </div>
      </StructuredDialogModal>

      {scene.meshRepairConfirmPrompt && (
        <MeshRepairConfirmModal
          prompt={scene.meshRepairConfirmPrompt}
          onRepair={() => scene.resolveMeshRepairConfirmPrompt('repair')}
          onRepairParts={() => scene.resolveMeshRepairConfirmPrompt('repair_parts')}
          onLoadAsIs={() => scene.resolveMeshRepairConfirmPrompt('load_as_is')}
          onCancelImport={() => scene.resolveMeshRepairConfirmPrompt('cancel_import')}
        />
      )}

      {manualRepairModelIds && (() => {
        const repairModels = scene.models.filter(m => manualRepairModelIds.includes(m.id));
        if (repairModels.length === 0) return null;
        const repairModelNames = repairModels.map(m => m.name).join(', ');
        const isMultiple = repairModels.length > 1;
        return (
          <div
            className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !isManualRepairing) {
                setManualRepairModelIds(null);
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
              aria-label={autoStartRepair ? _(msg`Repairing Mesh`) : _(msg`Repair Mesh`)}
            >
              <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="flex min-w-0 items-center gap-3">
                  <IconChip
                    size="lg"
                    icon={AlertTriangle}
                    style={{
                      borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 45%)',
                      background: 'color-mix(in srgb, #d97706, var(--surface-1) 88%)',
                      color: '#d97706',
                    }}
                  />

                  <div className="min-w-0 pr-2">
                    <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                      {autoStartRepair ? _(msg`Repairing Mesh`) : formatRepairMeshesTitle(_, repairModels.length)}
                    </h2>
                    <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                      {autoStartRepair
                        ? _(msg`Fixing geometry issues.`)
                        : _(msg`Fixes geometry issues before you keep working.`)}
                    </p>
                  </div>
                </div>

                <IconButton
                  variant="surface"
                  size="md"
                  aria-label={_(msg`Close repair mesh dialog`)}
                  disabled={isManualRepairing}
                  onClick={() => setManualRepairModelIds(null)}
                >
                  <X className="w-4 h-4" />
                </IconButton>
              </div>

              <div className="space-y-4 p-5">
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    {isMultiple
                      ? _(msg({ message: 'Models', context: 'Dialog field' }))
                      : _(msg({ message: 'Model', context: 'Dialog field' }))}
                  </div>
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={repairModelNames}>
                    {repairModelNames}
                  </div>
                </div>

                {manualRepair ? (
                  <RepairProgressPanel
                    state={manualRepair}
                    elapsedMs={Math.max(0, tick - manualRepair.startedAt)}
                    cancelling={cancelling}
                  />
                ) : (
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    {_(msg`Repairs holes, broken surfaces, and other mesh problems.`)}
                  </p>
                )}

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
                      {isMultiple
                        ? <Trans>The repaired results will replace these models in your current scene. Large or badly damaged meshes can take longer, and some files may still need manual cleanup afterward.</Trans>
                        : <Trans>The repaired result will replace this model in your current scene. Large or badly damaged meshes can take longer, and some files may still need manual cleanup afterward.</Trans>}
                    </p>
                  </div>
                </div>

                <div className={autoStartRepair || isManualRepairing ? 'pt-1' : 'grid grid-cols-2 gap-2 pt-1'}>
                  <Button
                    variant="secondary"
                    className="w-full inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                    disabled={cancelling}
                    onClick={() => {
                      if (isManualRepairing) {
                        if (!repairToken) return;
                        // Stops at the next stage boundary, so the mesh it leaves is
                        // one the pipeline finished a pass on.
                        setCancelling(true);
                        void cancelMeshRepair(repairToken);
                        return;
                      }
                      setManualRepairModelIds(null);
                    }}
                  >
                    {cancelling
                      ? <><Spinner size="sm" /><Trans>Stopping…</Trans></>
                      : isManualRepairing ? <Trans>Stop</Trans> : <Trans>Keep Original</Trans>
                    }
                  </Button>
                  {/* Once the run is under way Stop is the only thing to press: a second button
                      announcing the repair it is already doing, disabled, is noise beside it. */}
                  {!autoStartRepair && !isManualRepairing && (
                    <Button
                      variant="tinted-accent"
                      className="w-full inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                      onClick={runRepair}
                    >
                      <Wrench className="h-3.5 w-3.5" /><Trans>Repair</Trans>
                    </Button>
                  )}
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
