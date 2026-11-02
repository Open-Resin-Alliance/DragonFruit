'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

type ScenePluginMissingModalProps = {
  /** Set while the prompt is open. */
  prompt: { printerName?: string; pluginName: string } | null;
  onImportGeometry: () => void;
  onManagePlugins: () => void;
};

/**
 * Raised before a scene's meshes are loaded when the printer it names comes from
 * a plugin that is not installed. The plugin owns the printer definition and its
 * material pane, so there is nothing to restore; the choice is geometry alone or
 * install the plugin first.
 */
export function ScenePluginMissingModal({ prompt, onImportGeometry, onManagePlugins }: ScenePluginMissingModalProps) {
  const { _ } = useLingui();
  const printerName = prompt?.printerName?.trim();

  return (
    <StructuredDialogModal
      open={Boolean(prompt)}
      ariaLabel={_(msg`Printer plugin not installed`)}
      title={_(msg`Printer plugin not installed`)}
      subtitle={_(msg`Only the geometry can be imported`)}
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[130]"
      maxWidthClassName="max-w-lg"
      closeAriaLabel={_(msg`Close modal`)}
      onClose={onImportGeometry}
      onBackdropClick={onImportGeometry}
      actions={
        <>
          <Button variant="secondary" onClick={onManagePlugins}>
            <Trans>Manage Plugins</Trans>
          </Button>
          <Button variant="tinted-accent" onClick={onImportGeometry}>
            <Trans>Import Geometry</Trans>
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans>
          This scene was saved for{' '}
          <strong className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>
            {printerName || _(msg`the printer this scene was built for`)}
          </strong>
          , whose printer and material profiles come from the{' '}
          <strong className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>{prompt?.pluginName}</strong>{' '}
          plugin. That plugin is not installed, so those profiles cannot be restored.
        </Trans>
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans>Install the plugin, then reopen the scene, to restore its printer and materials.</Trans>
      </p>
    </StructuredDialogModal>
  );
}
