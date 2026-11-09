import { isTauriRuntime } from '@/utils/tauriRuntime';
import {
  equalSliceMeshInputSignatures,
  getSliceMeshInputSignature,
  hasWarmSliceMesh,
  prewarmSliceMesh,
  subscribeSliceMeshInputChanges,
} from './sliceMeshSnapshot';
import type { SliceMeshInputSignature, SliceMeshPrewarmOptions } from './sliceMeshSnapshot';

export const SLICE_MESH_CACHE_SETTLE_MS = 250;
export const SLICE_MESH_CACHE_QUIET_MS = 2_000;
export const SLICE_MESH_CACHE_IDLE_TIMEOUT_MS = 2_000;

/** One dirty-only scene producer, independent of autosave's enablement and clock. */
export class SliceMeshWarmup {
  private options: SliceMeshPrewarmOptions | null = null;
  private signature: SliceMeshInputSignature | null = null;
  private attempted: SliceMeshInputSignature | null = null;
  private retried = false;
  private timer: number | undefined;
  private idle: number | null = null;
  private preparing: AbortController | null = null;
  private quietUntil = 0;
  private revision = 0;
  private ready = true;
  private paused = false;
  private readonly pointers = new Set<number>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly host: Window) {
    this.unsubscribe = subscribeSliceMeshInputChanges(() => this.update(this.options, this.revision, this.ready, this.paused));
    host.addEventListener('pointerdown', this.onPointerDown, true);
    host.addEventListener('pointerup', this.onPointerUp, true);
    host.addEventListener('pointercancel', this.onPointerUp, true);
    host.addEventListener('wheel', this.onInteraction, { passive: true });
    host.addEventListener('keydown', this.onInteraction, true);
    host.addEventListener('blur', this.onBlur);
    host.addEventListener('focus', this.onInteraction);
    host.document.addEventListener('visibilitychange', this.onVisibility);
  }

  update(options: SliceMeshPrewarmOptions | null, revision = 0, ready = true, paused = false): void {
    if (this.disposed) return;
    const revisionChanged = revision !== this.revision;
    const becameReady = ready && !this.ready;
    const resumed = !paused && this.paused;
    this.options = options;
    this.revision = revision;
    this.ready = ready;
    this.paused = paused;
    if (!options || !isTauriRuntime() || !options.models.some(model => model.visible
      && !options.excludedModelIds?.includes(model.id))) {
      this.signature = null;
      this.attempted = null;
      this.cancelScheduled();
      this.preparing?.abort();
      return;
    }
    if (!ready) {
      this.cancelScheduled();
      // A transient/import edit invalidates this subscriber, but Slice's pause
      // below must leave matching preparation alive for foreground adoption.
      if (this.preparing && !this.preparing.signal.aborted) {
        this.preparing.abort();
        this.attempted = null;
      }
      return;
    }
    const signature = getSliceMeshInputSignature(options);
    const changed = !this.signature || !equalSliceMeshInputSignatures(this.signature, signature);
    if (changed) {
      this.signature = signature;
      this.attempted = null;
      this.retried = false;
      this.cancelScheduled();
      this.preparing?.abort();
    }
    if (changed || revisionChanged || becameReady || resumed) {
      // A settled import is about to be sliced; an edit waits for the user to pause.
      this.quietUntil = Date.now()
        + (becameReady ? SLICE_MESH_CACHE_SETTLE_MS : SLICE_MESH_CACHE_QUIET_MS);
      this.cancelScheduled();
    }
    if (paused) {
      this.cancelScheduled();
      return;
    }
    this.schedule();
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.pointers.add(event.pointerId);
    this.cancelScheduled();
    // Do not cancel identical work when the user presses Slice: export joins it.
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.pointers.delete(event.pointerId)) this.onInteraction();
  };

  private readonly onInteraction = () => {
    this.quietUntil = Date.now() + SLICE_MESH_CACHE_QUIET_MS;
    this.cancelScheduled();
    this.schedule();
  };

  private readonly onBlur = () => {
    this.pointers.clear();
    this.cancelScheduled();
  };

  private readonly onVisibility = () => {
    if (this.host.document.hidden) this.cancelScheduled();
    else this.onInteraction();
  };

  private cancelScheduled(): void {
    this.host.clearTimeout(this.timer);
    if (this.idle !== null) this.host.cancelIdleCallback(this.idle);
    this.timer = undefined;
    this.idle = null;
  }

  private schedule(): void {
    if (this.disposed || !this.ready || this.paused || !this.options || !this.signature
      || this.preparing || this.timer !== undefined || this.idle !== null || this.pointers.size > 0
      || this.host.document.hidden || (this.attempted
        && equalSliceMeshInputSignatures(this.signature, this.attempted))
      // A foreground export already published this exact input; nothing to prepare.
      || hasWarmSliceMesh(this.signature)) return;
    this.timer = this.host.setTimeout(() => {
      this.timer = undefined;
      if (!this.ready || this.paused || this.pointers.size > 0 || this.host.document.hidden) return;
      if (typeof this.host.requestIdleCallback === 'function') {
        // Bounded: a busy frame loop must not starve preparation forever.
        this.idle = this.host.requestIdleCallback(() => {
          this.idle = null;
          this.start();
        }, { timeout: SLICE_MESH_CACHE_IDLE_TIMEOUT_MS });
      } else {
        this.start();
      }
    }, Math.max(0, this.quietUntil - Date.now()));
  }

  private start(): void {
    if (this.disposed || !this.ready || this.paused || !this.options || !this.signature
      || this.preparing || this.pointers.size > 0 || this.host.document.hidden) return;
    const signature = getSliceMeshInputSignature(this.options);
    if (!equalSliceMeshInputSignatures(signature, this.signature)) {
      this.update(this.options, this.revision, this.ready, this.paused);
      return;
    }
    this.attempted = signature;
    const controller = new AbortController();
    this.preparing = controller;
    void prewarmSliceMesh(this.options, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn('[SliceMeshWarmup] Preparation unavailable; slice will prepare on demand.', error);
      // One retry per signature: a transient failure must not disable warmup until
      // the scene changes, and a permanent one must not spin.
      if (!this.retried) {
        this.retried = true;
        this.attempted = null;
      }
    }).finally(() => {
      if (this.preparing === controller) this.preparing = null;
      // Superseding edits wait for release before another producer can start.
      this.schedule();
    });
  }

  /** Release the background subscription until a real input signature changes. */
  cancel(): void {
    if (this.disposed) return;
    this.cancelScheduled();
    this.preparing?.abort();
    this.attempted = this.signature;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduled();
    this.preparing?.abort();
    this.unsubscribe();
    this.host.removeEventListener('pointerdown', this.onPointerDown, true);
    this.host.removeEventListener('pointerup', this.onPointerUp, true);
    this.host.removeEventListener('pointercancel', this.onPointerUp, true);
    this.host.removeEventListener('wheel', this.onInteraction);
    this.host.removeEventListener('keydown', this.onInteraction, true);
    this.host.removeEventListener('blur', this.onBlur);
    this.host.removeEventListener('focus', this.onInteraction);
    this.host.document.removeEventListener('visibilitychange', this.onVisibility);
    this.pointers.clear();
    this.options = null;
    this.signature = null;
    this.attempted = null;
  }
}
