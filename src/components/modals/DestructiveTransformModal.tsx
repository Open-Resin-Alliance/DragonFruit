import React from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

type DestructiveTransformModalProps = {
  isOpen: boolean;
  modelName: string | null;
  supportCount: number;
  operationLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DestructiveTransformModal({
  isOpen,
  modelName,
  supportCount,
  operationLabel,
  onCancel,
  onConfirm,
}: DestructiveTransformModalProps) {
  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel="Destructive transform warning"
      title="Destructive Transform"
      subtitle="Supports will be deleted before continuing"
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[130]"
      closeAriaLabel="Close warning modal"
      onClose={onCancel}
      onBackdropClick={onCancel}
      bodyClassName="p-4 space-y-3"
      actionsClassName="grid grid-cols-2 gap-2 pt-1"
      actions={(
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="tinted-danger"
            className="inline-flex items-center justify-center gap-1.5"
            onClick={onConfirm}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete & Continue
          </Button>
        </>
      )}
    >
      <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Operation</div>
        <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{operationLabel}</div>
      </div>

      <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Model</div>
        <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{modelName ?? 'Unknown Model'}</div>
      </div>

      <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Supports Detected</div>
        <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>
          {supportCount.toLocaleString()}
        </div>
      </div>

      <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        This transform invalidates existing supports. If you continue, all supports for this model will be deleted.
      </p>
    </StructuredDialogModal>
  );
}
