import * as THREE from 'three';

/**
 * The one material an instanced joint batch draws with.
 *
 * It is a plain `MeshStandardMaterial` with per-instance tint, so lighting,
 * clipping planes and the ghost-opacity pass stay the stock material's job. Two
 * things are injected, and only two:
 *
 * 1. `instanceMatrix` application. Three applies its built-in instancing chunks
 *    only when the *object* is an `InstancedMesh` (`USE_INSTANCING` comes from
 *    `WebGLPrograms`'s `object.isInstancedMesh`). A plain `<mesh>` over an
 *    `InstancedBufferGeometry` still draws every instance — the draw path reads
 *    `geometry.isInstancedBufferGeometry` — but the shader must apply the
 *    matrix itself. It is deliberately the same attribute three reserves
 *    (`instanceMatrix`), declared by us, because the define is what is missing,
 *    not the binding.
 * 2. The normal transform for the same matrix. Every joint is a uniformly
 *    scaled sphere, so a `mat3` of the matrix preserves the normal's direction;
 *    the fragment stage normalises it again.
 *
 * There is no per-instance emissive in step 1: one material carries one
 * `emissive` uniform, and the hover/marquee lift is approximated in the instance
 * colour instead (see `instancedPalette`). No integer attribute (`iData`,
 * `iPick`) is declared, so three does not bind them here.
 *
 * `customProgramCacheKey` is fixed: the ghost-opacity and clipping traversal in
 * `SupportRenderer` sets `material.needsUpdate` on every change, and the default
 * cache key is `onBeforeCompile.toString()`. Without a stable key each of those
 * would compile a new program.
 */

/** Registry name for this program; keep it distinct from every other material. */
export const INSTANCED_JOINT_PROGRAM_KEY = 'df-instanced-joint';

const INSTANCE_MATRIX_APPLICATION = /* glsl */ `
	transformed = ( instanceMatrix * vec4( transformed, 1.0 ) ).xyz;`;

const INSTANCE_NORMAL_ROTATION = /* glsl */ `
	objectNormal = mat3( instanceMatrix ) * objectNormal;`;

export function createInstancedJointMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    // The per-instance tint is the whole colour; a non-white base would multiply
    // every slot by a second colour.
    color: '#ffffff',
    // `color` is the batch's per-instance attribute, read by the stock vertex
    // colour chunks exactly as an `InstancedMesh`'s `instanceColor` is.
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });

  material.customProgramCacheKey = () => INSTANCED_JOINT_PROGRAM_KEY;

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      // `attribute` is `#define`d to `in` by three's ES 3.00 prefix, so this is
      // the same declaration the repo's other custom instanced shader writes.
      .replace('#include <common>', '#include <common>\nattribute mat4 instanceMatrix;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>${INSTANCE_MATRIX_APPLICATION}`)
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>${INSTANCE_NORMAL_ROTATION}`,
      );
  };

  return material;
}

/** The cross-section and ghost state every mesh under the support group shares. */
export type InstancedJointMaterialState = {
  /** Empty means unclipped, as the parent's traversal treats an empty list. */
  clippingPlanes: THREE.Plane[] | null;
  transparent: boolean;
  opacity: number;
};

/**
 * Apply the clipping and ghost state to the batch's material.
 *
 * This is what `SupportRenderer`'s traversal does to every material under its
 * group. The batch does it too, for the one case the traversal cannot cover: it
 * mounts a commit *after* the traversal last ran, so it would otherwise draw
 * unclipped (and at full opacity) until some unrelated dependency changed.
 * Material differences are guarded, and a change only marks `needsUpdate`,
 * which is a cache lookup thanks to the fixed program key.
 */
export function syncInstancedJointMaterialState(
  material: THREE.MeshStandardMaterial,
  state: InstancedJointMaterialState,
): void {
  const nextDepthWrite = !state.transparent;
  let changed = false;

  if (material.clippingPlanes !== state.clippingPlanes) {
    material.clippingPlanes = state.clippingPlanes;
    changed = true;
  }
  if (material.transparent !== state.transparent) {
    material.transparent = state.transparent;
    changed = true;
  }
  if (Math.abs(material.opacity - state.opacity) > 1e-4) {
    material.opacity = state.opacity;
    changed = true;
  }
  if (material.depthWrite !== nextDepthWrite) {
    material.depthWrite = nextDepthWrite;
    changed = true;
  }

  if (changed) material.needsUpdate = true;
}
