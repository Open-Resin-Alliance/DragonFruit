import React from 'react';
import * as THREE from 'three';
import type { ModelTransform } from '@/hooks/useModelTransform';
import type { MirrorAxis } from '@/features/mirror/types';
import { bakeWithFlips } from '@/features/mirror/logic/bakeWithFlips';
import {
  buildMirrorSupportTransforms,
  reflectTransformAcrossWorldAxis,
} from '@/features/mirror/logic/buildMirrorSupportTransforms';
import { transformSupportsForModel } from '@/supports/state';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { useTransformManager } from '@/features/transform/useTransformManager';

type MirrorSession = {
  modelId: string;
  flips: { x: boolean; y: boolean; z: boolean };
  initialTransform: ModelTransform;
  previewTransform: ModelTransform;
  initialGeometry: GeometryWithBounds;
};

export type UseMirrorManagerOptions = {
  scene: ReturnType<typeof useSceneCollectionManager>;
  transformMgr: ReturnType<typeof useTransformManager>;
  /** scene.mode === 'prepare' && transformMgr.transformMode === 'mirror' */
  mirrorToolActive: boolean;
  suppressTransformPersistenceCycles: (cycles?: number) => void;
  requestDestructiveTransformSupportDeletionWithContinuation: (
    operationLabel: string,
    onContinue: () => void,
  ) => boolean;
};

export type UseMirrorManagerResult = {
  handleMirror: (axis: MirrorAxis) => void;
  /** Cancels any pending deferred bake and commits it synchronously now. */
  flushPendingBake: () => void;
  /** Live mirror session ref — read `.current` to detect an active session. */
  mirrorSessionRef: React.RefObject<MirrorSession | null>;
};

/** Owns the world-space mirror tool: live preview reflection, deferred
 *  off-thread geometry baking, and session finalization. */
export function useMirrorManager({
  scene,
  transformMgr,
  mirrorToolActive,
  suppressTransformPersistenceCycles,
  requestDestructiveTransformSupportDeletionWithContinuation,
}: UseMirrorManagerOptions): UseMirrorManagerResult {
  const mirrorSessionRef = React.useRef<MirrorSession | null>(null);
  const mirrorPrevToolActiveRef = React.useRef(false);
  const mirrorLocalOriginRef = React.useRef(new THREE.Vector3(0, 0, 0));
  // Tracks a pending deferred bake so we can cancel/flush it on mode switch.
  const pendingBakeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks an in-flight bake worker so it can be terminated on flush.
  const pendingBakeWorkerRef = React.useRef<Worker | null>(null);

  const syncTransformManagerToTransform = React.useCallback((nextTransform: ModelTransform) => {
    // Keep transform-manager state aligned with raw mirror updates so the
    // persistence bridge cannot write a stale transform back into the model.
    suppressTransformPersistenceCycles(8);
    transformMgr.transformHook.setPosition(
      nextTransform.position.x,
      nextTransform.position.y,
      nextTransform.position.z,
    );
    transformMgr.transformHook.setRotation(
      nextTransform.rotation.x,
      nextTransform.rotation.y,
      nextTransform.rotation.z,
    );
    transformMgr.transformHook.setScale(
      nextTransform.scale.x,
      nextTransform.scale.y,
      nextTransform.scale.z,
    );
  }, [suppressTransformPersistenceCycles, transformMgr.transformHook]);

  const finalizeMirrorSession = React.useCallback(() => {
    const session = mirrorSessionRef.current;
    mirrorSessionRef.current = null;
    if (!session) return;

    const { modelId, flips, previewTransform, initialGeometry } = session;
    const anyFlip = flips.x || flips.y || flips.z;

    if (!anyFlip) {
      // Net-zero session (e.g. user clicked X twice). Nothing to commit.
      return;
    }

    let baked: THREE.BufferGeometry | null = null;
    try {
      baked = bakeWithFlips(initialGeometry.geometry, flips);
    } catch (error) {
      console.error('[Mirror] bakeWithFlips threw during finalize, preserving live mirrored state:', error);
      return;
    }
    if (!baked) {
      return;
    }

    // Preserve mirrored orientation while converting from reflected preview
    // transform to baked geometry: finalTransform * bakedGeometry == previewTransform * sourceGeometry.
    const bakeLocalMatrix = new THREE.Matrix4().identity();
    const bakeLocalElements = bakeLocalMatrix.elements;
    bakeLocalElements[0] = flips.x ? -1 : 1;
    bakeLocalElements[5] = flips.y ? -1 : 1;
    bakeLocalElements[10] = flips.z ? -1 : 1;

    const previewMatrix = new THREE.Matrix4().compose(
      previewTransform.position.clone(),
      quaternionFromGlobalEuler(previewTransform.rotation),
      previewTransform.scale.clone(),
    );
    const finalizedMatrix = previewMatrix.clone().multiply(bakeLocalMatrix);
    const finalizedPosition = new THREE.Vector3();
    const finalizedQuaternion = new THREE.Quaternion();
    const finalizedScale = new THREE.Vector3();
    finalizedMatrix.decompose(finalizedPosition, finalizedQuaternion, finalizedScale);
    const finalizedTransform: ModelTransform = {
      position: finalizedPosition,
      rotation: new THREE.Euler().setFromQuaternion(finalizedQuaternion, 'ZYX'),
      scale: finalizedScale,
    };

    // Replace geometry FIRST (direct setModels call using modelsRef.current),
    // then apply the finalized transform AFTER via a functional setModels updater.
    // This ordering matters: replaceModelGeometry uses a direct state value from
    // modelsRef.current (pre-mirror transform), so any prior setModelTransformRaw
    // functional updates get overwritten by the direct call. By setting the transform
    // AFTER replaceModelGeometry, the functional updater applies on top of the
    // direct state and the final batched React state has both the correct geometry
    // AND the correct transform.
    const axes = [flips.x && 'X', flips.y && 'Y', flips.z && 'Z'].filter(Boolean).join(', ');
    scene.replaceModelGeometry(modelId, baked, `Mirror Model (${axes})`, {
      includeSupportState: !flips.z,
    });
    scene.setModelTransformRaw(modelId, {
      position: finalizedTransform.position.clone(),
      rotation: finalizedTransform.rotation.clone(),
      scale: finalizedTransform.scale.clone(),
    });
    syncTransformManagerToTransform(finalizedTransform);
  }, [scene, syncTransformManagerToTransform]);

  // Schedules baking off the main thread via a Web Worker so the visual mirror
  // renders instantly. Cancels any in-flight worker/timer so rapid successive
  // clicks only trigger one bake pass. The session stays alive until the worker
  // completes (or flushPendingBake terminates it) so flushPendingBake can still
  // call finalizeMirrorSession as a synchronous fallback.
  const scheduleBake = React.useCallback(() => {
    // Cancel any previously scheduled bake.
    if (pendingBakeTimerRef.current !== null) {
      clearTimeout(pendingBakeTimerRef.current);
      pendingBakeTimerRef.current = null;
    }
    if (pendingBakeWorkerRef.current) {
      pendingBakeWorkerRef.current.terminate();
      pendingBakeWorkerRef.current = null;
    }

    const session = mirrorSessionRef.current;
    if (!session) return;

    const { modelId, flips, previewTransform, initialGeometry } = session;
    const anyFlip = flips.x || flips.y || flips.z;
    if (!anyFlip) {
      // Net-zero session: clear without baking.
      mirrorSessionRef.current = null;
      return;
    }

    // Compute the finalised transform on the main thread (pure matrix math, fast).
    const bakeLocalMatrix = new THREE.Matrix4().identity();
    const ble = bakeLocalMatrix.elements;
    ble[0] = flips.x ? -1 : 1;
    ble[5] = flips.y ? -1 : 1;
    ble[10] = flips.z ? -1 : 1;
    const previewMatrix = new THREE.Matrix4().compose(
      previewTransform.position.clone(),
      quaternionFromGlobalEuler(previewTransform.rotation),
      previewTransform.scale.clone(),
    );
    const finalizedMatrix = previewMatrix.clone().multiply(bakeLocalMatrix);
    const fPos = new THREE.Vector3();
    const fQuat = new THREE.Quaternion();
    const fScale = new THREE.Vector3();
    finalizedMatrix.decompose(fPos, fQuat, fScale);
    const finalizedTransform: ModelTransform = {
      position: fPos,
      rotation: new THREE.Euler().setFromQuaternion(fQuat, 'ZYX'),
      scale: fScale,
    };

    // Snapshot the geometry arrays needed by the worker.
    const source = initialGeometry.geometry;
    const posAttr = source.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) {
      // No position attribute – fall back to synchronous bake.
      finalizeMirrorSession();
      return;
    }

    // Slice (memcpy) the arrays we need to modify; the originals stay on the
    // main thread so the session geometry remains intact for flush fallback.
    const positions = (posAttr.array as Float32Array).slice();
    const normAttr = source.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const normals = normAttr ? (normAttr.array as Float32Array).slice() : null;
    const idxAttr = source.getIndex();
    const rawIdx = idxAttr?.array;
    let indices: Uint16Array | Uint32Array | null = null;
    let indexType: 'uint16' | 'uint32' | null = null;
    if (rawIdx) {
      indices = rawIdx.slice() as Uint16Array | Uint32Array;
      indexType = rawIdx instanceof Uint16Array ? 'uint16' : 'uint32';
    }
    const posItemSize = posAttr.itemSize;
    const normItemSize = normAttr?.itemSize ?? 3;
    const axes: number[] = [];
    if (flips.x) axes.push(0);
    if (flips.y) axes.push(1);
    if (flips.z) axes.push(2);
    const axisLabel = [flips.x && 'X', flips.y && 'Y', flips.z && 'Z'].filter(Boolean).join(', ');
    const includeSupports = !flips.z;

    const worker = new Worker(
      new URL('@/features/mirror/workers/bakeMirrorWorker', import.meta.url),
      { type: 'module' },
    );
    pendingBakeWorkerRef.current = worker;

    const transferables: Transferable[] = [positions.buffer];
    if (normals) transferables.push(normals.buffer);
    if (indices) transferables.push(indices.buffer);
    worker.postMessage({ positions, normals, indices, posItemSize, normItemSize, axes }, transferables);

    worker.onmessage = (e: MessageEvent) => {
      // Discard result if a newer bake/flush already took over.
      if (pendingBakeWorkerRef.current !== worker) {
        worker.terminate();
        return;
      }
      pendingBakeWorkerRef.current = null;
      worker.terminate();

      // Clear the session now that the worker has committed the bake.
      mirrorSessionRef.current = null;

      const { positions: bp, normals: bn, indices: bi } = e.data as {
        positions: Float32Array;
        normals: Float32Array | null;
        indices: Uint16Array | Uint32Array | null;
      };

      // Reconstruct a Three.js geometry from the worker-returned arrays.
      // We avoid a full geometry.clone() – only the modified arrays were
      // copied; all other attributes (UV, vertex colour, etc.) are shared
      // by reference from the source (safe since they are never modified).
      const baked = new THREE.BufferGeometry();
      baked.setAttribute('position', new THREE.BufferAttribute(bp, posItemSize));
      if (bn) {
        baked.setAttribute('normal', new THREE.BufferAttribute(bn, normItemSize));
      } else {
        baked.computeVertexNormals();
      }
      if (bi) {
        baked.setIndex(new THREE.BufferAttribute(bi, 1));
      }
      const srcAttrs = source.attributes;
      for (const name of Object.keys(srcAttrs)) {
        if (name !== 'position' && name !== 'normal') {
          baked.setAttribute(name, srcAttrs[name] as THREE.BufferAttribute);
        }
      }
      baked.computeBoundingBox();
      baked.computeBoundingSphere();

      scene.replaceModelGeometry(modelId, baked, `Mirror Model (${axisLabel})`, {
        includeSupportState: includeSupports,
      });
      scene.setModelTransformRaw(modelId, {
        position: finalizedTransform.position.clone(),
        rotation: finalizedTransform.rotation.clone(),
        scale: finalizedTransform.scale.clone(),
      });
      syncTransformManagerToTransform(finalizedTransform);
    };

    worker.onerror = () => {
      if (pendingBakeWorkerRef.current !== worker) return;
      pendingBakeWorkerRef.current = null;
      worker.terminate();
      console.error('[Mirror] bake worker failed – falling back to synchronous bake');
      finalizeMirrorSession();
    };
  }, [scene, finalizeMirrorSession, syncTransformManagerToTransform]);

  // Cancels any pending deferred bake (timer or worker) and runs it
  // synchronously now. Used when exiting mirror mode so geometry is committed
  // before the tool switch fires.
  const flushPendingBake = React.useCallback(() => {
    if (pendingBakeTimerRef.current !== null) {
      clearTimeout(pendingBakeTimerRef.current);
      pendingBakeTimerRef.current = null;
    }
    if (pendingBakeWorkerRef.current) {
      pendingBakeWorkerRef.current.terminate();
      pendingBakeWorkerRef.current = null;
    }
    finalizeMirrorSession();
  }, [finalizeMirrorSession]);

  React.useEffect(() => {
    const wasActive = mirrorPrevToolActiveRef.current;
    mirrorPrevToolActiveRef.current = mirrorToolActive;
    if (wasActive && !mirrorToolActive) {
      flushPendingBake();
    }
  }, [mirrorToolActive, flushPendingBake]);

  const handleMirror = React.useCallback((axis: MirrorAxis) => {
    const modelId = scene.activeModelId;
    if (!modelId) return;
    const model = scene.models.find((m) => m.id === modelId);
    if (!model) return;

    if (!mirrorSessionRef.current || mirrorSessionRef.current.modelId !== modelId) {
      // Finalize any prior session that was for a different model first.
      if (mirrorSessionRef.current) flushPendingBake();
      mirrorSessionRef.current = {
        modelId,
        flips: { x: false, y: false, z: false },
        initialTransform: {
          position: model.transform.position.clone(),
          rotation: model.transform.rotation.clone(),
          scale: model.transform.scale.clone(),
        },
        previewTransform: {
          position: model.transform.position.clone(),
          rotation: model.transform.rotation.clone(),
          scale: model.transform.scale.clone(),
        },
        initialGeometry: model.geometry,
      };
    }

    const session = mirrorSessionRef.current;
    if (!session) return;

    const performMirror = () => {
      session.flips[axis] = !session.flips[axis];

      // Reflect the model's transform across the world-space axis through the
      // model's world bbox center. This produces a true world-space mirror
      // regardless of the model's existing rotation.
      const nextTransform = reflectTransformAcrossWorldAxis(
        model.transform,
        mirrorLocalOriginRef.current,
        axis,
      );
      session.previewTransform = {
        position: nextTransform.position.clone(),
        rotation: nextTransform.rotation.clone(),
        scale: nextTransform.scale.clone(),
      };

      // For X/Y also push supports through the same reflection. Z deletes
      // supports up-front via the destructive modal.
      if (axis !== 'z') {
        const supportTransforms = buildMirrorSupportTransforms({
          current: model.transform,
          modelLocalBboxCenter: mirrorLocalOriginRef.current.clone(),
          axis,
        });
        if (supportTransforms) {
          transformSupportsForModel(modelId, supportTransforms.before, supportTransforms.after);
        }
      }

      scene.setModelTransformRaw(modelId, nextTransform);
      syncTransformManagerToTransform(nextTransform);

      // Schedule baking in the next task so the visual mirror renders
      // immediately. The session stays alive until the bake completes.
      // On mode switch, flushPendingBake() will cancel and run synchronously.
      scheduleBake();
    };

    if (axis === 'z') {
      const proceedNow = requestDestructiveTransformSupportDeletionWithContinuation('Mirror Z', performMirror);
      if (proceedNow) performMirror();
    } else {
      performMirror();
    }
  }, [scene, requestDestructiveTransformSupportDeletionWithContinuation, flushPendingBake, scheduleBake, syncTransformManagerToTransform]);

  return { handleMirror, flushPendingBake, mirrorSessionRef };
}
