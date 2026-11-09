/**
 * Frontend dispatcher for the DragonFruit mesh-repair engine.
 *
 * Under Tauri:
 *   - `repairFromPath(filePath)` — Rust reads the file directly (STL/OBJ/3MF/
 *     staged positions), runs analyze + repair, and leaves the repaired
 *     positions in the shared staging buffer. We then fetch those bytes back
 *     as a new Float32Array.
 *   - `repairFromGeometry(geometry)` — Uploads the existing
 *     `THREE.BufferGeometry` position buffer via the existing staging IPC
 *     (`stage_mesh_binary_set`) and runs `mesh_repair_staged`.
 *   - `classifyFromGeometry(geometry)` — Uploads geometry and runs
 *     `mesh_classify_staged`, a lightweight model/support section classifier
 *     that does not execute the heavy repair pipeline.
 *
 * In the browser (non-Tauri) this module is inert — call sites fall back to
 * the WASM Manifold repair path.
 */
import * as THREE from 'three';
import {
  expandGeometryToTriangleSoup,
  loadTauriCore,
  readPositionsFromCommand,
} from './tauriMeshBridge';

/**
 * Runs one staged mesh pass at a time.
 *
 * `stage_mesh_binary_set` — and every command that reads the staged buffer back —
 * is process-wide state, so a stage/consume window is only meaningful while nothing
 * else stages. The VOXL import builds four models concurrently, and a model whose
 * stored classification does not address its payload runs the classify pass from
 * inside its build: two of those interleaved, each read back the *other's* soup, and
 * the viewport showed one model's geometry in another model's place. Serialising the
 * window is the whole fix; each pass is still native work off the main thread.
 */
let stagedPass: Promise<unknown> = Promise.resolve();
function withStagedMesh<T>(pass: () => Promise<T>): Promise<T> {
  const run = stagedPass.then(pass, pass);
  stagedPass = run.catch(() => undefined);
  return run;
}

export interface MeshAnalysisJson {
  triangle_count: number;
  vertex_count: number;
  non_manifold_edges: number;
  non_manifold_vertices: number;
  boundary_edges: number;
  boundary_loops: number;
  inconsistent_edges: number;
  degenerate_triangles: number;
  duplicate_triangles: number;
  component_count: number;
  self_intersections: number;
  signed_volume: number;
  is_watertight: boolean;
  timings_ms: {
    topology_ms: number;
    self_intersections_ms: number;
    components_ms: number;
    total_ms: number;
  };
}

export interface MeshRepairStep {
  name: string;
  duration_ms: number;
  details?: string;
  changed?: number;
}

export interface MeshHealthReport {
  version: number;
  source_path?: string | null;
  pre: MeshAnalysisJson;
  post: MeshAnalysisJson;
  steps: MeshRepairStep[];
  likely_support_geometry: boolean;
  /** When present, the first N triangles in the repaired mesh are model body;
   *  the remainder are support geometry. Used to bake per-triangle vertex colors. */
  model_triangle_count?: number | null;
  /** Result of the final manifold_csg status check on the model section, run at
   *  the end of the native repair and classify routines. `false` means the CSG
   *  backend reported some non-manifold status (open mesh, non-finite vertices,
   *  out-of-bounds indices, etc.) and the model should render red;
   *  `null`/undefined means the check did not run (manifold backend disabled). */
  model_is_manifold?: boolean | null;
  /** Specific manifold_csg status string when `model_is_manifold` is false. */
  model_manifold_status?: string | null;
  residual_issues: string[];
  /** Set when the mesh was repaired as a plate: one entry per part, each with its own verdict.
   *  Empty for a single-object mesh, which is most of them. */
  parts?: MeshRepairPartSummary[];
  fully_repaired: boolean;
  /** True when the mesh in `post` came from the rebuild route rather than from the local pipeline:
   *  the surface was resolved into a solid, which is a different object rather than the same one
   *  repaired, so the before/after numbers describe two meshes rather than one mesh twice. */
  rebuilt: boolean;
  /** True when the run stopped at a stage boundary because the caller asked. */
  cancelled: boolean;
  total_ms: number;
}

/** One part of a plate, and what repairing it on its own came to. */
export interface MeshRepairPartSummary {
  index: number;
  triangles_before: number;
  triangles_after: number;
  fully_repaired: boolean;
  residual_issues: string[];
}

export interface MeshRepairOptions {
  weldToleranceMm?: number;
  fillHolesMaxEdges?: number;
  keepLargestNComponents?: number | null;
  repairOrientation?: boolean;
  resolveSelfIntersections?: boolean;
  /**
   * Cut the edges no winding assignment can satisfy, as a last resort after every other pass.
   *
   * Off by default: it settles the winding class with geometry — the region is one face from each
   * unsatisfiable edge, and the vertices it shares with the rest of the surface are duplicated.
   * Kept only when it helps. Measured on `Gusano_de_Dune_70%.stl`: winding 1,374 -> 0, non-manifold
   * edges 196 -> 97, pinched vertices 338 -> 188.
   */
  cutUnsatisfiableEdges?: boolean;
  /**
   * Let the repair fall back to the surface-to-solid rebuild when the local pipeline cannot settle
   * the mesh. On by default, and judged: kept only when it is fully repaired or strictly better.
   * The surface moves when it runs, and the report says so.
   */
  allowRebuild?: boolean;
  assumeSupportGeometry?: boolean;
}

export interface MeshRepairResult {
  /** Report JSON emitted by the Rust engine */
  report: MeshHealthReport;
  /** Repaired positions buffer — ready to drop into a THREE.BufferGeometry */
  positions: Float32Array;
}

type UnknownRecord = Record<string, unknown>;

interface RawMeshAnalysisJson extends UnknownRecord {
  triangle_count?: unknown;
  vertex_count?: unknown;
  non_manifold_edges?: unknown;
  non_manifold_vertices?: unknown;
  boundary_edges?: unknown;
  boundary_loops?: unknown;
  inconsistent_edges?: unknown;
  inconsistent_winding_edges?: unknown;
  degenerate_triangles?: unknown;
  duplicate_triangles?: unknown;
  component_count?: unknown;
  connected_components?: unknown;
  self_intersections?: unknown;
  self_intersection_triangles?: unknown;
  signed_volume?: unknown;
  is_watertight?: unknown;
  timings_ms?: unknown;
}

interface RawMeshRepairStep extends UnknownRecord {
  name?: unknown;
  duration_ms?: unknown;
  elapsed_ms?: unknown;
  details?: unknown;
  notes?: unknown;
  changed?: unknown;
}

interface RawMeshHealthReport extends UnknownRecord {
  version?: unknown;
  source_path?: unknown;
  pre?: unknown;
  post?: unknown;
  steps?: unknown;
  likely_support_geometry?: unknown;
  likelySupportGeometry?: unknown;
  model_triangle_count?: unknown;
  model_is_manifold?: unknown;
  model_manifold_status?: unknown;
  residual_issues?: unknown;
  rebuilt?: unknown;
  fully_repaired?: unknown;
  cancelled?: unknown;
  total_ms?: unknown;
}

function asRecord(value: unknown): UnknownRecord {
  return value != null && typeof value === 'object' ? value as UnknownRecord : {};
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeMeshAnalysis(input: unknown): MeshAnalysisJson {
  const raw = asRecord(input) as RawMeshAnalysisJson;
  const timings = asRecord(raw.timings_ms);
  return {
    triangle_count: asNumber(raw.triangle_count),
    vertex_count: asNumber(raw.vertex_count),
    non_manifold_edges: asNumber(raw.non_manifold_edges),
    non_manifold_vertices: asNumber(raw.non_manifold_vertices),
    boundary_edges: asNumber(raw.boundary_edges),
    boundary_loops: asNumber(raw.boundary_loops),
    inconsistent_edges: asNumber(raw.inconsistent_edges ?? raw.inconsistent_winding_edges),
    degenerate_triangles: asNumber(raw.degenerate_triangles),
    duplicate_triangles: asNumber(raw.duplicate_triangles),
    component_count: asNumber(raw.component_count ?? raw.connected_components),
    self_intersections: asNumber(raw.self_intersections ?? raw.self_intersection_triangles),
    signed_volume: asNumber(raw.signed_volume),
    is_watertight: asBoolean(raw.is_watertight),
    timings_ms: {
      topology_ms: asNumber(timings.topology_ms),
      self_intersections_ms: asNumber(timings.self_intersections_ms),
      components_ms: asNumber(timings.components_ms),
      total_ms: asNumber(timings.total_ms),
    },
  };
}

function normalizeMeshRepairStep(input: unknown): MeshRepairStep {
  const raw = asRecord(input) as RawMeshRepairStep;
  return {
    name: asString(raw.name, 'step'),
    duration_ms: asNumber(raw.duration_ms ?? raw.elapsed_ms),
    details: asOptionalString(raw.details ?? raw.notes),
    changed: asNumber(raw.changed),
  };
}

function normalizeMeshHealthReport(input: unknown): MeshHealthReport {
  const raw = asRecord(input) as RawMeshHealthReport;
  const pre = normalizeMeshAnalysis(raw.pre);
  const post = normalizeMeshAnalysis(raw.post);
  return {
    version: asNumber(raw.version, 1),
    source_path: typeof raw.source_path === 'string' ? raw.source_path : null,
    pre,
    post,
    steps: Array.isArray(raw.steps) ? raw.steps.map(normalizeMeshRepairStep) : [],
    likely_support_geometry: asBoolean(raw.likely_support_geometry ?? raw.likelySupportGeometry),
    model_triangle_count: typeof raw.model_triangle_count === 'number' && raw.model_triangle_count > 0
      ? raw.model_triangle_count
      : null,
    model_is_manifold: typeof raw.model_is_manifold === 'boolean' ? raw.model_is_manifold : null,
    model_manifold_status: typeof raw.model_manifold_status === 'string' ? raw.model_manifold_status : null,
    rebuilt: asBoolean(raw.rebuilt),
    residual_issues: asStringArray(raw.residual_issues),
    parts: Array.isArray(raw.parts)
      ? raw.parts.map((entry) => {
        const part = asRecord(entry);
        return {
          index: asNumber(part.index),
          triangles_before: asNumber(part.triangles_before),
          triangles_after: asNumber(part.triangles_after),
          fully_repaired: asBoolean(part.fully_repaired),
          residual_issues: asStringArray(part.residual_issues),
        };
      })
      : [],
    fully_repaired: asBoolean(raw.fully_repaired),
    cancelled: asBoolean(raw.cancelled),
    total_ms: asNumber(raw.total_ms),
  };
}

/**
 * Runs the native mesh-repair engine on a file the Rust side can read
 * directly (STL/OBJ/3MF). Returns null if the current runtime isn't Tauri.
 */
export async function repairFromPath(
  filePath: string,
  options: MeshRepairOptions = {},
  sink?: MeshRepairProgressSink,
): Promise<MeshRepairResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;
  const optionsPayload = {
    ...options,
    assume_support_geometry: options.assumeSupportGeometry,
  };
  const optionsJson = JSON.stringify(optionsPayload);

  const wantsProgress = Boolean(sink?.onProgress || sink?.onToken);
  const token = wantsProgress ? crypto.randomUUID() : null;
  let unlisten: (() => void) | null = null;
  if (token && sink) {
    sink.onToken?.(token);
    unlisten = await core.listen<MeshRepairProgress>('mesh-repair-progress', (event) => {
      const progress = event.payload;
      if (progress && progress.token === token) sink.onProgress?.(progress);
    });
  }

  try {
    return await withStagedMesh(async () => {
      const reportJson = await core.invoke<string>('mesh_repair_from_path', {
        filePath,
        optionsJson,
        progressToken: token,
      });
      const report = normalizeMeshHealthReport(JSON.parse(reportJson));
      const positions = await readPositionsFromCommand(core.invoke, 'mesh_repair_read_positions');
      return { report, positions };
    });
  } finally {
    unlisten?.();
  }
}

/**
 * Repairs a plate part by part: the shells that meet stay together as one object, each object is
 * repaired on its own, and the result comes back as one mesh with a verdict per object.
 *
 * The difference from {@link repairFromPath} is the unit. A file that is 25 objects gets one verdict
 * for all of them from the whole-file pass, which says nothing about which object is the problem;
 * this returns the same shape with `report.parts` filled in, so a caller can say "26 of 39 parts
 * repaired" and name the ones that are not. Returns null outside Tauri, or when the mesh is one
 * object (in which case `repairFromPath` is the right call).
 */
export async function repairPartsFromPath(
  filePath: string,
  options: MeshRepairOptions = {},
  sink?: MeshRepairProgressSink,
): Promise<MeshRepairResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;
  const optionsPayload = {
    ...options,
    assume_support_geometry: options.assumeSupportGeometry,
  };
  const optionsJson = JSON.stringify(optionsPayload);

  const wantsProgress = Boolean(sink?.onProgress || sink?.onToken);
  const token = wantsProgress ? crypto.randomUUID() : null;
  let unlisten: (() => void) | null = null;
  if (token && sink) {
    sink.onToken?.(token);
    unlisten = await core.listen<MeshRepairProgress>('mesh-repair-progress', (event) => {
      const progress = event.payload;
      if (progress && progress.token === token) sink.onProgress?.(progress);
    });
  }

  try {
    return await withStagedMesh(async () => {
      const reportJson = await core.invoke<string>('mesh_repair_parts_from_path', {
        filePath,
        optionsJson,
        progressToken: token,
      });
      const report = normalizeMeshHealthReport(JSON.parse(reportJson));
      const positions = await readPositionsFromCommand(core.invoke, 'mesh_repair_read_positions');
      return { report, positions };
    });
  } finally {
    unlisten?.();
  }
}

/**
 * Loads a mesh from a file path and returns its positions, repairing nothing.
 *
 * The webview refuses a `file://` fetch, so a path goes through Rust the way `repairFromPath` does
 * and stops before the repair. Used to put a model back to how it arrived.
 */
export async function loadMeshFromPath(filePath: string): Promise<Float32Array | null> {
  const core = await loadTauriCore();
  if (!core) return null;
  return withStagedMesh(async () => {
    await core.invoke<void>('mesh_load_from_path', { filePath });
    return readPositionsFromCommand(core.invoke, 'mesh_repair_read_positions');
  });
}

/**
 * Uploads a geometry to the Rust staging buffer and runs analysis only —
 * no repair is performed and the staged buffer retains the original positions.
 * Returns null if not running under Tauri.
 */
export async function analyzeFromGeometry(
  geometry: THREE.BufferGeometry,
): Promise<MeshAnalysisJson | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) throw new Error('analyzeFromGeometry: geometry has no position attribute');

  const soup = expandGeometryToTriangleSoup(geometry);
  const bytes = new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength);

  return withStagedMesh(async () => {
    await core.invoke('stage_mesh_binary_set', bytes, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    const analysisJson = await core.invoke<string>('mesh_analyze_staged');
    return normalizeMeshAnalysis(JSON.parse(analysisJson));
  });
}

/**
 * Returns true when analysis data indicates a heavy solidification repair will
 * be triggered. Matches the default thresholds in RepairOptions::default().
 */
export function isHeavyRepair(analysis: MeshAnalysisJson): boolean {
  // The five classes the verdict is made of, not the crossings.
  //
  // A mesh that crosses itself and is otherwise sound prints, so telling a user their
  // model needs a repair because of its crossings is how a good file ends up with
  // minutes of work spent on it. What makes a repair heavy is fragmentation, which the
  // pipeline resolves component by component, or a real defect: a bad edge, a hole, or
  // a winding disagreement.
  return (
    analysis.component_count >= 256
    || analysis.non_manifold_edges > 0
    || analysis.boundary_loops > 0
    || analysis.inconsistent_edges > 0
  );
}

/**
 * Runs the native mesh-repair engine over an existing THREE.BufferGeometry
 * by staging its position buffer and invoking the staged-repair command.
 * Returns null if not running under Tauri.
 */
/**
 * One stage of a repair, as the engine announces it.
 *
 * A repair runs for seconds and a large mesh for minutes, so the stages are what a
 * progress display has to show. `index` is the 1-based position among the stages
 * reported so far, and the total is not known upfront because two stages are
 * conditional.
 */
export interface MeshRepairProgress {
  token: string;
  name: string;
  index: number;
}

export interface MeshRepairProgressSink {
  /** Called as each stage starts. */
  onProgress?: (progress: MeshRepairProgress) => void;
  /**
   * Called with the run's token before it starts, so the caller can hold onto it
   * and cancel. A cancel lands at the next stage boundary, never mid-pass.
   */
  onToken?: (token: string) => void;
}

/**
 * Asks a repair in flight to stop at its next stage boundary.
 *
 * Returns whether a repair was carrying that token. A cancel arriving after the run
 * finished is a no-op rather than an error.
 */
export async function cancelMeshRepair(token: string): Promise<boolean> {
  const core = await loadTauriCore();
  if (!core) return false;
  return core.invoke<boolean>('mesh_repair_cancel', { progressToken: token });
}

export async function repairFromGeometry(
  geometry: THREE.BufferGeometry,
  options: MeshRepairOptions = {},
  sink?: MeshRepairProgressSink,
): Promise<MeshRepairResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) throw new Error('repairFromGeometry: geometry has no position attribute');

  // Normalize to a contiguous Float32Array (handle indexed geometry by
  // expanding to triangle soup).
  const soup = expandGeometryToTriangleSoup(geometry);
  const bytes = new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength);

  await core.invoke('stage_mesh_binary_set', bytes, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  const optionsPayload = {
    ...options,
    assume_support_geometry: options.assumeSupportGeometry,
  };
  const optionsJson = JSON.stringify(optionsPayload);
  const wantsProgress = Boolean(sink?.onProgress || sink?.onToken);
  const token = wantsProgress ? crypto.randomUUID() : null;
  let unlisten: (() => void) | null = null;
  if (token && sink) {
    sink.onToken?.(token);
    unlisten = await core.listen<MeshRepairProgress>('mesh-repair-progress', (event) => {
      const progress = event.payload;
      if (progress && progress.token === token) sink.onProgress?.(progress);
    });
  }

  try {
    const reportJson = await core.invoke<string>('mesh_repair_staged', {
      optionsJson,
      progressToken: token,
    });
    const report = normalizeMeshHealthReport(JSON.parse(reportJson));
    const positions = await readPositionsFromCommand(core.invoke, 'mesh_repair_read_positions');
    return { report, positions };
  } finally {
    unlisten?.();
  }
}

/**
 * Runs a lightweight model/support section classifier over an existing
 * THREE.BufferGeometry by staging positions and invoking `mesh_classify_staged`.
 * This does not run the expensive repair pipeline.
 */
export async function classifyFromGeometry(
  geometry: THREE.BufferGeometry,
  options: MeshRepairOptions = {},
): Promise<MeshRepairResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) throw new Error('classifyFromGeometry: geometry has no position attribute');

  const soup = expandGeometryToTriangleSoup(geometry);
  const bytes = new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength);

  const optionsPayload = {
    ...options,
    assume_support_geometry: options.assumeSupportGeometry,
  };
  const optionsJson = JSON.stringify(optionsPayload);
  return withStagedMesh(async () => {
    await core.invoke('stage_mesh_binary_set', bytes, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    const reportJson = await core.invoke<string>('mesh_classify_staged', {
      optionsJson,
    });
    const report = normalizeMeshHealthReport(JSON.parse(reportJson));
    const positions = await readPositionsFromCommand(core.invoke, 'mesh_repair_read_positions');
    return { report, positions };
  });
}

/**
 * Replaces the content of a BufferGeometry with a freshly-repaired triangle-
 * soup position buffer. Drops any existing normals/index; `processGeometry`
 * will rebuild them.
 */
export function applyRepairedPositions(
  geometry: THREE.BufferGeometry,
  positions: Float32Array,
): void {
  geometry.setIndex(null);
  // Remove any stale attributes keyed to the old vertex layout.
  const attrNames = Object.keys(geometry.attributes);
  for (const name of attrNames) {
    if (name !== 'position') geometry.deleteAttribute(name);
  }
  geometry.deleteAttribute('position');
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

