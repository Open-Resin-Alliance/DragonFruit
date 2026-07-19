import * as THREE from 'three';
import { computeBoundsTree, acceleratedRaycast, MeshBVH } from '@react-three/drei/node_modules/three-mesh-bvh';
import { setSettings } from '@/supports/Settings/state';
import type { SupportSettings } from '@/supports/Settings/types';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { routeRepairSupports, runAutoSupportPlan } from './autoSupportRunner';
import { evaluateCoverageScan } from './verifyCoverage';
import type {
  AutoSupportContactCandidate,
  AutoSupportPlannerSettings,
  AutoSupportPreset,
  AutoSupportProgress,
} from './types';

(THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
(THREE.Mesh.prototype as unknown as { raycast: typeof acceleratedRaycast }).raycast = acceleratedRaycast;

export interface RouteWorkerMeshPayload {
  /** Local-space geometry; the world transform travels separately. */
  positions: Float32Array;
  normals: Float32Array | null;
  index: ArrayLike<number> | null;
  matrixWorld: number[];
  /** MeshBVH.serialize output — deserializing beats rebuilding by ~30s on dense meshes. */
  bvh: { roots: ArrayBuffer[]; index: Uint32Array | Uint16Array | null; indirectBuffer: Uint32Array | Uint16Array | null } | null;
}

export interface RouteWorkerInitMessage {
  type: 'init';
  mesh: RouteWorkerMeshPayload;
  modelId: string;
  settings: SupportSettings;
}

export interface RouteWorkerPlanMessage {
  type: 'plan';
  requestId: number;
  scan: ScanResults;
  scanMinZ: number;
  layerHeightMm: number;
  preset: AutoSupportPreset;
  plannerSettings?: AutoSupportPlannerSettings;
  existingTipPoints: Array<{ x: number; y: number; z: number }>;
}

export interface RouteWorkerRepairMessage {
  type: 'repair';
  requestId: number;
  contacts: AutoSupportContactCandidate[];
  settings: AutoSupportPlannerSettings;
  existingTipPoints: Array<{ x: number; y: number; z: number }>;
}

export interface RouteWorkerEvaluateMessage {
  type: 'evaluate';
  requestId: number;
  scan: ScanResults;
  scanMinZ: number;
  layerHeightMm: number;
  settings: AutoSupportPlannerSettings;
}

export interface RouteWorkerCancelMessage {
  type: 'cancel';
  requestId: number;
}

export type RouteWorkerRequest =
  | RouteWorkerInitMessage
  | RouteWorkerPlanMessage
  | RouteWorkerRepairMessage
  | RouteWorkerEvaluateMessage
  | RouteWorkerCancelMessage;

let mesh: THREE.Mesh | null = null;
let modelId = '';
const abortControllers = new Map<number, AbortController>();

async function withRequest(requestId: number, run: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const abortController = new AbortController();
  abortControllers.set(requestId, abortController);
  try {
    const result = await run(abortController.signal);
    postMessage({ type: 'result', requestId, result });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      postMessage({ type: 'aborted', requestId });
    } else {
      postMessage({ type: 'error', requestId, message: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    abortControllers.delete(requestId);
  }
}

function progressReporter(requestId: number) {
  return (progress: AutoSupportProgress) => {
    postMessage({ type: 'progress', requestId, progress });
  };
}

self.onmessage = (event: MessageEvent<RouteWorkerRequest>) => {
  const message = event.data;
  if (!message) return;

  if (message.type === 'init') {
    const payload = message.mesh;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(payload.positions, 3));
    if (payload.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(payload.normals, 3));
    else geometry.computeVertexNormals();
    if (payload.index) {
      const IndexArray = payload.positions.length / 3 > 65535 ? Uint32Array : Uint16Array;
      geometry.setIndex(new THREE.BufferAttribute(IndexArray.from(payload.index as number[]), 1));
    }
    geometry.computeBoundingBox();
    let deserialized = false;
    if (payload.bvh && payload.bvh.index) {
      try {
        // The bundled SerializedBVH typing omits indirectBuffer; the runtime
        // reads it (serialize emits it for indirect BVHs).
        const serialized = {
          roots: payload.bvh.roots,
          index: payload.bvh.index,
          indirectBuffer: payload.bvh.indirectBuffer,
        } as unknown as Parameters<typeof MeshBVH.deserialize>[0];
        (geometry as unknown as { boundsTree: MeshBVH }).boundsTree = MeshBVH.deserialize(serialized, geometry, { setIndex: true });
        deserialized = true;
      } catch {
        deserialized = false;
      }
    }
    if (!deserialized) {
      (geometry as unknown as { computeBoundsTree: () => void }).computeBoundsTree();
    }
    mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorld.fromArray(payload.matrixWorld);
    modelId = message.modelId;
    setSettings(message.settings);
    postMessage({ type: 'ready' });
    return;
  }

  if (message.type === 'cancel') {
    abortControllers.get(message.requestId)?.abort();
    return;
  }

  if (!mesh) {
    postMessage({ type: 'error', requestId: message.requestId, message: 'route worker not initialised' });
    return;
  }
  const workerMesh = mesh;

  if (message.type === 'plan') {
    void withRequest(message.requestId, (signal) => runAutoSupportPlan({
      scan: message.scan,
      scanMinZ: message.scanMinZ,
      layerHeightMm: message.layerHeightMm,
      preset: message.preset,
      settings: message.plannerSettings,
      modelId,
      mesh: workerMesh,
      existingTipPoints: message.existingTipPoints,
      signal,
      onProgress: progressReporter(message.requestId),
    }));
    return;
  }

  if (message.type === 'repair') {
    void withRequest(message.requestId, (signal) => routeRepairSupports({
      contacts: message.contacts,
      settings: message.settings,
      modelId,
      mesh: workerMesh,
      existingTipPoints: message.existingTipPoints,
      signal,
      onProgress: progressReporter(message.requestId),
    }));
    return;
  }

  if (message.type === 'evaluate') {
    void withRequest(message.requestId, async () => evaluateCoverageScan({
      scan: message.scan,
      scanMinZ: message.scanMinZ,
      layerHeightMm: message.layerHeightMm,
      settings: message.settings,
    }));
  }
};
