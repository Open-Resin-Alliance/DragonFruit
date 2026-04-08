import * as THREE from 'three';
import {
  computeHighPrecisionArrangeUpdates,
  type ArrangeModel,
  type HighPrecisionArrangeInput,
  type HighPrecisionArrangeUpdate,
} from './highPrecisionArrange';
import type {
  HighPrecisionArrangeWorkerInput,
  HighPrecisionArrangeWorkerMessage,
  HighPrecisionArrangeWorkerRequest,
  SerializedArrangeModel,
} from './highPrecisionArrange.worker.shared';

let worker: Worker | null = null;
let requestSeq = 1;
const pending = new Map<number, { resolve: (updates: HighPrecisionArrangeUpdate[]) => void; reject: (reason?: unknown) => void }>();

const ensureWorker = () => {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;

  try {
    worker = new Worker(new URL('./highPrecisionArrange.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<HighPrecisionArrangeWorkerMessage>) => {
      const msg = event.data;
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      pending.delete(msg.requestId);

      if (msg.type === 'error') {
        entry.reject(new Error(msg.error));
        return;
      }

      const updates: HighPrecisionArrangeUpdate[] = msg.updates.map((u) => ({
        id: u.id,
        transform: {
          position: new THREE.Vector3(u.transform.position[0], u.transform.position[1], u.transform.position[2]),
          rotation: new THREE.Euler(
            u.transform.rotation[0],
            u.transform.rotation[1],
            u.transform.rotation[2],
            u.transform.rotation[3],
          ),
          scale: new THREE.Vector3(u.transform.scale[0], u.transform.scale[1], u.transform.scale[2]),
        },
      }));

      entry.resolve(updates);
    };
    worker.onerror = (event) => {
      for (const [, entry] of pending) {
        entry.reject(new Error(event.message || 'High-precision arrange worker failed'));
      }
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }

  return worker;
};

const serializeModel = (model: ArrangeModel, transform: ReturnType<HighPrecisionArrangeInput['getArrangeTransform']>): SerializedArrangeModel => {
  const positionAttr = model.geometry.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const rawArray = positionAttr ? positionAttr.array : null;
  const positions = rawArray instanceof Float32Array
    ? rawArray.slice()
    : new Float32Array(positionAttr ? Array.from(rawArray as ArrayLike<number>) : []);
  const supportLocalPoints = model.geometry.supportLocalPoints;
  const supportLocalPointArray = supportLocalPoints && supportLocalPoints.length > 0
    ? (() => {
        const arr = new Float32Array(supportLocalPoints.length * 3);
        for (let i = 0; i < supportLocalPoints.length; i += 1) {
          const p = supportLocalPoints[i];
          arr[(i * 3) + 0] = p.x;
          arr[(i * 3) + 1] = p.y;
          arr[(i * 3) + 2] = p.z;
        }
        return arr;
      })()
    : undefined;

  return {
    id: model.id,
    visible: model.visible,
    transform: {
      position: [transform.position.x, transform.position.y, transform.position.z],
      rotation: [transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.order],
      scale: [transform.scale.x, transform.scale.y, transform.scale.z],
    },
    geometry: {
      center: [model.geometry.center.x, model.geometry.center.y, model.geometry.center.z],
      uuid: model.geometry.geometry.uuid,
      positions,
      supportLocalPoints: supportLocalPointArray,
      supportHullKey: model.geometry.supportHullKey,
    },
  };
};

const serializeInput = (input: HighPrecisionArrangeInput): HighPrecisionArrangeWorkerInput => ({
  visibleModels: input.visibleModels.map((model) => serializeModel(model, input.getArrangeTransform(model))),
  sceneModels: input.sceneModels.map((model) => serializeModel(model, input.getArrangeTransform(model))),
  widthMm: input.widthMm,
  depthMm: input.depthMm,
  originMode: input.originMode,
  arrangeSpacingMm: input.arrangeSpacingMm,
  arrangeAllowRotateOnZ: input.arrangeAllowRotateOnZ,
  arrangeAnchorMode: input.arrangeAnchorMode,
  safetyMarginMm: input.safetyMarginMm,
});

export async function computeHighPrecisionArrangeUpdatesWorker(input: HighPrecisionArrangeInput): Promise<HighPrecisionArrangeUpdate[]> {
  const w = ensureWorker();
  if (!w) {
    return computeHighPrecisionArrangeUpdates(input);
  }

  const requestId = requestSeq++;
  const request: HighPrecisionArrangeWorkerRequest = {
    type: 'compute',
    requestId,
    input: serializeInput(input),
  };

  const transferables: Transferable[] = [];
  for (const model of request.input.visibleModels) transferables.push(model.geometry.positions.buffer);
  for (const model of request.input.sceneModels) transferables.push(model.geometry.positions.buffer);
  for (const model of request.input.visibleModels) {
    if (model.geometry.supportLocalPoints) transferables.push(model.geometry.supportLocalPoints.buffer);
  }
  for (const model of request.input.sceneModels) {
    if (model.geometry.supportLocalPoints) transferables.push(model.geometry.supportLocalPoints.buffer);
  }

  return new Promise<HighPrecisionArrangeUpdate[]>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try {
      w.postMessage(request, transferables);
    } catch (err) {
      pending.delete(requestId);
      reject(err);
    }
  });
}
