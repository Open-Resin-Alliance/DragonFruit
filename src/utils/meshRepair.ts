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
  stageFullResMutatorSource,
  type FullResMutatorSource,
} from '@/utils/fullResMutatorStaging';

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
  residual_issues: string[];
  fully_repaired: boolean;
  total_ms: number;
}

export interface MeshRepairOptions {
  weldEpsilon?: number;
  fillHolesMaxEdges?: number;
  keepLargestNComponents?: number | null;
  repairOrientation?: boolean;
  resolveSelfIntersections?: boolean;
  solidifyFragmentedComponents?: boolean;
  solidifyComponentThreshold?: number;
  solidifySelfIntersectionThreshold?: number;
  /**
   * P5-2 (decision D5): opt in to the lossy Tier-3 convex-hull rescue for
   * unrepairable support bodies. Serialized as `allowHullRescue` and consumed
   * by the Rust `RepairOptionsDto`. Defaults to false (skip) on the Rust side.
   */
  allowHullRescue?: boolean;
}

export interface MeshRepairResult {
  /** Report JSON emitted by the Rust engine */
  report: MeshHealthReport;
  /** Repaired positions buffer — ready to drop into a THREE.BufferGeometry */
  positions: Float32Array;
  /**
   * Phase 4 (STL-import remediation): true when the full-resolution ORIGINAL
   * file was spliced into staging instead of the ~2M preview geometry, so the
   * permanent repair consumed full resolution. The caller clears the
   * native-preview marker only when this is true.
   */
  usedFullRes?: boolean;
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
  residual_issues?: unknown;
  fully_repaired?: unknown;
  total_ms?: unknown;
}

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown> | ArrayBuffer | ArrayBufferView, opts?: { headers?: Record<string, string> }) => Promise<T>;

interface TauriCoreModule {
  invoke: TauriInvoke;
}

let tauriCorePromise: Promise<TauriCoreModule | null> | null = null;

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
    residual_issues: asStringArray(raw.residual_issues),
    fully_repaired: asBoolean(raw.fully_repaired),
    total_ms: asNumber(raw.total_ms),
  };
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

async function loadTauriCore(): Promise<TauriCoreModule | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriCorePromise) {
    tauriCorePromise = import('@tauri-apps/api/core')
      .then((mod) => ({ invoke: mod.invoke as TauriInvoke }))
      .catch(() => null);
  }
  return tauriCorePromise;
}

/**
 * Reads the repaired positions from the Rust staging buffer. Tauri v2 returns
 * raw `Response` body as an ArrayBuffer automatically when the command uses
 * `tauri::ipc::Response::new(bytes)`.
 */
async function readStagedPositions(invoke: TauriInvoke): Promise<Float32Array> {
  const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>('mesh_repair_read_positions');
  let u8: Uint8Array;
  if (bytes instanceof ArrayBuffer) {
    u8 = new Uint8Array(bytes);
  } else if (bytes instanceof Uint8Array) {
    u8 = bytes;
  } else if (Array.isArray(bytes)) {
    u8 = new Uint8Array(bytes);
  } else {
    throw new Error('mesh_repair_read_positions returned unexpected type');
  }
  // Copy into an aligned ArrayBuffer so the resulting Float32Array is self-contained.
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

/**
 * Runs the native mesh-repair engine on a file the Rust side can read
 * directly (STL/OBJ/3MF). Returns null if the current runtime isn't Tauri.
 */
export async function repairFromPath(
  filePath: string,
  options: MeshRepairOptions = {},
): Promise<MeshRepairResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;
  const optionsJson = JSON.stringify(options);
  const reportJson = await core.invoke<string>('mesh_repair_from_path', {
    filePath,
    optionsJson,
  });
  const report = normalizeMeshHealthReport(JSON.parse(reportJson));
  const positions = await readStagedPositions(core.invoke);
  return { report, positions };
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

  await core.invoke('stage_mesh_binary_set', bytes, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  const analysisJson = await core.invoke<string>('mesh_analyze_staged');
  return normalizeMeshAnalysis(JSON.parse(analysisJson));
}

/**
 * Returns true when analysis data indicates a heavy solidification repair will
 * be triggered. Matches the default thresholds in RepairOptions::default().
 */
export function isHeavyRepair(analysis: MeshAnalysisJson): boolean {
  return analysis.component_count >= 256 && analysis.self_intersections >= 128;
}

/**
 * Runs the native mesh-repair engine over an existing THREE.BufferGeometry
 * by staging its position buffer and invoking the staged-repair command.
 * Returns null if not running under Tauri.
 */
export async function repairFromGeometry(
  geometry: THREE.BufferGeometry,
  options: MeshRepairOptions = {},
  fullResSource?: FullResMutatorSource | null,
): Promise<MeshRepairResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) throw new Error('repairFromGeometry: geometry has no position attribute');

  // Phase 4: for a native-preview model, splice the ORIGINAL file into staging
  // Rust-side so the permanent repair consumes full resolution — bytes never
  // enter the WebView (plan §C.2). A missing/stale source degrades to staging
  // the preview geometry (never silent — the manager surfaces the reason).
  let usedFullRes = false;
  if (fullResSource) {
    try {
      await stageFullResMutatorSource(core.invoke, fullResSource);
      usedFullRes = true;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      console.warn(
        `[RepairFullRes] full-res source splice failed — repairing the reduced preview instead: ${raw}`,
      );
      await stageGeometrySoupToStagedMesh(core.invoke, geometry);
    }
  } else {
    await stageGeometrySoupToStagedMesh(core.invoke, geometry);
  }

  const optionsJson = JSON.stringify(options);
  const reportJson = await core.invoke<string>('mesh_repair_staged', {
    optionsJson,
  });
  const report = normalizeMeshHealthReport(JSON.parse(reportJson));
  const positions = await readStagedPositions(core.invoke);
  return { report, positions, usedFullRes };
}

/** Stages a geometry's triangle soup into the shared staged mesh (raw f32). */
async function stageGeometrySoupToStagedMesh(
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
 * Runs a lightweight model/support section classifier over an existing
 * THREE.BufferGeometry by staging positions and invoking `mesh_classify_staged`.
 * This does not run the expensive repair pipeline.
 */
export async function classifyFromGeometry(
  geometry: THREE.BufferGeometry,
): Promise<MeshRepairResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) throw new Error('classifyFromGeometry: geometry has no position attribute');

  const soup = expandGeometryToTriangleSoup(geometry);
  const bytes = new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength);

  await core.invoke('stage_mesh_binary_set', bytes, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  const reportJson = await core.invoke<string>('mesh_classify_staged');
  const report = normalizeMeshHealthReport(JSON.parse(reportJson));
  const positions = await readStagedPositions(core.invoke);
  return { report, positions };
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

function expandGeometryToTriangleSoup(geometry: THREE.BufferGeometry): Float32Array {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const positions = posAttr.array as Float32Array;
  const index = geometry.getIndex();

  if (!index) {
    // Already triangle soup, but caller may pass non-Float32Array — coerce.
    if (positions instanceof Float32Array) {
      return positions;
    }
    return new Float32Array(positions as unknown as ArrayLike<number>);
  }

  const indexArr = index.array as Uint16Array | Uint32Array;
  const out = new Float32Array(indexArr.length * 3);
  for (let i = 0; i < indexArr.length; i++) {
    const vi = indexArr[i] * 3;
    const oi = i * 3;
    out[oi] = positions[vi];
    out[oi + 1] = positions[vi + 1];
    out[oi + 2] = positions[vi + 2];
  }
  return out;
}
