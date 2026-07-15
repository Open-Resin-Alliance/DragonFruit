/**
 * Resource-aware safety limits for the hollow-voxel preview renderers
 * (`HollowVoxelPreview.tsx`, `HollowVoxelEditOverlay.tsx`).
 *
 * The cube bodies are a shared `InstancedMesh`, 64 bytes/voxel for the
 * instance matrix. The cube-edge wireframe used to be a separate, fully
 * expanded `LineSegments` position buffer at 288 bytes/voxel (24 vertices x
 * 3 floats) -- on a large part with a fine voxel size (or after repeated
 * lasso-blocking re-exposes more of the cavity interior as boundary), voxel
 * counts could reach into the millions, and an unbounded
 * `new Float32Array(voxelCount * 72)` could throw
 * `RangeError: Array buffer allocation failed` and crash the render tree.
 *
 * The edges are now GPU-instanced too (see `instancedEdgeShader.ts` /
 * `buildInstancedEdgeGeometry` in both renderer files), reusing the exact
 * same per-voxel matrix buffer already built for the cubes -- there is no
 * longer any O(voxel count) allocation for edges at all, just one shared
 * 288-byte template built once. So `maxEdgeInstances` is now simply equal
 * to `maxCubeInstances`; it's kept as a distinct field (rather than removed)
 * so neither renderer file needs to change its cap-checking logic, and so a
 * future change to either cost model doesn't require touching call sites.
 *
 * The budget itself is sized from `performance.memory.jsHeapSizeLimit` when
 * available (Chromium/WebView2) so the cap scales with the actual runtime
 * rather than a single fixed number picked for one machine.
 */

const BUDGET_FRACTION_OF_HEAP_LIMIT = 0.12;
const FALLBACK_BUDGET_BYTES = 150 * 1024 * 1024;
const BYTES_PER_CUBE_INSTANCE = 64; // 4x4 f32 instance matrix -- the only real per-voxel cost left

export type VoxelPreviewBudget = {
  maxCubeInstances: number;
  maxEdgeInstances: number;
};

function readMemoryBudgetBytes(): number {
  const memory = (performance as Performance & { memory?: { jsHeapSizeLimit?: number } }).memory;
  if (memory && typeof memory.jsHeapSizeLimit === 'number' && memory.jsHeapSizeLimit > 0) {
    return memory.jsHeapSizeLimit * BUDGET_FRACTION_OF_HEAP_LIMIT;
  }
  return FALLBACK_BUDGET_BYTES;
}

let cachedBudget: VoxelPreviewBudget | null = null;

/**
 * Returns the current voxel-instance ceilings. Cached for the page's
 * lifetime -- `jsHeapSizeLimit` is a fixed property of the running engine,
 * not something that changes moment to moment.
 */
export function getVoxelPreviewBudget(): VoxelPreviewBudget {
  if (!cachedBudget) {
    const budgetBytes = readMemoryBudgetBytes();
    const maxCubeInstances = Math.max(1, Math.floor(budgetBytes / BYTES_PER_CUBE_INSTANCE));
    cachedBudget = {
      maxCubeInstances,
      maxEdgeInstances: maxCubeInstances,
    };
  }
  return cachedBudget;
}

const warnedKeys = new Set<string>();

/** Logs a console warning at most once per unique key for the page's lifetime. */
export function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

/**
 * Allocates a Float32Array, returning `null` instead of throwing if the
 * engine can't satisfy the request. Defense-in-depth alongside the
 * resource-aware budget above, which should normally prevent this from
 * ever being hit -- guards against the heuristic underestimating real
 * available memory (fragmentation, other processes, etc.).
 */
export function tryAllocateFloat32Array(length: number): Float32Array | null {
  try {
    return new Float32Array(length);
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}
