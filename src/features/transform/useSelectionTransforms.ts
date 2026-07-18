import { useCallback } from 'react';
import * as THREE from 'three';
import type { ModelTransform } from '@/hooks/useModelTransform';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { useTransformManager } from '@/features/transform/useTransformManager';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

type GroupCommitEntry = { modelId: string; before: ModelTransform; after: ModelTransform };

type GroupTransformCommit = (payload: {
  operation: 'move' | 'rotate' | 'scale';
  entries: GroupCommitEntry[];
}) => void;

// PLATFORM_SNAP_CLEARANCE_MM = 0.001 (see src/hooks/useModelTransform.ts).
const PLATFORM_SNAP_CLEARANCE_MM = 0.001;

/**
 * Selection-aware transform actions that fan a single-model operation out over
 * the whole multi-selection (issue #305). Bodies live here rather than in
 * page.tsx so the orchestrator stays thin; they route through the vetted
 * group-commit path (support-sync + active-model live-transform + undo).
 */
export function useSelectionTransforms({
  scene,
  transformMgr,
  handleGizmoTransformGroupCommit,
  requestDestructiveTransformSupportDeletionWithContinuation,
}: {
  scene: ReturnType<typeof useSceneCollectionManager>;
  transformMgr: ReturnType<typeof useTransformManager>;
  handleGizmoTransformGroupCommit: GroupTransformCommit;
  // Drop/lift move each model relative to its plate-anchored supports, so they
  // prompt to clear supports first (returns true when it can proceed at once).
  requestDestructiveTransformSupportDeletionWithContinuation: (
    operationLabel: string,
    onContinue: () => void,
  ) => boolean;
}) {
  // Snap each selected model to a target build-plate height INDEPENDENTLY:
  // every model computes its OWN lowest world-Z, so a group drop lands each
  // model on the plate instead of sharing one model's delta (issue #305).
  const buildSelectionSnapEntries = useCallback((targetLowestZ: number): GroupCommitEntry[] => {
    const ids = scene.selectedModelIds.length > 0
      ? scene.selectedModelIds
      : (scene.activeModelId ? [scene.activeModelId] : []);

    const entries: GroupCommitEntry[] = [];
    for (const id of ids) {
      const model = scene.models.find((m) => m.id === id);
      if (!model) continue;

      const position = model.geometry.geometry.getAttribute('position');
      if (!position) continue;

      // World-Z per vertex = R*S*(v - center) + t — matches accurateMaxZ in page.tsx.
      const center = model.geometry.center;
      const t = model.transform;
      const matrix = new THREE.Matrix4().compose(
        t.position,
        quaternionFromGlobalEuler(t.rotation),
        t.scale,
      );
      const me = matrix.elements;
      const a = me[2], b = me[6], c = me[10], d = me[14];
      const src = position.array as Float32Array | number[];
      const count = position.count;
      let lowestZ = Infinity;
      for (let i = 0; i < count; i++) {
        const worldZ = a * (src[i * 3] - center.x)
          + b * (src[i * 3 + 1] - center.y)
          + c * (src[i * 3 + 2] - center.z)
          + d;
        if (worldZ < lowestZ) lowestZ = worldZ;
      }
      if (!Number.isFinite(lowestZ)) continue;

      const offset = targetLowestZ - lowestZ;
      entries.push({
        modelId: id,
        before: { position: t.position.clone(), rotation: t.rotation.clone(), scale: t.scale.clone() },
        after: {
          position: new THREE.Vector3(t.position.x, t.position.y, t.position.z + offset),
          rotation: t.rotation.clone(),
          scale: t.scale.clone(),
        },
      });
    }
    return entries;
  }, [scene]);

  const handleDropSelectionToPlatform = useCallback(() => {
    const apply = () => {
      const entries = buildSelectionSnapEntries(PLATFORM_SNAP_CLEARANCE_MM);
      if (entries.length === 0) return;
      handleGizmoTransformGroupCommit({ operation: 'move', entries });
    };
    if (requestDestructiveTransformSupportDeletionWithContinuation('Drop', apply)) apply();
  }, [buildSelectionSnapEntries, handleGizmoTransformGroupCommit, requestDestructiveTransformSupportDeletionWithContinuation]);

  const handleLiftSelection = useCallback(() => {
    const apply = () => {
      const entries = buildSelectionSnapEntries(transformMgr.liftDistance);
      if (entries.length === 0) return;
      handleGizmoTransformGroupCommit({ operation: 'move', entries });
    };
    if (requestDestructiveTransformSupportDeletionWithContinuation('Lift', apply)) apply();
  }, [buildSelectionSnapEntries, handleGizmoTransformGroupCommit, requestDestructiveTransformSupportDeletionWithContinuation, transformMgr.liftDistance]);

  return { handleDropSelectionToPlatform, handleLiftSelection };
}
