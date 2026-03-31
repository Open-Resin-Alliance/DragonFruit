export interface SupportWorkerRuntimeCapabilities {
  hasWorker: boolean;
  hasSharedArrayBuffer: boolean;
  hasAtomics: boolean;
  crossOriginIsolated: boolean;
  sharedMemoryWorkersEnabled: boolean;
}

let cachedCapabilities: SupportWorkerRuntimeCapabilities | null = null;
let hasLoggedCapabilities = false;

function computeCapabilities(): SupportWorkerRuntimeCapabilities {
  if (typeof window === 'undefined') {
    return {
      hasWorker: false,
      hasSharedArrayBuffer: false,
      hasAtomics: false,
      crossOriginIsolated: false,
      sharedMemoryWorkersEnabled: false,
    };
  }

  const hasWorker = typeof Worker !== 'undefined';
  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  const hasAtomics = typeof Atomics !== 'undefined' && typeof Atomics.load === 'function';
  const crossOriginIsolated = window.crossOriginIsolated === true;
  const sharedMemoryWorkersEnabled = hasWorker && hasSharedArrayBuffer && hasAtomics && crossOriginIsolated;

  return {
    hasWorker,
    hasSharedArrayBuffer,
    hasAtomics,
    crossOriginIsolated,
    sharedMemoryWorkersEnabled,
  };
}

export function getSupportWorkerRuntimeCapabilities() {
  if (!cachedCapabilities) {
    cachedCapabilities = computeCapabilities();
  }

  if (!hasLoggedCapabilities && typeof window !== 'undefined') {
    hasLoggedCapabilities = true;
    const c = cachedCapabilities;
    if (c.sharedMemoryWorkersEnabled) {
      console.info('[SupportWorkers] SharedArrayBuffer + Atomics worker path enabled.');
    } else {
      console.info('[SupportWorkers] SharedArrayBuffer worker path disabled; using standard worker/main-thread fallback.', {
        hasWorker: c.hasWorker,
        hasSharedArrayBuffer: c.hasSharedArrayBuffer,
        hasAtomics: c.hasAtomics,
        crossOriginIsolated: c.crossOriginIsolated,
      });
    }
  }

  return cachedCapabilities;
}
