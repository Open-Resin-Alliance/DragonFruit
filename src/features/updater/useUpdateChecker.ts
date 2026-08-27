'use client';

import { useCallback, useEffect, useState } from 'react';
import { useIsLinux } from '@/hooks/usePlatform';
import {
  fetchUpdateInfo,
  downloadAndInstall,
  getUpdateChannel,
  type UpdateInfo,
  type DownloadProgress,
  type UpdateChannel,
} from '@/features/updater/updateBridge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; info: UpdateInfo }
  | { status: 'up-to-date'; info: UpdateInfo }
  | { status: 'error'; message: string }
  | { status: 'downloading'; progress: DownloadProgress }
  | { status: 'installing' }
  | { status: 'installed' }
  | { status: 'external' };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const STORAGE_KEY_LAST_CHECK = 'dragonfruit-updater-last-check';

const EXTERNAL_STATE: UpdateState = { status: 'external' };

export function useUpdateChecker() {
  const [internalState, setState] = useState<UpdateState>({ status: 'idle' });
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(true);
  // Linux updates through Flatpak, not through the app.
  const isExternal = useIsLinux();
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [channelLoaded, setChannelLoaded] = useState(false);

  // Load the saved channel on mount.
  useEffect(() => {
    getUpdateChannel().then((ch) => {
      setChannel(ch);
      setChannelLoaded(true);
    });
  }, []);

  const state = isExternal ? EXTERNAL_STATE : internalState;

  const handleCheck = useCallback(async () => {
    // Nothing to check: Flatpak installs the update, not the app.
    if (isExternal) return;

    setState({ status: 'checking' });
    console.log('[updater] checking for updates on channel:', channel);

    try {
      const info = await fetchUpdateInfo(channel);

      if (!info) {
        // Couldn't reach the update server or no release exists yet.
        // Show "up to date" with a muted note instead of silently going
        // back to idle, so the user knows something happened.
        setState({ status: 'up-to-date', info: { version: '', currentVersion: '', body: undefined, date: undefined } });
        return;
      }

      // If we got info back, the plugin found a newer version.
      setState({ status: 'available', info });

      // Persist the last check timestamp.
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(
            STORAGE_KEY_LAST_CHECK,
            Date.now().toString(),
          );
        } catch {
          // Ignore storage errors.
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown error checking for updates.';
      setState({ status: 'error', message });
    }
  }, [channel, isExternal]);

  const handleDownloadAndInstall = useCallback(async () => {
    setState({ status: 'downloading', progress: { contentLength: 0, downloaded: 0 } });

    try {
      await downloadAndInstall((progress: DownloadProgress) => {
        setState({ status: 'downloading', progress });
      });
      // The app should relaunch — if we get here, show installed state.
      setState({ status: 'installed' });
    } catch (err) {
      // Show what actually broke. A generic "check your connection" hides
      // failures that have nothing to do with the network.
      const message =
        err instanceof Error ? err.message : 'Unknown error installing the update.';
      setState({ status: 'error', message });
    }
  }, []);

  const handleDismiss = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  // Auto-check once the channel is loaded from disk and enough time has passed.
  useEffect(() => {
    if (!autoCheckEnabled || !channelLoaded || isExternal) return;

    const lastCheck = (() => {
      if (typeof window === 'undefined') return 0;
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY_LAST_CHECK);
        return raw ? parseInt(raw, 10) : 0;
      } catch {
        return 0;
      }
    })();

    const elapsed = Date.now() - lastCheck;
    if (elapsed >= CHECK_INTERVAL_MS || lastCheck === 0) {
      handleCheck();
    }
  }, [autoCheckEnabled, channelLoaded, isExternal, handleCheck]);

  return {
    state,
    autoCheckEnabled,
    setAutoCheckEnabled,
    channel,
    setChannel,
    checkForUpdates: handleCheck,
    downloadAndInstall: handleDownloadAndInstall,
    dismiss: handleDismiss,
  };
}
