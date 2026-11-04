'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Palette } from 'lucide-react';
import { Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

export type SceneMaterialReassignOption = {
  id: string;
  name: string;
  color?: string;
};

export type SceneMaterialReassignRow = {
  id: string;
  name: string;
  color?: string;
};

type SceneMaterialTankRow = SceneMaterialReassignRow & { tankNumber: number };

type SceneMaterialReassignModalProps = {
  open: boolean;
  previousPrinterName: string;
  newPrinterName: string;
  mode?: 'reassign' | 'tankMatch';
  canReassign: boolean;
  rows: SceneMaterialReassignRow[];
  options: SceneMaterialReassignOption[];
  tankRows?: SceneMaterialTankRow[];
  canAssignTanks?: boolean;
  onApply: (mapping: Map<string, SceneMaterialReassignOption>) => void;
  onUnassign: () => void;
  onAssignTanks?: () => void;
  onKeepPrevious: () => void;
  onDismiss: () => void;
};

/**
 * Shown when the selected printer changes and the scene already names materials
 * from the old one. The new printer's tank materials are the only valid targets;
 * with none assigned, unassigning is the only safe outcome.
 */
export function SceneMaterialReassignModal({
  open,
  previousPrinterName,
  newPrinterName,
  mode = 'reassign',
  canReassign,
  rows,
  options,
  tankRows = [],
  canAssignTanks = false,
  onApply,
  onUnassign,
  onAssignTanks,
  onKeepPrevious,
  onDismiss,
}: SceneMaterialReassignModalProps) {
  const { _ } = useLingui();
  const isTankMatch = mode === 'tankMatch';
  const [mapping, setMapping] = React.useState<Record<string, string>>(() => (
    Object.fromEntries(rows.map((row) => [row.id, options[0]?.id ?? '']))
  ));

  React.useEffect(() => {
    if (!open) return;
    setMapping(Object.fromEntries(rows.map((row) => [row.id, options[0]?.id ?? ''])));
  }, [open, options, rows]);

  const handleApply = React.useCallback(() => {
    const next = new Map<string, SceneMaterialReassignOption>();
    rows.forEach((row) => {
      const selected = options.find((option) => option.id === mapping[row.id]);
      if (selected) next.set(row.id, selected);
    });
    onApply(next);
  }, [mapping, onApply, options, rows]);

  return (
    <StructuredDialogModal
      open={open}
      ariaLabel={_(isTankMatch ? msg`Assign scene materials to tanks` : msg`Reassign scene materials`)}
      title={_(isTankMatch ? msg`Assign scene materials to tanks` : msg`Reassign scene materials`)}
      subtitle={_(isTankMatch
        ? msg`The new printer shares these materials but its tanks are not assigned`
        : msg`The new printer has different material profiles`)}
      icon={<Palette className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[130]"
      maxWidthClassName="max-w-xl"
      closeAriaLabel={_(msg`Close material reassignment`)}
      onClose={onDismiss}
      onBackdropClick={onDismiss}
      actions={
        <>
          <Button variant="secondary" onClick={onKeepPrevious}>
            <Trans>Keep {previousPrinterName}</Trans>
          </Button>
          {!(isTankMatch && canAssignTanks) && (
            <Button variant="secondary" onClick={onUnassign}>
              <Trans>Unassign scene materials</Trans>
            </Button>
          )}
          {canReassign && (
            <Button variant="tinted-accent" onClick={handleApply}>
              <Trans>Reassign materials</Trans>
            </Button>
          )}
          {isTankMatch && canAssignTanks && (
            <Button variant="tinted-accent" onClick={() => onAssignTanks?.()}>
              <Trans>Assign to matching tanks</Trans>
            </Button>
          )}
        </>
      }
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {isTankMatch ? (
          <Trans>
            These scene materials are available on{' '}
            <strong style={{ color: 'var(--text-strong)' }}>{newPrinterName}</strong>, but its tanks
            are not assigned to them. Assign each material to the tank it occupied on{' '}
            <strong style={{ color: 'var(--text-strong)' }}>{previousPrinterName}</strong>, or keep
            the previous printer.
          </Trans>
        ) : (
          <Trans>
            This scene names materials from{' '}
            <strong style={{ color: 'var(--text-strong)' }}>{previousPrinterName}</strong>. Choose
            which materials on <strong style={{ color: 'var(--text-strong)' }}>{newPrinterName}</strong>{' '}
            the scene should use.
          </Trans>
        )}
      </p>

      {isTankMatch ? (
        <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-subtle)' }}>
          <table className="w-full border-collapse text-left text-xs">
            <thead style={{ background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
              <tr>
                <th scope="col" className="p-2 font-medium"><Trans>Scene material</Trans></th>
                <th scope="col" className="p-2 font-medium"><Trans>Tank</Trans></th>
              </tr>
            </thead>
            <tbody>
              {tankRows.map((row) => (
                <tr key={row.id} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <th scope="row" className="p-2 font-normal">
                    <span className="inline-flex items-center gap-1.5">
                      {row.color && (
                        <span
                          className="h-3 w-3 rounded-[3px]"
                          style={{ background: row.color, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3)' }}
                          aria-hidden="true"
                        />
                      )}
                      {row.name}
                    </span>
                  </th>
                  <td className="p-2"><Trans>Tank {row.tankNumber}</Trans></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : canReassign ? (
        <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-subtle)' }}>
          <table className="w-full border-collapse text-left text-xs">
            <thead style={{ background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
              <tr>
                <th scope="col" className="p-2 font-medium"><Trans>Scene material</Trans></th>
                <th scope="col" className="p-2 font-medium"><Trans>Use on this printer</Trans></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <th scope="row" className="p-2 font-normal">
                    <span className="inline-flex items-center gap-1.5">
                      {row.color && (
                        <span
                          className="h-3 w-3 rounded-[3px]"
                          style={{ background: row.color, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3)' }}
                          aria-hidden="true"
                        />
                      )}
                      {row.name}
                    </span>
                  </th>
                  <td className="p-2">
                    <select
                      className="ui-input h-[32px] w-full px-2 text-xs"
                      aria-label={row.name}
                      value={mapping[row.id] ?? ''}
                      onChange={(event) => {
                        setMapping((prev) => ({ ...prev, [row.id]: event.target.value }));
                      }}
                    >
                      {options.map((option) => (
                        <option key={option.id} value={option.id}>{option.name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <Trans>
            The new printer has no materials assigned to its tanks. Unassign the scene materials,
            or keep the previous printer to preserve them.
          </Trans>
        </p>
      )}
    </StructuredDialogModal>
  );
}
