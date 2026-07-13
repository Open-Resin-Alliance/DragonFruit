import * as React from 'react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import {
  getRotationQuatTuple,
  resolveBlockedVoxelValidity,
} from '@/features/mesh-modifiers/hollowingGrid';

export interface HollowingBlockerLifecycleCtx {
  // --- rotation-invalidation effect ---
  models: LoadedModel[];
  getModelMeshModifiers: (id: string) => ModelMeshModifiers | undefined;
  setModelMeshModifiers: (id: string, modifiers: ModelMeshModifiers | undefined) => void;
  activeModelId: string | undefined;
  setBlockedHollowVoxelIndices: (indices: number[]) => void;
  setEditingBlockedHollowVoxelIndices: (indices: number[]) => void;
  // --- quiet-resync effect ---
  blockedHollowVoxelIndices: number[];
  commitBlockedHollowVoxelIndices: (nextIndices: number[]) => void;
  /** Minimal structural view of the two fields the resync reads; page.tsx's
   *  full HollowPreviewState satisfies this. Tighten to `HollowPreviewState |
   *  null` once the refactor exports it from hollowingPreviewTypes.ts. */
  hollowPreview: {
    blockedVoxelIndices?: Uint32Array;
    requestedBlockedVoxelIndices?: readonly number[];
  } | null;
}

export function useHollowingBlockerLifecycle(ctx: HollowingBlockerLifecycleCtx): void {
  const {
    models,
    getModelMeshModifiers,
    setModelMeshModifiers,
    activeModelId,
    setBlockedHollowVoxelIndices,
    setEditingBlockedHollowVoxelIndices,
    blockedHollowVoxelIndices,
    commitBlockedHollowVoxelIndices,
    hollowPreview,
  } = ctx;

  // Rust echoes back which committed blockers it actually accepted (stale
  // indices that fell off the grid or landed on non-solid voxels are
  // dropped, preserving order). If the echo differs from the committed set,
  // adopt it so the persisted modifier stays in lockstep with the preview.
  React.useEffect(() => {
    const preview = hollowPreview;
    const echoed = preview?.blockedVoxelIndices;
    const requested = preview?.requestedBlockedVoxelIndices;
    if (!preview || !echoed || !requested) return;
    // Only resync when this preview was computed FROM the current committed
    // set — otherwise a newer request is already in flight and comparing
    // against it would clobber fresh state.
    if (requested.length !== blockedHollowVoxelIndices.length
      || requested.some((value, i) => value !== blockedHollowVoxelIndices[i])) {
      return;
    }
    // The accepted list is an order-preserving subsequence of the request:
    // equal length means identical content.
    if (echoed.length === blockedHollowVoxelIndices.length) return;
    commitBlockedHollowVoxelIndices(Array.from(echoed));
  }, [blockedHollowVoxelIndices, commitBlockedHollowVoxelIndices, hollowPreview]);

  // Committed blockers index the rotation-aligned voxel grid. If the model is
  // rotated after they were painted, the same linear indices land on entirely
  // different voxels (or off the grid), so Rust would either silently ignore
  // them or pin the wrong voxels (hollowing.rs keep-application). Clear them
  // instead, mirroring the resolution-change invalidation in
  // handleHollowingStateChange and the legacy-format clear above.
  // NOTE: models in React state carry meshModifiers: undefined by design —
  // modifiers must be read through the externalized store (getModelMeshModifiers),
  // matching the cavity-restore effect above.
  React.useEffect(() => {
    for (const model of models) {
      const modifiers = getModelMeshModifiers(model.id);
      const hollowing = modifiers?.hollowing;
      if (!hollowing?.enabled || hollowing.bakedIntoGeometry) continue;
      if (!hollowing.blockedVoxelIndices?.length) continue;
      const currentQuat = getRotationQuatTuple(model.transform.rotation);
      const validity = resolveBlockedVoxelValidity(hollowing, currentQuat);
      if (validity === 'valid') continue;

      if (validity === 'stamp-legacy') {
        // Blockers persisted before the rotation stamp existed: adopt the
        // current rotation instead of destroying the user's selection on
        // first launch after this change.
        setModelMeshModifiers(model.id, {
          ...(modifiers ?? {}),
          hollowing: { ...hollowing, blockedVoxelRotationQuat: currentQuat },
        });
        continue;
      }

      console.warn(
        '[Hollowing] Cleared blocked voxels: model rotation changed since they were painted.',
      );
      setModelMeshModifiers(model.id, {
        ...(modifiers ?? {}),
        hollowing: {
          ...hollowing,
          blockedVoxelIndices: [],
          blockedVoxelRotationQuat: undefined,
        },
      });
      if (model.id === activeModelId) {
        setBlockedHollowVoxelIndices([]);
        setEditingBlockedHollowVoxelIndices([]);
      }
    }
  }, [models, getModelMeshModifiers, setModelMeshModifiers, activeModelId, setBlockedHollowVoxelIndices, setEditingBlockedHollowVoxelIndices]);
}
