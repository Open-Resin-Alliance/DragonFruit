import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useModelTransform } from '@/hooks/useModelTransform';
import { computeLowestZ, computeBoundsZ } from '@/utils/geometry';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';

interface TransformManagerProps {
  geom: GeometryWithBounds | null;
}

export function useTransformManager({ geom }: TransformManagerProps) {
  const [isTransforming, setIsTransforming] = useState<boolean>(false);
  const pendingTransformRef = useRef<{ pos: THREE.Vector3; rot: THREE.Euler; scl: THREE.Vector3 } | null>(null);
  
  // Transform hooks
  const transformHook = useModelTransform();
  const { transform, setPosition } = transformHook;

  // Auto-lift settings
  const [autoLift, setAutoLift] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('autoLift');
      return saved ? JSON.parse(saved) : false;
    }
    return false;
  });
  
  const [liftDistance, setLiftDistance] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('liftDistance');
      return saved ? parseFloat(saved) : 5;
    }
    return 5;
  });

  // Persistence
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('autoLift', JSON.stringify(autoLift));
    }
  }, [autoLift]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('liftDistance', String(liftDistance));
    }
  }, [liftDistance]);

  // Helper to find lowest world Z
  const getLowestWorldZ = useCallback((): number | null => {
    if (!geom) return null;

    const currentT = pendingTransformRef.current
      ? {
        position: pendingTransformRef.current.pos,
        rotation: pendingTransformRef.current.rot,
        scale: pendingTransformRef.current.scl
      }
      : transform;

    const bbox = geom.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(geom.geometry.getAttribute('position') as THREE.BufferAttribute);
    const center = bbox.getCenter(new THREE.Vector3());

    const offsetMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
    
    const rotScaleMatrix = new THREE.Matrix4();
    rotScaleMatrix.compose(
      new THREE.Vector3(0, 0, 0),
      new THREE.Quaternion().setFromEuler(currentT.rotation),
      currentT.scale
    );

    const posMatrix = new THREE.Matrix4();
    posMatrix.makeTranslation(currentT.position.x, currentT.position.y, currentT.position.z);

    const finalMatrix = posMatrix.multiply(rotScaleMatrix).multiply(offsetMatrix);

    const z = computeLowestZ(geom.geometry, finalMatrix);
    return z;
  }, [geom, transform]);

  // Auto-snap on lift distance change
  useEffect(() => {
    const lowestWorldZ = getLowestWorldZ();
    if (lowestWorldZ !== null && transformHook.autoSnapEnabled) {
      if (autoLift) {
        transformHook.snapToLift(lowestWorldZ, liftDistance);
      } else {
        transformHook.snapToPlatform(lowestWorldZ);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liftDistance, autoLift]);

  // Initialize transform on load - REMOVED
  // This effect was causing issues in multi-model workflow by resetting 
  // transforms (position=0,0,Z) whenever geometry changed (e.g. switching models).
  // Initial transform logic is now handled by useSceneCollectionManager (for new files)
  // and synced by page.tsx (for existing models).
  /*
  useEffect(() => {
    if (geom?.bbox) {
      const bbox = geom.bbox;
      const center = bbox.getCenter(new THREE.Vector3());
      const heightOffset = center.z - bbox.min.z;
      const finalZ = autoLift ? heightOffset + liftDistance : heightOffset;
      setPosition(0, 0, finalZ);
    }
  }, [geom, setPosition, autoLift, liftDistance]);
  */

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
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z)
      ),
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
    pendingTransformRef.current = { pos, rot, scl };
    transformHook.setPosition(pos.x, pos.y, pos.z);
    transformHook.setRotation(rot.x, rot.y, rot.z);
    transformHook.setScale(scl.x, scl.y, scl.z);
  }, [transformHook]);

  const performAutoSnap = useCallback(() => {
     if (transformHook.autoSnapEnabled) {
        const lowestWorldZ = getLowestWorldZ();
        if (lowestWorldZ !== null) {
            if (autoLift) {
                transformHook.snapToLift(lowestWorldZ, liftDistance);
            } else {
                transformHook.snapToPlatform(lowestWorldZ);
            }
        }
    }
    pendingTransformRef.current = null;
  }, [transformHook, autoLift, liftDistance, getLowestWorldZ]);

  return {
    transformHook, // Expose full hook if needed
    transform: transformHook.transform,
    transformMode: transformHook.mode,
    setTransformMode: transformHook.setMode,
    isTransforming,
    setIsTransforming,
    autoLift,
    setAutoLift,
    liftDistance,
    setLiftDistance,
    zRange,
    onTransformChange,
    performAutoSnap,
    pendingTransformRef,
    getLowestWorldZ
  };
}
