/**
 * Bridge for update checking, using custom Rust commands for channel-aware
 * checks (stable vs dev prerelease) and the plugin's download+install flow.
 *
 * Browser-mode calls return null gracefully.
 */

import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpdateInfo = {
  version: string;
  currentVersion: string;
  body: string | undefined;
  date: string | undefined;
};

export type DownloadProgress = {
  contentLength: number;
  downloaded: number;
};

export type UpdateChannel = 'stable' | 'dev';

// ---------------------------------------------------------------------------
// Channel preference (persisted in app data dir via Rust)
// ---------------------------------------------------------------------------

export async function getUpdateChannel(): Promise<UpdateChannel> {
  try {
    return await invoke<UpdateChannel>('get_saved_update_channel');
  } catch {
    return 'stable';
  }
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  try {
    await invoke('save_update_channel', { channel });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Check for updates (channel-aware, via Rust)
// ---------------------------------------------------------------------------

/**
 * Check for updates using the given release channel.
 * Returns null if no update is available or the check fails.
 *
 * Internally calls the Rust `check_updates` command which:
 *  1. Picks the right GitHub Releases endpoint based on channel
 *  2. Uses the plugin's `UpdaterExt` API for the check
 *  3. Caches the `Update` object for subsequent download+install
 */
export async function fetchUpdateInfo(
  channel?: UpdateChannel,
): Promise<UpdateInfo | null> {
  try {
    const result = await invoke<{
      updateAvailable: boolean;
      version: string;
      currentVersion: string;
      body: string | null;
      date: string | null;
    } | null>('check_updates', { channel: channel ?? null });

    if (!result?.updateAvailable) return null;

    return {
      version: result.version,
      currentVersion: result.currentVersion,
      body: result.body ?? undefined,
      date: result.date ?? undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Download + install (via Rust — uses cached Update)
// ---------------------------------------------------------------------------

/**
 * Download and install the previously cached update.
 * The Rust side handles signature verification, installer launch, and exit.
 */
export async function downloadAndInstall(
  onProgress?: (progress: DownloadProgress) => void,
): Promise<boolean> {
  try {
    await invoke('perform_update');
    await relaunch();
    return true;
  } catch {
    return false;
  }
}
