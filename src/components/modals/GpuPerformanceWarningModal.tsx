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
          Windows is rendering DragonFruit on an integrated or software GPU. If this computer also
          has a discrete graphics card, Windows may not be using it — the viewport can feel much
          slower than it should.
        </Trans>
      </p>

      <div
        className="rounded-lg border p-3.5"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        <p
          className="text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: 'var(--text-muted)' }}
        >
          <Trans>Use the faster GPU</Trans>
        </p>
        <ol
          className="mt-2 list-decimal space-y-1.5 pl-4 text-sm leading-relaxed"
          style={{ color: 'var(--text-muted)' }}
        >
          <li>
            <Trans>
              Open <strong>Settings → System → Display → Graphics</strong>.
            </Trans>
          </li>
          <li>
            <Trans>
              Add <code>msedgewebview2.exe</code> as a <strong>Desktop app</strong>.
            </Trans>
          </li>
          <li>
            <Trans>
              Set it to <strong>High performance</strong>, then restart DragonFruit.
            </Trans>
          </li>
        </ol>
        <p className="mt-2 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
          <Trans>This setting applies to every app that uses WebView2.</Trans>
        </p>
      </div>

      {renderer ? (
        <div
          className="rounded-md border px-3 py-2"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
        >
          <div
            className="text-[10px] font-semibold uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            <Trans>Detected renderer</Trans>
          </div>
          <div
            className="mt-0.5 font-mono text-[11px] leading-snug break-words"
            style={{ color: 'var(--text-strong)' }}
          >
            {renderer}
          </div>
        </div>
      ) : null}
    </StructuredDialogModal>
  );
}
