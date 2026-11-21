/**
 * A model's display mesh: the one the renderer draws in place of the model's own.
 *
 * The per-vertex AO needs vertices to land on, and a coarse mesh has too few — a flat
 * panel made of two triangles interpolates its occlusion across the whole face. The
 * display mesh is the model's mesh with its long edges split. It is drawn and baked,
 * and nothing else: saving, exporting, slicing, scans and operations all read the
 * model's own mesh, so a model never grows because it was drawn.
 *
 * Every model mesh gets it the same way — loaded, replaced by an operation, restored
 * by undo: the scene's reconciler asks `requestDisplayGeometry` for whatever mesh
 * lacks one. A headless session (the CLIs, the scripting API) never asks: it draws
 * nothing, so it has nothing to derive.
 */
import * as THREE from 'three';
import { decodeDfmx } from '@/utils/dfmx';
import { expandGeometryToTriangleSoup, loadTauriCore } from '@/utils/tauriMeshBridge';
import { rememberLoadedMeshMesh } from './bakedOcclusion';

/**
 * The largest mesh worth deriving a display mesh for.
 *
 * The refine round trip sends the whole soup, so it costs the mesh in traffic. A mesh
 * with faces too long for the AO is a mesh with few of them — the target is a fraction
 * of the model's own diagonal, so a coarse face is a big face — which is what makes
 * this gate cheap in practice: the meshes that need refining are the ones small enough
 * to send. Above it a model draws its own mesh; a large mesh with a few huge faces is
 * rarer than the cost of treating every dense one as if it were coarse.
 */
export const DISPLAY_REFINE_MAX_TRIANGLES = 400_000;

/**
 * Longest edge the AO tolerates, as a fraction of the bounding-box diagonal. Mirrors
 * `MAX_EDGE_DIAGONAL_FRACTION` in `dragonfruit-mesh-core::refine`; this copy only
 * spares the round trip for a mesh the native side would leave alone.
 */
const MAX_EDGE_DIAGONAL_FRACTION = 0.02;

function triangleCountOf(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  return Math.floor((geometry.getIndex()?.count ?? position?.count ?? 0) / 3);
}

/**
 * Whether any edge of the mesh is longer than the AO tolerates — the same test the
 * native refiner makes before it splits anything.
 */
export function hasCoarseFaces(geometry: THREE.BufferGeometry): boolean {
  const position = geometry.getAttribute('position');
  if (!position || position.count === 0) return false;
  const box = new THREE.Box3().setFromBufferAttribute(position as THREE.BufferAttribute);
  const diagonal = box.min.distanceTo(box.max);
  if (!Number.isFinite(diagonal) || diagonal <= 0) return false;
  const limitSquared = (diagonal * MAX_EDGE_DIAGONAL_FRACTION) ** 2;

  const index = geometry.getIndex();
  const triangles = triangleCountOf(geometry);
  const corner = (triangle: number, k: number) => (index ? index.getX(triangle * 3 + k) : triangle * 3 + k);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let triangle = 0; triangle < triangles; triangle++) {
    for (let k = 0; k < 3; k++) {
      a.fromBufferAttribute(position, corner(triangle, k));
      b.fromBufferAttribute(position, corner(triangle, (k + 1) % 3));
      if (a.distanceToSquared(b) > limitSquared) return true;
    }
  }
  return false;
}

/** Whether a mesh is one `deriveDisplayGeometry` would send for refining. */
export function wantsDisplayGeometry(geometry: THREE.BufferGeometry): boolean {
  const triangles = triangleCountOf(geometry);
  if (triangles === 0 || triangles > DISPLAY_REFINE_MAX_TRIANGLES) return false;
  // Per-vertex colour is the model's own data, and the refiner would drop it.
  if (geometry.getAttribute('color')) return false;
  return hasCoarseFaces(geometry);
}

/**
 * Derive the display mesh for a model mesh, or `null` when the model draws its own:
 * nothing to split, too large to send, no native side (the web build), or the refine
 * failed. The model mesh is never changed.
 *
 * The result carries one normal per face and its bounding box, and is registered for
 * the AO bake under the token the native side kept it by, so the bake does not send
 * the soup back.
 */
export async function deriveDisplayGeometry(
  geometry: THREE.BufferGeometry,
): Promise<THREE.BufferGeometry | null> {
  if (!wantsDisplayGeometry(geometry)) return null;
  const core = await loadTauriCore();
  if (!core) return null;

  try {
    const soup = expandGeometryToTriangleSoup(geometry);
    const payload = await core.invoke<ArrayBuffer | Uint8Array>(
      'refine_mesh_soup',
      new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength),
      { headers: { 'Content-Type': 'application/octet-stream' } },
    );
    const decoded = await decodeDfmx(payload);
    const [display] = decoded.bodies;
    if (!display) return null;
    display.computeBoundingBox();
    if (decoded.meshToken) rememberLoadedMeshMesh(display, decoded.meshToken);
    return display;
  } catch (error) {
    console.warn('[displayMesh] drawing the model mesh: the refine failed', error);
    return null;
  }
}

/*
 * The display meshes the scene has derived, keyed on the model mesh they belong to.
 *
 * One derivation per model mesh, however many entries share it: a model, its history
 * snapshots and its linked copies hold the same `BufferGeometry`, so undoing to an
 * earlier mesh finds its display mesh here instead of refining it again. A mesh edited
 * in place (smoothing) is forgotten and derived afresh.
 */

/** Refines in flight at once: each holds its soup in the request and its result. */
const DERIVE_CONCURRENCY = 2;

const settled = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry | null>();
const inFlight = new WeakMap<THREE.BufferGeometry, Promise<THREE.BufferGeometry | null>>();
const editions = new WeakMap<THREE.BufferGeometry, number>();
const edited = new WeakSet<THREE.BufferGeometry>();
const listeners = new Set<() => void>();
const waiting: Array<() => void> = [];
let running = 0;
let inFlightCount = 0;

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error('[displayMesh] listener failed', error);
    }
  }
}

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= DERIVE_CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * The display mesh derived for `geometry`: the mesh, `null` when the model draws its
 * own, or `undefined` when it has not been derived (or was edited since).
 */
export function settledDisplayGeometry(
  geometry: THREE.BufferGeometry,
): THREE.BufferGeometry | null | undefined {
  return settled.get(geometry);
}

/**
 * Derive the display mesh for `geometry` once, and tell the subscribers when it lands.
 * A second request for the same mesh shares the first.
 */
export function requestDisplayGeometry(
  geometry: THREE.BufferGeometry,
): Promise<THREE.BufferGeometry | null> {
  const known = settled.get(geometry);
  if (known !== undefined) return Promise.resolve(known);
  const pending = inFlight.get(geometry);
  if (pending) return pending;

  const edition = editions.get(geometry) ?? 0;
  inFlightCount += 1;
  const promise = withSlot(() => deriveDisplayGeometry(geometry))
    .then((display): Promise<THREE.BufferGeometry | null> | THREE.BufferGeometry | null => {
      inFlight.delete(geometry);
      if ((editions.get(geometry) ?? 0) !== edition) {
        // Edited while it was being refined: what came back is the old shape.
        display?.dispose();
        return requestDisplayGeometry(geometry);
      }
      settled.set(geometry, display);
      notify();
      return display;
    })
    .finally(() => {
      inFlightCount -= 1;
    });
  inFlight.set(geometry, promise);
  return promise;
}

/**
 * The model mesh changed in place, so its display mesh shows the old shape. It is
 * dropped from the entries that carry it (`wasEditedInPlace`) and derived again.
 */
export function forgetDisplayGeometry(geometry: THREE.BufferGeometry): void {
  editions.set(geometry, (editions.get(geometry) ?? 0) + 1);
  settled.delete(geometry);
  edited.add(geometry);
  notify();
}

/** Whether `geometry` was edited in place since its entries were last reconciled. */
export function wasEditedInPlace(geometry: THREE.BufferGeometry): boolean {
  return edited.has(geometry);
}

/** The entries carrying `geometry` have dropped their stale display mesh. */
export function acknowledgeEditInPlace(geometry: THREE.BufferGeometry): void {
  edited.delete(geometry);
}

/**
 * Whether an entry's display mesh is still to come: derived but not yet attached, or
 * not derived at all. The AO waits for it, so it bakes the mesh that is drawn.
 */
export function isDisplayGeometryPending(
  entry: { geometry: THREE.BufferGeometry; displayGeometry?: THREE.BufferGeometry },
): boolean {
  if (edited.has(entry.geometry)) return true;
  const known = settled.get(entry.geometry);
  if (entry.displayGeometry) return known != null && known !== entry.displayGeometry;
  return known !== null;
}

/** Whether any display mesh is being derived. */
export function hasDisplayGeometryInFlight(): boolean {
  return inFlightCount > 0;
}

/** Called whenever a display mesh lands or a model mesh is forgotten. */
export function subscribeDisplayGeometry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
