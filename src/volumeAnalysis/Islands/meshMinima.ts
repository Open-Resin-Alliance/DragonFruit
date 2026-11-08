import * as THREE from 'three';
import { invoke } from '@tauri-apps/api/core';
import { invokeWithChunkedMesh } from '@/utils/meshChunkUpload';
import type { DetectedIsland } from './types';

/** Raw shape returned by the `scan_mesh_minima` Tauri command (camelCase). */
interface RawLocalMinimum {
  vertexIndex: number;
  position: { x: number; y: number; z: number };
  seedTriangleId: number;
}

/**
 * Invoke the stateless Rust mesh-minima scanner on world-space (build-plate)
 * positions and map the result to unified {@link DetectedIsland}s (source
 * 'minima'). In a plain browser the native call rejects, and the caller treats
 * that as non-fatal "no minima". No ROIs, no brushes — just coordinates.
 */
export async function scanMeshMinima(positions: Float32Array, k?: number): Promise<DetectedIsland[]> {
  const bytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
  const raw = await invokeWithChunkedMesh<RawLocalMinimum[]>(
    invoke, 'scan_mesh_minima', bytes, { args: { k } },
  );
  return raw.map((m, i) => ({
    id: `m${i}`,
    source: 'minima' as const,
    contact: new THREE.Vector3(m.position.x, m.position.y, m.position.z),
    baseZ: m.position.z,
    vertexIndex: m.vertexIndex,
    seedTriangleId: m.seedTriangleId,
  }));
}
