import { isTauriRuntime } from '@/utils/tauriRuntime';
import {
  equalSliceMeshInputSignatures,
  getSliceMeshInputSignature,
  prewarmSliceMesh,
  subscribeSliceMeshInputChanges,
} from './sliceMeshSnapshot';
import type { SliceMeshInputSignature, SliceMeshPrewarmOptions } from './sliceMeshSnapshot';

const QUIET_MS = 750;

/** Prepares the active slicing context once per real revision, outside slice startup. */
export class SliceMeshWarmup {
  private options: SliceMeshPrewarmOptions | null = null;
  private signature: SliceMeshInputSignature | null = null;
  private attempted: SliceMeshInputSignature | null = null;
  private timer: number | null = null;
  private idle: number | null = null;
  private preparing: AbortController | null = null;
  private readonly pointers = new Set<number>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private imminentSlice = false;
  private ready = true;
  private paused = false;

  constructor(private readonly host: Window) {
    this.unsubscribe = subscribeSliceMeshInputChanges(() => this.update(this.options, this.imminentSlice, this.ready, this.paused));
    host.addEventListener('pointerdown', this.onPointerDown, true);
    host.addEventListener('pointerup', this.onPointerUp, true);
    host.addEventListener('pointercancel', this.onPointerUp, true);
    host.addEventListener('wheel', this.onInteraction, { passive: true });
    host.addEventListener('keydown', this.onInteraction, true);
    host.addEventListener('blur', this.onBlur);
    host.addEventListener('focus', this.onInteraction);
    host.document.addEventListener('visibilitychange', this.onVisibility);
  }

  update(options: SliceMeshPrewarmOptions | null, imminentSlice = false, ready = true, paused = false): void {
    if (this.disposed) return;
    const wasReady = this.ready;
    const wasPaused = this.paused;
    this.ready = ready;
    this.paused = paused;
    // Foreground startup can spend time on thumbnails/save before joining preparation.
    // Stop new work while busy, but keep the matching background lease available to it.
    if (paused) this.cancelScheduled();
    const becameImminent = imminentSlice && !this.imminentSlice;
    this.imminentSlice = imminentSlice;
    this.options = options;
    if (!options || !isTauriRuntime() || !options.models.some(model => model.visible
      && !options.excludedModelIds?.includes(model.id))) {
      this.signature = null;
      this.attempted = null;
      this.cancelScheduled();
      this.preparing?.abort();
      this.preparing = null;
      return;
    }
    if (!ready) {
      this.cancelScheduled();
      // A settled retry is allowed only for work interrupted here, not a user cancel.
      if (this.preparing) {
        this.preparing.abort();
        this.preparing = null;
        this.attempted = null;
      }
      return;
    }
    const signature = getSliceMeshInputSignature(options);
    if (this.signature && equalSliceMeshInputSignatures(this.signature, signature)) {
      if (becameImminent || !wasReady || (wasPaused && !paused)) this.schedule(becameImminent);
      return;
    }
    const initialContext = this.signature === null;
    this.signature = signature;
    this.attempted = null;
    this.cancelScheduled();
    this.preparing?.abort();
    this.preparing = null;
    this.schedule(initialContext || this.imminentSlice);
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.pointers.add(event.pointerId);
    this.cancelScheduled();
    // Do not cancel identical work when the user presses Slice: export joins it.
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.pointers.delete(event.pointerId)) this.schedule();
  };

  private readonly onInteraction = () => {
    this.cancelScheduled();
    this.schedule();
  };

  private readonly onBlur = () => {
    this.pointers.clear();
    this.cancelScheduled();
  };

  private readonly onVisibility = () => {
    if (this.host.document.hidden) this.cancelScheduled();
    else this.schedule();
  };

  private cancelScheduled(): void {
    if (this.timer !== null) this.host.clearTimeout(this.timer);
    if (this.idle !== null) this.host.cancelIdleCallback(this.idle);
    this.timer = null;
    this.idle = null;
  }

  private schedule(initialContext = false): void {
    if (this.disposed || !this.ready || this.paused || !this.options || !this.signature || this.pointers.size > 0
      || this.host.document.hidden || (this.attempted
        && equalSliceMeshInputSignatures(this.signature, this.attempted))) return;
    this.cancelScheduled();
    this.timer = this.host.setTimeout(() => {
      this.timer = null;
      if (this.pointers.size > 0 || this.host.document.hidden) return;
      if (typeof this.host.requestIdleCallback === 'function') {
        // No timeout: never force background preparation while the UI is busy.
        this.idle = this.host.requestIdleCallback(() => {
          this.idle = null;
          this.start();
        });
      } else {
        this.start();
      }
    }, initialContext || this.imminentSlice ? 0 : QUIET_MS);
  }

  private start(): void {
    if (this.disposed || !this.ready || this.paused || !this.options || !this.signature || this.pointers.size > 0
      || this.host.document.hidden) return;
    const signature = getSliceMeshInputSignature(this.options);
    if (!equalSliceMeshInputSignatures(signature, this.signature)) {
      this.update(this.options, this.imminentSlice, this.ready, this.paused);
      return;
    }
    this.attempted = signature;
    const controller = new AbortController();
    this.preparing = controller;
    void prewarmSliceMesh(this.options, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) console.warn('[SliceMeshWarmup] Preparation unavailable; slice will prepare on demand.', error);
    }).finally(() => {
      if (this.preparing === controller) this.preparing = null;
    });
  }

  /** Stop this context's background subscription until a real input revision changes. */
  cancel(): void {
    if (this.disposed) return;
    this.cancelScheduled();
    this.preparing?.abort();
    this.preparing = null;
    this.attempted = this.signature;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduled();
    this.preparing?.abort();
    this.preparing = null;
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
