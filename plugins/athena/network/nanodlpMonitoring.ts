/**
 * Athena NanoDLP monitoring helpers.
 *
 * Plugin-owned parsing/normalization so app-level monitoring UI can stay
 * backend-agnostic.
 */

type UnknownRecord = Record<string, unknown>;

export type NanoDlpMonitoringSnapshot = {
  connected: boolean;
  stateText: string;
  isPrinting: boolean;
  isPaused: boolean;
  cancelLatched: boolean;
  pauseLatched: boolean;
  finished: boolean;
  progressPct: number | null;
  currentLayer: number | null;
  totalLayers: number | null;
  plateId: number | null;
  jobName: string | null;
  etaSec: number | null;
};

export type NanoDlpWebcamFeedInfo = {
  available: boolean;
  streamUrl: string | null;
  snapshotUrl: string | null;
  message: string;
};

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBooleanFlag(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) return numeric !== 0;
  }
  return Boolean(value);
}

function normalizePercent(value: number | null): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) return null;
  if (value <= 1) return Math.max(0, Math.min(100, value * 100));
  return Math.max(0, Math.min(100, value));
}

type NanoDlpLatchState = {
  cancelLatched: boolean;
  prevStateCode: number;
};

const stateByContext = new Map<string, NanoDlpLatchState>();

function getLatchState(contextKey: string): NanoDlpLatchState {
  const existing = stateByContext.get(contextKey);
  if (existing) return existing;
  const created: NanoDlpLatchState = {
    cancelLatched: false,
    prevStateCode: -1,
  };
  stateByContext.set(contextKey, created);
  return created;
}

function toAbsoluteNanoDlpUrl(candidate: string, host: string, port: number): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  if (trimmed.startsWith('/')) {
    return `http://${host}${port === 80 ? '' : `:${port}`}${trimmed}`;
  }

  if (trimmed.startsWith('//')) {
    return `http:${trimmed}`;
  }

  return `http://${host}${port === 80 ? '' : `:${port}`}/${trimmed.replace(/^\/+/, '')}`;
}

export function resolveNanodlpMonitoringSnapshot(
  payload: unknown,
  contextKey: string = 'default',
): NanoDlpMonitoringSnapshot {
  const root = (payload ?? {}) as UnknownRecord;
  const status = ((root.status ?? root.Status ?? root) ?? {}) as UnknownRecord;
  const latch = getLatchState(contextKey);

  const stateCode = toFiniteNumber(status.State ?? status.state ?? status.STATE);
  const rawPrinting = toBooleanFlag(status.Printing ?? status.printing ?? false);
  const rawPaused = toBooleanFlag(status.Paused ?? status.paused ?? false);

  const normalizedStateCode = (() => {
    if (stateCode != null) return Math.round(stateCode);
    const stateText = String(status.State ?? status.state ?? '').trim().toLowerCase();
    if (stateText === 'printing' || rawPrinting) return 5;
    if (stateText === 'paused' || rawPaused) return 3;
    if (stateText === 'idle') return 0;
    return -1;
  })();

  const currentLayer = toFiniteNumber(status.LayerID ?? status.layerId ?? status.CurrentLayer ?? status.currentLayer);
  const totalLayers = toFiniteNumber(status.LayersCount ?? status.layersCount ?? status.TotalLayers ?? status.totalLayers);
  const plateId = toFiniteNumber(status.PlateID ?? status.plateId ?? status.plate_id ?? status.PlateId ?? status.id);

  const reportedProgress = normalizePercent(toFiniteNumber(status.Progress ?? status.progress ?? status.Percent ?? status.percent));
  const derivedProgress = (currentLayer != null && totalLayers != null && totalLayers > 0)
    ? normalizePercent((currentLayer / totalLayers) * 100)
    : null;

  const etaSec = toFiniteNumber(
    status.TimeRemain
    ?? status.timeRemain
    ?? status.RemainingSec
    ?? status.remainingSec
    ?? status.ETA
    ?? status.eta,
  );

  const jobPath = (status.Path ?? status.path ?? status.File ?? status.file);
  const jobName = typeof jobPath === 'string' && jobPath.trim().length > 0
    ? jobPath.trim()
    : null;

  if (normalizedStateCode === 4) {
    latch.cancelLatched = true;
  }
  if (latch.prevStateCode === 0 && normalizedStateCode === 1) {
    latch.cancelLatched = false;
  }

  const pauseLatched = normalizedStateCode === 2;

  const canonical = (() => {
    if (normalizedStateCode === 0 && latch.cancelLatched) {
      return {
        stateText: 'Idle',
        isPaused: false,
        isPrinting: false,
        cancelLatched: true,
        pauseLatched: false,
        finished: false,
      };
    }

    if (latch.cancelLatched) {
      return {
        stateText: 'Canceling',
        isPaused: false,
        isPrinting: false,
        cancelLatched: true,
        pauseLatched: false,
        finished: false,
      };
    }

    if (normalizedStateCode === 3) {
      return {
        stateText: 'Paused',
        isPaused: true,
        isPrinting: true,
        cancelLatched: false,
        pauseLatched: false,
        finished: false,
      };
    }

    if (normalizedStateCode === 1 || (normalizedStateCode === 5 && rawPrinting)) {
      return {
        stateText: 'Printing',
        isPaused: false,
        isPrinting: true,
        cancelLatched: false,
        pauseLatched: false,
        finished: false,
      };
    }

    if (normalizedStateCode === 2) {
      return {
        stateText: 'Pausing',
        isPaused: false,
        isPrinting: true,
        cancelLatched: false,
        pauseLatched: true,
        finished: false,
      };
    }

    if (rawPaused) {
      return {
        stateText: 'Paused',
        isPaused: true,
        isPrinting: true,
        cancelLatched: false,
        pauseLatched,
        finished: false,
      };
    }

    if (rawPrinting) {
      return {
        stateText: 'Printing',
        isPaused: false,
        isPrinting: true,
        cancelLatched: false,
        pauseLatched,
        finished: false,
      };
    }

    const inferFinished = currentLayer != null || totalLayers != null || jobName != null;
    return {
      stateText: 'Idle',
      isPaused: false,
      isPrinting: false,
      cancelLatched: false,
      pauseLatched,
      finished: inferFinished,
    };
  })();

  latch.prevStateCode = normalizedStateCode;

  const resolvedStateText = [
    canonical.stateText,
    status.Status,
    status.State,
  ].find((value) => typeof value === 'string' && value.trim().length > 0) as string | undefined;

  const connected = root.ok === false ? false : true;

  return {
    connected,
    stateText: resolvedStateText?.trim() || canonical.stateText,
    isPrinting: canonical.isPrinting,
    isPaused: canonical.isPaused,
    cancelLatched: canonical.cancelLatched,
    pauseLatched: canonical.pauseLatched,
    finished: canonical.finished,
    progressPct: reportedProgress ?? derivedProgress,
    currentLayer,
    totalLayers,
    plateId: plateId != null && plateId > 0 ? Math.round(plateId) : null,
    jobName,
    etaSec: etaSec != null && etaSec >= 0 ? etaSec : null,
  };
}

export function resolveNanodlpWebcamFeedInfo(
  payload: unknown,
  host: string,
  port: number,
): NanoDlpWebcamFeedInfo {
  const root = (payload ?? {}) as UnknownRecord;

  if (root.ok === false) {
    return {
      available: false,
      streamUrl: null,
      snapshotUrl: null,
      message: typeof root.error === 'string' ? root.error : 'Webcam feed unavailable.',
    };
  }

  const status = ((root.status ?? root.Status ?? root) ?? {}) as UnknownRecord;

  const explicitRootCandidates = [
    root.streamUrl,
    root.snapshotUrl,
    ...(Array.isArray(root.candidates) ? root.candidates : []),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => toAbsoluteNanoDlpUrl(value, host, port))
    .filter((value): value is string => Boolean(value));

  const statusCandidates = [
    status.WebcamURL,
    status.webcamUrl,
    status.Webcam,
    status.webcam,
    status.CameraURL,
    status.cameraUrl,
    status.StreamURL,
    status.streamUrl,
    status.MjpegURL,
    status.mjpegUrl,
    status.SnapshotURL,
    status.snapshotUrl,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => toAbsoluteNanoDlpUrl(value, host, port))
    .filter((value): value is string => Boolean(value));

  const deduped = Array.from(new Set([...explicitRootCandidates, ...statusCandidates]));
  const snapshotUrl = deduped.find((value) => /snapshot|jpg|jpeg|png/i.test(value)) ?? deduped[0] ?? null;
  const streamUrl = deduped.find((value) => /stream|mjpeg|video/i.test(value)) ?? deduped[0] ?? null;

  if (!streamUrl && !snapshotUrl) {
    return {
      available: false,
      streamUrl: null,
      snapshotUrl: null,
      message: typeof root.message === 'string' && root.message.trim().length > 0
        ? root.message.trim()
        : 'No webcam endpoint reported by this printer.',
    };
  }

  return {
    available: true,
    streamUrl,
    snapshotUrl,
    message: typeof root.message === 'string' && root.message.trim().length > 0
      ? root.message.trim()
      : 'Webcam feed detected.',
  };
}
