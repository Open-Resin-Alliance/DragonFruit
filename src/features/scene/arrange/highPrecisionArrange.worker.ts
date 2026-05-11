import * as THREE from 'three';
import {
  computeHighPrecisionArrangeResult,
  type ArrangeModel,
  type ArrangeTransform,
  type HighPrecisionArrangeInput,
} from './highPrecisionArrange';
import type {
  HighPrecisionArrangeWorkerMessage,
  HighPrecisionArrangeWorkerRequest,
  SerializedEuler,
  SerializedArrangeModel,
  SerializedArrangeTransform,
  SerializedArrangeUpdate,
} from './highPrecisionArrange.worker.shared';

const toVec3 = (v: [number, number, number]) => new THREE.Vector3(v[0], v[1], v[2]);
const toEuler = (r: SerializedEuler) => new THREE.Euler(r[0], r[1], r[2], r[3]);

const fromTransform = (t: SerializedArrangeTransform): ArrangeTransform => ({
  position: toVec3(t.position),
  rotation: toEuler(t.rotation),
  scale: toVec3(t.scale),
});

const deserializeModel = (m: SerializedArrangeModel): ArrangeModel => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(m.geometry.positions, 3));
  Object.defineProperty(geometry, 'uuid', {
    value: m.geometry.uuid,
    writable: false,
    enumerable: true,
    configurable: true,
  });

  return {
    id: m.id,
    visible: m.visible,
    transform: fromTransform(m.transform),
    geometry: {
      center: toVec3(m.geometry.center),
      geometry,
      supportLocalPoints: m.geometry.supportLocalPoints
        ? (() => {
            const points: THREE.Vector3[] = [];
            const arr = m.geometry.supportLocalPoints;
            for (let i = 0; i + 2 < arr.length; i += 3) {
              points.push(new THREE.Vector3(arr[i], arr[i + 1], arr[i + 2]));
            }
            return points;
          })()
        : undefined,
      supportHullKey: m.geometry.supportHullKey,
    },
  };
};

const serializeUpdate = (update: { id: string; transform: ArrangeTransform }): SerializedArrangeUpdate => ({
  id: update.id,
  transform: {
    position: [update.transform.position.x, update.transform.position.y, update.transform.position.z],
    rotation: [
      update.transform.rotation.x,
      update.transform.rotation.y,
      update.transform.rotation.z,
      update.transform.rotation.order,
    ],
    scale: [update.transform.scale.x, update.transform.scale.y, update.transform.scale.z],
  },
});

self.onmessage = (event: MessageEvent<HighPrecisionArrangeWorkerRequest>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'compute') return;

  try {
    const visibleModels = msg.input.visibleModels.map(deserializeModel);
    const sceneModels = msg.input.sceneModels.map(deserializeModel);

    const input: HighPrecisionArrangeInput = {
      visibleModels,
      sceneModels,
      widthMm: msg.input.widthMm,
      depthMm: msg.input.depthMm,
      originMode: msg.input.originMode,
      arrangeSpacingMm: msg.input.arrangeSpacingMm,
      arrangeAllowRotateOnZ: msg.input.arrangeAllowRotateOnZ,
      arrangeAnchorMode: msg.input.arrangeAnchorMode,
      safetyMarginMm: msg.input.safetyMarginMm,
      getArrangeTransform: (model) => model.transform,
      hullCache: new Map(),
    };

    const result = computeHighPrecisionArrangeResult(input);
    const out: HighPrecisionArrangeWorkerMessage = {
      type: 'result',
      requestId: msg.requestId,
      result: {
        updates: result.updates.map(serializeUpdate),
        packedIds: result.packedIds,
        spilledIds: result.spilledIds,
      },
    };
    self.postMessage(out);
  } catch (error) {
    const out: HighPrecisionArrangeWorkerMessage = {
      type: 'error',
      requestId: msg.requestId,
      error: error instanceof Error ? error.message : 'Unknown worker error',
    };
    self.postMessage(out);
  }
};
