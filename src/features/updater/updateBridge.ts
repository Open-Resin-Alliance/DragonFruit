/**
 * Bridge for update checking, using custom Rust commands for channel-aware
 * checks (stable vs dev prerelease) and the plugin's download+install flow.
 *
 * Browser-mode calls return null gracefully.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { detectPlatform } from '@/hooks/usePlatform';

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
// Tauri availability check (gets rid of errors in pure frontend mode)
// ---------------------------------------------------------------------------

function isTauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ---------------------------------------------------------------------------
// Platform delivery
// ---------------------------------------------------------------------------

/** Where the latest DragonFruit release is published for Linux users. */
export const LINUX_RELEASES_URL =
  'https://github.com/Open-Resin-Alliance/DragonFruit/releases';

/** Flatpak application id, for the `flatpak update` hint shown on Linux. */
export const FLATPAK_APP_ID = 'org.openresinalliance.dragonfruit';

/**
 * True when updates are installed outside the app.
 *
 * Linux ships only as a Flatpak bundle: the updater feed has no Linux entry,
 * and the sandbox cannot write over a running install anyway. Those users
 * update through Flatpak instead.
 */
export function updatesAreExternal(): boolean {
  return detectPlatform() === 'linux';
}

// ---------------------------------------------------------------------------
// Channel preference (persisted in app data dir via Rust)
// ---------------------------------------------------------------------------

export async function getUpdateChannel(): Promise<UpdateChannel> {
  if (!isTauriAvailable()) {
    return 'stable';
  }
  try {
    const ch = await invoke<UpdateChannel>('get_saved_update_channel');
    console.log('[updater] saved channel:', ch);
    return ch;
  } catch (err) {
    console.warn('[updater] getUpdateChannel failed, defaulting to stable:', err);
    return 'stable';
  }
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  if (!isTauriAvailable()) {
    return;
  }
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
  if (!isTauriAvailable()) {
    return null;
  }
  if (updatesAreExternal()) {
    console.log('[updater] Linux ships as a Flatpak — skipping the update check');
    return null;
  }
  console.log('[updater] fetchUpdateInfo called, channel:', channel ?? 'null (Rust default)');
  try {
    const result = await invoke<{
      updateAvailable: boolean;
      version: string;
      currentVersion: string;
      body: string | null;
      date: string | null;
    } | null>('check_updates', { channel: channel ?? null });

    console.log('[updater] check_updates result:', result);

    if (!result?.updateAvailable) return null;

    return {
      version: result.version,
      currentVersion: result.currentVersion,
      body: result.body ?? undefined,
      date: result.date ?? undefined,
    };
  } catch (err) {
    console.error('[updater] check_updates invoke failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Download + install (via Rust — uses cached Update)
// ---------------------------------------------------------------------------

/** Progress payload pushed by the Rust `perform_update` channel. */
type PerformUpdateProgress = {
  downloadedBytes: number;
  totalBytes: number | null;
  phase: string;
};

/**
 * Download and install the previously cached update.
 * The Rust side handles signature verification, installer launch, and exit.
 *
 * Throws with the real backend message on failure — the caller shows it.
 */
export async function downloadAndInstall(
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  if (!isTauriAvailable()) {
    throw new Error('Updates are only available in the desktop app.');
  }

  // `perform_update` takes a Channel. Invoking without it fails argument
  // deserialization before the command body runs at all, so the channel is
  // what makes the call reach Rust — not just what reports progress.
  const onChunk = new Channel<PerformUpdateProgress>();
  onChunk.onmessage = ({ downloadedBytes, totalBytes, phase }) => {
    console.log(`[updater] ${phase}: ${downloadedBytes}/${totalBytes ?? '?'} bytes`);
    onProgress?.({ contentLength: totalBytes ?? 0, downloaded: downloadedBytes });
  };

  try {
    await invoke('perform_update', { onChunk });
  } catch (err) {
    console.error('[updater] perform_update failed:', err);
    throw err instanceof Error ? err : new Error(String(err));
  }

  try {
    await relaunch();
  } catch (err) {
    console.error('[updater] relaunch after install failed:', err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
