'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CloudDownload, Download, Loader2, RotateCcw, ScrollText, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { fetchUpdateInfo, downloadAndInstall, getUpdateChannel, type UpdateInfo, type DownloadProgress, type UpdateChannel } from '@/features/updater/updateBridge';
import { dispatchOpenSettingsAbout } from '@/features/updater/updateNotificationEvents';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IndicatorState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; info: UpdateInfo }
  | { status: 'downloading'; pct: number }
  | { status: 'error' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STARTUP_CHECK_DELAY_MS = 5_000;
const RE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STORAGE_KEY_SUPPRESSED = 'dragonfruit-update-suppressed-version';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Silently checks for updates on startup and periodically. When an update
 * is found, opens a structured modal showing version info, release notes,
 * and a download & install flow.
 *
 * Dev shortcut: Ctrl+Shift+U triggers a fake update for testing.
 */
export function GlobalUpdateIndicator() {
  const [state, setState] = useState<IndicatorState>({ status: 'idle' });
  const [showReleaseNotesModal, setShowReleaseNotesModal] = useState(false);

  // ── Silent background check ──────────────────────────────────────────
  useEffect(() => {
    let channel: UpdateChannel = 'stable';

    const runCheck = () => {
      setState({ status: 'checking' });

      fetchUpdateInfo(channel)
        .then((info) => {
          if (info) {
            const suppressed = (() => {
              try {
                return window.localStorage.getItem(STORAGE_KEY_SUPPRESSED);
              } catch {
                return null;
              }
            })();

            if (suppressed !== info.version) {
              setState({ status: 'available', info });
              return;
            }
          }
          setState({ status: 'idle' });
        })
        .catch(() => {
          setState({ status: 'idle' });
        });
    };

    // Load the saved channel first, then schedule the startup check.
    getUpdateChannel().then((c) => {
      channel = c;
      startupTimer = setTimeout(runCheck, STARTUP_CHECK_DELAY_MS);
    });

    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const interval = setInterval(runCheck, RE_CHECK_INTERVAL_MS);

    return () => {
      clearTimeout(startupTimer);
      clearInterval(interval);
    };
  }, []);

  // ── Dev shortcut: Ctrl+Shift+U ──────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: CustomEvent) => {
      const { key, ctrlKey, shiftKey } = e.detail;
      if (ctrlKey && shiftKey && key.toLowerCase() === 'u') {
        setState({
          status: 'available',
          info: {
            version: '9.9.9',
            currentVersion: '0.1.7',
            body: '## Dev fake release\n\nThis is a fake update triggered via Ctrl+Shift+U for testing the update notification UI.\n\n- Test item 1\n- Test item 2',
            date: new Date().toISOString(),
          },
        });
      }
    };
    window.addEventListener('app-hotkey-keydown', handleKeyDown as EventListener);
    return () => window.removeEventListener('app-hotkey-keydown', handleKeyDown as EventListener);
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────
  const handleDownloadAndInstall = useCallback(async () => {
    if (state.status !== 'available') return;
    setState({ status: 'downloading', pct: 0 });

    const success = await downloadAndInstall((progress: DownloadProgress) => {
      const pct =
        progress.contentLength > 0
          ? Math.round((progress.downloaded / progress.contentLength) * 100)
          : 0;
      setState({ status: 'downloading', pct });
    });

    if (!success) {
      setState({ status: 'error' });
    }
    // On success the app relaunches.
  }, [state.status]);

  const handleDismiss = useCallback(() => {
    if (state.status !== 'available') return;
    try {
      window.localStorage.setItem(STORAGE_KEY_SUPPRESSED, state.info.version);
    } catch {
      // ignore
    }
    setState({ status: 'idle' });
  }, [state]);

  const handleClose = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  // ── Render ──────────────────────────────────────────────────────────
  const isModalOpen = state.status === 'available'
    || state.status === 'downloading'
    || state.status === 'error';

  if (!isModalOpen) return null;

  const info = state.status === 'available' ? state.info : null;
  const isDownloading = state.status === 'downloading';
  const isError = state.status === 'error';

  const subtitle = info?.date
    ? `Released ${new Date(info.date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`
    : undefined;

  return (    <>    <StructuredDialogModal
      open={isModalOpen}
      ariaLabel="Update available"
      title={isDownloading
        ? 'Downloading Update'
        : isError
          ? 'Update Failed'
          : `Update Available — v${info?.version ?? '?'}`}
      subtitle={subtitle}
      icon={isDownloading
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : <CloudDownload className="h-4 w-4" />}
      iconTone="accent"
      zIndexClassName="z-[130]"
      maxWidthClassName="max-w-lg"
      closeAriaLabel="Close update dialog"
      onClose={isDownloading ? undefined : handleClose}
      onBackdropClick={isDownloading ? undefined : handleClose}
      actions={isError ? (
        <>
          <button
            type="button"
            onClick={handleClose}
            className="ui-button ui-button-secondary !h-9 px-3 text-sm"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="ui-button ui-button-accent !h-9 px-3 text-sm inline-flex items-center gap-1.5"
          >
            <RotateCcw className="w-4 h-4" />
            Try Again
          </button>
        </>
      ) : isDownloading ? (
        <>
          <button
            type="button"
            disabled
            className="ui-button ui-button-accent !h-9 px-3 text-sm inline-flex items-center gap-1.5 opacity-60"
          >
            <Loader2 className="w-4 h-4 animate-spin" />
            Downloading… {state.status === 'downloading' ? `${state.pct}%` : ''}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={handleDismiss}
            className="ui-button ui-button-secondary !h-9 px-3 text-sm"
          >
            Remind Me Later
          </button>
          <button
            type="button"
            onClick={handleDownloadAndInstall}
            className="ui-button ui-button-accent !h-9 px-3 text-sm inline-flex items-center gap-1.5"
          >
            <Download className="w-4 h-4" />
            Download &amp; Install
          </button>
        </>
      )}
    >
      {isError && (
        <div
          className="rounded-md border px-2.5 py-2 text-[11px] leading-snug"
          style={{
            borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 45%)',
            background: 'color-mix(in srgb, var(--danger), var(--surface-1) 92%)',
            color: 'var(--danger)',
          }}
        >
          The update download or install failed. Please check your connection and try again.
        </div>
      )}

      {isDownloading && (
        <div className="space-y-2">
          <div
            className="w-full h-2 rounded-full overflow-hidden"
            style={{ background: 'color-mix(in srgb, var(--surface-2), transparent 20%)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-200 ease-out"
              style={{
                width: `${Math.min(state.pct, 100)}%`,
                background: 'linear-gradient(90deg, var(--accent), var(--accent-secondary))',
              }}
            />
          </div>
          <div className="text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {state.pct}% — Downloading update, please wait…
          </div>
        </div>
      )}

      {info && !isDownloading && !isError && (
        <div className="space-y-3">
          {/* Version info */}
          <div className="flex items-center gap-3">
            <div
              className="rounded-lg border px-3 py-2 flex-1"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
            >
              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Current Version
              </div>
              <div className="text-sm font-semibold mt-0.5" style={{ color: 'var(--text-strong)' }}>
                v{info.currentVersion}
              </div>
            </div>
            <div className="text-lg" style={{ color: 'var(--text-muted)' }}>→</div>
            <div
              className="rounded-lg border px-3 py-2 flex-1"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)',
              }}
            >
              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--accent)' }}>
                New Version
              </div>
              <div className="text-sm font-semibold mt-0.5" style={{ color: 'var(--accent)' }}>
                v{info.version}
              </div>
            </div>
          </div>

          {/* Release notes — opens a popup */}
          {info.body && (
            <button
              type="button"
              onClick={() => setShowReleaseNotesModal(true)}
              className="w-full rounded-lg border px-3 py-2 text-left transition-all duration-150 hover:brightness-110"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'color-mix(in srgb, var(--surface-1), transparent 8%)',
              }}
            >
              <div className="flex items-center gap-2">
                <ScrollText className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
                  Show Release Notes
                </span>
              </div>
            </button>
          )}

        </div>
      )}
    </StructuredDialogModal>

      {/* ── Release notes popup ── */}
      {showReleaseNotesModal && info?.body && (
        <div
          className="fixed inset-0 z-[160] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowReleaseNotesModal(false);
          }}
        >
          <div
            className="w-full max-w-xl max-h-[80vh] flex flex-col overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
          >
            {/* Header — matching StructuredDialogModal */}
            <div
              className="flex items-center justify-between gap-4 border-b px-5 py-4 shrink-0"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%)',
                    color: 'var(--accent-secondary)',
                  }}
                >
                  <ScrollText className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                    Release Notes — v{info.version}
                  </h3>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowReleaseNotesModal(false)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors hover:brightness-110"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'color-mix(in srgb, var(--surface-1), transparent 6%)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close release notes"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body — scrollable */}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-5 space-y-4">
              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                }}
              >
                <div
                  className="text-[13px] leading-relaxed prose prose-invert prose-sm max-w-none"
                  style={{ color: 'var(--text-strong)' }}
                >
                  <ReactMarkdown>{info.body}</ReactMarkdown>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
