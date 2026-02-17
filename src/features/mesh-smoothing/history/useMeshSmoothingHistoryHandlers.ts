import { useEffect } from 'react';
import * as THREE from 'three';

import { pushHistory, registerHistoryHandler } from '@/history/historyStore';
import type { HistoryDirection, HistoryAction } from '@/history/types';

import { MESH_SMOOTHING_STROKE, type MeshSmoothingStrokePayload } from './actionTypes';
import { getMeshSmoothingGeometryByKey, subscribeToMeshSmoothingStrokeFinalized } from '../meshSmoothingEngine';
import { getMeshTopology } from '../topologyCache';

type BVHGeometry = THREE.BufferGeometry & {
  boundsTree?: {
    refit?: () => void;
  };
  computeBoundsTree?: () => void;
  disposeBoundsTree?: () => void;
};

function applyUniquePositions(geometry: THREE.BufferGeometry, uniqueIds: Uint32Array, positions: Float32Array): boolean {
  const topo = getMeshTopology(geometry);
  if (!topo) return false;

  const uPos = topo.uniquePositions;
  const posAttr = topo.positionAttribute;
  const arr = posAttr.array as Float32Array;

  for (let i = 0; i < uniqueIds.length; i++) {
    const uid = uniqueIds[i];
    const x = positions[i * 3 + 0];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;

    const u3 = uid * 3;
    if (u3 + 2 >= uPos.length) continue;

    uPos[u3 + 0] = x;
    uPos[u3 + 1] = y;
    uPos[u3 + 2] = z;

    const group = topo.groups[uid];
    if (!group) continue;
    for (let gi = 0; gi < group.length; gi++) {
      const vi = group[gi];
      const v3 = vi * 3;
      if (v3 + 2 >= arr.length) continue;
      arr[v3 + 0] = x;
      arr[v3 + 1] = y;
      arr[v3 + 2] = z;
    }
  }

  posAttr.needsUpdate = true;

  geometry.computeVertexNormals();
  const normalAttr = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (normalAttr) normalAttr.needsUpdate = true;

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const g = geometry as BVHGeometry;
  if (g.boundsTree && typeof g.boundsTree.refit === 'function') {
    try {
      g.boundsTree.refit();
    } catch {
      if (typeof g.disposeBoundsTree === 'function') {
        try {
          g.disposeBoundsTree();
        } catch {}
      }
      if (typeof g.computeBoundsTree === 'function') {
        try {
          g.computeBoundsTree();
        } catch {}
      }
    }
  } else {
    if (typeof g.disposeBoundsTree === 'function') {
      try {
        g.disposeBoundsTree();
      } catch {}
    }
    if (typeof g.computeBoundsTree === 'function') {
      try {
        g.computeBoundsTree();
      } catch {}
    }
  }

  return true;
}

export function useMeshSmoothingHistoryHandlers() {
  useEffect(() => {
    const unregisterStroke = registerHistoryHandler(
      MESH_SMOOTHING_STROKE,
      (action: HistoryAction, direction: HistoryDirection) => {
        const payload = action.payload as MeshSmoothingStrokePayload | undefined;
        if (!payload) return false;

        const geometry = getMeshSmoothingGeometryByKey(payload.geometryKey);
        if (!geometry) return false;

        const positions = direction === 'undo' ? payload.before : payload.after;
        return applyUniquePositions(geometry, payload.uniqueIds, positions);
      },
    );

    const unsubFinalize = subscribeToMeshSmoothingStrokeFinalized((payload) => {
      pushHistory({ type: MESH_SMOOTHING_STROKE, payload: payload as MeshSmoothingStrokePayload });
    });

    return () => {
      unregisterStroke();
      unsubFinalize();
    };
  }, []);
}
