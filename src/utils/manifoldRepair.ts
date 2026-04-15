/**
 * Mesh repair via the Manifold WASM library (manifold-3d).
 *
 * The module is loaded lazily on first use and kept as a singleton.
 * Call `prewarmManifold()` early to hide the one-time WASM init cost.
 *
 * The main export — `repairGeometryWithManifold` — takes a THREE.BufferGeometry,
 * feeds it through Manifold's merge+construct pipeline, and writes the repaired
 * position / index attributes back in-place.  It is a no-op (returns null) if:
 *   - WASM initialisation fails
 *   - the mesh is so broken that Manifold cannot build any solid from it
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Minimal WASM type shims (avoids pulling in manifold-3d types at compile time
// since the module is imported dynamically and may not be present in SSR).
// ---------------------------------------------------------------------------

type MeshInput = {
  numProp: number;
  triVerts: Uint32Array;
  vertProperties: Float32Array;
};

type MeshOutput = {
  numVert: number;
  numTri: number;
  triVerts: Uint32Array;
  vertProperties: Float32Array;
  delete?: () => void;
};

type ManifoldMesh = MeshInput & {
  numVert: number;
  numTri: number;
  triVerts: Uint32Array;
  vertProperties: Float32Array;
  merge(): boolean;
  delete?: () => void;
};

type ManifoldObj = {
  isEmpty(): boolean;
  getMesh(): MeshOutput;
  delete(): void;
};

type ManifoldWasm = {
  Manifold: { new (mesh: ManifoldMesh): ManifoldObj };
  Mesh: { new (opts: MeshInput): ManifoldMesh };
  setup(): void;
};

// ---------------------------------------------------------------------------
// Singleton WASM init
// ---------------------------------------------------------------------------

let initPromise: Promise<ManifoldWasm | null> | null = null;

function getManifoldWasm(): Promise<ManifoldWasm | null> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        // Dynamic import keeps this out of the SSR bundle.
        const { default: ManifoldModule } = await import('manifold-3d');
        const wasm = await ManifoldModule();
        (wasm as { setup?: () => void }).setup?.();
        return wasm as unknown as ManifoldWasm;
      } catch (err) {
        console.warn('[manifoldRepair] WASM init failed:', err);
        // Reset so a later attempt can retry (e.g. if the first call was SSR).
        initPromise = null;
        return null;
      }
    })();
  }
  return initPromise;
}

/**
 * Pre-warms the WASM module in the background so the first real repair call is
 * fast.  Safe to call unconditionally at app startup; it is a no-op after the
 * first call.
 */
export function prewarmManifold(): void {
  if (typeof window === 'undefined') return;  // browser only
  void getManifoldWasm();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ManifoldRepairStats = {
  /** Whether `mesh.merge()` found and welded any open seam edges. */
  manifoldMergedEdges: boolean;
  /** Number of degenerate/zero-area triangles collapsed by manifold construction. */
  degeneratesRemoved: number;
};

/**
 * Attempts to repair `geometry` using the Manifold library:
 *
 * 1. Builds a `Mesh` from the position / index attributes (unindexed STL
 *    triangles are given a trivial `0,1,2,3,4,5,…` index).
 * 2. Calls `mesh.merge()` to weld vertices that share a position — this
 *    reconstructs topological manifoldness for files that lost it (e.g. STL
 *    which duplicates vertices per-triangle).
 * 3. Constructs a `Manifold`, which collapses degenerate triangles and verifies
 *    the mesh is a valid closed solid.
 * 4. Calls `manifold.getMesh()` and writes the repaired vertex/index data back
 *    into `geometry` **in-place** (position + index attributes are replaced;
 *    normals/UVs are removed and must be recomputed by the caller).
 *
 * Returns `ManifoldRepairStats` on success, or `null` if the WASM is unavailable
 * or the mesh cannot be made into a valid manifold solid.
 */
export async function repairGeometryWithManifold(
  geometry: THREE.BufferGeometry,
): Promise<ManifoldRepairStats | null> {
  const wasm = await getManifoldWasm();
  if (!wasm) return null;

  const { Manifold, Mesh } = wasm;

  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) return null;

  // ── Build flat xyz vertex properties ───────────────────────────────────────
  const vertCount = posAttr.count;
  const vertProperties = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    vertProperties[i * 3 + 0] = posAttr.getX(i);
    vertProperties[i * 3 + 1] = posAttr.getY(i);
    vertProperties[i * 3 + 2] = posAttr.getZ(i);
  }

  // ── Build triangle index (trivial for unindexed STL output) ───────────────
  const indexAttr = geometry.getIndex();
  const triIndexLen = indexAttr ? indexAttr.count : vertCount;
  const triVerts = new Uint32Array(triIndexLen);
  if (indexAttr) {
    for (let i = 0; i < indexAttr.count; i++) triVerts[i] = indexAttr.getX(i);
  } else {
    for (let i = 0; i < triIndexLen; i++) triVerts[i] = i;
  }

  const preTri = triIndexLen / 3;

  let mesh: ManifoldMesh | null = null;
  let manifold: ManifoldObj | null = null;

  try {
    mesh = new Mesh({ numProp: 3, triVerts, vertProperties });

    // merge() welds open edges — best-effort, returns true if any merging happened.
    const merged = mesh.merge();

    manifold = new Manifold(mesh);

    if (manifold.isEmpty()) {
      manifold.delete();
      mesh.delete?.();
      return null;
    }

    const outMesh = manifold.getMesh();
    const outVertCount = outMesh.numVert;
    const outTriCount = outMesh.numTri;

    // ── Write repaired data back into the geometry in-place ─────────────────
    const newPositions = new Float32Array(outVertCount * 3);
    const vp = outMesh.vertProperties;
    for (let i = 0; i < outVertCount * 3; i++) newPositions[i] = vp[i];

    const newIndex = new Uint32Array(outTriCount * 3);
    const tv = outMesh.triVerts;
    for (let i = 0; i < newIndex.length; i++) newIndex[i] = tv[i];

    geometry.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
    geometry.setIndex(new THREE.BufferAttribute(newIndex, 1));
    // Normal/UV attributes are now stale — caller must recompute.
    if (geometry.getAttribute('normal')) geometry.deleteAttribute('normal');
    if (geometry.getAttribute('uv')) geometry.deleteAttribute('uv');

    // ── Cleanup WASM objects ────────────────────────────────────────────────
    outMesh.delete?.();
    manifold.delete();
    mesh.delete?.();

    return {
      manifoldMergedEdges: merged,
      degeneratesRemoved: Math.max(0, preTri - outTriCount),
    };
  } catch (err) {
    console.warn('[manifoldRepair] Manifold construction failed (mesh may be non-manifold):', err);
    try { manifold?.delete(); } catch { /* ignore */ }
    try { mesh?.delete?.(); } catch { /* ignore */ }
    return null;
  }
}
