'use client';

import React from 'react';
import { subscribeHistory } from '@/history/historyStore';
import { armStallWatch, setStallPhase } from '@/utils/mainThreadStallWatch';
import { ExportManager } from '@/features/export/logic/ExportManager';
import { VoxlChunkCache } from '@/features/scene/voxl';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AUTOSAVE_DEBOUNCE_MS = 30_000;  // 30 s of quiet → write
const AUTOSAVE_CAP_MS = 2 * 60_000;  // write at most every 2 min even under churn
const AUTOSAVE_NAVIGATION_SETTLE_MS = 900;

// ---------------------------------------------------------------------------
// Tauri helpers
// ---------------------------------------------------------------------------

export type AutosaveOrigin = 'sidecar' | 'recovery-dir';

export type AutosavePaths = {
  voxlPath: string;
  manifestPath: string;
  origin: AutosaveOrigin;
  projectPath: string | null;
  /** Set only when the sidecar target was unusable. See `resolve_scene_autosave_target`. */
  fallbackReason: string | null;
};

export type AutosaveRecoveryCandidate = {
  voxlPath: string;
  origin: AutosaveOrigin;
  savedAt: string | null;
  clean: boolean;
  projectPath: string | null;
  payloadBytes: number;
  fallbackReason: string | null;
};

/** Minimal shape of `@tauri-apps/api/core`'s `invoke`, so tests can inject one. */
export type AutosaveInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function desktopInvoke(): Promise<AutosaveInvoke> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as AutosaveInvoke;
}

let cachedPaths: AutosavePaths | null = null;
let cachedPreferredSavePath: string | null | undefined;
let warnedFallbackFor: string | null = null;

/** Drops the resolved-path cache. Used by tests, which would otherwise leak it between cases. */
export function resetAutosavePathCache(): void {
  cachedPaths = null;
  cachedPreferredSavePath = undefined;
  warnedFallbackFor = null;
}

/**
 * Resolves the autosave target at **tick time** (finding N3).
 *
 * The cache is keyed on the project path, so a Save As to a new folder moves the
 * sidecar with it instead of writing next to the old project forever. A resolved
 * *fallback* is deliberately never cached: falling back means the project folder
 * was unusable at that moment (read-only, permission-denied, disconnected
 * share), which is exactly the kind of condition that clears — re-probing costs
 * one syscall per tick and lets the sidecar come back on its own.
 */
export async function resolveAutosavePaths(
  invoke: AutosaveInvoke,
  preferredSavePath?: string | null,
): Promise<AutosavePaths> {
  if (cachedPaths && preferredSavePath !== cachedPreferredSavePath) {
    cachedPaths = null;
  }
  if (cachedPaths) return cachedPaths;

  const result = await invoke<AutosavePaths>(
    'scene_autosave_get_paths',
    preferredSavePath ? { preferredSavePath } : {},
  );

  if (result.fallbackReason) {
    // Never fail an autosave over a folder-policy question — but never hide it
    // either. Warned once per distinct project so a 30 s tick cannot spam.
    const key = `${preferredSavePath ?? ''}:${result.fallbackReason}`;
    if (warnedFallbackFor !== key) {
      warnedFallbackFor = key;
      console.warn(
        `[SceneAutosave] Cannot write a recovery file beside this project (${result.fallbackReason}); `
        + `using the default recovery location instead: ${result.voxlPath}`,
      );
    }
    cachedPaths = null;
    cachedPreferredSavePath = undefined;
    return result;
  }

  warnedFallbackFor = null;
  cachedPaths = result;
  cachedPreferredSavePath = preferredSavePath;
  return result;
}

async function getAutosavePaths(preferredSavePath?: string | null): Promise<AutosavePaths> {
  return resolveAutosavePaths(await desktopInvoke(), preferredSavePath);
}

// ---------------------------------------------------------------------------
// Failure honesty (sub-phase D3, finding N4)
// ---------------------------------------------------------------------------

/**
 * How many consecutive failures before the user is interrupted.
 *
 * One is a transient: an antivirus holding the destination, a share blinking,
 * a rename losing a race. Two in a row across a 30 s debounce is a condition,
 * not a blip — and a condition the user can usually act on (free disk, remove a
 * model, save elsewhere).
 */
export const AUTOSAVE_FAILURE_NOTIFY_THRESHOLD = 2;

export type AutosaveFailureOutcome = {
  consecutiveFailures: number;
  /** True exactly once per outage, at the threshold. */
  shouldNotifyUser: boolean;
  message: string;
};

/**
 * Tracks the autosave's honesty state (finding N4).
 *
 * Before this, failures were swallowed with a `console.warn` and the manifest
 * was written only on success. An autosave that had been failing for an hour
 * presented as a stale "unsaved changes from <time>" prompt with no signal at
 * all — and it is the surface the 4 GiB guard (D1) fails into, so the two had to
 * land together.
 *
 * The rule the class exists to enforce: **a failed tick never advances the
 * timestamp recovery shows the user.** `saved_at` keeps naming the last payload
 * that actually reached disk, and the error rides alongside it.
 */
export class AutosaveFailureTracker {
  private consecutive = 0;

  private error: string | null = null;

  private successAt: string | null = null;

  get lastError(): string | null {
    return this.error;
  }

  /** ISO timestamp of the last payload that actually committed. */
  get lastSuccessAt(): string | null {
    return this.successAt;
  }

  get consecutiveFailures(): number {
    return this.consecutive;
  }

  recordSuccess(savedAt: string): void {
    this.consecutive = 0;
    this.error = null;
    this.successAt = savedAt;
  }

  recordFailure(error: unknown): AutosaveFailureOutcome {
    const message = error instanceof Error
      ? error.message
      : String(error ?? 'Unknown autosave failure');
    this.consecutive += 1;
    this.error = message;
    return {
      consecutiveFailures: this.consecutive,
      // Strictly `===`, not `>=`: a 30 s tick against a persistent condition
      // would otherwise interrupt the user twice a minute forever.
      shouldNotifyUser: this.consecutive === AUTOSAVE_FAILURE_NOTIFY_THRESHOLD,
      message,
    };
  }
}

// ---------------------------------------------------------------------------
// Contention policy (sub-phase D4)
// ---------------------------------------------------------------------------

export type AutosaveGateInput = {
  enabled: boolean;
  desktop: boolean;
  /** Epoch ms until which `suppressSceneAutosave` holds ticks off. */
  suppressedUntil: number;
  now: number;
  modelCount: number;
  navigationBusy: boolean;
  /** An explicit flush: quit, or a hand-off from the save path. */
  forced: boolean;
  /**
   * Monotonic scene-content revision at the moment this tick started, and the
   * revision the last SUCCESSFUL persist committed. Equal ⇒ nothing has changed
   * since the file on disk was written, so the whole tick is skipped before any
   * build/stringify/hash/I/O. `revision` bumps on every autosave trigger
   * (history push, model add/remove); `lastPersistedRevision` advances only on a
   * committed write, so a failed save is never mistaken for a clean scene.
   */
  revision: number;
  lastPersistedRevision: number;
};

export type AutosaveGateDecision =
  | { action: 'run' }
  | { action: 'defer'; reason: 'navigation' | 'suppressed'; retainDirty: true }
  | { action: 'skip'; reason: 'disabled' | 'not-desktop' | 'empty-scene' | 'unchanged'; retainDirty: boolean };

/**
 * Decides whether a tick runs now, later, or not at all.
 *
 * Sub-phase A's single-flight lock already made an overlapping native write
 * **safe**; this makes it **cheap**, and — more importantly — makes the
 * defer-vs-skip choice explicit rather than an emergent property of early
 * returns.
 *
 * The load-bearing half is `retainDirty`. The old control flow cleared the dirty
 * flag before every one of these checks, so edits made during a slice, a hollow,
 * or a suppression window were silently forgotten and waited for the *next*
 * unrelated history push to be persisted at all. Deferring keeps the scene
 * dirty; only "there is genuinely nothing to save" (an empty scene) and "this
 * build cannot save" (browser) drop it.
 *
 * A forced flush overrides both defer reasons: it is the quit path and the
 * explicit hand-off, where waiting means losing the work outright.
 */
export function decideAutosaveGate(input: AutosaveGateInput): AutosaveGateDecision {
  if (!input.desktop) return { action: 'skip', reason: 'not-desktop', retainDirty: false };
  if (!input.enabled) return { action: 'skip', reason: 'disabled', retainDirty: true };
  if (input.modelCount === 0) return { action: 'skip', reason: 'empty-scene', retainDirty: false };

  if (!input.forced) {
    if (input.now < input.suppressedUntil) {
      return { action: 'defer', reason: 'suppressed', retainDirty: true };
    }
    if (input.navigationBusy) {
      return { action: 'defer', reason: 'navigation', retainDirty: true };
    }
    // Nothing changed since the last committed write — skip the entire tick.
    // retainDirty:false because there is genuinely nothing outstanding; a real
    // edit bumps `revision` and re-arms a tick. Forced flushes bypass this so
    // the quit/hand-off path always reaches disk.
    if (input.revision === input.lastPersistedRevision) {
      return { action: 'skip', reason: 'unchanged', retainDirty: false };
    }
  }

  return { action: 'run' };
}

export type WriteManifestOptions = {
  voxlPath?: string | null;
  origin?: string | null;
  projectPath?: string | null;
  payloadBytes?: number | null;
  fallbackReason?: string | null;
  /**
   * Records why the last tick failed (D3 / N4). When set, the backend preserves
   * the previous manifest's `savedAt` and payload pointer, so recovery keeps
   * naming the last file that actually committed.
   */
  lastError?: string | null;
  /**
   * Deletes the advertised payload as well as marking the manifest clean.
   * **Only ever passed when there is no unsaved work to lose** — after a
   * successful save, a successful restore, or an explicit discard.
   */
  deletePayload?: boolean;
};

async function writeManifest(
  savedAt: string,
  clean: boolean,
  options: WriteManifestOptions = {},
): Promise<void> {
  const invoke = await desktopInvoke();
  await invoke('scene_autosave_write_manifest', {
    savedAt,
    clean,
    voxlPath: options.voxlPath ?? null,
    origin: options.origin ?? null,
    projectPath: options.projectPath ?? null,
    payloadBytes: options.payloadBytes ?? null,
    fallbackReason: options.fallbackReason ?? null,
    lastError: options.lastError ?? null,
    deletePayload: options.deletePayload ?? false,
  });
}

/**
 * The single entry point for recovery discovery. Resolves, in order: the
 * manifest's committed `voxlPath` → the sidecar derived from its `projectPath` →
 * the legacy generic location → none.
 */
export async function resolveAutosaveRecovery(): Promise<AutosaveRecoveryCandidate | null> {
  const invoke = await desktopInvoke();
  return invoke<AutosaveRecoveryCandidate | null>('scene_autosave_resolve_recovery');
}

/** Reads a recovery payload. The backend accepts only its own candidates. */
export async function readAutosaveRecoveryBytes(path: string | null): Promise<ArrayBuffer> {
  const invoke = await desktopInvoke();
  return invoke<ArrayBuffer>('scene_autosave_read_voxl_bytes', path ? { path } : {});
}

/**
 * Removes the sidecar belonging to `projectPath`. Used on Save As against the
 * **old** project, so a rename never leaves an orphaned `_autosave.voxl` implying
 * unsaved work that does not exist.
 */
export async function deleteAutosaveSidecarForProject(projectPath: string): Promise<void> {
  const invoke = await desktopInvoke();
  await invoke('scene_autosave_delete_sidecar', { projectPath });
}

function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type UseSceneAutosaveOptions = {
  models: LoadedModel[];
  activeModelId: string | null;
  selectedModelIds: string[];
  enabled?: boolean;
  debounceMs?: number;
  capMs?: number;
  preferredSavePath?: string | null;
  /**
   * Whether the current scene's on-disk format is the chunked VOXL 2.2 layout.
   * Autosave preserves the inline (pre-2.2) layout only when this is `false`; a
   * scene that is already 2.2 is never written back to inline (no downgrade).
   * Defaults to `true` (newest) so an unknown/new scene autosaves as 2.2.
   */
  sceneFormatChunked?: boolean;
  /**
   * Fired when autosave had to escalate an inline write to the 2.2 chunked
   * layout (the inline write threw). The owner latches the scene to chunked so
   * later ticks stop re-attempting — and never downgrade — the now-2.2 file.
   */
  onSceneFormatUpgraded?: () => void;
};

export type UseSceneAutosaveResult = {
  isAutosaving: boolean;
  lastAutosaveAt: string | null;
  /** Message from the most recent failed tick, or null while autosave is healthy (D3). */
  lastAutosaveError: string | null;
  clearAutosave: () => Promise<void>;
  flushAutosave: () => Promise<void>;
};

/**
 * Fired once per outage, after {@link AUTOSAVE_FAILURE_NOTIFY_THRESHOLD}
 * consecutive failures. `page.tsx` turns it into a modal; the settings tab shows
 * the standing state regardless.
 */
export const SCENE_AUTOSAVE_FAILED_EVENT = 'scene-autosave-failed';

export function useSceneAutosave({
  models,
  activeModelId,
  selectedModelIds,
  enabled = true,
  debounceMs = AUTOSAVE_DEBOUNCE_MS,
  capMs = AUTOSAVE_CAP_MS,
  preferredSavePath = null,
  sceneFormatChunked = true,
  onSceneFormatUpgraded,
}: UseSceneAutosaveOptions): UseSceneAutosaveResult {
  const [isAutosaving, setIsAutosaving] = React.useState(false);
  const [lastAutosaveAt, setLastAutosaveAt] = React.useState<string | null>(null);
  const [lastAutosaveError, setLastAutosaveError] = React.useState<string | null>(null);
  const failureTrackerRef = React.useRef(new AutosaveFailureTracker());

  // Keep stable refs so the debounce callback always sees fresh values
  const modelsRef = React.useRef(models);
  modelsRef.current = models;
  const activeModelIdRef = React.useRef(activeModelId);
  activeModelIdRef.current = activeModelId;
  const selectedModelIdsRef = React.useRef(selectedModelIds);
  selectedModelIdsRef.current = selectedModelIds;
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const debounceMsRef = React.useRef(debounceMs);
  debounceMsRef.current = debounceMs;
  const capMsRef = React.useRef(capMs);
  capMsRef.current = capMs;
  const preferredSavePathRef = React.useRef(preferredSavePath);
  preferredSavePathRef.current = preferredSavePath;
  const sceneFormatChunkedRef = React.useRef(sceneFormatChunked);
  sceneFormatChunkedRef.current = sceneFormatChunked;
  const onSceneFormatUpgradedRef = React.useRef(onSceneFormatUpgraded);
  onSceneFormatUpgradedRef.current = onSceneFormatUpgraded;

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const capRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferredAutosaveRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationSettleRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationActiveRef = React.useRef(false);
  const navigationQuietUntilRef = React.useRef(0);
  const inFlightRef = React.useRef(false);
  const autosavePromiseRef = React.useRef<Promise<void> | null>(null);
  const dirtyRef = React.useRef(false);

  // Monotonic scene-content revision: bumped by `scheduleSave` on every autosave
  // trigger, and snapshotted into `lastPersistedRevisionRef` only when a write
  // commits. The gate skips a tick whose revision already matches the last
  // committed one, so an idle/duplicate tick does no build/stringify/hash/I/O.
  // Starts at 0 == lastPersisted so a freshly loaded scene (disk already current)
  // does not autosave until the first real edit.
  const revisionRef = React.useRef(0);
  const lastPersistedRevisionRef = React.useRef(0);

  // Incremental-write state (Phase 1). The chunk cache persists across ticks so
  // unchanged modifier/SUPP chunks reuse their compressed bytes; the last-write
  // fingerprint (scoped to its path) drives the "content unchanged → skip the
  // disk write" decision inside `ExportManager.exportVoxl`.
  const chunkCacheRef = React.useRef<VoxlChunkCache | null>(null);
  const lastWriteFingerprintRef = React.useRef<{ path: string; fingerprint: string } | null>(null);

  const clearDeferredAutosave = React.useCallback(() => {
    if (deferredAutosaveRef.current === null) return;
    clearTimeout(deferredAutosaveRef.current);
    deferredAutosaveRef.current = null;
  }, []);

  const shouldDeferAutosaveForNavigation = React.useCallback(() => {
    return navigationActiveRef.current || Date.now() < navigationQuietUntilRef.current;
  }, []);

  const scheduleDeferredAutosave = React.useCallback((perform: () => void, notBeforeMs = 0) => {
    clearDeferredAutosave();

    // `notBeforeMs` lets a suppression-deferred tick wake when the window
    // actually closes instead of re-checking every settle interval for the whole
    // length of a long import or hollow (D4).
    const delay = Math.max(
      AUTOSAVE_NAVIGATION_SETTLE_MS,
      navigationQuietUntilRef.current - Date.now(),
      notBeforeMs - Date.now(),
      0,
    );

    deferredAutosaveRef.current = setTimeout(() => {
      deferredAutosaveRef.current = null;
      if (!dirtyRef.current) return;
      perform();
    }, delay);
  }, [clearDeferredAutosave]);

  const performAutosave = React.useCallback(async (options?: { force?: boolean }) => {
    if (autosavePromiseRef.current) {
      await autosavePromiseRef.current;
      return;
    }

    const run = async () => {
      const currentModels = modelsRef.current;

      // Snapshot the revision BEFORE the gate/write: edits that land while this
      // tick is in flight bump `revisionRef` past this value, so committing this
      // one only advances `lastPersistedRevision` to what it actually wrote,
      // leaving the scene correctly dirty for a follow-up tick.
      const revisionAtStart = revisionRef.current;

      // One explicit policy decision instead of five early returns, so
      // "does the dirtiness survive this?" is answerable by reading it (D4).
      const decision = decideAutosaveGate({
        enabled: enabledRef.current,
        desktop: isDesktopRuntime(),
        suppressedUntil: sceneAutosaveSuppressRef.current,
        now: Date.now(),
        modelCount: currentModels.length,
        navigationBusy: shouldDeferAutosaveForNavigation(),
        forced: options?.force === true,
        revision: revisionAtStart,
        lastPersistedRevision: lastPersistedRevisionRef.current,
      });

      if (decision.action !== 'run') {
        if (!decision.retainDirty) dirtyRef.current = false;
        if (decision.action === 'defer') {
          // Re-arm rather than drop. `scheduleDeferredAutosave` no-ops when the
          // scene is not dirty, so this cannot spin on a clean scene.
          scheduleDeferredAutosave(
            () => { void performAutosave(); },
            decision.reason === 'suppressed' ? sceneAutosaveSuppressRef.current : 0,
          );
        }
        return;
      }

      clearDeferredAutosave();
      inFlightRef.current = true;
      dirtyRef.current = false;
      setIsAutosaving(true);
      setStallPhase('autosave-tick');  // DIAGNOSTIC

      try {
        // Resolved per tick, not per render: `preferredSavePathRef` now tracks
        // `activeSceneFilePath` state, so a Save As moves the sidecar with the
        // project instead of stranding it beside the old one (finding N3).
        const paths = await getAutosavePaths(preferredSavePathRef.current);
        const { voxlPath } = paths;

        // Format preservation: keep a pre-2.2 file inline, but never downgrade a
        // file that is already 2.2. If the inline write throws (typically the
        // MODL string ceiling on snapshots too large to inline), escalate to the
        // chunked 2.2 layout and latch the scene there so later ticks stop
        // re-attempting inline.
        // Incremental-write cache (Phase 1): reuse compressed chunks across
        // ticks and skip the disk write entirely when the document fingerprint
        // matches what is already on `voxlPath`. The fingerprint is trusted only
        // for the SAME path — a Save As moves `voxlPath`, so a stale fingerprint
        // must not authorize a skip.
        if (chunkCacheRef.current === null) chunkCacheRef.current = new VoxlChunkCache();
        const priorWrite = lastWriteFingerprintRef.current;
        const previousFingerprint =
          priorWrite !== null && priorWrite.path === voxlPath ? priorWrite.fingerprint : undefined;

        const runExport = (chunkModifierSnapshots: boolean): Promise<string | null> =>
          ExportManager.exportScene(
            null,
            null,
            {
              filename: 'autosave',
              format: 'voxl',
              binary: true,
              separateFiles: false,
              includeRaft: false,
              includeSupports: true,
              includeModel: true,
            },
            {
              models: currentModels,
              activeModelId: activeModelIdRef.current,
              selectedModelIds: selectedModelIdsRef.current,
            },
            {
              nativePath: voxlPath,
              chunkModifierSnapshots,
              chunkCache: chunkCacheRef.current ?? undefined,
              previousFingerprint,
              onFingerprint: (fingerprint) => {
                lastWriteFingerprintRef.current = fingerprint
                  ? { path: voxlPath, fingerprint }
                  : null;
              },
            },
          );

        if (sceneFormatChunkedRef.current) {
          await runExport(true);
        } else {
          try {
            await runExport(false);
          } catch (error) {
            console.warn('[autosave] Inline VOXL write failed; upgrading scene to the 2.2 chunked layout.', error);
            onSceneFormatUpgradedRef.current?.();
            sceneFormatChunkedRef.current = true;
            await runExport(true);
          }
        }

        // Ordering is load-bearing and must stay this way: payload first, then
        // manifest. `exportScene` above commits the VOXL through the atomic
        // writer (temp → fsync → rename, ExportManager.downloadFile), so by the
        // time the manifest is written the file it advertises is guaranteed to
        // be complete. A manifest written first — or written on a failed
        // export — would point recovery at a file that may not exist or may be
        // half a scene. Sub-phase B relies on exactly this: `voxlPath` below is
        // what makes the manifest authoritative for recovery, and it is only
        // trustworthy because it is written after the commit.
        const savedAt = new Date().toISOString();
        await writeManifest(savedAt, false, {
          voxlPath,
          origin: paths.origin,
          projectPath: paths.projectPath,
          fallbackReason: paths.fallbackReason,
        });
        // Commit succeeded: the file on disk now reflects `revisionAtStart`.
        // Advance the persisted marker so the gate skips ticks until the next
        // real edit. Set to the snapshot, NOT the current revision — edits that
        // arrived mid-write are not in this file and must remain outstanding.
        lastPersistedRevisionRef.current = revisionAtStart;
        failureTrackerRef.current.recordSuccess(savedAt);
        setLastAutosaveAt(savedAt);
        setLastAutosaveError(null);
      } catch (err) {
        // Failure honesty (D3 / N4). The old code was a bare `console.warn`, and
        // because the manifest is written only after a successful payload, a
        // failing autosave was indistinguishable from a quiet one until the user
        // hit recovery and found hour-old work.
        //
        // Three things happen now: the error is recorded in the manifest beside
        // the LAST GOOD `savedAt` (never overwriting it), it is surfaced in the
        // autosave settings tab, and a persistent outage interrupts the user
        // once. This is also the surface the 4 GiB guard (D1) fails into.
        const outcome = failureTrackerRef.current.recordFailure(err);
        setLastAutosaveError(outcome.message);
        console.warn('[SceneAutosave] Autosave failed:', err);

        try {
          await writeManifest(
            failureTrackerRef.current.lastSuccessAt ?? new Date().toISOString(),
            false,
            { lastError: outcome.message },
          );
        } catch (manifestError) {
          console.warn('[SceneAutosave] Could not record the autosave failure either.', manifestError);
        }

        if (outcome.shouldNotifyUser && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(SCENE_AUTOSAVE_FAILED_EVENT, {
            detail: {
              message: outcome.message,
              consecutiveFailures: outcome.consecutiveFailures,
              lastSuccessAt: failureTrackerRef.current.lastSuccessAt,
            },
          }));
        }
      } finally {
        inFlightRef.current = false;
        setIsAutosaving(false);
        setStallPhase('idle');  // DIAGNOSTIC
      }
    };

    const promise = run();
    autosavePromiseRef.current = promise;
    try {
      await promise;
    } finally {
      if (autosavePromiseRef.current === promise) {
        autosavePromiseRef.current = null;
      }
    }
  }, []);

  const scheduleSave = React.useCallback(() => {
    if (!isDesktopRuntime()) return;

    // Mark dirty BEFORE the enabled check (D4). Autosave is disabled outright
    // during slicing and printing (`page.tsx`), and the old order meant every
    // edit made in those windows never marked the scene dirty at all — it
    // waited for the next unrelated history push to be persisted. Recording it
    // here costs nothing and means the window closing is enough to fire a tick.
    dirtyRef.current = true;
    // Every trigger advances the content revision; the gate compares this to the
    // revision of the last committed write to skip idle/duplicate ticks.
    revisionRef.current += 1;
    if (!enabledRef.current) return;

    // Reset the debounce window
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void performAutosave();
    }, debounceMsRef.current);

    // Ensure we still fire within the cap if the scene is continuously dirty
    if (capRef.current === null) {
      capRef.current = setTimeout(() => {
        capRef.current = null;
        if (dirtyRef.current) {
          if (debounceRef.current !== null) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
          }
          void performAutosave();
        }
      }, capMsRef.current);
    }
  }, [performAutosave]);

  // DIAGNOSTIC: arm the main-thread stall detector for the whole app lifetime so
  // a freeze is caught and timestamped wherever it happens (edit-commit vs the
  // autosave tick), regardless of whether autosave is enabled.
  React.useEffect(() => {
    armStallWatch();
  }, []);

  // Subscribe to history events (push / undo / redo)
  React.useEffect(() => {
    const unsubscribe = subscribeHistory(scheduleSave);
    return () => {
      unsubscribe();
    };
  }, [scheduleSave]);

  // Also fire when a model is added or removed
  const prevModelCountRef = React.useRef(models.length);
  React.useEffect(() => {
    const prev = prevModelCountRef.current;
    prevModelCountRef.current = models.length;
    if (models.length !== prev && models.length > 0) {
      scheduleSave();
    }
  }, [models.length, scheduleSave]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const markNavigationActive = () => {
      navigationActiveRef.current = true;
      navigationQuietUntilRef.current = Date.now() + AUTOSAVE_NAVIGATION_SETTLE_MS;
      if (navigationSettleRef.current !== null) {
        clearTimeout(navigationSettleRef.current);
        navigationSettleRef.current = null;
      }
    };

    const markNavigationSettling = (event?: Event) => {
      navigationActiveRef.current = false;
      const resumeAfterMs = event
        ? Number((event as CustomEvent<{ resumeAfterMs?: number }>).detail?.resumeAfterMs ?? 0)
        : 0;
      const settleMs = Math.max(AUTOSAVE_NAVIGATION_SETTLE_MS, resumeAfterMs + AUTOSAVE_NAVIGATION_SETTLE_MS);
      navigationQuietUntilRef.current = Date.now() + settleMs;

      if (navigationSettleRef.current !== null) {
        clearTimeout(navigationSettleRef.current);
      }

      navigationSettleRef.current = setTimeout(() => {
        navigationSettleRef.current = null;
        if (!dirtyRef.current) return;
        if (shouldDeferAutosaveForNavigation()) {
          scheduleDeferredAutosave(() => {
            void performAutosave();
          });
          return;
        }
        void performAutosave();
      }, settleMs);
    };

    window.addEventListener('picking-orbit-start', markNavigationActive);
    window.addEventListener('picking-orbit-change', markNavigationActive);
    window.addEventListener('picking-orbit-end', markNavigationSettling);
    window.addEventListener('picking-pan-start', markNavigationActive);
    window.addEventListener('picking-pan-change', markNavigationActive);
    window.addEventListener('picking-pan-end', markNavigationSettling);
    window.addEventListener('picking-zoom-start', markNavigationActive);
    window.addEventListener('picking-zoom-change', markNavigationActive);
    window.addEventListener('picking-zoom-end', markNavigationSettling);
    window.addEventListener('blur', markNavigationSettling);

    return () => {
      window.removeEventListener('picking-orbit-start', markNavigationActive);
      window.removeEventListener('picking-orbit-change', markNavigationActive);
      window.removeEventListener('picking-orbit-end', markNavigationSettling);
      window.removeEventListener('picking-pan-start', markNavigationActive);
      window.removeEventListener('picking-pan-change', markNavigationActive);
      window.removeEventListener('picking-pan-end', markNavigationSettling);
      window.removeEventListener('picking-zoom-start', markNavigationActive);
      window.removeEventListener('picking-zoom-change', markNavigationActive);
      window.removeEventListener('picking-zoom-end', markNavigationSettling);
      window.removeEventListener('blur', markNavigationSettling);
      if (navigationSettleRef.current !== null) {
        clearTimeout(navigationSettleRef.current);
        navigationSettleRef.current = null;
      }
    };
  }, [performAutosave, scheduleDeferredAutosave, shouldDeferAutosaveForNavigation]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      if (capRef.current !== null) clearTimeout(capRef.current);
      if (deferredAutosaveRef.current !== null) clearTimeout(deferredAutosaveRef.current);
      if (navigationSettleRef.current !== null) clearTimeout(navigationSettleRef.current);
    };
  }, []);

  /**
   * Marks the autosave clean **and deletes the payload**.
   *
   * A `_autosave.voxl` lingering beside a saved project is user-visible clutter
   * that implies unsaved work which does not exist. Deleting is safe only
   * because every caller runs after the work is already secured — a successful
   * explicit save, a successful restore, or an explicit discard. It is
   * deliberately NOT called on a clean exit that still has unsaved changes; see
   * `handleRequestProgramClose` in `page.tsx`.
   */
  const clearAutosave = React.useCallback(async () => {
    if (!isDesktopRuntime()) return;
    try {
      await writeManifest(new Date().toISOString(), true, { deletePayload: true });
    } catch (err) {
      console.warn('[SceneAutosave] Failed marking autosave clean:', err);
    }
  }, []);

  const flushAutosave = React.useCallback(async () => {
    if (!enabledRef.current || !isDesktopRuntime()) return;

    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (capRef.current !== null) {
      clearTimeout(capRef.current);
      capRef.current = null;
    }

    dirtyRef.current = true;
    clearDeferredAutosave();
    await performAutosave({ force: true });
  }, [clearDeferredAutosave, performAutosave]);

  return { isAutosaving, lastAutosaveAt, lastAutosaveError, clearAutosave, flushAutosave };
}

// ---------------------------------------------------------------------------
// Exported helper for recovery: suppress autosave briefly after restore
// ---------------------------------------------------------------------------

// We expose a module-level timestamp so page.tsx can tell the hook to hold off
// after restoring a scene (otherwise the newly-imported models immediately
// trigger another dirty write).  Call suppressSceneAutosave(30_000) after a
// recovery restore.
export const sceneAutosaveSuppressRef = { current: 0 };

export function suppressSceneAutosave(ms: number): void {
  sceneAutosaveSuppressRef.current = Date.now() + ms;
}
