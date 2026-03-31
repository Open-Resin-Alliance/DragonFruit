export type SupportComputeJobKind =
  | 'support-render-lookup'
  | 'joint-drag-preview';

export type SupportComputeJobPriority =
  | 'critical'
  | 'high'
  | 'normal'
  | 'low';

export interface SupportComputeJob<TPayload = unknown, TResult = unknown> {
  id: number;
  kind: SupportComputeJobKind;
  payload: TPayload;
  priority: SupportComputeJobPriority;
  generation: number;
  dedupeKey?: string;
  createdAtMs: number;
  resolve: (value: TResult) => void;
  reject: (reason?: unknown) => void;
}

export type SupportComputeJobRunner = (payload: unknown, signal: AbortSignal) => unknown | Promise<unknown>;

export interface SupportComputeRuntimeOptions {
  runners: Partial<Record<SupportComputeJobKind, SupportComputeJobRunner>>;
  onError?: (jobKind: SupportComputeJobKind, error: unknown) => void;
}

export interface SupportComputeRuntimeStats {
  queued: number;
  inFlight: boolean;
  latestCompletedJobId: number;
  latestCompletedGeneration: number;
}

const PRIORITY_RANK: Record<SupportComputeJobPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export class SupportComputeRuntime {
  private readonly runners: Partial<Record<SupportComputeJobKind, SupportComputeJobRunner>>;
  private readonly onError?: (jobKind: SupportComputeJobKind, error: unknown) => void;

  private queue: Array<SupportComputeJob<unknown, unknown>> = [];
  private inFlight: SupportComputeJob<unknown, unknown> | null = null;
  private inFlightAbortController: AbortController | null = null;
  private drainScheduled = false;

  private nextJobId = 1;
  private latestCompletedJobId = 0;
  private latestCompletedGeneration = 0;

  constructor(options: SupportComputeRuntimeOptions) {
    this.runners = options.runners;
    this.onError = options.onError;
  }

  enqueue<TPayload, TResult>(
    kind: SupportComputeJobKind,
    payload: TPayload,
    options?: {
      priority?: SupportComputeJobPriority;
      generation?: number;
      dedupeKey?: string;
    },
  ): Promise<TResult> {
    const priority = options?.priority ?? 'normal';
    const generation = options?.generation ?? 0;
    const dedupeKey = options?.dedupeKey;

    return new Promise<TResult>((resolve, reject) => {
      const job: SupportComputeJob<TPayload, TResult> = {
        id: this.nextJobId++,
        kind,
        payload,
        priority,
        generation,
        dedupeKey,
        createdAtMs: Date.now(),
        resolve,
        reject,
      };

      if (dedupeKey) {
        // Backpressure primitive: keep only the newest queued job for a dedupe key.
        const existingIndex = this.queue.findIndex((item) => item.dedupeKey === dedupeKey);
        if (existingIndex >= 0) {
          const [stale] = this.queue.splice(existingIndex, 1);
          stale.reject(new Error(`Job superseded: ${dedupeKey}`));
        }
      }

      this.queue.push(job as SupportComputeJob<unknown, unknown>);
      this.scheduleDrain();
    });
  }

  cancelGeneration(maxGenerationInclusive: number) {
    this.queue = this.queue.filter((job) => {
      if (job.generation > maxGenerationInclusive) return true;
      job.reject(new Error(`Job cancelled for generation ${job.generation}`));
      return false;
    });

    if (this.inFlight && this.inFlight.generation <= maxGenerationInclusive) {
      this.inFlightAbortController?.abort();
    }
  }

  snapshotStats(): SupportComputeRuntimeStats {
    return {
      queued: this.queue.length,
      inFlight: this.inFlight !== null,
      latestCompletedJobId: this.latestCompletedJobId,
      latestCompletedGeneration: this.latestCompletedGeneration,
    };
  }

  dispose() {
    const queued = this.queue.splice(0, this.queue.length);
    for (const job of queued) {
      job.reject(new Error('SupportComputeRuntime disposed'));
    }

    if (this.inFlight) {
      this.inFlightAbortController?.abort();
    }

    this.inFlight = null;
    this.inFlightAbortController = null;
    this.drainScheduled = false;
  }

  private scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        this.drainScheduled = false;
        this.drainQueue();
      });
      return;
    }

    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drainQueue();
    });
  }

  private async drainQueue() {
    if (this.inFlight) return;
    if (this.queue.length === 0) return;

    this.queue.sort((a, b) => {
      const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.id - b.id;
    });

    const job = this.queue.shift();
    if (!job) return;

    const runner = this.runners[job.kind];
    if (!runner) {
      job.reject(new Error(`No runner registered for ${job.kind}`));
      this.scheduleDrain();
      return;
    }

    const abortController = new AbortController();
    this.inFlight = job;
    this.inFlightAbortController = abortController;

    try {
      const result = await runner(job.payload, abortController.signal);
      if (abortController.signal.aborted) {
        job.reject(new Error(`Job aborted: ${job.kind}#${job.id}`));
      } else {
        job.resolve(result);
        this.latestCompletedJobId = job.id;
        this.latestCompletedGeneration = job.generation;
      }
    } catch (error) {
      this.onError?.(job.kind, error);
      job.reject(error);
    } finally {
      this.inFlight = null;
      this.inFlightAbortController = null;
      this.scheduleDrain();
    }
  }
}
