import type * as THREE from 'three';

import { createInstancedStandardMaterial } from './instancedStandardMaterial';

/**
 * The one material an instanced joint batch draws with.
 *
 * It is `instancedStandardMaterial`'s shared batch material — a stock
 * `MeshStandardMaterial` with the `instanceMatrix` and normal injections —
 * under this primitive's own program key. A joint is a uniformly scaled sphere,
 * so the shared `mat3(instanceMatrix)` normal transform is the sphere's exact
 * normal here; nothing joint-specific is added to the shader.
 */

/** Registry name for this program; keep it distinct from every other material. */
export const INSTANCED_JOINT_PROGRAM_KEY = 'df-instanced-joint';

export function createInstancedJointMaterial(): THREE.MeshStandardMaterial {
  return createInstancedStandardMaterial(INSTANCED_JOINT_PROGRAM_KEY);
}
