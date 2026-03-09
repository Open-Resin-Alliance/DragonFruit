/**
 * Athena-owned NanoDLP upload progress tracker.
 *
 * This logic is specific to NanoDLP's `/plate/add` upload flow, response
 * quirks, and UI telemetry semantics, so it belongs inside the Athena plugin
 * rather than in generic app utilities.
 */

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

const userData: Record<string, any> = {};

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

export function abortUpload(): void {
  const xhr = userData.uploadXhr as XMLHttpRequest | undefined;
  if (xhr) {
    xhr.abort();
    delete userData.uploadXhr;
  }
}

export function getUploadXhr(): XMLHttpRequest | null {
  return userData.uploadXhr ?? null;
}