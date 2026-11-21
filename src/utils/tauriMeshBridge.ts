import * as THREE from 'three';
import { isTauriRuntime } from './tauriRuntime';

export type TauriInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown> | ArrayBuffer | ArrayBufferView,
  opts?: { headers?: Record<string, string> },
) => Promise<T>;

/** Subscribe to a backend event. Returns the unsubscribe function. */
export type TauriListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

export interface TauriCoreModule {
  invoke: TauriInvoke;
  listen: TauriListen;
}

let tauriCorePromise: Promise<TauriCoreModule | null> | null = null;

/**
 * Resolve the Tauri bindings this bridge needs, or null in the browser. Cached.
 *
 * Both modules are loaded together so a caller cannot end up with an `invoke` and no
 * way to hear back from the command it invoked.
 */
export async function loadTauriCore(): Promise<TauriCoreModule | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriCorePromise) {
    tauriCorePromise = Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ])
      .then(([core, event]) => ({
        invoke: core.invoke as TauriInvoke,
        listen: event.listen as TauriListen,
      }))
      .catch(() => null);
  }
  return tauriCorePromise;
}

/**
 * Flatten a geometry into a non-indexed f32 triangle soup, expanding the index
 * buffer when present. Returns the existing array when already flat.
 */
export function expandGeometryToTriangleSoup(geometry: THREE.BufferGeometry): Float32Array {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) throw new Error('expandGeometryToTriangleSoup: geometry has no position attribute');

  const positions = posAttr.array as ArrayLike<number>;
  const index = geometry.getIndex();
  if (!index) {
    if (positions instanceof Float32Array) return positions;
    return Float32Array.from(positions);
  }

  const indexArr = index.array as ArrayLike<number>;
  const soup = new Float32Array(indexArr.length * 3);
  for (let i = 0; i < indexArr.length; i += 1) {
    const src = indexArr[i] * 3;
    const dst = i * 3;
    soup[dst] = positions[src];
    soup[dst + 1] = positions[src + 1];
    soup[dst + 2] = positions[src + 2];
  }
  return soup;
}

/** Upload a geometry to the shared Rust staging buffer as a binary triangle soup. */
export async function stageGeometryToStagedMesh(
  invoke: TauriInvoke,
  geometry: THREE.BufferGeometry,
): Promise<void> {
  const soup = expandGeometryToTriangleSoup(geometry);
  const bytes = new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength);

  await invoke('stage_mesh_binary_set', bytes, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

/**
 * Decode raw little-endian f32 bytes returned over IPC. `label` names the source
 * in the error message. The bytes are copied into an aligned buffer so the
 * result is self-contained.
 */
export function decodeF32(bytes: ArrayBuffer | Uint8Array | number[], label: string): Float32Array {
  let u8: Uint8Array;
  if (bytes instanceof ArrayBuffer) {
    u8 = new Uint8Array(bytes);
  } else if (bytes instanceof Uint8Array) {
    u8 = bytes;
  } else if (Array.isArray(bytes)) {
    u8 = new Uint8Array(bytes);
  } else {
    throw new Error(`${label} returned unexpected type`);
  }

  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

/** Commands that return a raw little-endian f32 position payload. */
export type MeshPositionReadCommand =
  | 'mesh_repair_read_positions'
  | 'mesh_punch_read_positions'
  | 'mesh_hollow_preview_read_positions'
  | 'mesh_hollow_preview_read_infill_positions'
  | 'mesh_hollow_preview_read_removed_voxel_centers'
  | 'mesh_hollow_preview_read_blocked_voxel_centers'
  | 'mesh_hollow_preview_read_cavity_positions'
  | 'mesh_hollow_staged_read_cavity_positions'
  | 'mesh_organic_cut_read_geodesic'
  | 'mesh_organic_cut_read_membrane'
  | 'mesh_organic_cut_read_tenon';

/** Invoke a position-reading command and decode its f32 payload. */
export async function readPositionsFromCommand(
  invoke: TauriInvoke,
  command: MeshPositionReadCommand,
): Promise<Float32Array> {
  const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>(command);
  return decodeF32(bytes, command);
}

/**
 * Options for the native shrinkwrap resampler. Field names are the Rust
 * `ShrinkWrapOptions` struct's, which parses this JSON as-is.
 */
export interface ShrinkWrapOptions {
  /** Voxel size in mesh units; detail finer than this does not survive. */
  voxel_mm: number;
  /** Push the surface out by this much before extraction, closing gaps up to twice as wide. */
  gap_fill_mm: number;
  /** Push it out by this much more; additive with `gap_fill_mm`. */
  thickness_mm: number;
  /** Simplify the result to at most this many triangles. Zero keeps all of them. */
  max_triangles: number;
}

/** The native shrinkwrap report. Field names are the Rust `ShrinkWrapReport` struct's. */
export interface ShrinkWrapReport {
  input_triangles: number;
  /** Triangles before simplification. */
  isosurface_triangles: number;
  output_triangles: number;
  voxel_mm: number;
  offset_mm: number;
  band_points: number;
  ms: number;
  /** True when the run was stopped at a phase boundary; the mesh is then the input unchanged. */
  cancelled: boolean;
}

/**
 * One phase of a shrinkwrap run, as the engine announces it.
 *
 * The phases are the resampler's own: marking the cells the surface passes through, growing that
 * band, measuring a distance at each band point, extracting the isosurface, welding it, smoothing
 * it, orienting it, closing it, and — when the triangle budget is set — simplifying it and closing
 * that again. `index` is the 1-based position among the phases announced so far; the last two are
 * conditional, so the total is not fixed.
 */
export interface ShrinkWrapProgress {
  token: string;
  name: string;
  index: number;
}

/**
 * Resample the staged mesh into a closed one and return the report.
 *
 * The command rebuilds the surface from a signed distance field, so the result
 * has no relation to the input beyond its shape — every triangle is new. It
 * replaces the staging buffer, so read the result back with
 * `mesh_repair_read_positions`.
 *
 * When `progressToken` is given, the engine announces each phase on the
 * `mesh-shrinkwrap-progress` event carrying that token, and the same token can be
 * passed to `mesh_repair_cancel` to stop the run at a phase boundary.
 */
export async function shrinkwrapStagedMesh(
  invoke: TauriInvoke,
  options: ShrinkWrapOptions,
  progressToken?: string | null,
): Promise<ShrinkWrapReport> {
  const json = await invoke<string>('mesh_shrinkwrap_staged', {
    optionsJson: JSON.stringify(options),
    progressToken: progressToken ?? null,
  });
  return JSON.parse(json) as ShrinkWrapReport;
}

/**
 * Options for the native tetrahedral surfacing mode. Field names are the Rust
 * `TetWrapOptions` struct's, which parses this JSON as-is.
 */
export interface TetWrapOptions {
  /**
   * TetGen's own switches. `p` reads the model as a piecewise linear complex, so the decomposition
   * is constrained to contain its triangles; `Q` keeps TetGen quiet.
   */
  switches: string;
  /** Simplify the extracted surface to at most this many triangles. Zero keeps all of it. */
  max_triangles: number;
  /**
   * Simplify the input before decomposing it, on the engine's error scale. Off by default: a value
   * that does real work folds the facets this mode has to constrain.
   */
  tolerance: number;
}

/** The native tetrahedral surfacing report. Field names are the Rust `TetWrapReport` struct's. */
export interface TetWrapReport {
  input_triangles: number;
  /** Distinct points in the decomposition, after welding coincident export corners. */
  points: number;
  /** Tetrahedra in the decomposition. */
  tetrahedra: number;
  /** Tetrahedra the winding number put inside the surface. */
  inside_tetrahedra: number;
  output_triangles: number;
  ms: number;
  /** The tetrahedralisation alone. */
  tetgen_ms: number;
  /** Labelling every tetrahedron by the winding number at its centroid. */
  label_ms: number;
  /** Walking the faces to keep the boundary. */
  extract_ms: number;
  /** True when the run was stopped at a phase boundary; the mesh is then the input unchanged. */
  cancelled: boolean;
}

/**
 * One phase of a tetrahedral surfacing run, as the engine announces it.
 *
 * The phases are the resampler's own: tetrahedralising the welded points, labelling each cell by
 * the winding number at its centroid, and walking the faces to keep the boundary. `index` is the
 * 1-based position among the phases announced so far; all three always run, so the total is fixed.
 */
export interface TetWrapProgress {
  token: string;
  name: string;
  index: number;
}

/**
 * Resample the staged mesh by tetrahedralising its points and keeping the inside/outside boundary.
 *
 * Where the shrinkwrap command resamples onto a uniform lattice, this decomposition follows the
 * model's own points, so it keeps detail a voxel size would destroy; the boundary between two
 * labels is closed by construction, so it emits no debris. It replaces the staging buffer, so read
 * the result back with `mesh_repair_read_positions`.
 *
 * When `progressToken` is given, the engine announces each phase on the
 * `mesh-tet-surface-progress` event carrying that token, and the same token can be passed to
 * `mesh_repair_cancel` to stop the run at a phase boundary.
 */
/**
 * How a shrink-wrap resolves a surface into a solid.
 *
 * `fill_holes_max_edges` caps the loops the hole pass will close; the pass reads zero as "no loop
 * qualifies", so filling every loop is a very large number and that is the default. On a clean
 * closed solid the whole pass is a no-op, which is the point of keeping it beside the other two.
 */
export interface SolidRemeshOptions {
  fill_holes_max_edges: number;
  remove_noise_shells: boolean;
  /**
   * Simplify before resolving, on the engine's error scale. 0.001 removes about a quarter of a dense
   * model and 0.05 leaves almost nothing; zero leaves the surface alone.
   */
  tolerance: number;
}

/** The native shrink-wrap report. Field names are the Rust `SolidRemeshReport` struct's. */
export interface SolidRemeshReport {
  input_triangles: number;
  output_triangles: number;
  /** Shells before and after. The reference's own shrinkwrap is recorded as taking 246 to 1. */
  shells_before: number;
  shells_after: number;
  /** Boundary loops closed before the boolean ran. */
  holes_filled: number;
  /**
   * Vertices the preparation split to make the surface manifold enough for the boolean.
   *
   * Non-zero means the input shared edges between surfaces. A boolean will not take a mesh like that,
   * so without this step the rebuild declines on exactly the files that need it most.
   */
  non_manifold_resolved: number;
  /** Set when the boolean refused the input; the mesh is then the input unchanged. */
  declined: string | null;
  ms: number;
  cancelled: boolean;
}

/** One phase of a shrink-wrap run, as the engine announces it. */
export interface SolidRemeshProgress {
  token: string;
  name: string;
  index: number;
}

/**
 * Rebuild the staged mesh's surface by resolving it into a solid.
 *
 * This is the mode the reference implementation's shrinkwrap uses: close what is open, boolean the
 * mesh with itself so the result is resolved and retriangulated, then drop scrap shells. It moves
 * the surface, where the tetrahedral command conforms to it and hands it back. It replaces the
 * staging buffer, so read the result back with `mesh_repair_read_positions`.
 */
export async function solidRemeshStagedMesh(
  invoke: TauriInvoke,
  options: SolidRemeshOptions,
  progressToken?: string | null,
): Promise<SolidRemeshReport> {
  const json = await invoke<string>('mesh_solid_remesh_staged', {
    optionsJson: JSON.stringify(options),
    progressToken: progressToken ?? null,
  });
  return JSON.parse(json) as SolidRemeshReport;
}

export async function tetSurfaceStagedMesh(
  invoke: TauriInvoke,
  options: TetWrapOptions,
  progressToken?: string | null,
): Promise<TetWrapReport> {
  const json = await invoke<string>('mesh_tet_surface_staged', {
    optionsJson: JSON.stringify(options),
    progressToken: progressToken ?? null,
  });
  return JSON.parse(json) as TetWrapReport;
}

/**
 * Load a mesh that sits at a known offset inside a file on disk.
 *
 * A VOXL stores each model's mesh as a packed STL chunk at a directory-recorded
 * offset. Handing the native loader those numbers lets it read and inflate the chunk
 * where it already parses, so the bytes never enter the webview: the alternative
 * inflated 677 MB across a 15-model scene in JS before any model work started, and
 * everything that arrived here came back out again as a soup for the AO bake.
 *
 * Desktop only, and only for a source that has a path — a file out of a zip has no
 * range to give.
 */
export async function loadMeshRangeFromNativePath(request: {
  sourcePath: string;
  offset: number;
  compressedSize: number;
  compression: number;
  classify?: boolean;
}): Promise<Uint8Array> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native mesh loading is only available in DragonFruit Desktop (Tauri runtime).');
  }
  const bytes = await core.invoke<ArrayBuffer | Uint8Array>('load_mesh_range', {
    sourcePath: request.sourcePath,
    offset: request.offset,
    length: request.compressedSize,
    compression: request.compression,
    classify: request.classify ?? false,
  });
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}
