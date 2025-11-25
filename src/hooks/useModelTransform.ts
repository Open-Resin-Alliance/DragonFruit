import { useState, useCallback } from 'react';
import * as THREE from 'three';

export type TransformMode = 'select' | 'transform';

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
  autoSnapEnabled: boolean;
  setAutoSnapEnabled: (enabled: boolean) => void;
  snapToLift: (currentLowestWorldZ: number, liftDistance: number) => void;
  snapToPlatform: (currentLowestWorldZ: number) => void;
}

export function useModelTransform(initialPosition?: THREE.Vector3): UseModelTransformReturn {
  const [mode, setMode] = useState<TransformMode>('select');
  const [position, setPositionState] = useState<THREE.Vector3>(initialPosition || new THREE.Vector3(0, 0, 0));
  const [rotation, setRotationState] = useState<THREE.Euler>(new THREE.Euler(0, 0, 0, 'XYZ'));
  const [scale, setScaleState] = useState<THREE.Vector3>(new THREE.Vector3(1, 1, 1));
  const [autoSnapEnabled, setAutoSnapEnabled] = useState<boolean>(true); // Auto-snap enabled by default

  const setPosition = useCallback((x: number, y: number, z: number) => {
    setPositionState(new THREE.Vector3(x, y, z));
  }, []);

  const setRotation = useCallback((x: number, y: number, z: number) => {
    setRotationState(new THREE.Euler(x, y, z, 'XYZ'));
  }, []);

  const setScale = useCallback((x: number, y: number, z: number) => {
    setScaleState(new THREE.Vector3(x, y, z));
  }, []);

  const resetPosition = useCallback(() => {
    setPositionState(new THREE.Vector3(0, 0, 0));
  }, []);

  const resetRotation = useCallback(() => {
    setRotationState(new THREE.Euler(0, 0, 0, 'XYZ'));
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

  const snapToLift = useCallback((currentLowestWorldZ: number, liftDistance: number) => {
    // Current lowest point is at currentLowestWorldZ
    // We want it at liftDistance
    // So adjust position by the difference
    const offset = liftDistance - currentLowestWorldZ;
    
    console.log('[snapToLift]', {
      currentLowestWorldZ,
      liftDistance,
      offset
    });
    
    setPositionState(prev => {
      const newZ = prev.z + offset;
      console.log('[snapToLift] Position change:', { oldZ: prev.z, offset, newZ });
      return new THREE.Vector3(prev.x, prev.y, newZ);
    });
    setAutoSnapEnabled(true); // Re-enable auto-snap
  }, []);

  const snapToPlatform = useCallback((currentLowestWorldZ: number) => {
    // Current lowest point is at currentLowestWorldZ
    // We want it at 0
    // So adjust position by the difference
    const offset = 0 - currentLowestWorldZ;
    
    console.log('[snapToPlatform]', {
      currentLowestWorldZ,
      offset
    });
    
    setPositionState(prev => {
      const newZ = prev.z + offset;
      console.log('[snapToPlatform] Position change:', { oldZ: prev.z, offset, newZ });
      return new THREE.Vector3(prev.x, prev.y, newZ);
    });
    setAutoSnapEnabled(true); // Re-enable auto-snap
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
    autoSnapEnabled,
    setAutoSnapEnabled,
    snapToLift,
    snapToPlatform,
  };
}
