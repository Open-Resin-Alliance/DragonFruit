'use client';

import React, { useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Check,
  CloudDownload,
  CloudOff,
  Download,
  ExternalLink,
  Loader2,
  Package,
  RotateCcw,
} from 'lucide-react';
import { FLATPAK_APP_ID, LINUX_RELEASES_URL } from '@/features/updater/updateBridge';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useUpdateChecker } from '@/features/updater/useUpdateChecker';
import type { UpdateState } from '@/features/updater/useUpdateChecker';
import { isAllowSameVersionEnabled, enableAllowSameVersionForSession } from '@/features/updater/debugForceSession';

// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function openExternal(url: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_external_url', { url });
  } catch {
    window.open(url, '_blank');
  }
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div
      className="w-full h-1.5 rounded-full overflow-hidden"
      style={{ background: 'color-mix(in srgb, var(--surface-2), transparent 20%)' }}
    >
      <div
        className="h-full rounded-full transition-all duration-200 ease-out"
        style={{
          width: `${Math.min(pct, 100)}%`,
          background: 'linear-gradient(90deg, var(--accent), var(--accent-secondary))',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// State renderers
// ---------------------------------------------------------------------------

function IdleState({ onCheck }: { onCheck: () => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={onCheck}
        className="ui-button ui-button-secondary !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Check for Updates
      </button>
      <button
        type="button"
        disabled
        className="ui-button ui-button-secondary !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5 opacity-50 cursor-not-allowed"
        title="No update available"
      >
        <Download className="h-3.5 w-3.5" />
        Install
      </button>
    </div>
  );
}

function CheckingState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 82%)',
            color: 'var(--accent)',
          }}
        >
          <Loader2 className="h-6 w-6 animate-spin" />
        </span>
        <span className="min-w-0">
          <span className="block text-lg font-bold" style={{ color: 'var(--text-strong)' }}>
            Checking for Updates…
          </span>
          <span className="block text-sm mt-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>
            Querying GitHub releases
          </span>
        </span>
      </div>
    </div>
  );
}

function UpToDateState({ onCheck }: { onCheck: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 py-16">
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 40%)',
            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 82%)',
            color: 'var(--accent-secondary)',
          }}
        >
          <Check className="h-6 w-6" />
        </span>
        <span className="min-w-0">
          <span className="block text-lg font-bold" style={{ color: 'var(--accent-secondary)' }}>
            Up to date
          </span>
          <span className="block text-sm mt-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>
            You’re on the latest version
          </span>
        </span>
      </div>
      <button
        type="button"
        onClick={onCheck}
        className="ui-button ui-button-secondary !h-10 px-8 text-sm inline-flex items-center justify-center gap-1.5"
      >
        <RotateCcw className="h-4 w-4" />
        Check Again
      </button>
    </div>
  );
}

function AvailableState({
  state: s,
  onDownload,
  onCheck,
}: {
  state: UpdateState & { status: 'available' };
  onDownload: () => void;
  onCheck: () => void;
}) {
  const info = s.info;
  const [showWarning, setShowWarning] = React.useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-2">
      <div className="flex flex-col items-center gap-2.5 text-center">
        <span
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 40%)',
            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 82%)',
            color: 'var(--accent-secondary)',
          }}
        >
          <Download className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-base font-bold" style={{ color: 'var(--accent-secondary)' }}>
            Update Available
          </span>
          <span className="block text-xs mt-1 font-medium" style={{ color: 'var(--text-muted)' }}>
            {info.version === info.currentVersion ? (
              <>Version {info.version}</>
            ) : (
              <>Version {info.version} • update ready</>
            )}
          </span>
        </span>
      </div>

      {info.body && (
        <div
          className="flex-1 min-h-0 overflow-y-auto custom-scrollbar rounded-md border px-3 py-3 text-xs leading-relaxed"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-0)',
            color: 'var(--text-muted)',
          }}
        >
          <div className="prose prose-invert max-w-none prose-sm prose-headings:font-semibold prose-headings:text-[13px] prose-headings:text-[var(--text-strong)] prose-h2:text-sm prose-h3:text-xs prose-p:text-xs prose-p:leading-relaxed prose-p:text-[var(--text-muted)] prose-li:text-xs prose-li:leading-relaxed prose-a:text-[var(--accent)] prose-a:underline-offset-2 hover:prose-a:underline prose-strong:text-[var(--text-strong)] prose-code:font-mono prose-code:text-[11px] prose-code:font-medium prose-code:text-[var(--text-strong)] prose-code:bg-[var(--surface-1)] prose-code:border prose-code:border-[var(--border-subtle)] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-pre:bg-[var(--surface-1)] prose-pre:border prose-pre:border-[var(--border-subtle)] prose-pre:p-3 prose-pre:rounded-md prose-pre:overflow-x-auto prose-pre:text-[11px] prose-pre:leading-relaxed prose-pre:prose-code:bg-transparent prose-pre:prose-code:border-0 prose-pre:prose-code:p-0 prose-pre:prose-code:text-[var(--text-muted)] prose-hr:my-2 prose-hr:border-[var(--border-subtle)]" style={{ color: 'var(--text-muted)' }}>
            <ReactMarkdown>{info.body}</ReactMarkdown>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={onCheck}
          className="ui-button ui-button-secondary !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Check for Updates
        </button>
        <button
          type="button"
          onClick={() => {
            void openExternal(`https://github.com/Open-Resin-Alliance/DragonFruit/releases/tag/v${info.version}`);
          }}
          className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)',
            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 86%)',
            color: 'var(--accent-secondary)',
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </button>
        <button
          type="button"
          onClick={() => setShowWarning(true)}
          className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
            color: 'var(--accent)',
          }}
        >
          <Download className="h-3.5 w-3.5" />
          Install
        </button>
      </div>
      <StructuredDialogModal
        open={showWarning}
        ariaLabel="Confirm update and restart"
        title="Update & Restart?"
        subtitle={`Version ${info.version} is ready to install`}
        icon={<Download className="h-4 w-4" />}
        iconTone="warning"
        onClose={() => setShowWarning(false)}
        onBackdropClick={() => setShowWarning(false)}
        actions={
          <>
            <button type="button" onClick={() => setShowWarning(false)} className="ui-button ui-button-secondary !h-9 px-4 text-xs">Cancel</button>
            <button type="button" onClick={async () => { setShowWarning(false); try { await (window as unknown as { __df_flushAutosave?: () => Promise<void> }).__df_flushAutosave?.(); } catch {} try { await new Promise<void>((r) => setTimeout(r, 400)); } catch {} onDownload(); }} className="ui-button !h-9 px-4 text-xs inline-flex items-center justify-center gap-1.5" style={{ borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)', background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)', color: 'var(--accent)' }}>Update & Restart</button>
          </>
        }
      >
        <div className="space-y-3 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <p>
            DragonFruit will <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>download, verify and install</span> the update, then restart automatically.
          </p>
          <p>
            Please <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>save your scene and any unsaved progress</span> before continuing.
          </p>
          <p
            className="pt-3 mt-1 border-t text-sm font-semibold leading-relaxed"
            style={{ borderColor: 'var(--border-subtle)', color: 'color-mix(in srgb, var(--danger), white 32%)' }}
          >
            Unsaved changes may be lost.
          </p>
        </div>
      </StructuredDialogModal>
    </div>
  );
}

function DownloadingState({
  state: s,
}: {
  state: UpdateState & { status: 'downloading' };
}) {
  const { contentLength, downloaded } = s.progress;
  const pct = contentLength > 0
    ? ((downloaded / contentLength) * 100).toFixed(1)
    : '0.0';

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 82%)',
            color: 'var(--accent)',
          }}
        >
          <Loader2 className="h-6 w-6 animate-spin" />
        </span>
        <span className="min-w-0">
          <span className="block text-lg font-bold" style={{ color: 'var(--text-strong)' }}>
            Downloading Update
          </span>
          <span className="block text-sm mt-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>
            {formatBytes(downloaded)} / {formatBytes(contentLength)} ({pct}%)
          </span>
        </span>
      </div>
      <div className="w-full max-w-sm">
        <ProgressBar pct={parseFloat(pct)} />
      </div>
    </div>
  );
}

function InstallingState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16">
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 82%)',
            color: 'var(--accent)',
          }}
        >
          <Loader2 className="h-6 w-6 animate-spin" />
        </span>
        <span className="min-w-0">
          <span className="block text-lg font-bold" style={{ color: 'var(--text-strong)' }}>
            Installing Update…
          </span>
          <span className="block text-sm mt-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>
            The update is being installed. DragonFruit will restart automatically.
          </span>
        </span>
      </div>
    </div>
  );
}


function InstalledState() {
  return (
    <div
      className="w-full rounded-md border p-2.5"
      style={{
        borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 50%)',
        background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 92%)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 38%)',
            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 85%)',
          }}
        >
          <CloudOff className="h-4 w-4" style={{ color: 'var(--accent-secondary)' }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Update installed. DragonFruit will restart.
          </span>
        </span>
      </div>
    </div>
  );
}

function ExternalState() {
  return (
    <div
      className="w-full rounded-md border p-2.5"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--surface-0)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
          }}
        >
          <Package className="h-4 w-4" style={{ color: 'var(--accent)' }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Managed by Flatpak
          </span>
          <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            DragonFruit for Linux ships as a Flatpak, so updates are installed
            outside the app.
          </span>
        </span>
        <button
          type="button"
          onClick={() => void openExternal(LINUX_RELEASES_URL)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-all duration-150"
          style={{
            color: 'var(--text-muted)',
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-2)',
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Releases
        </button>
      </div>
      <code
        className="mt-2 block rounded-md border px-2 py-1.5 text-[11px]"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'var(--surface-1)',
          color: 'var(--text-muted)',
        }}
      >
        flatpak update {FLATPAK_APP_ID}
      </code>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="w-full rounded-md border p-2.5"
      style={{
        borderColor: 'color-mix(in srgb, #b91c1c, var(--border-subtle) 50%)',
        background: 'color-mix(in srgb, #b91c1c, var(--surface-0) 92%)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
          style={{
            borderColor: 'color-mix(in srgb, #b91c1c, var(--border-subtle) 38%)',
            background: 'color-mix(in srgb, #b91c1c, var(--surface-1) 85%)',
          }}
        >
          <CloudOff className="h-4 w-4" style={{ color: '#ef4444' }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Update Failed
          </span>
          <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {message}
          </span>
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-all duration-150"
          style={{
            color: 'var(--text-muted)',
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-2)',
          }}
        >
          <RotateCcw className="h-3 w-3" />
          Retry
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface UpdateCheckerSectionProps {
  className?: string;
}

export function UpdateCheckerSection({
  className = '',
}: UpdateCheckerSectionProps) {
  const {
    state,
    checkForUpdates,
    downloadAndInstall,
    dismiss,
    channel,
  } = useUpdateChecker();
  const [debugForceAvailable, setDebugForceAvailable] = React.useState<UpdateState | null>(null);

  // Persist session



  // Dev shortcut: just enables allow_same_version for regular logic until reload
  React.useEffect(() => {
    const handleKeyDown = async (e: CustomEvent) => {
      console.log('[updater] checker hotkey raw', (e as CustomEvent).detail);
      const detail = e.detail as unknown;
      if (!detail || typeof detail !== 'object' || !('key' in detail) || !('ctrlKey' in detail) || !('shiftKey' in detail)) return;
      const key = (detail as { key: unknown }).key;
      const ctrlKey = (detail as { ctrlKey: unknown }).ctrlKey;
      const shiftKey = (detail as { shiftKey: unknown }).shiftKey;
      if (ctrlKey !== true || shiftKey !== true || typeof key !== 'string' || key.toLowerCase() !== 'u') return;
      enableAllowSameVersionForSession();
      console.log('[updater] debug Ctrl+Shift+U -> allow_same_version enabled for session, channel:', channel);
      try {
        const { fetchUpdateInfo } = await import('@/features/updater/updateBridge');
        const info = await fetchUpdateInfo(channel, true);
        console.log('[updater] debug fetch result:', info);
        if (info) setDebugForceAvailable({ status: 'available', info } as UpdateState);
      } catch {}
    };
    window.addEventListener('app-hotkey-keydown', handleKeyDown as unknown as EventListener);
    return () => window.removeEventListener('app-hotkey-keydown', handleKeyDown as unknown as EventListener);
  }, [channel]);

  // Auto-check when opening Updates tab
  React.useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);
  const effectiveState = debugForceAvailable ?? state;
  const handleDismissDebug = React.useCallback(() => {
    if (debugForceAvailable) setDebugForceAvailable(null);
    dismiss();
  }, [debugForceAvailable, dismiss]);
  const handleForceInstall = React.useCallback(async () => {
    if (debugForceAvailable?.status === 'available') return;
    enableAllowSameVersionForSession();
    console.log('[updater] Install in Up to date clicked, fetching allowSameVersion=true, channel:', channel);
    try {
      const { fetchUpdateInfo } = await import('@/features/updater/updateBridge');
      const info = await fetchUpdateInfo(channel, true);
      console.log('[updater] forceInstall fetch result:', info);
      if (info) {
        setDebugForceAvailable({ status: 'available', info } as UpdateState);
        return;
      }
    } catch {
      // ignore
    }
  }, [channel, debugForceAvailable]);

  return (
    <div className={className}>
      {effectiveState.status === 'external' && <ExternalState />}
      {effectiveState.status === 'idle' && <IdleState onCheck={checkForUpdates} />}
      {effectiveState.status === 'checking' && <CheckingState />}
      {effectiveState.status === 'up-to-date' && (
        <UpToDateState onCheck={checkForUpdates} />
      )}
      {effectiveState.status === 'available' && (
        <AvailableState
          state={effectiveState as UpdateState & { status: 'available' }}
          onDownload={downloadAndInstall}
          onCheck={checkForUpdates}
        />
      )}
      {effectiveState.status === 'downloading' && <DownloadingState state={effectiveState as UpdateState & { status: 'downloading' }} />}
      {effectiveState.status === 'installing' && <InstallingState />}
      {effectiveState.status === 'installed' && <InstalledState />}
      {effectiveState.status === 'error' && (
        <ErrorState message={(effectiveState as UpdateState & { status: 'error' }).message} onRetry={checkForUpdates} />
      )}
    </div>
  );
}
