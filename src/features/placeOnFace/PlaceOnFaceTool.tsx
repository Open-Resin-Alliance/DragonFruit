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
  onAnimationStart: () => void;
  onAnimatedTransformChange: (pos: THREE.Vector3, rot: THREE.Euler, scl: THREE.Vector3) => void;
  resolveAnimatedTransform: (candidate: ModelTransform) => ModelTransform;
  onFaceSelect: (modelId: string) => void;
}

interface AnimState {
  startQuat: THREE.Quaternion;
  targetQuat: THREE.Quaternion;
  startTime: number;
  modelId: string;
  startPosition: THREE.Vector3;
  scale: THREE.Vector3;
}

export function PlaceOnFaceTool({
  models,
  activeModelId,
  activeTransform,
  onAnimationStart,
  onAnimatedTransformChange,
  resolveAnimatedTransform,
  onFaceSelect,
}: PlaceOnFaceToolProps) {
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

      const targetWorldNormal = new THREE.Vector3(0, 0, -1);
      const currentWorldQuat = quaternionFromGlobalEuler(transform.rotation);
      const currentWorldNormal = normal.clone().applyQuaternion(currentWorldQuat).normalize();
      const deltaQuat = new THREE.Quaternion().setFromUnitVectors(currentWorldNormal, targetWorldNormal);
      const targetQuat = deltaQuat.multiply(currentWorldQuat);

      onAnimationStart();
      setAnimState({
        startQuat: currentWorldQuat.clone(),
        targetQuat,
        startTime: performance.now(),
        modelId: activeModelId,
        startPosition: transform.position.clone(),
        scale: transform.scale.clone(),
      });
    },
    [activeModel, animState, activeModelId, onAnimationStart, transform]
  );

  useFrame(() => {
    if (!animState || !toolGroupRef.current) return;

    const durationMs = 350;
    const elapsed = performance.now() - animState.startTime;
    const t = Math.min(elapsed / durationMs, 1.0);
    const easeT = 1 - Math.pow(1 - t, 3);
    const currentQuat = animState.startQuat.clone().slerp(animState.targetQuat, easeT);
    const animatedEuler = new THREE.Euler().setFromQuaternion(currentQuat, 'ZYX');
    const resolvedTransform = resolveAnimatedTransform({
      position: animState.startPosition.clone(),
      rotation: animatedEuler,
      scale: animState.scale.clone(),
    });
    const resolvedQuat = quaternionFromGlobalEuler(resolvedTransform.rotation);

    toolGroupRef.current.position.copy(resolvedTransform.position);
    toolGroupRef.current.quaternion.copy(resolvedQuat);
    toolGroupRef.current.scale.copy(resolvedTransform.scale);

    if (targetMeshGroupRef.current) {
      targetMeshGroupRef.current.position.copy(resolvedTransform.position);
      targetMeshGroupRef.current.quaternion.copy(resolvedQuat);
      targetMeshGroupRef.current.scale.copy(resolvedTransform.scale);
    }

    onAnimatedTransformChange(
      resolvedTransform.position.clone(),
      resolvedTransform.rotation.clone(),
      resolvedTransform.scale.clone(),
    );

    if (t >= 1.0) {
      setAnimState(null);
      onFaceSelect(animState.modelId);
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
          geometry={activeModel.geometry}
          onFaceSelect={handleFaceSelect}
        />
      </group>
    </group>
  );
}
