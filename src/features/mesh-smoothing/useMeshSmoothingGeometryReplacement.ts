import { useEffect, useRef } from 'react';
import type * as THREE from 'three';

import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MessageDescriptor } from '@lingui/core';

import { MESH_SMOOTHING_STROKE } from './history/actionTypes';
import { MESH_SMOOTHING_HISTORY_LABELS } from './history/historyLabels';
import { setMeshSmoothingGeometryReplacer } from './meshSmoothingEngine';

type SmoothingScene = {
  models: readonly LoadedModel[];
  replaceModelGeometry: (
    id: string,
    next: THREE.BufferGeometry,
    historyDescription: MessageDescriptor,
    options?: { historyBefore?: Record<string, never> },
  ) => boolean;
};

/**
 * Lets a brush stroke over faces longer than the brush put its refined, smoothed copy of
 * the mesh in the model's place, as one "Brush stroke" undo step — the way any operation
 * that changes a model's triangles does, so the display mesh, the AO and every cache
 * keyed on the mesh follow it.
 *
 * It declines, and the stroke smooths in place on the mesh as it is, when:
 * - the mesh is shared by linked copies, which a replacement would split apart;
 * - the mesh carries the support classification it was imported with, which is indexed
 *   by triangle and which a replacement does not keep.
 */
export function useMeshSmoothingGeometryReplacement(scene: SmoothingScene): void {
  const sceneRef = useRef(scene);
  useEffect(() => {
    sceneRef.current = scene;
  });

  useEffect(() => setMeshSmoothingGeometryReplacer((previous, next) => {
    const { models, replaceModelGeometry } = sceneRef.current;
    const owners = models.filter((model) => model.geometry.geometry === previous);
    if (owners.length !== 1) return false;
    const [owner] = owners;
    if (owner.geometry.meshDefects) return false;
    return replaceModelGeometry(owner.id, next, MESH_SMOOTHING_HISTORY_LABELS[MESH_SMOOTHING_STROKE], {
      historyBefore: {},
    });
  }), []);
}
