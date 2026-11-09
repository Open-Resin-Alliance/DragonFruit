import * as THREE from 'three';

/**
 * Pick rays for the orthographic camera, which deliberately does not clip
 * behind itself.
 *
 * The scene ortho camera runs a symmetric, deeply negative near (see
 * `ORTHO_NEAR` in `orthoDolly.ts`) because an orthographic image does not depend
 * on where the camera sits along its view axis: the camera dollies through
 * space, and the visible set has to stay whole regardless. That is what lets you
 * zoom into a model at any FOV without the near plane slicing it, and it is why
 * the camera can dolly past a surface while the surface stays on screen.
 *
 * `Raycaster.setFromCamera` does not know that. It puts an ortho ray origin at
 * NDC z 0, which with a symmetric range is the camera's own plane, and then
 * walks forward only. Anything the camera has moved past is therefore drawn but
 * permanently out of reach: the cursor hits nothing, so support placement and
 * every other surface-aimed tool silently stop working exactly where the user
 * zoomed in to work.
 *
 * These helpers start the ray at the near plane instead, the first depth the
 * camera draws, so a pick covers the same volume as the render. The ray is the
 * same line either way; only the origin moves, so a point reconstructed as
 * `origin + direction * t` is unchanged.
 */

/** Move a ray origin back to the near plane when the camera draws behind itself. */
export function extendPickRayToNearPlane(ray: THREE.Ray, camera: THREE.Camera): void {
  const ortho = camera as THREE.OrthographicCamera;
  // Perspective never draws behind itself, and an ortho camera with a normal
  // near does not either: three's own origin already lands on the near plane
  // there, so there is nothing to correct. `!(near < 0)` also rejects a camera
  // whose near is missing or NaN rather than writing an NaN origin.
  if (ortho.isOrthographicCamera !== true || !(ortho.near < 0)) return;
  ray.origin.addScaledVector(ray.direction, ortho.near);
}

/** `Raycaster.setFromCamera` with the orthographic correction applied. */
export function setPickRayFromCamera(
  raycaster: THREE.Raycaster,
  coords: THREE.Vector2,
  camera: THREE.Camera,
): void {
  raycaster.setFromCamera(coords, camera);
  extendPickRayToNearPlane(raycaster.ray, camera);
}
