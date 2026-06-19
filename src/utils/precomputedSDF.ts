/**
 * Frontend loader for the Rust pre-computed signed distance field.
 *
 * After mesh repair completes, call `loadPrecomputedSDF(mesh)` to
 * compute the SDF grid in Rust (via Tauri IPC) and inject it into
 * the SDFCache for that model. All subsequent pathfinding queries
 * become O(1) hash lookups with zero BVH overhead.
 */

import { PrecomputedSDFGrid } from '../supports/PlacementLogic/Pathfinding/PrecomputedSDFGrid';
import type { ClearanceHeightmap } from '../supports/PlacementLogic/Pathfinding/ClearanceHeightmap';
import { isTauriRuntime } from './meshRepair';

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let tauriCorePromise: Promise<{ invoke: TauriInvoke } | null> | null = null;

async function loadTauriCore(): Promise<{ invoke: TauriInvoke } | null> {
    if (!isTauriRuntime()) return null;
    if (!tauriCorePromise) {
        tauriCorePromise = import('@tauri-apps/api/core')
            .then((mod) => ({ invoke: mod.invoke as TauriInvoke }))
            .catch(() => null);
    }
    return tauriCorePromise;
}

export interface PrecomputedSDFResult {
    grid: PrecomputedSDFGrid;
    cellCount: number;
    cellSize: number;
}

/**
 * Request the Rust backend to compute a signed distance field from the
 * current staged mesh and return the deserialised grid.
 *
 * The grid is cached on the Rust side (keyed by mesh stats), so
 * repeated calls for the same model return instantly.
 */
export async function computePrecomputedSDF(
    opts?: { cellSize?: number; shellThickness?: number },
): Promise<PrecomputedSDFResult | null> {
    const core = await loadTauriCore();
    if (!core) return null;

    const args: Record<string, unknown> = {};
    if (opts?.cellSize !== undefined) args.cellSize = opts.cellSize;
    if (opts?.shellThickness !== undefined) args.shellThickness = opts.shellThickness;

    const response = await core.invoke<ArrayBuffer | Uint8Array | number[]>(
        'compute_sdf_from_staged',
        args,
    );

    let bytes: Uint8Array;
    if (response instanceof ArrayBuffer) {
        bytes = new Uint8Array(response);
    } else if (response instanceof Uint8Array) {
        bytes = response;
    } else if (Array.isArray(response)) {
        bytes = new Uint8Array(response);
    } else {
        console.warn('compute_sdf_from_staged: unexpected response type', typeof response);
        return null;
    }

    // Copy response bytes into a standalone ArrayBuffer for parsing.
    const buf: ArrayBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const grid = PrecomputedSDFGrid.fromBytes(buf as ArrayBuffer);

    if (!grid) {
        console.warn('compute_sdf_from_staged: failed to parse binary grid');
        return null;
    }

    return {
        grid,
        cellCount: grid.cellCount,
        cellSize: grid.cellSize,
    };
}

/**
 * Invalidate the Rust-side SDF cache (call after mesh repair or replacement).
 */
export async function invalidatePrecomputedSDF(): Promise<void> {
    const core = await loadTauriCore();
    if (!core) return;
    await core.invoke('invalidate_sdf_cache');
}

/**
 * Compute a clearance heightmap from the cached SDF grid on the Rust side.
 *
 * The heightmap is a 2D grid of per-XY highest-blocked Z values.  The A*
 * pathfinder uses it as a tight admissible heuristic and for O(1)
 * straight-descent viability checks.
 *
 * Requires that `computePrecomputedSDF()` has been called first.
 */
export async function computeHeightmap(
    clearance?: number,
): Promise<ClearanceHeightmap | null> {
    const core = await loadTauriCore();
    if (!core) return null;

    const args: Record<string, unknown> = {};
    if (clearance !== undefined) args.clearance = clearance;

    const response = await core.invoke<ArrayBuffer | Uint8Array | number[]>(
        'compute_heightmap_from_staged',
        args,
    );

    let bytes: Uint8Array;
    if (response instanceof ArrayBuffer) {
        bytes = new Uint8Array(response);
    } else if (response instanceof Uint8Array) {
        bytes = response;
    } else if (Array.isArray(response)) {
        bytes = new Uint8Array(response);
    } else {
        return null;
    }

    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);

    const { ClearanceHeightmap } = await import(
        '../supports/PlacementLogic/Pathfinding/ClearanceHeightmap'
    );
    return ClearanceHeightmap.fromBytes(buf);
}
