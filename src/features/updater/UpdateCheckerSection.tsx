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
  RotateCcw,
} from 'lucide-react';
import { useUpdateChecker } from '@/features/updater/useUpdateChecker';
import type { UpdateState } from '@/features/updater/useUpdateChecker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    <button
      type="button"
      onClick={onCheck}
      className="w-full rounded-lg border px-3 py-2.5 text-left transition-all duration-150 hover:brightness-110"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'color-mix(in srgb, var(--surface-1), transparent 8%)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-2)',
          }}
        >
          <CloudDownload className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Check for Updates
          </span>
          <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
            See if a newer version of DragonFruit is available
          </span>
        </span>
      </div>
    </button>
  );
}

function CheckingState() {
  return (
    <div
      className="w-full rounded-lg border px-3 py-2.5"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'color-mix(in srgb, var(--surface-1), transparent 8%)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-2)',
          }}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--accent)' }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Checking for updates…
          </span>
          <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Querying GitHub releases
          </span>
        </span>
      </div>
    </div>
  );
}

function UpToDateState({ onCheck }: { onCheck: () => void }) {
  return (
    <div
      className="w-full rounded-lg border px-3 py-2.5"
      style={{
        borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 50%)',
        background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 92%)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 38%)',
            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 85%)',
          }}
        >
          <Check className="h-3.5 w-3.5" style={{ color: 'var(--accent-secondary)' }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Up To Date!
          </span>
          <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
            You're running the latest version of DragonFruit.
          </span>
        </span>
        <button
          type="button"
          onClick={onCheck}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-all duration-150"
          style={{
            color: 'var(--text-muted)',
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-2)',
          }}
        >
          <RotateCcw className="h-3 w-3" />
          Check Again
        </button>
      </div>
    </div>
  );
}

function AvailableState({
  state: s,
  onDownload,
  onDismiss,
}: {
  state: UpdateState & { status: 'available' };
  onDownload: () => void;
  onDismiss: () => void;
}) {
  const info = s.info;

  return (
    <div
      className="w-full rounded-lg border overflow-hidden"
      style={{
        borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 90%)',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 82%)',
          }}
        >
          <Download className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Update Available
          </span>
          <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
            DragonFruit v{info.version} is available (you have v{info.currentVersion})
          </span>
        </span>
      </div>

      {/* Release notes */}
      {info.body && (
        <div
          className="mx-3 mb-2 max-h-28 overflow-y-auto custom-scrollbar rounded-md border px-2.5 py-2 text-[11px] leading-relaxed"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-1), transparent 30%)',
            color: 'var(--text-muted)',
          }}
        >
          <div className="prose prose-invert prose-sm max-h-none text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <ReactMarkdown>{info.body}</ReactMarkdown>
          </div>
        </div>
      )}

      {/* Actions — single "Download & Install" button using the plugin */}
      <div className="flex items-center gap-2 px-3 pb-2.5">
        <button
          type="button"
          onClick={onDownload}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-all duration-150"
          style={{
            color: 'var(--accent-contrast)',
            borderColor: 'color-mix(in srgb, var(--accent), white 18%)',
            background: 'color-mix(in srgb, var(--accent), transparent 12%)',
          }}
        >
          <Download className="h-3.5 w-3.5" />
          Download &amp; Install
        </button>

        <a
          href={`https://github.com/Open-Resin-Alliance/DragonFruit/releases/tag/v${info.version}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] transition-all duration-150"
          style={{
            color: 'var(--text-muted)',
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-2)',
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </a>

        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-all duration-150"
          style={{
            color: 'var(--text-muted)',
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-2)',
          }}
        >
          Dismiss
        </button>
      </div>
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
    <div
      className="w-full rounded-lg border px-3 py-2.5"
      style={{
        borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 90%)',
      }}
    >
      <div className="flex items-center gap-2.5 mb-2">
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 82%)',
          }}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--accent)' }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Downloading Update
          </span>
          <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {formatBytes(downloaded)} / {formatBytes(contentLength)} ({pct}%)
          </span>
        </span>
      </div>
      <ProgressBar pct={parseFloat(pct)} />
    </div>
  );
}

function InstallingState() {
  return (
    <div
      className="w-full rounded-lg border px-3 py-2.5"
      style={{
        borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 90%)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 82%)',
          }}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--accent)' }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Installing Update…
          </span>
          <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
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
      className="w-full rounded-lg border px-3 py-2.5"
      style={{
        borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 50%)',
        background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 92%)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 38%)',
            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 85%)',
          }}
        >
          <CloudOff className="h-3.5 w-3.5" style={{ color: 'var(--accent-secondary)' }} />
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

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="w-full rounded-lg border px-3 py-2.5"
      style={{
        borderColor: 'color-mix(in srgb, #b91c1c, var(--border-subtle) 50%)',
        background: 'color-mix(in srgb, #b91c1c, var(--surface-0) 92%)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
          style={{
            borderColor: 'color-mix(in srgb, #b91c1c, var(--border-subtle) 38%)',
            background: 'color-mix(in srgb, #b91c1c, var(--surface-1) 85%)',
          }}
        >
          <CloudOff className="h-3.5 w-3.5" style={{ color: '#ef4444' }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Update Failed
          </span>
          <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
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
  } = useUpdateChecker();

  return (
    <div className={className}>
      {state.status === 'idle' && <IdleState onCheck={checkForUpdates} />}
      {state.status === 'checking' && <CheckingState />}
      {state.status === 'up-to-date' && <UpToDateState onCheck={checkForUpdates} />}
      {state.status === 'available' && (
        <AvailableState state={state} onDownload={downloadAndInstall} onDismiss={dismiss} />
      )}
      {state.status === 'downloading' && <DownloadingState state={state} />}
      {state.status === 'installing' && <InstallingState />}
      {state.status === 'installed' && <InstalledState />}
      {state.status === 'error' && (
        <ErrorState message={state.message} onRetry={checkForUpdates} />
      )}
    </div>
  );
}
