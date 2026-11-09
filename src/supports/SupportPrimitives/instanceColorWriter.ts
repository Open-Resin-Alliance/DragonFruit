import * as THREE from 'three';

/**
 * An instance's colour is a function of the model it belongs to, so a selection
 * or a hover moves the colour of one or two models and leaves every other
 * instance alone. This writes only those instances.
 *
 * Rewriting the whole batch is what a plate of 18 supported models pays for: a
 * hover that moves between two models costs ~70 ms in a development build, and
 * the colour pass and its uploads are ~18% of it, most of that `Color.toArray`
 * inside `setColorAt`. Grouping the batch by model once, then comparing the
 * resolved colour per model, turns that into the instances of the models that
 * actually changed.
 *
 * The cache is keyed by the mesh and invalidated by the instance list and by the
 * colour attribute, so a rebuilt batch or a remounted mesh writes everything.
 */
type InstanceColorCache = {
  /** The instances the grouping was built from. */
  instances: readonly { modelId?: string }[];
  /** The colour attribute the written colours live in. */
  attribute: THREE.BufferAttribute | null;
  /** Model key to the indices of its instances, in batch order. */
  indicesByModel: Map<string, number[]>;
  /** Model key to the colour last written for it, as a hex number. */
  hexByModel: Map<string, number>;
};

const caches = new WeakMap<THREE.InstancedMesh, InstanceColorCache>();
const MODEL_NONE_KEY = '__none__';
const scratch = new THREE.Color();

export function writeInstanceColors<T extends { modelId?: string }>(
  mesh: THREE.InstancedMesh,
  instances: readonly T[],
  colorFor: (instance: T) => THREE.Color,
): void {
  const attribute = mesh.instanceColor;
  let cache = caches.get(mesh);
  if (!cache || cache.instances !== instances || cache.attribute !== attribute) {
    cache = { instances, attribute, indicesByModel: new Map(), hexByModel: new Map() };
    caches.set(mesh, cache);
  }

  if (cache.indicesByModel.size === 0) {
    for (let i = 0; i < instances.length; i += 1) {
      const key = instances[i].modelId ?? MODEL_NONE_KEY;
      const indices = cache.indicesByModel.get(key);
      if (indices) indices.push(i);
      else cache.indicesByModel.set(key, [i]);
    }
  }

  let wrote = false;
  for (const [key, indices] of cache.indicesByModel) {
    // One colour per model: the tint resolves from the model, not the instance.
    const hex = colorFor(instances[indices[0]]).getHex();
    if (cache.hexByModel.get(key) === hex) continue;
    cache.hexByModel.set(key, hex);
    scratch.setHex(hex);
    for (const index of indices) mesh.setColorAt(index, scratch);
    wrote = true;
  }

  if (wrote && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Read the attribute after writing, not before: the first `setColorAt` creates
  // it, so caching the value seen on entry would invalidate the cache on every
  // second call and rewrite the whole batch each time.
  cache.attribute = mesh.instanceColor;
}
