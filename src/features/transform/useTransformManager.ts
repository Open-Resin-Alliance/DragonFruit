import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useModelTransform, type ModelTransform } from '@/hooks/useModelTransform';
import { computeBoundsZ } from '@/utils/geometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { alignModelToLift, type LiftDropModel } from '@/features/scene/selectionLiftDrop';
import { DEFAULT_LIFT_DISTANCE_MM } from './liftDefaults';

interface TransformManagerProps {
  geom: GeometryWithBounds | null;
  /** The model the live transform belongs to; its own bottom is what a transform holds. */
  activeModel: LiftDropModel | null;
}

export function useTransformManager({ geom, activeModel }: TransformManagerProps) {
  const [isTransforming, setIsTransforming] = useState<boolean>(false);
  const pendingTransformRef = useRef<{ pos: THREE.Vector3; rot: THREE.Euler; scl: THREE.Vector3 } | null>(null);
  /** A manual Z drag sets the height itself, so the live snap stands down for that gesture. */
  const snapEnabledRef = useRef(true);

  // Transform hooks
  const transformHook = useModelTransform();
  const { transform } = transformHook;

  // Lift distance: the amount the Lift action seats a model at.
  const [liftDistance, setLiftDistance] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('liftDistance');
      return saved ? parseFloat(saved) : DEFAULT_LIFT_DISTANCE_MM;
    }
    return DEFAULT_LIFT_DISTANCE_MM;
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('liftDistance', String(liftDistance));
    }
  }, [liftDistance]);

  const setSnapEnabled = useCallback((enabled: boolean) => {
    snapEnabledRef.current = enabled;
  }, []);

  const resolveLiveTransform = useCallback((candidate: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  }) => (
    snapEnabledRef.current && activeModel
      ? alignModelToLift(activeModel, candidate, liftDistance)
      : {
          position: candidate.position.clone(),
          rotation: candidate.rotation.clone(),
          scale: candidate.scale.clone(),
        }
  ), [activeModel, liftDistance]);

  // Compute Z Range
  const zRange = useMemo(() => {
    if (!geom?.bbox) return { min: 0, max: 0 };

    if (isTransforming) {
      const originalHeight = geom.bbox.max.z - geom.bbox.min.z;
      const maxScale = Math.max(transform.scale.x, transform.scale.y, transform.scale.z);
      return { min: 0, max: originalHeight * maxScale * 1.5 };
    }

    const bbox = geom.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(geom.geometry.getAttribute('position') as THREE.BufferAttribute);
    const center = bbox.getCenter(new THREE.Vector3());

    const offsetMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);

    const rotScaleMatrix = new THREE.Matrix4();
    rotScaleMatrix.compose(
      new THREE.Vector3(0, 0, 0),
      quaternionFromGlobalEuler(transform.rotation),
      new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z)
    );

    const posMatrix = new THREE.Matrix4();
    posMatrix.makeTranslation(transform.position.x, transform.position.y, transform.position.z);

    const finalMatrix = posMatrix.multiply(rotScaleMatrix).multiply(offsetMatrix);

    const { max } = computeBoundsZ(geom.geometry, finalMatrix);
    return { min: 0, max };
  }, [
    geom,
    isTransforming,
    transform.position.x, transform.position.y, transform.position.z,
    transform.rotation.x, transform.rotation.y, transform.rotation.z,
    transform.scale.x, transform.scale.y, transform.scale.z
  ]);

  // Handlers for transform
  const onTransformChange = useCallback((pos: THREE.Vector3, rot: THREE.Euler, scl: THREE.Vector3) => {
    const nextTransform = resolveLiveTransform({ position: pos, rotation: rot, scale: scl });

    pendingTransformRef.current = {
      pos: nextTransform.position,
      rot: nextTransform.rotation,
      scl: nextTransform.scale,
    };
    transformHook.setPosition(nextTransform.position.x, nextTransform.position.y, nextTransform.position.z);
    transformHook.setRotation(nextTransform.rotation.x, nextTransform.rotation.y, nextTransform.rotation.z);
    transformHook.setScale(nextTransform.scale.x, nextTransform.scale.y, nextTransform.scale.z);
  }, [resolveLiveTransform, transformHook]);

  /**
   * Reseats after a rotation. `reference` is the transform the gesture started from — the store
   * may already hold the rotated one, so the model's own pre-rotation bottom has to come from the
   * caller's history entry rather than from the model as it stands now.
   */
  const performAutoSnap = useCallback((reference?: ModelTransform): ModelTransform | null => {
    let snapped: ModelTransform | null = null;
    if (snapEnabledRef.current && activeModel) {
      const current = pendingTransformRef.current
        ? {
            position: pendingTransformRef.current.pos,
            rotation: pendingTransformRef.current.rot,
            scale: pendingTransformRef.current.scl,
          }
        : transform;
      snapped = alignModelToLift(
        { ...activeModel, transform: reference ?? activeModel.transform },
        current,
        liftDistance,
      );
      transformHook.setPosition(snapped.position.x, snapped.position.y, snapped.position.z);
      transformHook.setRotation(snapped.rotation.x, snapped.rotation.y, snapped.rotation.z);
      transformHook.setScale(snapped.scale.x, snapped.scale.y, snapped.scale.z);
    }
    pendingTransformRef.current = null;
    return snapped;
  }, [activeModel, liftDistance, transform, transformHook]);

  return {
    transformHook, // Expose full hook if needed
    transform: transformHook.transform,
    transformMode: transformHook.mode,
    setTransformMode: transformHook.setMode,
    isTransforming,
    setIsTransforming,
    liftDistance,
    setLiftDistance,
    setSnapEnabled,
    zRange,
    onTransformChange,
    performAutoSnap,
    pendingTransformRef,
    resolveLiveTransform
  };
}
