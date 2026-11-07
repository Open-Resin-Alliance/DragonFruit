'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { classifyGpuRenderer, isWindowsWebview, readGpuRendererName } from '@/utils/gpuRenderer';

/** Persisted only when the user asks not to see this again. */
const DISMISS_KEY = 'df.gpu-performance-warning.v1.dismissed';

/**
 * Warns when the webview is rendering on an integrated or software GPU.
 *
 * Windows can keep WebView2's GPU process on the integrated adapter even when a
 * discrete one exists. The `--force_high_performance_gpu` switch in
 * `tauri.conf.json` is the first line of defence; this dialog covers machines
 * whose WebView2 runtime predates the switch, or whose driver still chooses the
 * integrated adapter.
 */
export function GpuPerformanceWarningModal() {
  const { _ } = useLingui();
  const [open, setOpen] = React.useState(false);
  const [renderer, setRenderer] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isWindowsWebview()) return;

    try {
      if (window.localStorage.getItem(DISMISS_KEY) === '1') return;
    } catch {
      // Storage can be unavailable; showing the warning is still correct.
    }

    const name = readGpuRendererName();
    if (!name) return;

    const kind = classifyGpuRenderer(name);
    if (kind !== 'integrated' && kind !== 'software') return;

    setRenderer(name);
    setOpen(true);
  }, []);

  const dismiss = React.useCallback(() => setOpen(false), []);

  const dismissForever = React.useCallback(() => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Ignore storage failures; the dialog still closes for this session.
    }
    setOpen(false);
  }, []);

  return (
    <StructuredDialogModal
      open={open}
      ariaLabel={_(msg`Graphics performance warning`)}
      title={_(msg`Graphics performance warning`)}
      subtitle={_(msg`DragonFruit may run slowly`)}
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[130]"
      onClose={dismiss}
      onBackdropClick={dismiss}
      actions={(
        <>
          <Button variant="secondary" onClick={dismissForever}>
            <Trans>Don&apos;t show again</Trans>
          </Button>
          <Button variant="tinted-accent" onClick={dismiss}>
            <Trans>Got it</Trans>
          </Button>
        </>
      )}
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans>
          DragonFruit is rendering on an integrated or software GPU. If this computer also has a
          discrete graphics card, Windows may not be using it, and the viewport can feel much
          slower than it should.
        </Trans>
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans>
          To give DragonFruit the faster GPU, open Windows Settings → System → Display → Graphics,
          add <code>msedgewebview2.exe</code>, and set it to High performance. This setting applies
          to every app that uses WebView2.
        </Trans>
      </p>
      {renderer ? (
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <Trans>Detected renderer:</Trans>{' '}
          <span className="font-mono break-all" style={{ color: 'var(--text-strong)' }}>{renderer}</span>
        </p>
      ) : null}
    </StructuredDialogModal>
  );
}
