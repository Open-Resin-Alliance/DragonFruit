/**
 * Thin bridge wrapping the official `@tauri-apps/plugin-updater` API.
 *
 * The plugin handles checking, downloading, installing, and signature
 * verification. We just wrap it in slightly friendlier types for our UI.
 *
 * Browser-mode calls return null gracefully.
 */

import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import type { DownloadEvent } from '@tauri-apps/plugin-updater';

// Re-export the plugin's types we use externally.
export type { DownloadEvent };
export type UpdateInfo = {
  version: string;
  currentVersion: string;
  body: string | undefined;
  date: string | undefined;
};

export type DownloadProgress = {
  /** Total content length in bytes (from `Started` event). */
  contentLength: number;
  /** Total bytes downloaded so far (accumulated from `Progress` events). */
  downloaded: number;
};

// ---------------------------------------------------------------------------
// Check for updates
// ---------------------------------------------------------------------------

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body,
      date: update.date,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Download + install
// ---------------------------------------------------------------------------

/**
 * Check for updates AND return a helper that can download+install.
 *
 * We keep the `Update` object alive across the async boundary so the
 * caller can inspect the update info first (version, release notes),
 * then trigger download → install → relaunch.
 */
let _cachedUpdate: Awaited<ReturnType<typeof check>> = null;

export async function fetchUpdateInfo(): Promise<UpdateInfo | null> {
  try {
    _cachedUpdate = await check();
  } catch {
    // Plugin throws on non-2XX (e.g. endpoint 404 during dev).
    _cachedUpdate = null;
    return null;
  }
  if (!_cachedUpdate) return null;
  return {
    version: _cachedUpdate.version,
    currentVersion: _cachedUpdate.currentVersion,
    body: _cachedUpdate.body,
    date: _cachedUpdate.date,
  };
}

/**
 * Download + install the previously checked update.
 * Call `fetchUpdateInfo()` first to make sure an update is available.
 */
export async function downloadAndInstall(
  onProgress?: (progress: DownloadProgress) => void,
): Promise<boolean> {
  const update = _cachedUpdate;
  if (!update) return false;

  try {
    let lastContentLength = 0;
    let accumulated = 0;

    await update.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === 'Started') {
        lastContentLength = event.data.contentLength;
        accumulated = 0;
        onProgress?.({ contentLength: lastContentLength, downloaded: 0 });
      } else if (event.event === 'Progress') {
        accumulated += event.data.chunkLength;
        onProgress?.({ contentLength: lastContentLength, downloaded: accumulated });
      }
    });

    // On most platforms the app exits during install; relaunch handles
    // the remaining case (e.g. macOS where the user needs to drag).
    await relaunch();
    return true;
  } catch {
    return false;
  }
}
