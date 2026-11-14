import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { BlockingOverlay, Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { DestructiveTransformModal } from '@/components/modals/DestructiveTransformModal';
import { type HollowingPanelState } from '@/features/hollowing';

function formatElapsedLabel(
  translate: (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string,
  elapsed: string,
): string {
  return translate(msg`Elapsed: ${elapsed}`);
}

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
  pendingDestructiveTransform: { modelIds: string[]; modelName: string; supportCount: number; operationLabel: string; } | null;
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
  const { _ } = useLingui();
  // A blocking progress overlay: swallow Escape rather than let it through.
  useEscapeToClose(showModifierApplyBlockingOverlay, undefined);

  // Two of the three reset actions undo hollowing; only `hole_punch` is about
  // holes alone, so the confirmation reads off that rather than one action.
  const isHollowingReset = pendingModifierResetAction === 'hollowing'
    || pendingModifierResetAction === 'clear_hollowing';

  return (
    <>
      <StructuredDialogModal
        open={showUnappliedHolePunchModal}
        ariaLabel={_(msg`Unapplied model changes`)}
        title={unappliedModifierPrompt.title}
        subtitle={unappliedModifierPrompt.subtitle}
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel={_(msg`Close`)}
        onClose={() => unappliedHolePunchResolveRef.current?.('skip')}
        actions={(
          <>
            <Button
              variant="secondary"
              onClick={() => unappliedHolePunchResolveRef.current?.('skip')}
            >
              <Trans>Continue Without</Trans>
            </Button>
            <Button
              variant="tinted-accent"
              className="inline-flex items-center justify-center gap-1.5"
              onClick={() => unappliedHolePunchResolveRef.current?.('goto')}
            >
              <Trans>Go to Hollow Tool</Trans>
            </Button>
            {unappliedModifierPrompt.showApplyAll && (
              <Button
                variant="tinted-accent"
                className="inline-flex items-center justify-center gap-1.5"
                onClick={() => unappliedHolePunchResolveRef.current?.('apply')}
              >
                <Trans>Apply to All</Trans>
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
        ariaLabel={_(msg`Confirm modifier reset`)}
        title={isHollowingReset ? _(msg`Remove Hollowing?`) : _(msg`Remove All Holes?`)}
        subtitle={_(msg`This action can't be undone`)}
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel={_(msg`Close reset confirmation`)}
        onClose={() => setPendingModifierResetAction(null)}
        actions={(
          <>
            <Button
              variant="secondary"
              onClick={() => setPendingModifierResetAction(null)}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="tinted-danger"
              className="inline-flex items-center justify-center gap-1.5"
              onClick={handleConfirmModifierReset}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {isHollowingReset ? _(msg`Remove Hollowing`) : _(msg`Remove All Holes`)}
            </Button>
          </>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {isHollowingReset
              ? _(msg`Are you sure you want to remove hollowing from this model?`)
              : _(msg`Are you sure you want to remove all hole punches from this model?`)}
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {pendingModifierResetAction === 'clear_hollowing'
              ? _(msg`The cavity and all holes will be removed.`)
              : pendingModifierResetAction === 'hollowing'
                ? _(msg`Your model will return to its solid version.`)
                : _(msg`All holes on this model will be removed.`)}
          </p>
        </div>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={pendingBlockerResetState !== null}
        ariaLabel={_(msg`Confirm solid area reset`)}
        title={_(msg`Reset Solid Areas?`)}
        subtitle={_(msg`Solid areas will be lost`)}
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel={_(msg`Close solid area reset confirmation`)}
        onClose={() => setPendingBlockerResetState(null)}
        actions={(
          <>
            <Button
              variant="secondary"
              onClick={() => setPendingBlockerResetState(null)}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="tinted-danger"
              className="inline-flex items-center justify-center gap-1.5"
              onClick={handleConfirmBlockerReset}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <Trans>Reset Solid Areas</Trans>
            </Button>
          </>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <Trans>Changing the voxel resolution or shell thickness will clear all solid areas.</Trans>
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <Trans>You will need to mark them again after the change.</Trans>
          </p>
        </div>
      </StructuredDialogModal>

      <DestructiveTransformModal
        isOpen={pendingDestructiveTransform !== null}
        modelName={pendingDestructiveTransform?.modelName ?? null}
        supportCount={pendingDestructiveTransform?.supportCount ?? 0}
        operationLabel={pendingDestructiveTransform?.operationLabel ?? _(msg`Transform`)}
        onCancel={handleCancelDestructiveTransform}
        onConfirm={handleConfirmDestructiveTransform}
      />

      {showModifierApplyBlockingOverlay && (
        <BlockingOverlay
          zIndexClassName="z-[121]"
          title={modifierApplyOverlayContent.title}
          details={modifierApplyOverlayContent.detailLines}
          elapsed={formatElapsedLabel(_, modifierApplyOverlayElapsedLabel)}
          footnote={modifierApplyProcessingLabel}
          progress={null}
          progressLabel={modifierApplyOverlayContent.title}
        />
      )}
    </>
  );
}
