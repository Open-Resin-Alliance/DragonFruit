/**
 * Recentering helper for the persisted (on-disk) hollowing cavity.
 *
 * When a VOXL is saved, the model STL is exported RE-CENTERED: ExportManager
 * bakes `mesh.position = −model.geometry.center` into the vertices
 * (`exportModelAsEmbeddedBinaryStlBytes`). The cavity, however, is persisted as
 * `cavityPositionsBase64` and rebuilt verbatim on reload. To keep the reloaded
 * cavity aligned with the reloaded (already-centered) model, the on-disk cavity
 * must live in the SAME centered frame — i.e. translated by the same `−center`.
 *
 * This returns a NEW Float32Array; the input is never mutated because the
 * in-session cavity geometry references the original `result.cavityPositions`
 * array directly and must stay in the raw (uncentered) in-session frame.
 *
 * @param positions xyz-triple vertex positions (length is a multiple of 3).
 * @param center the model geometry bbox center that the model STL is centered
 *   by on export (= `model.geometry.center` post-`replaceModelGeometry`).
 */
export function centerCavityPositions(
  positions: Float32Array,
  center: { readonly x: number; readonly y: number; readonly z: number },
): Float32Array {
  const { x: cx, y: cy, z: cz } = center;
  const out = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    out[i] = positions[i] - cx;
    out[i + 1] = positions[i + 1] - cy;
    out[i + 2] = positions[i + 2] - cz;
  }
  return out;
}
