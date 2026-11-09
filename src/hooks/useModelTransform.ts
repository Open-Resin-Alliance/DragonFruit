import { useState, useCallback } from 'react';
import * as THREE from 'three';
import { eulerFromGlobalEuler } from '@/utils/rotation';

const EPSILON = 1e-5;

const approxEqual = (a: number, b: number) => Math.abs(a - b) <= EPSILON;

export type TransformMode = 'select' | 'transform' | 'smoothing' | 'arrange' | 'duplicate' | 'placeOnFace' | 'mirror' | 'hollowing' | 'organicCut' | 'supportBlockers';

export interface ModelTransform {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
}

export interface UseModelTransformReturn {
  mode: TransformMode;
  setMode: (mode: TransformMode) => void;
  transform: ModelTransform;
  setPosition: (x: number, y: number, z: number) => void;
  setRotation: (x: number, y: number, z: number) => void;
  setScale: (x: number, y: number, z: number) => void;
  resetPosition: () => void;
  resetRotation: () => void;
  resetScale: () => void;
  centerXY: () => void;
  setPlatformZ: (modelBBox: THREE.Box3) => void;
}

export function useModelTransform(initialPosition?: THREE.Vector3): UseModelTransformReturn {
  const [mode, setMode] = useState<TransformMode>('select');
  const [position, setPositionState] = useState<THREE.Vector3>(initialPosition || new THREE.Vector3(0, 0, 0));
  const [rotation, setRotationState] = useState<THREE.Euler>(eulerFromGlobalEuler({ x: 0, y: 0, z: 0 }));
  const [scale, setScaleState] = useState<THREE.Vector3>(new THREE.Vector3(1, 1, 1));

  const setPosition = useCallback((x: number, y: number, z: number) => {
    setPositionState(prev => {
      if (approxEqual(prev.x, x) && approxEqual(prev.y, y) && approxEqual(prev.z, z)) {
        return prev;
      }
      return new THREE.Vector3(x, y, z);
    });
  }, []);

  const setRotation = useCallback((x: number, y: number, z: number) => {
    setRotationState(prev => {
      if (approxEqual(prev.x, x) && approxEqual(prev.y, y) && approxEqual(prev.z, z)) {
        return prev;
      }
      return eulerFromGlobalEuler({ x, y, z });
    });
  }, []);

  const setScale = useCallback((x: number, y: number, z: number) => {
    setScaleState(prev => {
      if (approxEqual(prev.x, x) && approxEqual(prev.y, y) && approxEqual(prev.z, z)) {
        return prev;
      }
      return new THREE.Vector3(x, y, z);
    });
  }, []);

  const resetPosition = useCallback(() => {
    setPositionState(new THREE.Vector3(0, 0, 0));
  }, []);

  const resetRotation = useCallback(() => {
    setRotationState(eulerFromGlobalEuler({ x: 0, y: 0, z: 0 }));
  }, []);

  const resetScale = useCallback(() => {
    setScaleState(new THREE.Vector3(1, 1, 1));
  }, []);

  const centerXY = useCallback(() => {
    setPositionState(prev => new THREE.Vector3(0, 0, prev.z));
  }, []);

  const setPlatformZ = useCallback((modelBBox: THREE.Box3) => {
    // Set Z position so bottom of model is at Z=0
    const bottomZ = modelBBox.min.z;
    setPositionState(prev => new THREE.Vector3(prev.x, prev.y, -bottomZ));
  }, []);

  return {
    mode,
    setMode,
    transform: { position, rotation, scale },
    setPosition,
    setRotation,
    setScale,
    resetPosition,
    resetRotation,
    resetScale,
    centerXY,
    setPlatformZ,
  };
}
