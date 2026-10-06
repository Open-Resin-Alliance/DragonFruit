import { AlertTriangle, Trash2 } from 'lucide-react';
import { BlockingOverlay, Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { DestructiveTransformModal } from '@/components/modals/DestructiveTransformModal';
import { type HollowingPanelState } from '@/features/hollowing';

type PendingModifierResetAction = 'hollowing' | 'hole_punch' | 'clear_hollowing';

/** What the user chose in the unapplied-modifier prompt. The page performs the
 *  action — the modal only reports it. */
export type UnappliedModifierAction = 'apply' | 'skip' | 'goto';

export type UnappliedModifierPrompt = {
  title: string;
  subtitle: string;
  paragraphs: string[];
  /** Hidden when nothing has unapplied hole punches (nothing to bake). */
  showApplyAll: boolean;
};

export type ModifierModalsProps = {
  handleCancelDestructiveTransform: () => void;
  handleConfirmBlockerReset: () => void;
  handleConfirmDestructiveTransform: () => void;
  handleConfirmModifierReset: () => void;
  modifierApplyOverlayContent: { title: string; detailLines: string[]; };
  modifierApplyOverlayElapsedLabel: string;
  modifierApplyProcessingLabel: string;
  pendingBlockerResetState: HollowingPanelState | null;
  pendingDestructiveTransform: { modelId: string; modelName: string; supportCount: number; operationLabel: string; } | null;
  pendingModifierResetAction: PendingModifierResetAction | null;
  setPendingBlockerResetState: React.Dispatch<React.SetStateAction<HollowingPanelState | null>>;
  setPendingModifierResetAction: React.Dispatch<React.SetStateAction<PendingModifierResetAction | null>>;
  showModifierApplyBlockingOverlay: boolean;
  showUnappliedHolePunchModal: boolean;
  unappliedModifierPrompt: UnappliedModifierPrompt;
  unappliedHolePunchResolveRef: React.RefObject<((action: UnappliedModifierAction) => void) | null>;
};

/** Editor modal organism: StructuredDialog_unappliedHolePunch, StructuredDialog_modifierReset, StructuredDialog_blockerReset, DestructiveTransformModal, modifierApplyBlockingOverlay. */
export function ModifierModals({
  handleCancelDestructiveTransform,
  handleConfirmBlockerReset,
  handleConfirmDestructiveTransform,
  handleConfirmModifierReset,
  modifierApplyOverlayContent,
  modifierApplyOverlayElapsedLabel,
  modifierApplyProcessingLabel,
  pendingBlockerResetState,
  pendingDestructiveTransform,
  pendingModifierResetAction,
  setPendingBlockerResetState,
  setPendingModifierResetAction,
  showModifierApplyBlockingOverlay,
  showUnappliedHolePunchModal,
  unappliedModifierPrompt,
  unappliedHolePunchResolveRef,
}: ModifierModalsProps) {
  // A blocking progress overlay: swallow Escape rather than let it through.
  useEscapeToClose(showModifierApplyBlockingOverlay, undefined);

  return (
    <>
      <StructuredDialogModal
        open={showUnappliedHolePunchModal}
        ariaLabel="Unapplied model changes"
        title={unappliedModifierPrompt.title}
        subtitle={unappliedModifierPrompt.subtitle}
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel="Close"
        onClose={() => unappliedHolePunchResolveRef.current?.('skip')}
        actions={(
          <>
            <Button
              variant="secondary"
              onClick={() => unappliedHolePunchResolveRef.current?.('skip')}
            >
              Continue Without
            </Button>
            <Button
              variant="tinted-accent"
              className="inline-flex items-center justify-center gap-1.5"
              onClick={() => unappliedHolePunchResolveRef.current?.('goto')}
            >
              Go to Hollow Tool
            </Button>
            {unappliedModifierPrompt.showApplyAll && (
              <Button
                variant="tinted-accent"
                className="inline-flex items-center justify-center gap-1.5"
                onClick={() => unappliedHolePunchResolveRef.current?.('apply')}
              >
                Apply to All
              </Button>
            )}
          </>
        )}
      >
        <div className="space-y-2">
          {unappliedModifierPrompt.paragraphs.map((paragraph, index) => (
            <p
              key={index}
              className="text-xs leading-relaxed"
              style={{ color: 'var(--text-muted)' }}
            >
              {paragraph}
            </p>
          ))}
        </div>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={pendingModifierResetAction !== null}
        ariaLabel="Confirm modifier reset"
        title={pendingModifierResetAction === 'hollowing' ? 'Remove Hollowing?' : 'Remove All Holes?'}
        subtitle="This action can't be undone"
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel="Close reset confirmation"
        onClose={() => setPendingModifierResetAction(null)}
        actions={(
          <>
            <Button
              variant="secondary"
              onClick={() => setPendingModifierResetAction(null)}
            >
              Cancel
            </Button>
            <Button
              variant="tinted-danger"
              className="inline-flex items-center justify-center gap-1.5"
              onClick={handleConfirmModifierReset}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {pendingModifierResetAction === 'hollowing' ? 'Remove Hollowing' : 'Remove All Holes'}
            </Button>
          </>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {pendingModifierResetAction === 'hollowing'
              ? 'Are you sure you want to remove hollowing from this model?'
              : 'Are you sure you want to remove all hole punches from this model?'}
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {pendingModifierResetAction === 'hollowing'
              ? 'Your model will return to its solid version.'
              : 'All holes on this model will be removed.'}
          </p>
        </div>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={pendingBlockerResetState !== null}
        ariaLabel="Confirm blocker reset"
        title="Reset Blockers?"
        subtitle="Blockers will be lost"
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel="Close blocker reset confirmation"
        onClose={() => setPendingBlockerResetState(null)}
        actions={(
          <>
            <Button
              variant="secondary"
              onClick={() => setPendingBlockerResetState(null)}
            >
              Cancel
            </Button>
            <Button
              variant="tinted-danger"
              className="inline-flex items-center justify-center gap-1.5"
              onClick={handleConfirmBlockerReset}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Reset Blockers
            </Button>
          </>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Changing the voxel resolution or shell thickness will clear all applied blockers.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            You will need to re-select blocked regions after the change.
          </p>
        </div>
      </StructuredDialogModal>

      <DestructiveTransformModal
        isOpen={pendingDestructiveTransform !== null}
        modelName={pendingDestructiveTransform?.modelName ?? null}
        supportCount={pendingDestructiveTransform?.supportCount ?? 0}
        operationLabel={pendingDestructiveTransform?.operationLabel ?? 'Transform'}
        onCancel={handleCancelDestructiveTransform}
        onConfirm={handleConfirmDestructiveTransform}
      />

      {showModifierApplyBlockingOverlay && (
        <BlockingOverlay
          zIndexClassName="z-[121]"
          title={modifierApplyOverlayContent.title}
          details={modifierApplyOverlayContent.detailLines}
          elapsed={`Elapsed: ${modifierApplyOverlayElapsedLabel}`}
          footnote={modifierApplyProcessingLabel}
          progress={null}
          progressLabel={modifierApplyOverlayContent.title}
        />
      )}
    </>
  );
}
