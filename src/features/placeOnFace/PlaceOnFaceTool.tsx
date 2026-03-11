import React, { useMemo, useRef, useState, useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { PlaceOnFaceOverlay } from './components/PlaceOnFaceOverlay';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

interface PlaceOnFaceToolProps {
  models: LoadedModel[];
  activeModelId: string | null;
  activeTransform?: ModelTransform;
  onFaceSelect: (modelId: string, newEuler: THREE.Euler) => void;
}

interface AnimState {
  startQuat: THREE.Quaternion;
  targetQuat: THREE.Quaternion;
  startTime: number;
  modelId: string;
}

export function PlaceOnFaceTool({ models, activeModelId, activeTransform, onFaceSelect }: PlaceOnFaceToolProps) {
  const { scene } = useThree();
  const toolGroupRef = useRef<THREE.Group>(null);
  const targetMeshGroupRef = useRef<THREE.Group | null>(null);

  const [animState, setAnimState] = useState<AnimState | null>(null);

  // Find the actual THREE.Group for the active model in the scene
  useEffect(() => {
    let found: THREE.Group | null = null;
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.userData?.modelId === activeModelId) {
        if (obj.parent && obj.parent.type === 'Group') {
          found = obj.parent as THREE.Group;
        }
      }
    });
    targetMeshGroupRef.current = found;
  }, [scene, activeModelId]);

  const activeModel = useMemo(() => models.find(m => m.id === activeModelId), [models, activeModelId]);
  const transform = activeTransform || activeModel?.transform;

  const handleFaceSelect = React.useCallback(
    (normal: THREE.Vector3) => {
      if (animState || !activeModel || !activeModelId || !transform) return; // Prevent multiple clicks during animation

      // Calculate the target rotation
      const targetWorldNormal = new THREE.Vector3(0, 0, -1);
      const currentWorldQuat = quaternionFromGlobalEuler(transform.rotation);
      const currentWorldNormal = normal.clone().applyQuaternion(currentWorldQuat).normalize();
      const deltaQuat = new THREE.Quaternion().setFromUnitVectors(currentWorldNormal, targetWorldNormal);
      const targetQuat = deltaQuat.multiply(currentWorldQuat);

      setAnimState({
        startQuat: currentWorldQuat.clone(),
        targetQuat,
        startTime: performance.now(),
        modelId: activeModelId,
      });
    },
    [activeModel, animState, activeModelId]
  );

  useFrame(() => {
    if (!animState || !toolGroupRef.current) return;

    const durationMs = 350;
    const elapsed = performance.now() - animState.startTime;
    let t = Math.min(elapsed / durationMs, 1.0);
    
    // Cubic ease-out function
    const easeT = 1 - Math.pow(1 - t, 3);
    
    // Interpolate
    const currentQuat = animState.startQuat.clone().slerp(animState.targetQuat, easeT);
    
    // Apply to our overlay group
    toolGroupRef.current.quaternion.copy(currentQuat);

    // Apply directly to the StlMesh group to bypass React lag
    if (targetMeshGroupRef.current) {
      targetMeshGroupRef.current.quaternion.copy(currentQuat);
    }

    if (t >= 1.0) {
      // Done animating
      const finalEuler = new THREE.Euler().setFromQuaternion(currentQuat, 'ZYX');
      setAnimState(null);
      onFaceSelect(animState.modelId, finalEuler);
    }
  });

  const meshLocalOffset = useMemo(() => {
    if (!activeModel) return new THREE.Vector3();
    const geometry = activeModel.geometry.geometry;
    const bbox = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    const center = bbox.getCenter(new THREE.Vector3());
    return new THREE.Vector3(-center.x, -center.y, -center.z);
  }, [activeModel]);

  const currentQuaternion = useMemo(() => {
    if (!transform) return new THREE.Quaternion();
    return quaternionFromGlobalEuler(transform.rotation);
  }, [transform]);

  if (!activeModelId || !activeModel || !transform) return null;

  return (
    <group
      ref={toolGroupRef}
      position={transform.position}
      quaternion={currentQuaternion}
      scale={transform.scale}
    >
      <group position={meshLocalOffset}>
        <PlaceOnFaceOverlay
          active={!animState} // Disable interaction while animating
          geometry={activeModel.geometry.geometry}
          onFaceSelect={handleFaceSelect}
        />
      </group>
    </group>
  );
}
