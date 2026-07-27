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
  /**
   * Ph1 CP3 — `null` means UNKNOWN, not "no".
   *
   * `minimal_analysis` (the classify-only tier) computes no topology at all and
   * returned a hardcoded `is_watertight: false`, which the UI rendered as a
   * definite "not watertight" for perfectly closed meshes. Rust now reports
   * `is_watertight_measured` alongside the value; when it is false the verdict
   * is transported as `null` and must be rendered as an em dash, never as "no".
   */
  is_watertight: boolean | null;
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
  fully_repaired: boolean;
  total_ms: number;
}

/**
 * Ph1 wiring — cheap per-section topology stats measured at import.
 *
 * The honesty contract is the whole point of the shape: EVERY field the tier
 * may or may not compute is `number | null`. `null` means UNKNOWN and renders
 * as an em dash; it must never be collapsed to `0`. `self_intersection_triangles`
 * is `null` by construction — the sweep that would fill it is a BVH query per
 * triangle and has no place in an import path.
 */
export interface SectionStatsJson {
  triangle_count: number;
  vertex_count: number;
  connected_components: number | null;
  boundary_edges: number | null;
  boundary_loops: number | null;
  largest_boundary_loop: number | null;
  non_manifold_edges: number | null;
  non_manifold_vertices: number | null;
  inconsistent_winding_edges: number | null;
  is_watertight: boolean | null;
  self_intersection_triangles: number | null;
  elapsed_ms: number;
}

/**
 * Ph1 wiring — what `load_stl_file` learned about the FULL-RESOLUTION source,
 * decoded from the DFST response.
 *
 * This describes the SOURCE FILE, not the geometry in the viewport: for an
 * over-budget import the payload is a decimated preview while these numbers
 * (and the run map) still address the original. `model_triangle_count` is
 * therefore only a valid index into the returned geometry when `isPreview` is
 * false.
 */
export interface ImportClassificationJson {
  /** `null` when no reliable model/support partition was found — which is the
   *  ABSENCE of a split, not a split covering everything. */
  model_triangle_count: number | null;
  likely_support_geometry: boolean;
  connected_components: number | null;
  model_section: SectionStatsJson | null;
  support_section: SectionStatsJson | null;
  source_triangle_count: number;
  dropped_nonfinite_triangles: number;
  /** `null` = the manifold check was DELIBERATELY NOT RUN. Never `false` for a
   *  mesh nobody looked at. */
  model_is_manifold: boolean | null;
  model_manifold_status: string | null;
  /** True when the check was skipped by the size guard specifically, as opposed
   *  to the backend being unavailable. */
  manifold_check_size_guarded: boolean;
  classify_ms: number;
  section_stats_ms: number;
  /** Runs the classifier PRODUCED. Greater than the decoded run map's length
   *  means the map exceeded the transport cap and must be recomputed. */
  run_count: number;
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
  /**
   * Ph1(e) — forward a model's ALREADY-KNOWN support verdict into a re-repair.
   *
   * `likely_support_geometry` is derived from a component-shaped heuristic, and
   * the first repair's own manifold batch-union fuses the support components
   * into a single solid. A second repair therefore cannot re-derive the verdict
   * and — because each `repair()` starts a fresh report — silently downgrades
   * it to false, which is what makes the support checkbox stop sticking.
   * Serialized as `assumeSupportGeometry`; seeds the Rust-side latch.
   */
  assumeSupportGeometry?: boolean;
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
  is_watertight_measured?: unknown;
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
    // UNKNOWN when the topology tier did not run. Older payloads carry no
    // `is_watertight_measured` field at all; those came from `analyze` /
    // `analyze_lightweight`, which always measured it, so absence means true.
    is_watertight:
      raw.is_watertight_measured === false ? null : asBoolean(raw.is_watertight),
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

/**
 * Test-only seam for the Ph1 CP3 UNKNOWN contract. The normalizer is the single
 * place the Rust `is_watertight_measured` flag becomes a `null` verdict, and
 * there is no other way to reach it without a live Tauri `invoke`.
 */
export function normalizeMeshHealthReportForTest(input: unknown): MeshHealthReport {
  return normalizeMeshHealthReport(input);
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
    residual_issues: asStringArray(raw.residual_issues),
    fully_repaired: asBoolean(raw.fully_repaired),
    total_ms: asNumber(raw.total_ms),
  };
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeSectionStats(input: unknown): SectionStatsJson | null {
  if (input == null || typeof input !== 'object') return null;
  const raw = asRecord(input);
  return {
    triangle_count: asNumber(raw.triangle_count),
    vertex_count: asNumber(raw.vertex_count),
    connected_components: asOptionalNumber(raw.connected_components),
    boundary_edges: asOptionalNumber(raw.boundary_edges),
    boundary_loops: asOptionalNumber(raw.boundary_loops),
    largest_boundary_loop: asOptionalNumber(raw.largest_boundary_loop),
    non_manifold_edges: asOptionalNumber(raw.non_manifold_edges),
    non_manifold_vertices: asOptionalNumber(raw.non_manifold_vertices),
    inconsistent_winding_edges: asOptionalNumber(raw.inconsistent_winding_edges),
    is_watertight: typeof raw.is_watertight === 'boolean' ? raw.is_watertight : null,
    // Never defaulted to 0 — see `SectionStatsJson`.
    self_intersection_triangles: asOptionalNumber(raw.self_intersection_triangles),
    elapsed_ms: asNumber(raw.elapsed_ms),
  };
}

/**
 * Decodes the classification block carried by the DFST import response.
 *
 * Tolerant of a missing block (returns `null`) because a response produced by
 * an older binary carries none — but NOT tolerant about UNKNOWN: an absent
 * numeric field becomes `null`, never `0`.
 */
export function parseImportClassification(input: unknown): ImportClassificationJson | null {
  if (input == null || typeof input !== 'object') return null;
  const raw = asRecord(input);
  const modelTriangleCount = asOptionalNumber(raw.model_triangle_count);
  return {
    model_triangle_count:
      modelTriangleCount != null && modelTriangleCount > 0 ? modelTriangleCount : null,
    likely_support_geometry: asBoolean(raw.likely_support_geometry),
    connected_components: asOptionalNumber(raw.connected_components),
    model_section: normalizeSectionStats(raw.model_section),
    support_section: normalizeSectionStats(raw.support_section),
    source_triangle_count: asNumber(raw.source_triangle_count),
    dropped_nonfinite_triangles: asNumber(raw.dropped_nonfinite_triangles),
    model_is_manifold: typeof raw.model_is_manifold === 'boolean' ? raw.model_is_manifold : null,
    model_manifold_status:
      typeof raw.model_manifold_status === 'string' ? raw.model_manifold_status : null,
    manifold_check_size_guarded: asBoolean(raw.manifold_check_size_guarded),
    classify_ms: asNumber(raw.classify_ms),
    section_stats_ms: asNumber(raw.section_stats_ms),
    run_count: asNumber(raw.run_count),
  };
}

/**
 * Projects an import classification onto the `MeshHealthReport` shape the rest
 * of the app already consumes (shell count, support verdict, section split,
 * manifold flag).
 *
 * Why a projection rather than a second report type: every consumer of these
 * signals — `ModelManagerPanel`'s shell count, `SceneCanvas`'s orange tint,
 * `page.tsx`'s Split-to-Bodies gate, the defect chip — reads
 * `meshDefects.nativeRepairReport`. Giving the import path its own parallel
 * shape would mean touching all of them; projecting means the import simply
 * becomes another producer of the report they already read.
 *
 * `pre` and `post` are identical because classification does not change the
 * mesh — it only reorders it. Boundary/non-manifold figures come from the MODEL
 * section, matching what the repair path's own manifold check reports on.
 *
 * KNOWN GAP, inherited not introduced: `MeshAnalysisJson.self_intersections` is
 * a plain `number`, so the un-measured self-intersection count is reported as
 * `0` here exactly as the incumbent classify-only tier (`minimal_analysis`)
 * already does. Widening that field to `number | null` ripples into the repair
 * report modal and the repair quality gate, and belongs with those.
 */
export function importClassificationToHealthReport(
  classification: ImportClassificationJson,
  geometry: { triangleCount: number; vertexCount: number },
): MeshHealthReport {
  const model = classification.model_section;
  const analysis: MeshAnalysisJson = {
    triangle_count: geometry.triangleCount,
    vertex_count: geometry.vertexCount,
    non_manifold_edges: model?.non_manifold_edges ?? 0,
    non_manifold_vertices: model?.non_manifold_vertices ?? 0,
    boundary_edges: model?.boundary_edges ?? 0,
    boundary_loops: model?.boundary_loops ?? 0,
    inconsistent_edges: model?.inconsistent_winding_edges ?? 0,
    degenerate_triangles: 0,
    duplicate_triangles: 0,
    component_count: classification.connected_components ?? 0,
    self_intersections: 0,
    signed_volume: 0,
    // UNKNOWN stays UNKNOWN: absent stats mean the tier did not run, which is
    // an em dash, not "this mesh has holes".
    is_watertight: model ? model.is_watertight : null,
    timings_ms: {
      topology_ms: model?.elapsed_ms ?? 0,
      self_intersections_ms: 0,
      components_ms: 0,
      total_ms: classification.classify_ms + classification.section_stats_ms,
    },
  };

  return {
    version: 1,
    source_path: null,
    pre: analysis,
    post: analysis,
    steps: [
      {
        name: 'classify_import',
        duration_ms: classification.classify_ms,
        details: `import classification of ${classification.source_triangle_count.toLocaleString()} source triangles`,
        changed: 0,
      },
    ],
    likely_support_geometry: classification.likely_support_geometry,
    model_triangle_count: classification.model_triangle_count,
    model_is_manifold: classification.model_is_manifold,
    model_manifold_status: classification.model_manifold_status,
    residual_issues: [],
    // `true` matches what the incumbent classify-only pass reports
    // (`classify_support_split` sets it unconditionally). A classify pass has
    // nothing to repair, so it has no residual issues — and reporting `false`
    // would make `repairReportNeedsAttention` treat every import as a failed
    // repair and raise the report modal.
    fully_repaired: true,
    total_ms: classification.classify_ms + classification.section_stats_ms,
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
 *
 * DORMANT (audited STL-import Ph2, 2026-07-26): this function has NO production
 * caller — live repair goes through the geometry-passing path instead.
 * Deliberately KEPT, not deleted. Note that it reads the ORIGINAL file from
 * disk, so it inherently bypasses the Original/Decimated chokepoint in
 * `prepareModelGeometry.ts`; any future caller must confirm full-resolution
 * input is what that call site actually wants.
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

/**
 * Stages a geometry's triangle soup into the shared staged mesh (raw f32).
 *
 * Exported for `rustAnalysisStaging.ts` (Ph2), which needs the same encoding
 * for the preview arm of the analysis chokepoint. Callers that mean "stage THIS
 * MODEL for Rust" should use `stageModelForRustAnalysis` rather than this —
 * handing it a `BufferGeometry` directly bypasses the output-policy resolver.
 */
export async function stageGeometrySoupToStagedMesh(
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
