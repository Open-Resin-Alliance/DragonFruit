'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CloudDownload, Download, Loader2, RotateCcw, ScrollText, X } from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import ReactMarkdown from 'react-markdown';
import { fetchUpdateInfo, downloadAndInstall, getUpdateChannel, updatesAreExternal, type UpdateInfo, type DownloadProgress, type UpdateChannel } from '@/features/updater/updateBridge';
import { openSettingsModal } from '@/components/settings/settingsModalEvents';
import { pushSystemNotification, dismissSystemNotification } from '@/features/notifications/systemNotificationStore';
import { isAllowSameVersionEnabled, enableAllowSameVersionForSession } from '@/features/updater/debugForceSession';
import { formatUpdateProgressPct, formatUpdateReleaseLine, formatUpdateVersionChip } from '@/features/updater/updaterMessages';
// ---------------------------------------------------------------------------

type IndicatorState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; info: UpdateInfo }
  | { status: 'downloading'; pct: number }
  | { status: 'error'; message: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STARTUP_CHECK_DELAY_MS = 5_000;
const RE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STORAGE_KEY_SUPPRESSED = 'dragonfruit-update-suppressed-version';

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
  const { _, i18n } = useLingui();
  const [state, setState] = useState<IndicatorState>({ status: 'idle' });
  const [showReleaseNotesModal, setShowReleaseNotesModal] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  const isSettingsOpen = () => {
    try {
      return !!document.querySelector('div.fixed.inset-0.z-\\[50\\] h2');
    } catch {
      return false;
    }
  };

  const triggerExit = useCallback((after: () => void) => {
    setIsExiting(true);
    window.setTimeout(after, 190);
  }, []);

  // ── Silent background check ──────────────────────────────────────────
  useEffect(() => {
    // Linux installs updates through Flatpak — nothing to check or offer here.
    if (updatesAreExternal()) return;

    let channel: UpdateChannel = 'stable';
    const runCheck = () => {
      const allowSame = isAllowSameVersionEnabled();
      if (allowSame) console.log('[updater] runCheck with allow_same_version=true (session debug)');
      setState({ status: 'checking' });

      fetchUpdateInfo(channel, allowSame)
        .then(async (info) => {
          if (info && !info.body) {
            try {
              const ghRes = await fetch(`https://api.github.com/repos/Open-Resin-Alliance/DragonFruit/releases/tags/v${info.version}`);
              if (ghRes.ok) {
                const gh = await ghRes.json() as { body?: string; published_at?: string };
                if (gh.body) info.body = gh.body as string;
                if (gh.published_at && !info.date) info.date = gh.published_at as string;
              }
            } catch {}
          }
          if (info) {
            const suppressed = (() => {
              try {
                return window.localStorage.getItem(STORAGE_KEY_SUPPRESSED);
              } catch {
                return null;
              }
            })();

            if (suppressed !== info.version) {
              if (isSettingsOpen()) return;
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

    // Load the saved channel first, then schedule checks.
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;

    getUpdateChannel().then((c) => {
      channel = c;
      startupTimer = setTimeout(runCheck, STARTUP_CHECK_DELAY_MS);
      interval = setInterval(runCheck, RE_CHECK_INTERVAL_MS);
    });

    return () => {
      clearTimeout(startupTimer);
      clearInterval(interval);
    };
  }, []);

  // ── Dev shortcut: Ctrl+Shift+U ── just enables allow_same_version for regular logic until reload
  useEffect(() => {
    const handleKeyDown = async (e: CustomEvent) => {
      console.log('[updater] hotkey raw', (e as CustomEvent).detail);
      const { key, ctrlKey, shiftKey } = (e.detail as { key: unknown; ctrlKey: unknown; shiftKey: unknown }) as { key: string; ctrlKey: boolean; shiftKey: boolean };
      if (!(ctrlKey && shiftKey && typeof key === 'string' && key.toLowerCase() === 'u')) return;
      enableAllowSameVersionForSession();
      console.log('[updater] Ctrl+Shift+U -> allow_same_version enabled for session, re-checking');
      try {
        const channel = await getUpdateChannel();
        const info = await fetchUpdateInfo(channel, true);
        if (info && !isSettingsOpen()) setState({ status: 'available', info });
      } catch {}
    };
    window.addEventListener('app-hotkey-keydown', handleKeyDown as unknown as EventListener);
    return () => window.removeEventListener('app-hotkey-keydown', handleKeyDown as unknown as EventListener);
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────
  const handleDownloadAndInstall = useCallback(async () => {
    if (state.status !== 'available') return;
    // Force autosave before restart (don't trust user to have saved)
    try { await (window as unknown as { __df_flushAutosave?: () => Promise<void> }).__df_flushAutosave?.(); } catch {}
    try { await new Promise<void>((r) => setTimeout(r, 400)); } catch {}
    setState({ status: 'downloading', pct: 0 });

    try {
      await downloadAndInstall((progress: DownloadProgress) => {
        const pct =
          progress.contentLength > 0
            ? Math.round((progress.downloaded / progress.contentLength) * 100)
            : 0;
        setState({ status: 'downloading', pct });
      });
      // On success the app relaunches.
    } catch (err) {
      const message =
        err instanceof Error ? err.message : _(msg`Unknown error installing the update.`);
      setState({ status: 'error', message });
    }
  }, [state.status, _]);

  const handleDismiss = useCallback(() => {
    if (state.status !== 'available') return;
    triggerExit(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY_SUPPRESSED, (state as { status: 'available'; info: UpdateInfo }).info.version);
      } catch {
        // ignore
      }
      setState({ status: 'idle' });
      setIsExiting(false);
    });
  }, [state, triggerExit]);

  const handleClose = useCallback(() => {
    triggerExit(() => {
      setState({ status: 'idle' });
      setIsExiting(false);
    });
  }, [triggerExit]);

  // Push to reusable System Notification stack (bottom-right, frosted, 30s expiry)
  // This makes the update notification reusable for future system notifications like "Print is Done"
  useEffect(() => {
    if (state.status === 'available' && state.info) {
      if (isSettingsOpen()) {
        dismissSystemNotification('update-available');
        return;
      }
      const info = state.info;
      const parsedDate = info.date ? new Date(info.date) : null;
      const releaseDate = parsedDate && !Number.isNaN(parsedDate.getTime())
        ? parsedDate.toLocaleDateString(i18n.locale, { year: 'numeric', month: 'long', day: 'numeric' })
        : null;
      const subtitle = releaseDate ? formatUpdateReleaseLine(releaseDate, _) : undefined;
      pushSystemNotification({
        id: 'update-available',
        title: _(msg`Update Available!`),
        subtitle,
        tone: 'accent-secondary',
        hideIcon: true,
        versionChip: formatUpdateVersionChip(info.version, _),
        expiryMs: 30_000,
        onClose: handleClose,
        actions: [
          { label: _(msg`Remind me later`), variant: 'secondary', onClick: handleDismiss },
          { label: _(msg`View in Settings`), variant: 'accent-secondary', onClick: () => { openSettingsModal('updates'); handleClose(); } },
        ],
      });
      return;
    }
    if (state.status === 'downloading') {
      const pct = state.pct;
      pushSystemNotification({
        id: 'update-available',
        title: _(msg`Downloading update`),
        subtitle: formatUpdateProgressPct(pct, _),
        tone: 'accent',
        progressPct: pct,
        expiryMs: null,
        actions: [],
      });
      return;
    }
    if (state.status === 'error') {
      pushSystemNotification({
        id: 'update-available',
        title: _(msg`Update failed`),
        subtitle: state.message,
        tone: 'error',
        expiryMs: null,
        actions: [
          { label: _(msg`Dismiss`), variant: 'secondary', onClick: handleClose },
          { label: _(msg`Try again`), variant: 'danger', onClick: handleClose },
        ],
      });
      return;
    }
    dismissSystemNotification('update-available');
  }, [state, i18n, _, handleDismiss, handleClose]);

  return null;
}
