/**
 * Athena-owned NanoDLP upload progress tracker.
 *
 * This logic is specific to NanoDLP's `/plate/add` upload flow, response
 * quirks, and UI telemetry semantics, so it belongs inside the Athena plugin
 * rather than in generic app utilities.
 */

import { pluginNetworkFetch, readNativeFileSize } from '@/utils/pluginNetworkBridge';

export type UploadProgressEvent = {
  loaded: number;
  total: number;
  uploadSpeed: string;
  remainingTime: string;
  transferred: string;
  percentComplete: number;
};

export type UploadStatusUpdate = {
  stage: 'uploading' | 'processing' | 'complete' | 'error';
  message: string;
  progress?: UploadProgressEvent;
  plateId?: number | null;
  error?: string;
};

type UploadCallbacks = {
  onProgress: (event: UploadProgressEvent) => void;
  onStatusUpdate: (update: UploadStatusUpdate) => void;
  onComplete?: (plateId: number | null) => void;
  onError?: (error: string) => void;
};

function bytesToStringRep(bytes: number): string {
  const absolute = Math.max(0, bytes);

  if (absolute >= 1000000000) {
    return `${(absolute / 1000000000).toFixed(absolute >= 10000000000 ? 0 : 1)} Gb`;
  }
  if (absolute >= 1000000) {
    return `${(absolute / 1000000).toFixed(absolute >= 10000000 ? 0 : 1)} Mb`;
  }
  if (absolute >= 1000) {
    return `${(absolute / 1000).toFixed(absolute >= 10000 ? 0 : 1)} Kb`;
  }

  return `${Math.round(absolute)} b`;
}

function secondsToTimeString(seconds: number): string {
  const normalized = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0;
  const secs = normalized % 60;
  const temp = (normalized - secs) / 60;
  const mins = temp % 60;
  const hrs = (temp - mins) / 60;

  let str = '';
  if (hrs < 10) str += '0';
  str += hrs;
  str += ':';
  if (mins < 10) str += '0';
  str += mins;
  str += ':';
  if (secs < 10) str += '0';
  str += secs;

  return str;
}

function getPlateIdFromResponse(responseText: string, location: string): number | null {
  const locationMatch = /\/(\d+)(?:\D*$)?/.exec(location);
  if (locationMatch) {
    const id = Number(locationMatch[1]);
    if (Number.isFinite(id) && id > 0) return id;
  }

  const bodyMatch = /(plate[_\s-]?id|\bplate\b)\D{0,12}(\d{1,10})/i.exec(responseText);
  if (bodyMatch) {
    const id = Number(bodyMatch[2]);
    if (Number.isFinite(id) && id > 0) return id;
  }

  return null;
}

function getSafeResponseHeader(xhr: XMLHttpRequest, name: string): string {
  try {
    return xhr.getResponseHeader(name) || '';
  } catch {
    return '';
  }
}

const userData: {
  uploadXhr?: XMLHttpRequest;
} = {};

function parseHostAndPortFromUrl(hostUrl: string): { host: string; port: number } {
  const trimmed = hostUrl.trim();
  if (!trimmed) {
    throw new Error('Host URL is required for NanoDLP upload');
  }

  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(normalized);
  const host = parsed.hostname.trim();
  if (!host) {
    throw new Error('Invalid host URL for NanoDLP upload');
  }

  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error('Invalid host port for NanoDLP upload');
  }

  return { host, port };
}

export async function uploadToNanoDlpWithProgress(
  hostUrl: string,
  zipBlob: Blob,
  path: string,
  profileId: string,
  callbacks: UploadCallbacks,
): Promise<{ ok: boolean; plateId: number | null }> {
  return new Promise((resolve, reject) => {
    let lastProgressTs = Date.now();
    let lastProgressLoaded = 0;
    const uploadStartedTs = Date.now();
    let smoothedBytesPerSecond = 0;

    const form = new FormData();
    form.set('Path', path);
    form.set('ProfileID', profileId);
    form.set('ZipFile', zipBlob, `${path}.nanodlp`);

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e: ProgressEvent<XMLHttpRequestUpload>) => {
      if (!e.lengthComputable) return;

      const percentComplete = Math.round(((e.loaded / e.total) * 100) * 100) / 100;
      const loadedStr = bytesToStringRep(e.loaded);
      const totalStr = bytesToStringRep(e.total);

      const now = Date.now();
      const timeSinceLastCall = Math.max(1, now - lastProgressTs);
      const uploadAmountSinceLastCall = e.loaded - lastProgressLoaded;

      lastProgressTs = now;
      lastProgressLoaded = e.loaded;

      const instantaneousBytesPerSecond = Math.max(0, uploadAmountSinceLastCall / (timeSinceLastCall / 1000));
      const elapsedSeconds = Math.max(0.001, (now - uploadStartedTs) / 1000);
      const averageUploadSpeed = Math.max(0, e.loaded / elapsedSeconds);

      if (smoothedBytesPerSecond <= 0) {
        smoothedBytesPerSecond = instantaneousBytesPerSecond || averageUploadSpeed;
      } else if (instantaneousBytesPerSecond > 0) {
        smoothedBytesPerSecond = (smoothedBytesPerSecond * 0.8) + (instantaneousBytesPerSecond * 0.2);
      }

      const effectiveBytesPerSecond = Math.max(
        averageUploadSpeed * 0.65,
        (smoothedBytesPerSecond * 0.75) + (averageUploadSpeed * 0.25),
      );
      const uploadSpeedStr = `${bytesToStringRep(effectiveBytesPerSecond)}/s`;
      const secondsRemaining = effectiveBytesPerSecond > 0
        ? (e.total - e.loaded) / effectiveBytesPerSecond
        : 0;
      const remainingTimeStr = secondsToTimeString(secondsRemaining);

      const progressEvent: UploadProgressEvent = {
        loaded: e.loaded,
        total: e.total,
        uploadSpeed: uploadSpeedStr,
        remainingTime: remainingTimeStr,
        transferred: `${loadedStr} / ${totalStr}`,
        percentComplete,
      };

      callbacks.onProgress(progressEvent);

      if (e.loaded === e.total) {
        callbacks.onStatusUpdate({
          stage: 'processing',
          message: 'File uploaded, processing on device…',
          progress: progressEvent,
        });
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status === 200 || xhr.status === 302) {
        const responseText = xhr.responseText || '';
        const location = getSafeResponseHeader(xhr, 'location');
        const plateId = getPlateIdFromResponse(responseText, location);

        callbacks.onStatusUpdate({
          stage: 'complete',
          message: 'Upload complete',
          plateId,
        });

        if (callbacks.onComplete) {
          callbacks.onComplete(plateId);
        }

        resolve({ ok: true, plateId });
      } else {
        const error = `HTTP ${xhr.status}: ${xhr.statusText}`;
        callbacks.onStatusUpdate({
          stage: 'error',
          message: 'Upload failed',
          error,
        });

        if (callbacks.onError) {
          callbacks.onError(error);
        }

        reject(new Error(error));
      }
    });

    xhr.addEventListener('error', () => {
      const error = 'Network error during upload';
      callbacks.onStatusUpdate({
        stage: 'error',
        message: error,
        error,
      });

      if (callbacks.onError) {
        callbacks.onError(error);
      }

      reject(new Error(error));
    });

    xhr.addEventListener('abort', () => {
      const error = 'Upload canceled';
      callbacks.onStatusUpdate({
        stage: 'error',
        message: error,
        error,
      });

      if (callbacks.onError) {
        callbacks.onError(error);
      }

      reject(new Error(error));
    });

    xhr.open('POST', `${hostUrl}/plate/add`);

    userData.uploadXhr = xhr;
    xhr.send(form);
  });
}

export async function uploadToNanoDlpFromPathWithProgress(
  hostUrl: string,
  zipFilePath: string,
  path: string,
  profileId: string,
  callbacks: UploadCallbacks,
): Promise<{ ok: boolean; plateId: number | null }> {
  const normalizedPath = zipFilePath.trim();
  if (!normalizedPath) {
    throw new Error('zipFilePath is required for native NanoDLP upload');
  }

  const { host, port } = parseHostAndPortFromUrl(hostUrl);
  const uploadId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `nanodlp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const fileSize = await readNativeFileSize(normalizedPath);
  const knownTotal = Number.isFinite(fileSize) && (fileSize ?? 0) > 0
    ? Number(fileSize)
    : null;

  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let progressPollInFlight = false;
  const uploadStartedTs = Date.now();
  let lastProgressTs = uploadStartedTs;
  let lastProgressLoaded = 0;
  let smoothedBytesPerSecond = 0;
  let currentLoaded = 0;
  let currentTotal = knownTotal ?? 0;
  let uploadBytesFullySent = false;

  const emitProgress = (loadedInput: number, totalInput: number, options?: { phase?: 'uploading' | 'processing' | 'complete' }) => {
    const phase = options?.phase ?? 'uploading';
    const safeTotal = Math.max(1, Number.isFinite(totalInput) ? Math.round(totalInput) : 1);
    const loaded = Math.max(0, Math.min(Math.round(loadedInput), safeTotal));

    const now = Date.now();
    const timeSinceLastCall = Math.max(1, now - lastProgressTs);
    const uploadAmountSinceLastCall = Math.max(0, loaded - lastProgressLoaded);

    lastProgressTs = now;
    lastProgressLoaded = loaded;

    const instantaneousBytesPerSecond = Math.max(0, uploadAmountSinceLastCall / (timeSinceLastCall / 1000));
    const elapsedSeconds = Math.max(0.001, (now - uploadStartedTs) / 1000);
    const averageUploadSpeed = Math.max(0, loaded / elapsedSeconds);

    if (phase === 'uploading') {
      if (smoothedBytesPerSecond <= 0) {
        smoothedBytesPerSecond = instantaneousBytesPerSecond || averageUploadSpeed;
      } else if (instantaneousBytesPerSecond > 0) {
        smoothedBytesPerSecond = (smoothedBytesPerSecond * 0.8) + (instantaneousBytesPerSecond * 0.2);
      }
    }

    const effectiveBytesPerSecond = phase === 'uploading'
      ? Math.max(
          averageUploadSpeed * 0.65,
          (smoothedBytesPerSecond * 0.75) + (averageUploadSpeed * 0.25),
        )
      : 0;

    const uploadSpeed = phase === 'complete'
      ? 'done'
      : phase === 'processing'
        ? 'uploaded'
        : effectiveBytesPerSecond > 0
          ? `${bytesToStringRep(effectiveBytesPerSecond)}/s`
          : 'starting…';

    const remainingTime = phase === 'complete'
      ? '00:00:00'
      : phase === 'processing'
        ? 'processing…'
        : effectiveBytesPerSecond > 0
          ? secondsToTimeString((safeTotal - loaded) / effectiveBytesPerSecond)
          : 'estimating…';

    const transferred = (knownTotal ?? currentTotal) > 0
      ? `${bytesToStringRep(loaded)} / ${bytesToStringRep(safeTotal)}`
      : `${bytesToStringRep(loaded)} / unknown`;

    callbacks.onProgress({
      loaded,
      total: safeTotal,
      uploadSpeed,
      remainingTime,
      transferred,
      percentComplete: phase === 'complete'
        ? 100
        : Math.round(((loaded / safeTotal) * 100) * 100) / 100,
    });
  };

  const pollNativeUploadProgress = async () => {
    if (progressPollInFlight) return;
    progressPollInFlight = true;

    try {
      const response = await pluginNetworkFetch({
        pluginId: 'athena',
        operation: 'nanodlp/job/upload-progress',
        host,
        ipAddress: host,
        port,
        uploadId,
      });

      if (!response.ok) return;

      const payloadRaw = await response.json().catch(() => ({}));
      const payload: Record<string, unknown> = payloadRaw && typeof payloadRaw === 'object'
        ? payloadRaw as Record<string, unknown>
        : {};
      const uploadRaw = payload.upload;
      const upload = uploadRaw && typeof uploadRaw === 'object'
        ? uploadRaw as Record<string, unknown>
        : null;
      if (!upload) return;

      const sentBytes = Number(upload.sentBytes);
      const totalBytes = Number(upload.totalBytes);
      if (!Number.isFinite(sentBytes) || sentBytes < 0 || !Number.isFinite(totalBytes) || totalBytes <= 0) {
        return;
      }

      currentLoaded = Math.max(0, Math.min(Math.round(sentBytes), Math.round(totalBytes)));
      currentTotal = Math.max(1, Math.round(totalBytes));

      const fullyTransferred = currentLoaded >= currentTotal;

      if (fullyTransferred && !uploadBytesFullySent) {
        // Bytes are all sent; NanoDLP is now processing server-side.
        // Stop the poll timer so speed/ETA don't drift, then signal processing.
        // NOTE: do NOT call emitProgress here — onProgress clears the 220ms
        // handoff timeout in page.tsx that transitions to the indeterminate bar.
        uploadBytesFullySent = true;
        if (progressTimer !== null) {
          clearInterval(progressTimer);
          progressTimer = null;
        }
        callbacks.onStatusUpdate({
          stage: 'processing',
          message: 'File uploaded, processing on device…',
        });
      } else if (!fullyTransferred) {
        emitProgress(currentLoaded, currentTotal, { phase: 'uploading' });
      }
    } finally {
      progressPollInFlight = false;
    }
  };

  callbacks.onStatusUpdate({
    stage: 'uploading',
    message: 'Uploading print job to NanoDLP device…',
  });

  emitProgress(0, knownTotal ?? 1, { phase: 'uploading' });
  progressTimer = setInterval(() => {
    void pollNativeUploadProgress();
  }, 280);
  void pollNativeUploadProgress();

  try {
    const response = await pluginNetworkFetch({
      pluginId: 'athena',
      operation: 'nanodlp/job/import',
      host,
      ipAddress: host,
      port,
      path,
      profileId,
      zipFilePath: normalizedPath,
      uploadId,
    });

    const payloadRaw = await response.json().catch(() => ({}));
    const payload: Record<string, unknown> = payloadRaw && typeof payloadRaw === 'object'
      ? payloadRaw as Record<string, unknown>
      : {};

    if (!response.ok || payload.ok === false) {
      const reason = typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`;
      throw new Error(reason);
    }

    // If the poll never detected full transfer (fast/local uploads), transition to
    // processing now so the user sees the state before complete fires.
    // NOTE: do NOT call emitProgress here — onProgress clears the 220ms
    // handoff timeout in page.tsx that transitions to the indeterminate bar.
    if (!uploadBytesFullySent) {
      uploadBytesFullySent = true;
      callbacks.onStatusUpdate({
        stage: 'processing',
        message: 'File uploaded, processing on device…',
      });
    }

    const plateIdRaw = Number(payload.plateId);
    const plateId = Number.isFinite(plateIdRaw) && plateIdRaw > 0
      ? Math.round(plateIdRaw)
      : null;

    callbacks.onStatusUpdate({
      stage: 'complete',
      message: 'Upload complete',
      plateId,
    });

    callbacks.onComplete?.(plateId);
    const finalTotal = currentTotal > 0 ? currentTotal : (knownTotal ?? 1);
    emitProgress(finalTotal, finalTotal, { phase: 'complete' });

    return { ok: true, plateId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to upload print job to NanoDLP';
    callbacks.onStatusUpdate({
      stage: 'error',
      message: 'Upload failed',
      error: message,
    });
    callbacks.onError?.(message);
    throw error;
  } finally {
    if (progressTimer !== null) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }
}

export function abortUpload(): void {
  const xhr = userData.uploadXhr;
  if (xhr) {
    xhr.abort();
    delete userData.uploadXhr;
  }
}

export function getUploadXhr(): XMLHttpRequest | null {
  return userData.uploadXhr ?? null;
}