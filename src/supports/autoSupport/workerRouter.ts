import * as THREE from 'three';
import { MeshBVH } from '@react-three/drei/node_modules/three-mesh-bvh';
import type { SupportSettings } from '@/supports/Settings/types';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { routeRepairSupports, runAutoSupportPlan } from './autoSupportRunner';
import { evaluateCoverageScan, type CoverageVerification } from './verifyCoverage';
import type { RouteWorkerMeshPayload } from './autoSupportRoute.worker';
import type {
  AutoSupportContactCandidate,
  AutoSupportPlanPreview,
  AutoSupportPlannerSettings,
  AutoSupportPreset,
  AutoSupportProgress,
  PlannedAutoSupport,
} from './types';

// Generous: in dev, the first worker load includes Turbopack compiling the
// whole placement-stack module graph on demand.
const WORKER_READY_TIMEOUT_MS = 300000;

type Point = { x: number; y: number; z: number };

interface RouteWorkerReply {
  type: 'ready' | 'progress' | 'result' | 'aborted' | 'error';
  requestId?: number;
  progress?: AutoSupportProgress;
  result?: unknown;
  message?: string;
}

export interface AutoSupportPipelineWorker {
  planAutoSupports: (args: {
    scan: ScanResults;
    scanMinZ: number;
    layerHeightMm: number;
    preset: AutoSupportPreset;
    modelId: string;
    mesh: THREE.Mesh;
    existingTipPoints: Point[];
    signal?: AbortSignal;
    onProgress?: (progress: AutoSupportProgress) => void;
  }) => Promise<AutoSupportPlanPreview>;
  repairSupports: (args: {
    contacts: AutoSupportContactCandidate[];
    settings: AutoSupportPlannerSettings;
    modelId: string;
    mesh: THREE.Mesh;
    existingTipPoints: Point[];
    signal?: AbortSignal;
    onProgress?: (progress: AutoSupportProgress) => void;
  }) => Promise<PlannedAutoSupport[]>;
  evaluateCoverage: (args: {
    scan: ScanResults;
    scanMinZ: number;
    layerHeightMm: number;
    settings: AutoSupportPlannerSettings;
  }) => Promise<CoverageVerification>;
  dispose: () => void;
}

/**
 * Copy everything the worker needs to rebuild an identical raycast mesh:
 * local-space geometry, the world matrix, and — crucially — the serialized
 * BVH, so the worker does not spend tens of seconds rebuilding it for dense
 * meshes.
 */
export function extractRouteWorkerMeshPayload(mesh: THREE.Mesh): { payload: RouteWorkerMeshPayload; transfers: ArrayBuffer[] } | null {
  const geometry = mesh.geometry;
  const position = geometry?.getAttribute?.('position');
  if (!position) return null;
  const positions = (position.array as Float32Array).slice();
  const normalAttribute = geometry.getAttribute('normal');
  const normals = normalAttribute ? (normalAttribute.array as Float32Array).slice() : null;
  const indexAttribute = geometry.getIndex();
  const index = indexAttribute ? indexAttribute.array.slice() : null;

  let bvh: RouteWorkerMeshPayload['bvh'] = null;
  const boundsTree = (geometry as unknown as { boundsTree?: MeshBVH }).boundsTree;
  if (boundsTree) {
    try {
      bvh = MeshBVH.serialize(boundsTree, { cloneBuffers: true }) as RouteWorkerMeshPayload['bvh'];
    } catch {
      bvh = null;
    }
  }

  const payload: RouteWorkerMeshPayload = {
    positions,
    normals,
    index,
    matrixWorld: mesh.matrixWorld.toArray(),
    bvh,
  };
  const transfers: ArrayBuffer[] = [positions.buffer as ArrayBuffer];
  if (normals) transfers.push(normals.buffer as ArrayBuffer);
  if (index) transfers.push(index.buffer as ArrayBuffer);
  if (bvh) {
    transfers.push(...bvh.roots);
    if (bvh.index && !transfers.includes(bvh.index.buffer as ArrayBuffer)) transfers.push(bvh.index.buffer as ArrayBuffer);
    if (bvh.indirectBuffer) transfers.push(bvh.indirectBuffer.buffer as ArrayBuffer);
  }
  return { payload, transfers };
}

/** Strip class instances the pipeline never reads so the scan survives structuredClone. */
function serializableScan(scan: ScanResults): ScanResults {
  return { ...scan, islands: [], islandLabelsPerLayer: [] };
}

/**
 * Runs the whole auto-support pipeline off the main thread. Every method
 * falls back to the in-thread implementation when the worker is unavailable,
 * so a broken worker degrades to jank instead of a hang.
 */
export function createAutoSupportRouteWorker(args: {
  mesh: RouteWorkerMeshPayload;
  transfers: ArrayBuffer[];
  modelId: string;
  settings: SupportSettings;
}): AutoSupportPipelineWorker | null {
  if (typeof Worker === 'undefined') return null;

  let worker: Worker;
  try {
    worker = new Worker(new URL('@/supports/autoSupport/autoSupportRoute.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }

  const pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    onProgress?: (progress: AutoSupportProgress) => void;
  }>();
  let nextRequestId = 1;
  let broken = false;

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('route worker init timed out')), WORKER_READY_TIMEOUT_MS);
    const onReady = (event: MessageEvent<RouteWorkerReply>) => {
      if (event.data?.type === 'ready') {
        clearTimeout(timeout);
        worker.removeEventListener('message', onReady);
        resolve();
      }
    };
    worker.addEventListener('message', onReady);
    worker.addEventListener('error', (event) => {
      clearTimeout(timeout);
      console.error('[auto-support] route worker failed:', event.message, event.filename, event.lineno);
      reject(new Error(event.message || 'route worker failed'));
    }, { once: true });
    worker.addEventListener('messageerror', () => {
      clearTimeout(timeout);
      reject(new Error('route worker message deserialization failed'));
    }, { once: true });
  });

  worker.addEventListener('message', (event: MessageEvent<RouteWorkerReply>) => {
    const reply = event.data;
    if (!reply || reply.requestId === undefined) return;
    const entry = pending.get(reply.requestId);
    if (!entry) return;
    if (reply.type === 'progress' && reply.progress) {
      entry.onProgress?.(reply.progress);
      return;
    }
    pending.delete(reply.requestId);
    if (reply.type === 'result') {
      entry.resolve(reply.result);
    } else if (reply.type === 'aborted') {
      entry.reject(new DOMException('Auto support routing aborted', 'AbortError'));
    } else {
      entry.reject(new Error(reply.message ?? 'route worker error'));
    }
  });

  worker.postMessage({ type: 'init', mesh: args.mesh, modelId: args.modelId, settings: args.settings }, args.transfers);

  const request = async (message: Record<string, unknown>, options: {
    signal?: AbortSignal;
    onProgress?: (progress: AutoSupportProgress) => void;
  }): Promise<unknown | null> => {
    if (broken) return null;
    try {
      await ready;
    } catch (error) {
      console.error('[auto-support] route worker unavailable, falling back to in-thread pipeline:', error);
      broken = true;
      return null;
    }
    if (options.signal?.aborted) throw new DOMException('Auto support routing aborted', 'AbortError');
    const requestId = nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject, onProgress: options.onProgress });
      options.signal?.addEventListener('abort', () => {
        worker.postMessage({ type: 'cancel', requestId });
      }, { once: true });
      worker.postMessage({ ...message, requestId });
    });
  };

  return {
    planAutoSupports: async (planArgs) => {
      const result = await request({
        type: 'plan',
        scan: serializableScan(planArgs.scan),
        scanMinZ: planArgs.scanMinZ,
        layerHeightMm: planArgs.layerHeightMm,
        preset: planArgs.preset,
        existingTipPoints: planArgs.existingTipPoints,
      }, { signal: planArgs.signal, onProgress: planArgs.onProgress });
      if (result !== null) return result as AutoSupportPlanPreview;
      return runAutoSupportPlan(planArgs);
    },
    repairSupports: async (repairArgs) => {
      const result = await request({
        type: 'repair',
        contacts: repairArgs.contacts,
        settings: repairArgs.settings,
        existingTipPoints: repairArgs.existingTipPoints,
      }, { signal: repairArgs.signal, onProgress: repairArgs.onProgress });
      if (result !== null) return result as PlannedAutoSupport[];
      return routeRepairSupports(repairArgs);
    },
    evaluateCoverage: async (evaluateArgs) => {
      const result = await request({
        type: 'evaluate',
        scan: serializableScan(evaluateArgs.scan),
        scanMinZ: evaluateArgs.scanMinZ,
        layerHeightMm: evaluateArgs.layerHeightMm,
        settings: evaluateArgs.settings,
      }, {});
      if (result !== null) return result as CoverageVerification;
      return evaluateCoverageScan(evaluateArgs);
    },
    dispose: () => {
      for (const entry of pending.values()) {
        entry.reject(new DOMException('Auto support routing aborted', 'AbortError'));
      }
      pending.clear();
      worker.terminate();
    },
  };
}
