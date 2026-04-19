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
  onBeforeFaceApply?: (normal: THREE.Vector3, continueApply: () => void) => boolean;
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
  onBeforeFaceApply,
}: PlaceOnFaceToolProps) {
  const { scene, invalidate } = useThree();
  const toolGroupRef = useRef<THREE.Group>(null);
  const targetMeshGroupRef = useRef<THREE.Group | null>(null);
  const tempQuatRef = useRef(new THREE.Quaternion());
  const tempEulerRef = useRef(new THREE.Euler(0, 0, 0, 'ZYX'));
  const tempPositionRef = useRef(new THREE.Vector3());
  const tempCandidateRef = useRef<ModelTransform>({
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(0, 0, 0, 'ZYX'),
    scale: new THREE.Vector3(1, 1, 1),
  });

  const [animState, setAnimState] = useState<AnimState | null>(null);
  const activeModel = useMemo(() => models.find(m => m.id === activeModelId), [models, activeModelId]);
  const transform = activeTransform || activeModel?.transform;

  const startFaceApplyAnimation = React.useCallback((normal: THREE.Vector3) => {
    if (animState || !activeModel || !activeModelId || !transform) return;

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
  }, [activeModel, activeModelId, animState, onAnimationStart, transform]);

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

  const handleFaceSelect = React.useCallback(
    (normal: THREE.Vector3) => {
      if (animState || !activeModel || !activeModelId || !transform) return; // Prevent multiple clicks during animation

      const proceedImmediately = onBeforeFaceApply
        ? onBeforeFaceApply(normal.clone(), () => startFaceApplyAnimation(normal.clone()))
        : true;

      if (!proceedImmediately) return;

      startFaceApplyAnimation(normal);
    },
    [activeModel, activeModelId, animState, onBeforeFaceApply, startFaceApplyAnimation, transform]
  );

  useFrame(() => {
    if (!animState || !toolGroupRef.current) return;

    const durationMs = 240;
    const elapsed = performance.now() - animState.startTime;
    const t = Math.min(elapsed / durationMs, 1.0);
    const easeT = t * t * (3 - (2 * t));

    const currentQuat = tempQuatRef.current.copy(animState.startQuat).slerp(animState.targetQuat, easeT);
    const animatedEuler = tempEulerRef.current.setFromQuaternion(currentQuat, 'ZYX');
    const candidate = tempCandidateRef.current;
    candidate.position.copy(animState.startPosition);
    candidate.rotation.copy(animatedEuler);
    candidate.scale.copy(animState.scale);

    const resolvedTransform = resolveAnimatedTransform({
      position: candidate.position,
      rotation: candidate.rotation,
      scale: candidate.scale,
    });
    const easedPosition = tempPositionRef.current
      .copy(animState.startPosition)
      .lerp(resolvedTransform.position, easeT);
    const resolvedQuat = quaternionFromGlobalEuler(resolvedTransform.rotation);

    toolGroupRef.current.position.copy(easedPosition);
    toolGroupRef.current.quaternion.copy(resolvedQuat);
    toolGroupRef.current.scale.copy(resolvedTransform.scale);

    if (targetMeshGroupRef.current) {
      targetMeshGroupRef.current.position.copy(easedPosition);
      targetMeshGroupRef.current.quaternion.copy(resolvedQuat);
      targetMeshGroupRef.current.scale.copy(resolvedTransform.scale);
    }

    if (t >= 1.0) {
      // Commit to the transform manager once at the end to avoid heavy
      // per-frame React/store churn during high-refresh animations.
      onAnimatedTransformChange(
        resolvedTransform.position.clone(),
        resolvedTransform.rotation.clone(),
        resolvedTransform.scale.clone(),
      );
      setAnimState(null);
      onFaceSelect(animState.modelId);
    }

    // Keep the demand-mode loop alive while the face-apply animation runs.
    invalidate();
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
