import * as THREE from 'three';
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
 * 'minima'). The Tauri import is dynamic so this module is inert in a non-Tauri
 * (plain browser) context — it simply rejects, and the caller treats that as a
 * non-fatal "no minima". No ROIs, no brushes — just coordinates.
 */
export async function scanMeshMinima(positions: Float32Array, k?: number): Promise<DetectedIsland[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  const raw = await invoke<RawLocalMinimum[]>('scan_mesh_minima', {
    positions: Array.from(positions),
    k,
  });
  return raw.map((m, i) => ({
    id: `m${i}`,
    source: 'minima' as const,
    contact: new THREE.Vector3(m.position.x, m.position.y, m.position.z),
    baseZ: m.position.z,
    vertexIndex: m.vertexIndex,
    seedTriangleId: m.seedTriangleId,
  }));
}
