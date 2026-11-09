import React from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { stepFollowHandoff, type FollowHandoffState } from './followModelMoveMath';

type FollowModelMoveProps = {
  modelId: string;
  /** The transform the children were drawn for. */
  baseTransform: ModelTransform;
  /** Live per-model transforms of a drag in flight; the model is absent when it is not moving. */
  liveTransformsRef: React.RefObject<Map<string, ModelTransform>>;
  children: React.ReactNode;
};

/**
 * Carries plate-level helpers along with a model being moved. A drag moves the model
 * imperatively without rerendering the scene, so anything drawn from React props stays
 * where the drag began; this shifts it by the model's live XY offset every frame
 * instead. Only for moves: a rotation or scale changes the helper's shape, not just its
 * place, and Z is left out so the helper stays on the plate.
 *
 * The frame a drag ends is the delicate one: the live transform is already gone while
 * the committed transform may still be a render away, so the last live position is held
 * until the prop catches up (bounded — see `stepFollowHandoff`). Without that the outline
 * snapped back to the drag's starting point for a frame.
 */
export function FollowModelMove({ modelId, baseTransform, liveTransformsRef, children }: FollowModelMoveProps) {
  const groupRef = React.useRef<THREE.Group>(null);
  const handoffRef = React.useRef<FollowHandoffState>({ tracked: null, framesSinceRelease: 0 });

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const live = liveTransformsRef.current?.get(modelId) ?? null;
    const { state, offset } = stepFollowHandoff(
      live ? { x: live.position.x, y: live.position.y } : null,
      { x: baseTransform.position.x, y: baseTransform.position.y },
      handoffRef.current,
    );
    handoffRef.current = state;
    group.position.set(offset.x, offset.y, 0);
  });

  return <group ref={groupRef}>{children}</group>;
}
