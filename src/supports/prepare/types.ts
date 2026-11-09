import type * as THREE from 'three';

/**
 * One model's harness-free Prepare support geometry.
 *
 * Prepared from the proxy primitives so the visual fidelity matches what the
 * instanced proxy draws today. Spaces: world; the caller parents it inside the
 * model group behind the inverse committed transform.
 */
export type MergedSupportGeometry = {
  geometry: THREE.BufferGeometry;
  /** Triangle count of the merged geometry, for reporting and scene stats. */
  triangles: number;
  modelId?: string;
};
