import * as THREE from 'three';
import { invoke } from '@tauri-apps/api/core';
import { expandGeometryToTriangleSoup, resolveMeshPayload, type MeshReadbackRef } from '@/utils/tauriMeshBridge';
import { logToNativeFile } from '@/utils/nativeLog';
import { invokeWithChunkedMesh } from '@/utils/meshChunkUpload';

/**
 * Model ambient occlusion, baked per vertex by the native side and attached to
 * the geometry as an attribute.
 *
 * The native bake (`bake_vertex_occlusion`, see
 * `dragonfruit-mesh-core::vertex_occlusion`) fires a hemisphere fan per vertex
 * from the mesh's own normal and returns one `f32` per vertex in the geometry's
 * own order, so this module's whole job is to fetch it and set the attribute.
 *
 * Why per-vertex, rather than the volumetric or screen-space approaches that
 * were tried first (all three measured, see `docs/dev/backlog.md`): a volumetric
 * grid is smooth but its grid *is* the resolution, so sub-voxel relief — a
 * figurine's feather scallops — bakes away to nothing, and a screen-space pass
 * doubles the frame time while compositing the whole scene. Per-vertex sampling
 * resolves whatever the mesh resolves, and it is affordable only because the
 * bake is native and parallel: 12 ms / 56 ms / 263 ms for 40k / 160k / 640k
 * triangle meshes, against ~15 µs *per vertex* in TypeScript before.
 */

/** The geometry attribute the bake's values are attached as. */
export const BAKED_OCCLUSION_ATTRIBUTE = 'aBakedAo';

/**
 * How much of the baked occlusion the material applies.
 *
 * Paired with the falloff in `dragonfruit-mesh-core`: this maps the weighted
 * field's range back to the contrast the surface wants. Measured on the model the
 * report came from, 0.75 renders its deepest 5% at 0.57 against 0.55 for the
 * unweighted bake at 0.6, so folds look as they did, while a flat base under them
 * renders at 0.98 against 0.95, which is the part that was reading as dirt.
 * Changing either constant without the other makes the model flat or dirty.
 */
export const BAKED_OCCLUSION_STRENGTH = 0.75;

/**
 * What the Ambient Occlusion slider starts at, and what Restore Defaults sets it
 * to. With the strength below, 0.85 renders a little lighter than the value the
 * two constants were tuned to match, which is the default the shading was asked
 * for.
 */
export const DEFAULT_BAKED_OCCLUSION_INTENSITY = 0.85;

/** How much of the baked occlusion to apply for a user-set intensity. */
export function bakedOcclusionStrength(intensity: number): number {
  if (!Number.isFinite(intensity)) return BAKED_OCCLUSION_STRENGTH;
  return BAKED_OCCLUSION_STRENGTH * Math.min(Math.max(intensity, 0), 2);
}

/** Whether the native bake is reachable — false in the plain web build. */
export function canBakeOcclusion(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Whether the machine has a discrete GPU.
 *
 * AO is disabled without one: integrated-only machines render unoccluded rather
 * than spending bake time. Cached for the session. A backend that predates the
 * `ao_available` command resolves to `true`, so an older build keeps its CPU
 * fallback instead of silently losing AO.
 */
let aoHardwareAvailability: Promise<boolean> | null = null;

export function canBakeOcclusionAsync(): Promise<boolean> {
  if (!canBakeOcclusion()) return Promise.resolve(false);
  aoHardwareAvailability ??= invoke<boolean>('ao_available').catch(() => true);
  return aoHardwareAvailability;
}

/**
 * Geometries the hardware check skipped.
 *
 * The idle sweep treats "no `aBakedAo`" as "needs a bake"; without this it would
 * re-queue every skipped geometry on every model change and re-run the check.
 */
const aoUnavailableGeometries = new WeakSet<THREE.BufferGeometry>();

export function isOcclusionUnavailable(geometry: THREE.BufferGeometry): boolean {
  return aoUnavailableGeometries.has(geometry);
}

/**
 * Bake one model's occlusion and return its per-vertex values, or `null` when
 * the native bake is unreachable (plain web build), the mesh has no usable
 * vertices, or the returned count does not line up with the geometry. Throws
 * only on a real IPC failure, which the caller logs and degrades from.
 *
 * **The soup is sent in the request body, and it is built from the very geometry
 * the values are attached to.** The obvious alternative — stage the mesh, then
 * bake from the staging buffer — is what the island scanner used to do, and it
 * is wrong for the same reason there: staging is process-wide mutable state that
 * repair, hole punching and hollowing all write, so a bake landing after one of
 * those writes computes occlusion for a *different* mesh and indexes it into
 * this one. That renders as misaligned triangles, on exactly the models that
 * happened to touch the buffer in between.
 */
export async function bakeOcclusionForGeometry(
  geometry: THREE.BufferGeometry,
): Promise<Float32Array | null> {
  if (!canBakeOcclusion()) return null;
  if (!(await canBakeOcclusionAsync())) {
    aoUnavailableGeometries.add(geometry);
    return null;
  }

  const positions = geometry.getAttribute('position');
  if (!positions) return null;

  // The corner-to-vertex table this request is built from, read *now*. The bake is
  // started before the BVH is built (see `processGeometry`), and what the values
  // belong to is the table the soup was expanded through — not whatever the
  // geometry carries when the values come back. Mapping against the live index was
  // what put a shuffled occlusion field on an imported mesh: the values landed one
  // triangle over, which reads as speckled shading. The table is captured whole, so
  // nothing that happens to the geometry's index in between can move them.
  const indexAtRequest = geometry.getIndex();
  const cornerTable = indexAtRequest ? (indexAtRequest.array as Uint16Array | Uint32Array).slice() : null;

  // A geometry whose mesh the loader kept is baked by token: forty bytes instead of
  // the soup, and the same field (the loader's weld and this path's re-weld of the
  // same soup were measured to produce the same vertex set and a bit-identical
  // field). A refusal — an evicted token, a geometry that moved on — falls through to
  // the soup below, which cannot go stale. Tried first, because expanding and copying
  // the soup is 36 bytes a triangle this path then does not use.
  const token = meshTokenForGeometry(geometry);
  if (token) {
    try {
      const byToken = await resolveMeshPayload(await invoke<ArrayBuffer | Uint8Array | number[] | MeshReadbackRef>(
        'bake_vertex_occlusion',
        { meshToken: token.token, expectedCorners: cornerCount(geometry) },
        { headers: {} },
      ));
      const fromLoader = toCornerValues(byToken);
      if (fromLoader) {
        // The values are in the loader's mesh triangle order, which is this
        // geometry's corner order (a range-loaded geometry is a soup; the BVH's index
        // over one is the identity), so the mapping is the identity.
        const values = mapCornerValuesToVertices(fromLoader, cornerCount(geometry), null);
        if (values) {
          const note = `[ao] baked via the loader's mesh (token ${token.token}, ${values.length} vertices)`;
          console.log(note);
          void logToNativeFile('info', note);
          return values;
        }
        console.warn('[ao] the token bake did not map onto this geometry; sending the soup');
      }
    } catch (error) {
      console.warn('[ao] the loader\'s mesh was not usable for this bake; sending the soup', error);
    }
  }

  // The soup, for a mesh the loader never had. A copy, not a view over the geometry's
  // own buffer: the request outlives this call, and anything that touches the mesh
  // while it is in flight would be sending the native side something other than what
  // it is about to shade.
  const prepared = performance.now();
  const soup = expandGeometryToTriangleSoup(geometry);
  const body = new Uint8Array(soup.byteLength);
  body.set(new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength));
  const soupTiming =
    `[ao] ${(soup.byteLength / 1_000_000).toFixed(1)} MB soup copied for the bake in ` +
    `${(performance.now() - prepared).toFixed(0)}ms`;
  console.log(soupTiming);
  void logToNativeFile('info', soupTiming);

  const payload = await resolveMeshPayload(
    await invokeWithChunkedMesh<ArrayBuffer | Uint8Array | number[] | MeshReadbackRef>(
      invoke, 'bake_vertex_occlusion', body,
    ),
  );

  // One f32 per soup corner. An ArrayBuffer off the IPC channel is ours and
  // 4-byte aligned, so that *is* the values; a view or a plain array is neither,
  // and one copy is what makes it viewable. The corner array is transient either
  // way, because the per-vertex attribute is built from it below.
  const cornerValues = toCornerValues(payload);
  if (!cornerValues) return null;

  // A geometry whose positions were replaced while its bake was in flight (a
  // repair landing late, a swap) would take these values onto vertices they were
  // never computed for. Dropping them costs an unoccluded model until the idle
  // sweep re-bakes it, against the geometry that will actually be drawn.
  if (geometry.getAttribute('position') !== positions) {
    console.warn('[ao] geometry changed while its bake was in flight; dropping the values');
    return null;
  }

  // An indexed geometry whose table moved under the request is the case the
  // snapshot exists for, and it is worth saying out loud: it is the only signal
  // that the ordering here is load-bearing. Sampled rather than compared whole —
  // a reorder shows up in any window of the table, and this runs per model.
  if (indexAtRequest) {
    const live = geometry.getIndex();
    const table = cornerTable!;
    const moved = !live
      || live.array.length !== table.length
      || live.array[0] !== table[0]
      || live.array[8] !== table[8]
      || live.array[live.array.length - 1] !== table[table.length - 1];
    if (moved) {
      console.warn(
        '[ao] the geometry was re-indexed while its bake was in flight; the values are mapped ' +
        'through the table the soup was sent through',
      );
    }
  }

  const values = mapCornerValuesToVertices(cornerValues, positions.count, cornerTable);
  if (!values) {
    console.warn(
      '[ao] bake does not map onto this geometry:',
      `${cornerValues.length} corner values,`,
      `${positions.count} vertices,`,
      cornerTable ? 'indexed when sent' : 'soup when sent',
    );
    return null;
  }
  return values;
}

/**
 * Turn the bake's per-corner values into a per-*vertex* attribute, or `null` when
 * the two do not describe the same mesh.
 *
 * The bake returns one value per triangle corner, in the order the soup was sent.
 * A non-indexed geometry *is* that soup, so its corners are its vertices and the
 * mapping is the identity. An indexed one is not: the table handed in is the
 * corner order the soup was expanded through — slot `s` of it holds value
 * `cornerValues[s]` at vertex `table[s]`. Reading it the other way round —
 * `values[vertex] = cornerValues[table[vertex]]` — silently assumes the table is
 * its own inverse, which is true only for an identity index; on a welded mesh it
 * hands nearly every vertex a neighbouring vertex's occlusion, which renders as a
 * mosaic of triangles and looks exactly like broken shading.
 *
 * The table is a parameter rather than `geometry.getIndex()` for the same reason:
 * the geometry can be re-indexed while a bake is in flight (three-mesh-bvh's
 * build reorders a soup's index), and what the values belong to is the table the
 * soup was expanded through, not whatever the geometry carries afterwards.
 */
export function mapCornerValuesToVertices(
  cornerValues: Float32Array,
  positionCount: number,
  cornerTable: ArrayLike<number> | null,
): Float32Array | null {
  if (positionCount === 0) return null;

  if (!cornerTable) {
    return cornerValues.length === positionCount ? cornerValues : null;
  }

  if (cornerTable.length !== cornerValues.length) return null;

  // Unreferenced vertices keep "open sky"; a baked mesh has none, but a
  // half-built attribute shades as black rather than as a bug if one appears.
  const values = new Float32Array(positionCount).fill(1);
  for (let slot = 0; slot < cornerTable.length; slot += 1) {
    values[cornerTable[slot]] = cornerValues[slot];
  }
  return values;
}

/**
 * The intensity the store currently has, for the geometry prep that runs outside
 * React and has to decide whether to bake at all. The store pushes it here
 * whenever it changes, so this is never more than one render behind.
 */
let currentIntensity = DEFAULT_BAKED_OCCLUSION_INTENSITY;

export function setBakedOcclusionIntensity(intensity: number): void {
  currentIntensity = intensity;
}

/**
 * Bake this geometry's occlusion and attach it, before it reaches the scene.
 *
 * Geometry prep is the one place every import goes through, and the model is not
 * added to the scene until prep resolves, so baking here means the first frame a
 * model appears in already has its occlusion. Baking after the fact instead, on an
 * idle callback, is what made it pop in a moment after the model showed up. The
 * caller can start this before the rest of prep and await it at the end: the bake
 * is native work while prep is synchronous, so most of it overlaps.
 *
 * Returns whether an attribute was attached.
 */
/**
 * A mesh the *loader* kept, which the bake can ask for by token instead of being sent
 * the soup back.
 *
 * `positions` is the point of the record: a geometry whose position array is no longer
 * the one the loader produced is a different mesh — a repair installs a new attribute,
 * a swap is a new geometry, a clone copies the arrays, and a smoothing pass that writes
 * in place replaces the attribute too — so the token must not be used for it. The
 * native side checks the corner count as well, and the caller falls back to sending the
 * soup when either disagrees.
 */
type LoadedMeshToken = { token: number; positions: ArrayLike<number> };
const loadedMeshTokens = new WeakMap<THREE.BufferGeometry, LoadedMeshToken>();

/**
 * Record that `geometry` still holds `token`'s mesh, as the loader produced it.
 *
 * Call this in the loader, immediately after the soup is assembled and *before* any
 * prep pass runs. The token names a mesh in the Rust registry, in the loader's triangle
 * order; a classify, repair or refine pass replaces the position attribute with the
 * reordered soup, so recording afterwards would sign off on the new order and the token
 * bake would index the loader's order into it — a field that lands one triangle over,
 * which reads as speckle. Recorded here, the array the guard compares is the loader's
 * own and the reorder invalidates the token by itself.
 *
 * A translate (the centering in prep) mutates the array in place and correctly keeps
 * the token: it moves the mesh the registry holds by the same amount.
 */
export function rememberLoadedMeshMesh(
  geometry: THREE.BufferGeometry,
  token: number,
): void {
  const position = geometry.getAttribute('position');
  if (!position) return;
  loadedMeshTokens.set(geometry, { token, positions: position.array });
}

/**
 * The token to bake `geometry` with, or null when it must be sent as a soup.
 *
 * Exported for its test: the identity check is the whole guard, and it is the one
 * thing that must not regress (a stale token means a field computed for a mesh that
 * is no longer there).
 */
export function meshTokenForGeometry(
  geometry: THREE.BufferGeometry,
): LoadedMeshToken | null {
  const entry = loadedMeshTokens.get(geometry);
  if (!entry) return null;
  const position = geometry.getAttribute('position');
  if (!position || position.array !== entry.positions) return null;
  return entry;
}

/** How many corners the bake's token request claims, for the native guard. */
function cornerCount(geometry: THREE.BufferGeometry): number {
  return geometry.getAttribute('position')?.count ?? 0;
}

/**
 * The bake's response as corner values: one `f32` per corner, in the order the request
 * described them. An `ArrayBuffer` off the IPC channel is ours and 4-byte aligned, so
 * that *is* the values; a view or a plain array is neither, and one copy is what makes
 * it viewable.
 */
function toCornerValues(
  payload: ArrayBuffer | Uint8Array | number[],
): Float32Array | null {
  if (payload instanceof ArrayBuffer && payload.byteLength % 4 === 0) {
    return new Float32Array(payload);
  }
  if (Array.isArray(payload) && payload.length === 0) return null;
  const view = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (view.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return new Float32Array(copy.buffer);
}

export async function bakeAndAttachOcclusionForGeometry(
  geometry: THREE.BufferGeometry,
): Promise<boolean> {
  // Not an experiment any more: what is left is a capability check, since the
  // bake is native and the plain web build has no command to call.
  if (!canBakeOcclusion()) return false;
  if (!(currentIntensity > 0)) return false;
  if (!geometry.getAttribute('position')) return false;

  const occlusion = await bakeOcclusionForGeometry(geometry);
  if (!occlusion) return false;
  const attribute = new THREE.BufferAttribute(occlusion, 1);
  attribute.setUsage(THREE.StaticDrawUsage);
  geometry.setAttribute(BAKED_OCCLUSION_ATTRIBUTE, attribute);
  return true;
}

/**
 * Which bake a geometry's `aBakedAo` came from.
 *
 * The attribute lands on a geometry that is already in the scene and keeps its
 * identity, so nothing about the geometry tells React to look again; this is the
 * signal that it changed. Keyed by the geometry, not by the model: the attribute
 * belongs to the geometry, a model's geometry can be swapped, and a model that is
 * deleted takes its counter with it instead of needing one.
 *
 * It used to ride on the `models` entries, which meant every bake that landed
 * replaced that array — and everything derived from it rebuilt: the clearance map
 * and the raft together measured **17 rebuilds in the fifteen seconds after a
 * load**. This is render-only state read by `StlMesh`, so it belongs in a store
 * of its own.
 */
const bakedAoVersionByGeometry = new WeakMap<THREE.BufferGeometry, number>();
const bakedAoVersionListeners = new Set<() => void>();

/** Announce that this geometry now carries a fresh `aBakedAo`. */
export function bumpBakedOcclusionVersion(geometry: THREE.BufferGeometry): void {
  bakedAoVersionByGeometry.set(geometry, bakedOcclusionVersion(geometry) + 1);
  bakedAoVersionListeners.forEach((listener) => listener());
}

export function bakedOcclusionVersion(geometry: THREE.BufferGeometry): number {
  return bakedAoVersionByGeometry.get(geometry) ?? 0;
}

export function subscribeToBakedOcclusionVersions(listener: () => void): () => void {
  bakedAoVersionListeners.add(listener);
  return () => {
    bakedAoVersionListeners.delete(listener);
  };
}

/** The server snapshot: no bake has landed in a render that has no window. */
export function getBakedOcclusionServerVersion(): number {
  return 0;
}
