export type PrinterReachabilityMap = Record<string, boolean | null>;

type Listener = () => void;

const SERVER_SNAPSHOT: PrinterReachabilityMap = {};

let reachabilityMap: PrinterReachabilityMap = {};
const listeners = new Set<Listener>();

function shallowEqualReachabilityMap(a: PrinterReachabilityMap, b: PrinterReachabilityMap): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // no-op
    }
  });
}

export function subscribeToPrinterReachability(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPrinterReachabilitySnapshot(): PrinterReachabilityMap {
  return reachabilityMap;
}

export function getPrinterReachabilityServerSnapshot(): PrinterReachabilityMap {
  return SERVER_SNAPSHOT;
}

export function setPrinterReachabilityMap(next: PrinterReachabilityMap): void {
  const normalized: PrinterReachabilityMap = {};
  for (const [id, value] of Object.entries(next)) {
    if (!id || id.trim().length === 0) continue;
    normalized[id] = value === true ? true : value === false ? false : null;
  }

  if (shallowEqualReachabilityMap(reachabilityMap, normalized)) return;
  reachabilityMap = normalized;
  notify();
}

export function patchPrinterReachabilityMap(patch: PrinterReachabilityMap): void {
  setPrinterReachabilityMap({
    ...reachabilityMap,
    ...patch,
  });
}
