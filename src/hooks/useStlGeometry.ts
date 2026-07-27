import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { Fast3MFLoader, fast3mfBuilder } from 'fast-3mf-loader';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { accelerateGeometry } from '@/utils/bvh';
import { computeFlatteningPlanes, type FlatteningPlane } from '@/features/placeOnFace/logic/computeFlatteningPlanes';
import { repairGeometryWithManifold } from '@/utils/manifoldRepair';
import {
  analyzeFromGeometry,
  applyRepairedPositions,
  classifyFromGeometry,
  importClassificationToHealthReport,
  isHeavyRepair,
  isTauriRuntime,
  parseImportClassification,
  repairFromGeometry,
  type ImportClassificationJson,
  type MeshAnalysisJson,
  type MeshHealthReport,
} from '@/utils/meshRepair';
import {
  importRunMapFromResponse,
  summarizeImportRunMap,
  IMPORT_RUN_MAP_BYTES_PER_ENTRY,
  type ImportRunMap,
  type ImportRunMapRecomputeReason,
} from '@/utils/importRunMap';
import type { FullResMutatorSource } from '@/utils/fullResMutatorStaging';

export type MeshDefects = {
  /** Whether any non-finite vertex position values were found */
  hasDefects: boolean;
  /** Number of individual float components (x/y/z) replaced with 0 */
  repairedFloats: number;
  /** Total vertex count in the position buffer */
  totalVertices: number;
  /** Whether Manifold WASM successfully rebuilt the mesh topology */
  repairedByManifold?: boolean;
  /** Number of degenerate triangles collapsed by Manifold */
  degeneratesRemoved?: number;
  /** Full health report from the native Rust repair engine (Tauri only) */
  nativeRepairReport?: MeshHealthReport;
  /** When the repaired mesh has a model/support split (model_triangle_count in the report),
   *  this geometry holds only the support-section triangles for separate orange rendering. */
  supportSectionGeometry?: THREE.BufferGeometry;
  /** When the repaired mesh has a model/support split, this geometry holds only the
   *  model-section (part) triangles, so overlays such as the non-manifold red flag can
   *  be scoped to the part alone and never stripe the supports. */
  modelSectionGeometry?: THREE.BufferGeometry;
};

export type GeometryWithBounds = {
  geometry: THREE.BufferGeometry;
  bbox: THREE.Box3;
  center: THREE.Vector3;
  size: THREE.Vector3;
  flatteningPlanes: FlatteningPlane[];
  /** Present when defective vertex data was detected and auto-repaired */
  meshDefects?: MeshDefects;
  /**
   * Pre-computed hard-edge geometry for the Higher Contrast Model Edges overlay.
   * Uses a 30° threshold angle — only crease edges are included, not every triangle edge.
   * Computed once during import to avoid synchronous lag when toggling the setting on.
   */
  edgeGeometry?: THREE.EdgesGeometry;
  /** Present when an oversized native source was reduced for interactive use. */
  nativePreview?: {
    originalTriangleCount: number;
    previewTriangleCount: number;
    /**
     * C_pre — the pre-centering 3-D bbox center `processGeometry` subtracts
     * at import, measured in raw-file coordinates (STL-import remediation
     * P0 memo §2.2). Output paths reproject the ORIGINAL file with
     * `w = M · (v_raw − C_pre)`; this stored value must be used verbatim,
     * never recomputed from the full mesh (the islands sideload's frame bug
     * came from substituting a scene-side center).
     */
    cPre?: [number, number, number];
    /** Import-time staleness fingerprint of the source file (`stat_source_file`). */
    sourceFingerprint?: {
      sizeBytes: number;
      mtimeMs: number;
    };
    /**
     * meshopt achieved relative decimation error (relative to mesh extents,
     * [0,1]) from the Phase-2a query-first decimation. Surfaced for the
     * preview-honesty badge (Phase 2b consumes it); present only on decimated
     * previews.
     */
    achievedError?: number;
    /** The import-time governor triangle budget this preview was reduced to. */
    budgetTriangles?: number;
    /**
     * Ph1 wiring — the persisted SUMMARY of this model's import run map. The
     * run array itself lives in its own VOXL chunk; this stays here so a
     * reader can always tell what the file meant to carry (and whether the
     * array was dropped for exceeding the cap) even when the chunk is absent.
     */
    runMap?: import('@/utils/importRunMap').ImportRunMapSummary;
  };
  /**
   * Ph1 wiring — model-section triangle runs in SOURCE-FILE indices, as
   * measured by the Rust importer over the FULL-RESOLUTION mesh.
   *
   * Present only for a native file-backed import that found a model/support
   * split. NEVER read it directly: an over-cap map and an absent map both look
   * like an empty array, and only `resolveImportRunMap` distinguishes them.
   */
  importRunMap?: ImportRunMap;
  /**
   * Ph3 — the recompute verdict a PREVIOUS `resolveImportRunMap` call reached
   * for this geometry, when it could not produce a usable map.
   *
   * It exists because the reload path decides the verdict while the `RUNM`
   * chunk is still in hand and the splice needs it much later, by which time
   * `chunk-damaged` and `chunk-missing` are indistinguishable — a dropped
   * damaged chunk and an absent one look the same. Preserving the verdict keeps
   * all four of the resolver's reasons reportable at the point they matter.
   *
   * Invalidated exactly like `importRunMap` and `cPre`: `replaceModelGeometry`
   * builds its successor geometry by explicit construction, so a mutation drops
   * it. Carried by `cloneGeometryWithBounds`, which shares the source file.
   */
  importRunMapRecompute?: ImportRunMapRecomputeReason;
  /**
   * C_pre — the pre-centering 3-D bbox center this geometry was built around,
   * expressed in its SOURCE FILE's coordinate frame (P0 memo §2.2). Any
   * consumer that RE-READS the original file must reproject with
   * `w = M · (v_raw − cPre)`; the post-centering `center` above is valid only
   * against the scene geometry. Substituting one for the other displaces the
   * result by `M_linear · T_center` — the islands sideload frame bug.
   *
   * PRECONDITION — present ONLY when this geometry was built directly from a
   * file still re-readable at the model's `sourcePath`. Deliberately ABSENT
   * for VOXL reloads (which re-run `processGeometry` over the EMBEDDED,
   * already-centered mesh, so a center captured there describes embedded
   * coordinates, not the original file's) and for 3MF/OBJ (a multi-body 3MF
   * yields several models sharing one path, so a re-read returns the wrong
   * geometry). Absent ⇒ consumers must fall back to the scene geometry.
   * NEVER substitute a scene-side center.
   *
   * `nativePreview.cPre` carries this same datum for decimated imports
   * (Phase 1) and is populated from this same single capture — one mechanism,
   * two exposures, divergence impossible.
   */
  cPre?: [number, number, number];
  /**
   * Internal hand-off from `processGeometry` to the file-backed loaders: the
   * pre-centering bbox center captured at the centering site, for EVERY
   * centered load. `loadStlGeometry` promotes it to the public `cPre` (only
   * when the load came from a re-readable path) and folds it into
   * `nativePreview.cPre` for decimated imports, stripping it either way.
   * Loaders that never promote (3MF/OBJ) may leave it present; it is inert —
   * no consumer reads it, and the public `cPre` is the only contract.
   * @internal
   */
  _importCPre?: [number, number, number];
  /**
   * Internal hand-off from `processGeometry` to `repairModelInPlace`: whether
   * the in-place repair consumed the full-resolution ORIGINAL (Phase 4). When
   * true the caller clears the native-preview marker (the output is full-res-
   * derived); when false/absent it carries the marker forward.
   * @internal
   */
  _repairUsedFullRes?: boolean;
};

/**
 * Scans the geometry's position attribute for NaN/Inf values and replaces them
 * with 0, preventing Three.js bbox/sphere computations from producing NaN.
 * Returns a summary of what was repaired (or a clean result if nothing was wrong).
 */
function sanitizePositionAttribute(geometry: THREE.BufferGeometry): MeshDefects {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) return { hasDefects: false, repairedFloats: 0, totalVertices: 0 };

  const arr = posAttr.array as Float32Array;
  let repairedFloats = 0;

  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (arr as any)[i] = 0;
      repairedFloats++;
    }
  }

  if (repairedFloats > 0) {
    posAttr.needsUpdate = true;
  }

  return {
    hasDefects: repairedFloats > 0,
    repairedFloats,
    totalVertices: arr.length / 3,
  };
}

export interface ProcessGeometryOptions {
  center?: boolean;
  /**
   * Controls native Tauri mesh processing behavior.
   *
   * Ph1 wiring (d): CLASSIFICATION IS NO LONGER SIZE-GATED IN ANY MODE. Only
   * auto-mode's heavy REPAIR retains a size opt-out
   * (`AUTO_NATIVE_PROCESSING_TRIANGLE_THRESHOLD`, ≥ 3M triangles). Repair is
   * optional work; classification decides what a triangle IS, and gating it
   * silently stripped the shell count, the support verdict and the defect chip
   * from exactly the large pre-supported imports that need them. Do not
   * reintroduce a size gate on the classify path.
   * - `auto` (default): standard flow; classifies always, repairs below 3M.
   * - `classify-only`: lightweight shell-split classification, no heavy repair.
   * - `none`: skip heavy repair, but STILL run the classify-only shell-split
   *   pass for support-geometry detection. It does NOT skip native processing.
   * - `repair`: force the full repair/classification path.
   */
    nativeProcessingMode?: 'auto' | 'classify-only' | 'none' | 'repair';
  /**
   * Called when analysis indicates a heavy solidification repair is needed on a
   * multi-component mesh. Returns whether to proceed with repair and — the P5-2
   * / D5 consent — whether to allow the lossy convex-hull rescue of otherwise
   * unrepairable support bodies. Only invoked when running under Tauri.
   */
  onConfirmHeavyRepair?: (
    analysis: MeshAnalysisJson,
  ) => Promise<{ proceed: boolean; allowHullRescue: boolean }>;
  /**
   * Optional status callback for native mesh processing stages.
   * Useful for surfacing progress text in import loading overlays.
   */
  onNativeProcessingStage?: (stage: 'analyzing' | 'repairing' | 'classifying' | 'postprocess') => void;
  /**
   * When running in Tauri, the on-disk file path for native (Rust-side) mesh
   * loading. If provided, `loadStlGeometry` will use a Tauri IPC command to
   * parse the STL in Rust and return pre-computed positions + normals,
   * avoiding holding the raw file data in webview memory.
   */
  filePath?: string;
  /**
   * Skip `computeVertexNormals()` — the geometry already has a `normal`
   * attribute (e.g. from the Rust-side STL parser).
   * @internal
   */
  _skipComputeNormals?: boolean;
  /** Skip nonessential analysis for a native reduced-detail preview. @internal */
  _isNativePreview?: boolean;
  /**
   * Phase 4 (STL-import remediation): when repairing a native-preview model in
   * place, splice this ORIGINAL-file source into staging Rust-side instead of
   * the ~2M preview geometry, so the permanent repair consumes full resolution.
   * Consulted only in the `nativeProcessingMode === 'repair'` path.
   * @internal
   */
  fullResSource?: FullResMutatorSource | null;
  /**
   * Ph1(e): the model's previously-reported `likely_support_geometry`, carried
   * into a re-repair so the verdict survives a pass that can no longer derive
   * it (repair #1 fuses the support components the classifier counts). Only
   * consulted on the repair path — a classify-only pass measures afresh.
   */
  assumeSupportGeometry?: boolean;
  /**
   * Ph1 wiring — the classification the Rust importer already performed over
   * the FULL-RESOLUTION mesh, handed straight to this pass.
   *
   * Consulted only when this pass would otherwise have run a classify-only
   * round trip AND the geometry is the very mesh the classification describes
   * (i.e. not a decimated preview, whose triangle order is a different mesh
   * entirely). In that case the round trip is pure duplicated work — the same
   * classifier, over the same triangles, plus two whole-mesh IPC transfers —
   * so it is skipped and this result used instead. The geometry arrives
   * already reordered model-section-first, which is `classify_import`'s
   * contract.
   * @internal
   */
  _importClassification?: ImportClassificationJson | null;
}

// Cloning extremely large position buffers can require hundreds of MB and can
// fail with `RangeError: Array buffer allocation failed` on constrained heaps.
// Above this threshold we process the source geometry in place to avoid
// allocating a second full copy before normals/BVH work begins.
const IN_PLACE_PROCESSING_VERTEX_THRESHOLD = 12_000_000;
// Native analyze/repair on extremely large meshes can take minutes with little
// practical benefit in auto-import flows. In auto mode, skip native processing
// beyond this size and let users opt-in via manual Repair.
const AUTO_NATIVE_PROCESSING_TRIANGLE_THRESHOLD = 3_000_000;
// EdgesGeometry builds an internal hash map keyed by unique edge hashes using
// a plain object, then iterates it with `for...in`. V8 throws "Too many
// properties to enumerate" when the hash map exceeds ~2M entries. Skip
// precomputation for meshes above this threshold to avoid the wasted work.
// The Higher Contrast Model Edges overlay simply won't be available for that model.
const EDGE_GEOMETRY_MAX_TRIANGLES = 800_000;
// Loading an STL file larger than this will be rejected with a user-facing
// error. A 300 MB binary STL contains ~6M triangles, which after Three.js
// processing (positions + normals + BVH) can consume 1-2 GB of RAM.
// STL files above this vertex count skip non-critical post-processing
// (flattening planes) to keep memory pressure manageable.
const HUGE_STL_VERTEX_THRESHOLD = 15_000_000;

type NativeRepairQualityGateDecision = {
  reject: boolean;
  reason?: string;
};

function computeReductionRatio(before: number, after: number): number {
  if (!Number.isFinite(before) || before <= 0) return 1;
  if (!Number.isFinite(after)) return 0;
  return Math.max(0, (before - after) / before);
}

/**
 * Guardrail against "repairs" that introduce large open boundaries with little
 * meaningful reduction in severe defects. These cases can visibly shred side
 * walls/rims while only nudging self-intersection counts.
 */
export function evaluateNativeRepairQualityGate(report: MeshHealthReport): NativeRepairQualityGateDecision {
  const pre = report.pre;
  const post = report.post;

  if (post.vertex_count <= 0 || post.triangle_count <= 0) {
    return {
      reject: true,
      reason: `invalid repaired topology size (triangles=${post.triangle_count}, vertices=${post.vertex_count})`,
    };
  }

  const boundaryIncrease = Math.max(0, post.boundary_edges - pre.boundary_edges);
  const selfIntersectionReduction = computeReductionRatio(pre.self_intersections, post.self_intersections);

  const introducedLargeBoundaryFromClosedMesh = pre.boundary_edges === 0
    && post.boundary_edges >= 64
    && post.boundary_loops > 0;

  if (introducedLargeBoundaryFromClosedMesh && selfIntersectionReduction < 0.35) {
    return {
      reject: true,
      reason: `introduced large boundary on previously closed mesh (${pre.boundary_edges}→${post.boundary_edges}) with low self-intersection reduction (${(selfIntersectionReduction * 100).toFixed(1)}%)`,
    };
  }

  const explosiveBoundaryIncrease = boundaryIncrease >= 256
    && post.boundary_edges >= Math.max(128, pre.boundary_edges * 4);
  if (explosiveBoundaryIncrease && selfIntersectionReduction < 0.2) {
    return {
      reject: true,
      reason: `boundary edges increased too aggressively (${pre.boundary_edges}→${post.boundary_edges}) without enough self-intersection relief (${(selfIntersectionReduction * 100).toFixed(1)}%)`,
    };
  }

  return { reject: false };
}

function stripEmbeddedColorAttributes(geometry: THREE.BufferGeometry): void {
  // DragonFruit controls model tinting centrally via mesh settings.
  // Ignore per-file embedded colors (e.g. binary STL color extension).
  if (geometry.getAttribute('color')) {
    geometry.deleteAttribute('color');
  }

  const withLoaderMetadata = geometry as THREE.BufferGeometry & {
    hasColors?: boolean;
    alpha?: number;
  };

  if ('hasColors' in withLoaderMetadata) {
    delete withLoaderMetadata.hasColors;
  }

  if ('alpha' in withLoaderMetadata) {
    delete withLoaderMetadata.alpha;
  }
}

export async function processGeometry(bufferGeometry: THREE.BufferGeometry, options: ProcessGeometryOptions = { center: true }): Promise<GeometryWithBounds> {
  console.log(`[${new Date().toISOString()}] [processGeometry] Starting Geometry Prep`);
  const startPrep = performance.now();
  const sourcePosition = bufferGeometry.getAttribute('position') as THREE.BufferAttribute | null;
  const sourceVertexCount = sourcePosition?.count ?? 0;
  const sourceIndex = bufferGeometry.getIndex();
  const sourceTriangleEstimate = Math.floor((sourceIndex?.count ?? sourceVertexCount) / 3);

  let geometry: THREE.BufferGeometry;
  if (sourceVertexCount >= IN_PLACE_PROCESSING_VERTEX_THRESHOLD) {
    console.warn(
      `[processGeometry] Large geometry detected (${sourceVertexCount.toLocaleString()} vertices).` +
      ' Processing in place to avoid copy-time allocation spikes.',
    );
    geometry = bufferGeometry;
  } else {
    geometry = new THREE.BufferGeometry();
    try {
      geometry.copy(bufferGeometry);
    } catch (error) {
      if (error instanceof RangeError) {
        console.warn(
          '[processGeometry] Geometry copy allocation failed; falling back to in-place processing.',
          error,
        );
        geometry = bufferGeometry;
      } else {
        throw error;
      }
    }
  }

  stripEmbeddedColorAttributes(geometry);

  // Sanitize any non-finite position values before any Three.js computation
  // to prevent NaN bbox/sphere and subsequent renderer crashes.
  let meshDefects = sanitizePositionAttribute(geometry);
  if (meshDefects.hasDefects) {
    console.warn(
      `[processGeometry] Defective mesh detected: ${meshDefects.repairedFloats} non-finite position` +
      ` values (out of ${meshDefects.totalVertices * 3} floats) replaced with 0.`,
    );
  }

  // In Tauri we usually run native analyze/repair/classification. For gigantic
  // meshes, auto mode now skips this expensive path and leaves the mesh as-is
  // unless the user explicitly requests manual repair.
  // In the browser we fall back to the legacy Manifold WASM path (which only
  // activates when NaN defects were detected).
  let nativeModifiedGeometry = false;
  // Phase 4: set when an in-place repair spliced the full-res ORIGINAL (so the
  // caller clears the native-preview marker). Only the 'repair' path can set it.
  let repairUsedFullRes = false;
  if (isTauriRuntime()) {
    const nativeMode = options.nativeProcessingMode ?? 'auto';
    // Ph1 wiring (d): the P6 `>= 3M` size gate that used to sit here is GONE.
    //
    // It skipped native processing — the auto-REPAIR path and the classify-only
    // shell-split pass alike — for any mesh at or above
    // AUTO_NATIVE_PROCESSING_TRIANGLE_THRESHOLD. Repair is genuinely optional
    // work and opting big meshes out of it is defensible. Classification is
    // not: it decides what a triangle IS, and skipping it silently removed
    // `component_count` (the shell count), `likely_support_geometry` (the
    // orange support tint and the Split-to-Bodies gate), the model/support
    // section split and the defect chip — for exactly the large pre-supported
    // imports that need them most. The pass was cheap relative to what it
    // bought, and the user saw a model that had simply forgotten it had
    // supports.
    //
    // Auto-repair keeps its own size opt-out below; the classify path has none,
    // by design, and must never grow one again.
    const skipAutoRepairForSize = nativeMode === 'auto'
      && sourceTriangleEstimate >= AUTO_NATIVE_PROCESSING_TRIANGLE_THRESHOLD;

    try {
      if (nativeMode === 'none') {
        console.log('[processGeometry] Native repair skipped (mode=none) — running classification for support geometry detection');
      }
      let classifyOnly = nativeMode === 'classify-only' || nativeMode === 'none';
      const forceRepair = nativeMode === 'repair';
      if (skipAutoRepairForSize) {
        console.warn(
          `[processGeometry] Skipping auto-repair for large mesh (`
          + `${sourceTriangleEstimate.toLocaleString()} triangles ≥ `
          + `${AUTO_NATIVE_PROCESSING_TRIANGLE_THRESHOLD.toLocaleString()} threshold). `
          + 'Classifying only — use manual Repair to force a repair.',
        );
        classifyOnly = true;
      }
      // P5-2 / D5: convex-hull rescue is opt-in. Only ever true when the user
      // explicitly consents in the multi-component confirm dialog below; single-
      // component / watertight meshes never prompt, so this stays false.
      let allowHullRescue = false;

      // Ph1 wiring (d): the native importer already classified this exact mesh
      // at full resolution and shipped the result in the DFST response. Running
      // `classifyFromGeometry` now would re-run the same classifier over the
      // same triangles and pay two whole-mesh IPC transfers for an answer we
      // are holding. Only valid when the geometry IS the classified mesh —
      // a decimated preview is a different triangle set, so its own classify
      // pass still runs.
      const preClassified = classifyOnly
        && options._isNativePreview !== true
        && options._importClassification != null
        ? options._importClassification
        : null;

      // If a confirmation callback is wired up, run a quick pre-repair analysis
      // so we can ask the user before committing to a heavy solidification pass.
      if (!classifyOnly && !forceRepair && options.onConfirmHeavyRepair) {
        try {
          options.onNativeProcessingStage?.('analyzing');
          console.log(`[${new Date().toISOString()}] [processGeometry] Running pre-repair analysis`);
          const analysis = await analyzeFromGeometry(geometry);
          if (analysis && isHeavyRepair(analysis)) {
            console.log(
              `[processGeometry] Heavy repair detected (components=${analysis.component_count}, ` +
              `self_intersections=${analysis.self_intersections}). Requesting user confirmation.`,
            );
            const decision = await options.onConfirmHeavyRepair(analysis);
            if (!decision.proceed) {
              console.log('[processGeometry] User declined heavy repair — running classify-only shell split pass.');
              classifyOnly = true;
            } else {
              allowHullRescue = decision.allowHullRescue;
            }
          }
        } catch (analysisErr) {
          const analysisErrMsg = analysisErr instanceof Error ? analysisErr.message : String(analysisErr);
          if (analysisErrMsg === 'MESH_IMPORT_CANCELLED_BY_USER') {
            throw analysisErr; // Propagate cancellation — do not proceed with repair.
          }
          console.warn('[processGeometry] Pre-repair analysis failed; proceeding with repair.', analysisErr);
        }
      }

      options.onNativeProcessingStage?.(classifyOnly ? 'classifying' : 'repairing');
      const positionCount = (geometry.getAttribute('position') as THREE.BufferAttribute | null)?.count ?? 0;
      console.log(
        `[${new Date().toISOString()}] [processGeometry] `
        + (preClassified
          ? 'Using the import-time classification (no round trip)'
          : `Running native ${classifyOnly ? 'classification' : 'repair/classification'}`),
      );
      const nativeStart = performance.now();
      const result = preClassified
        ? {
            report: importClassificationToHealthReport(preClassified, {
              triangleCount: Math.floor(positionCount / 3),
              vertexCount: positionCount,
            }),
            // The importer already applied this ordering before encoding the
            // response — there are no positions to write back.
            positions: new Float32Array(0),
          }
        : classifyOnly
        ? await classifyFromGeometry(geometry)
        : await repairFromGeometry(
            geometry,
            // Ph1(e): carry the caller's prior support verdict in. Without it a
            // second repair over a mesh the first one fused reports
            // `likely_support_geometry: false` and the section identity — the
            // orange tint, the split, the user's checkbox — is lost.
            { allowHullRescue, assumeSupportGeometry: options.assumeSupportGeometry === true },
            forceRepair ? options.fullResSource : null,
          );
      if (result) {
        if (!classifyOnly && result.usedFullRes) {
          repairUsedFullRes = true;
        }
        let effectiveResult = result;
        let usedFallbackClassification = false;
        // The pre-classified path has nothing to write back: the importer
        // reordered the mesh before it encoded the response, so the geometry
        // already matches the report.
        let shouldApplyPositions = preClassified == null;

        if (!classifyOnly) {
          const qualityGate = evaluateNativeRepairQualityGate(result.report);
          if (qualityGate.reject) {
            console.warn(`[processGeometry] Rejecting native auto-repair result: ${qualityGate.reason}. Falling back to classify-only pass.`);
            try {
              options.onNativeProcessingStage?.('classifying');
              const fallbackClassification = await classifyFromGeometry(geometry);
              if (fallbackClassification) {
                effectiveResult = fallbackClassification;
                usedFallbackClassification = true;
              } else {
                effectiveResult = {
                  ...result,
                  report: {
                    ...result.report,
                    fully_repaired: false,
                    residual_issues: [
                      ...result.report.residual_issues,
                      `Auto-repair output discarded: ${qualityGate.reason}`,
                    ],
                  },
                };
                shouldApplyPositions = false;
              }
            } catch (fallbackError) {
              console.warn('[processGeometry] Fallback classify-only pass failed after rejecting repair output; keeping original geometry.', fallbackError);
              effectiveResult = {
                ...result,
                report: {
                  ...result.report,
                  fully_repaired: false,
                  residual_issues: [
                    ...result.report.residual_issues,
                    `Auto-repair output discarded: ${qualityGate.reason}`,
                    'Fallback classify-only pass failed; geometry kept as-is.',
                  ],
                },
              };
              shouldApplyPositions = false;
            }
          }
        }

        if (shouldApplyPositions) {
          applyRepairedPositions(geometry, effectiveResult.positions);
          nativeModifiedGeometry = true;
        }

        const { report } = effectiveResult;
        console.log(
          `[processGeometry] Native ${classifyOnly ? 'classification' : usedFallbackClassification ? 'repair/classification (fallback classify applied)' : 'repair/classification'} finished in ${(performance.now() - nativeStart).toFixed(2)}ms. ` +
          `pre=${report.pre.triangle_count}t/${report.pre.non_manifold_edges}nme/${report.pre.boundary_edges}be, ` +
          `post=${report.post.triangle_count}t/${report.post.non_manifold_edges}nme/${report.post.boundary_edges}be, ` +
          `watertight=${report.post.is_watertight}`,
        );
        meshDefects = {
          ...meshDefects,
          hasDefects: classifyOnly
            ? meshDefects.hasDefects
            : (meshDefects.hasDefects || !report.fully_repaired || report.residual_issues.length > 0),
          nativeRepairReport: report,
        };

        // If the mesh has a model/support split, extract the support section as
        // a separate geometry for orange overlay rendering.
        //
        // The precondition is that the buffer is IN THE REPORT'S ORDER, which
        // is true either because this pass wrote the reordered positions back,
        // or because the importer had already reordered them before encoding.
        // (It is NOT true when the repair output was rejected and the original
        // geometry kept — hence the flag rather than an unconditional slice.)
        const geometryMatchesReport = shouldApplyPositions || preClassified != null;

        if (geometryMatchesReport && report.model_triangle_count != null && report.model_triangle_count > 0) {
          const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
          const allPos = posAttr.array as Float32Array;
          const modelFloatEnd = report.model_triangle_count * 9; // 3 vertices × 3 floats per tri
          if (modelFloatEnd < allPos.length) {
            const supportPositions = allPos.slice(modelFloatEnd);
            const supportGeo = new THREE.BufferGeometry();
            supportGeo.setAttribute('position', new THREE.BufferAttribute(supportPositions, 3));
            supportGeo.computeVertexNormals();

            // Model-section (part) geometry: the first model_triangle_count triangles.
            // Used to scope the non-manifold red overlay to the part alone so it never
            // stripes the supports. Normals are unnecessary — the overlay shader only
            // reads world-space position.
            const modelPositions = allPos.slice(0, modelFloatEnd);
            const modelGeo = new THREE.BufferGeometry();
            modelGeo.setAttribute('position', new THREE.BufferAttribute(modelPositions, 3));

            meshDefects = {
              ...meshDefects,
              supportSectionGeometry: supportGeo,
              modelSectionGeometry: modelGeo,
            };
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg === 'MESH_IMPORT_CANCELLED_BY_USER') {
        throw err; // Propagate cancellation — do not fall back to loading the model.
      }
      console.warn('[processGeometry] Native mesh repair failed; falling back to sanitized geometry.', err);
    } finally {
      options.onNativeProcessingStage?.('postprocess');
    }
  } else if (meshDefects.hasDefects) {
    // Attempt full topology repair via Manifold (welds open edges, collapses
    // degenerate triangles, rebuilds a valid watertight solid).
    console.log(`[${new Date().toISOString()}] [processGeometry] Attempting Manifold repair`);
    const startManifold = performance.now();
    const repairStats = await repairGeometryWithManifold(geometry);
    if (repairStats) {
      console.log(
        `[processGeometry] Manifold repair succeeded in ${(performance.now() - startManifold).toFixed(2)}ms.` +
        ` Merged edges: ${repairStats.manifoldMergedEdges}, degenerates removed: ${repairStats.degeneratesRemoved}`,
      );
      meshDefects = {
        ...meshDefects,
        repairedByManifold: true,
        degeneratesRemoved: repairStats.degeneratesRemoved,
      };
    } else {
      console.warn(`[processGeometry] Manifold repair unavailable or failed — using NaN-sanitized geometry.`);
    }
  }

  // Yield to let the loading indicator repaint before each heavy synchronous op
  await new Promise<void>(r => setTimeout(r, 0));

  if (!options._skipComputeNormals || nativeModifiedGeometry) {
    console.log(`[${new Date().toISOString()}] [processGeometry] Computing Normals${nativeModifiedGeometry ? ' (geometry modified by native processing)' : ''}`);
    geometry.computeVertexNormals();
  } else {
    console.log(`[${new Date().toISOString()}] [processGeometry] Normals already present — skipping computeVertexNormals`);
  }

  console.log(`[${new Date().toISOString()}] [processGeometry] Computing BBox`);
  geometry.computeBoundingBox();

  const preBBox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
  const preCenter = preBBox.getCenter(new THREE.Vector3());

  // C_pre capture (STL-import remediation Phase 1; generalized for the islands
  // sideload fix): record the pre-centering bbox center so consumers that
  // RE-READ the original file can reproject it into the scene frame
  // (`w = M·(v_raw − C_pre)`). Exact by construction: measured from the very
  // geometry the centering below uses (post-sanitize, post-classify), whether
  // or not the translate actually runs — when it does, translate + stored
  // post-center sum to exactly this value; when it does not, the stored center
  // IS this value.
  //
  // Captured UNCONDITIONALLY (Phase 1 captured it for native previews only).
  // The datum is equally required by any raw-file re-read, and the islands
  // sideload's population is dominated by ordinary NON-decimated imports, which
  // had no datum at all. Promotion to the public `cPre` is gated by the loader
  // on the load actually coming from a re-readable file path.
  const importCPre: [number, number, number] = [preCenter.x, preCenter.y, preCenter.z];

  // Normalize: center X/Z at 0 and set bottom (minY) to 0 in local space
  if (options.center) {
    geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z);
  }
  geometry.computeBoundingBox();
  console.log(`[${new Date().toISOString()}] [processGeometry] Geometry Prep finished. Took ${(performance.now() - startPrep).toFixed(2)}ms`);

  // Yield before BVH (expensive synchronous tree build)
  await new Promise<void>(r => setTimeout(r, 0));

  // Add BVH acceleration for fast raycasting (critical for support placement)
  console.log(`[${new Date().toISOString()}] [processGeometry] Starting BVH Construction`);
  const startBVH = performance.now();
  accelerateGeometry(geometry);
  console.log(`[${new Date().toISOString()}] [processGeometry] BVH Construction finished. Took ${(performance.now() - startBVH).toFixed(2)}ms`);

  const bbox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());

  // Yield before ConvexHull / flattening planes computation
  await new Promise<void>(r => setTimeout(r, 0));

  // Skip flattening planes for gigantic meshes — the ConvexHull + grid
  // decimation still processes every vertex, adding measurable time and
  // allocations for meshes with 15M+ vertices.
  let flatteningPlanes: FlatteningPlane[];
  if (options._isNativePreview || sourceVertexCount >= HUGE_STL_VERTEX_THRESHOLD) {
    console.warn(
      `[processGeometry] Skipping flattening planes for huge mesh (` +
      `${sourceVertexCount.toLocaleString()} vertices).`,
    );
    flatteningPlanes = [];
  } else {
    console.log(`[${new Date().toISOString()}] [processGeometry] Computing Flattening Planes`);
    const startPlanes = performance.now();
    flatteningPlanes = computeFlatteningPlanes(geometry);
    console.log(`[${new Date().toISOString()}] [processGeometry] Flattening Planes finished. Took ${(performance.now() - startPlanes).toFixed(2)}ms`);
  }

  // Yield before edge geometry computation (can be expensive for large meshes)
  await new Promise<void>(r => setTimeout(r, 0));

  let edgeGeometry: THREE.EdgesGeometry | undefined;
  if (sourceTriangleEstimate >= EDGE_GEOMETRY_MAX_TRIANGLES) {
    console.warn(
      `[processGeometry] Skipping edge geometry for large mesh (` +
      `${sourceTriangleEstimate.toLocaleString()} triangles, threshold=${EDGE_GEOMETRY_MAX_TRIANGLES.toLocaleString()}).`,
    );
  } else {
    console.log(`[${new Date().toISOString()}] [processGeometry] Computing Edge Geometry`);
    const startEdges = performance.now();
    try {
      edgeGeometry = new THREE.EdgesGeometry(geometry, 30);
      console.log(`[${new Date().toISOString()}] [processGeometry] Edge Geometry finished. Took ${(performance.now() - startEdges).toFixed(2)}ms`);
    } catch (edgeError) {
      console.warn(
        `[processGeometry] Edge geometry computation failed for large mesh (${sourceTriangleEstimate.toLocaleString()} triangles).`,
        edgeError,
      );
    }
  }

  const shouldSurfaceDefects = meshDefects.hasDefects || meshDefects.nativeRepairReport != null;
  return {
    geometry,
    bbox,
    center,
    size,
    flatteningPlanes,
    edgeGeometry,
    ...(shouldSurfaceDefects ? { meshDefects } : {}),
    _importCPre: importCPre,
    ...(repairUsedFullRes ? { _repairUsedFullRes: true } : {}),
  };
}

/** Number of bytes per triangle in a binary STL: 12 byte normal + 36 byte vertices + 2 byte attribute */
const BINARY_STL_TRIANGLE_BYTES = 50;
/** Offset of the triangle count in a binary STL header */
const STL_HEADER_TRIANGLE_COUNT_OFFSET = 80;
/** Total binary STL header size: 80 byte comment + 4 byte count */
const STL_HEADER_SIZE = 84;
/**
 * Binary STL triangle: vertices start at byte 12 (after 12-byte normal),
 * span 36 bytes (3 vertices × 3 floats × 4 bytes).
 */
const STL_TRIANGLE_VERTEX_OFFSET = 12;
const STL_TRIANGLE_VERTEX_BYTES = 36;
// Leave headroom for normals, BVH nodes, renderer uploads, and the rest of the
// application. Chromium terminates the process with 0xe0000008 when a typed
// array allocation cannot be satisfied, so this must be checked beforehand.
const MAX_WEBVIEW_STL_POSITION_BYTES = 1_000_000_000;

class StlWebviewMemoryError extends Error {}

/**
 * Parse complete binary STL triangles from a Uint8Array and write their
 * vertex positions into the target Float32Array starting at `posIndex`.
 * `posIndex` is the float-offset into `target`, updated in-place.
 */
function parseStlTrianglesInto(
  target: Float32Array,
  data: Uint8Array,
  startFloatIndex: number,
): number {
  const triCount = Math.floor(data.byteLength / BINARY_STL_TRIANGLE_BYTES);
  let fi = startFloatIndex;
  for (let t = 0; t < triCount; t++) {
    const triByteOffset = t * BINARY_STL_TRIANGLE_BYTES + STL_TRIANGLE_VERTEX_OFFSET;
    const dv = new DataView(data.buffer, data.byteOffset + triByteOffset, STL_TRIANGLE_VERTEX_BYTES);
    target[fi++] = dv.getFloat32(0, true);
    target[fi++] = dv.getFloat32(4, true);
    target[fi++] = dv.getFloat32(8, true);
    target[fi++] = dv.getFloat32(12, true);
    target[fi++] = dv.getFloat32(16, true);
    target[fi++] = dv.getFloat32(20, true);
    target[fi++] = dv.getFloat32(24, true);
    target[fi++] = dv.getFloat32(28, true);
    target[fi++] = dv.getFloat32(32, true);
  }
  return fi;
}

/** Concatenate two Uint8Arrays into a new one. */
function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

/**
 * Streams a binary STL file, parsing triangles incrementally into a
 * pre-allocated Float32Array. Avoids holding the entire file in memory
 * as a single ArrayBuffer (can save ~1GB for a 20M-triangle file).
 *
 * Falls back to null on any error (caller should use STLLoader).
 */
export async function loadStlBinaryStreaming(fileUrl: string): Promise<THREE.BufferGeometry | null> {
  let response: Response;
  try {
    response = await fetch(fileUrl);
  } catch {
    return null;
  }

  const reader = response.body?.getReader();
  if (!reader) return null;

  try {
    // --- Phase 1: Read first chunk — must contain the 84-byte header ---
    const firstRead = await reader.read();
    if (firstRead.done || !firstRead.value || firstRead.value.byteLength < STL_HEADER_SIZE) return null;

    const firstChunk = new Uint8Array(firstRead.value.buffer, firstRead.value.byteOffset, firstRead.value.byteLength);

    // Check for ASCII STL signature ("solid ")
    const asciiSig = 'solid ';
    let isAscii = true;
    for (let i = 0; i < asciiSig.length; i++) {
      if (String.fromCharCode(firstChunk[i]) !== asciiSig[i]) {
        isAscii = false;
        break;
      }
    }
    if (isAscii) return null; // ASCII STL — fall back to STLLoader

    // Read triangle count from bytes 80-83
    const triCount = new DataView(firstChunk.buffer, firstChunk.byteOffset + STL_HEADER_TRIANGLE_COUNT_OFFSET, 4).getUint32(0, true);
    if (triCount === 0) return null;

    const expectedStlSize = STL_HEADER_SIZE + triCount * BINARY_STL_TRIANGLE_BYTES;
    const positionBytes = triCount * 9 * Float32Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(positionBytes) || positionBytes > MAX_WEBVIEW_STL_POSITION_BYTES) {
      throw new StlWebviewMemoryError(
        `This STL contains ${triCount.toLocaleString()} triangles and needs at least ` +
        `${(positionBytes / 1_000_000_000).toFixed(2)} GB for positions in the WebView. ` +
        'Open it from a desktop file path so DragonFruit can use the native STL loader.',
      );
    }
    console.warn(
      `[loadStlGeometry] Streaming ${triCount.toLocaleString()} triangles ` +
      `(${(expectedStlSize / 1_000_000_000).toFixed(2)} GB file). ` +
      `Pre-allocating ${((triCount * 9 * 4) / 1_000_000_000).toFixed(2)} GB position buffer.`,
    );

    // Pre-allocate the position buffer (9 floats per triangle: 3 vertices × 3 coords)
    const positions = new Float32Array(triCount * 9);
    let posIndex = 0;

    // --- Phase 2: Process any triangle data already in the first chunk (after the 84-byte header) ---
    const firstTriData = firstChunk.subarray(STL_HEADER_SIZE);
    const firstCompleteBytes = Math.floor(firstTriData.byteLength / BINARY_STL_TRIANGLE_BYTES)
      * BINARY_STL_TRIANGLE_BYTES;
    if (firstCompleteBytes > 0) {
      posIndex = parseStlTrianglesInto(
        positions,
        firstTriData.subarray(0, firstCompleteBytes),
        posIndex,
      );
    }

    // --- Phase 3: Stream remaining chunks ---
    const firstRemaining = firstTriData.byteLength - firstCompleteBytes;
    let pendingBuffer: Uint8Array | null = firstRemaining > 0
      ? firstTriData.slice(firstCompleteBytes)
      : null;

    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      if (!chunk) continue;

      // Combine with any pending bytes from previous iteration
      const data: Uint8Array = pendingBuffer
        ? concatUint8Arrays(pendingBuffer, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

      // Count complete triangles in this buffer
      const completeBytes = Math.floor(data.byteLength / BINARY_STL_TRIANGLE_BYTES) * BINARY_STL_TRIANGLE_BYTES;
      if (completeBytes > 0) {
        posIndex = parseStlTrianglesInto(positions, data.subarray(0, completeBytes), posIndex);
      }

      // Keep leftover bytes for next chunk
      const remaining: number = data.byteLength - completeBytes;
      pendingBuffer = remaining > 0 ? data.slice(completeBytes) : null;
    }

    if (pendingBuffer?.byteLength || posIndex !== positions.length) {
      console.warn(
        `[loadStlGeometry] Expected ${positions.length} position floats but got ${posIndex}. ` +
        `STL file may be truncated.`,
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(
      posIndex === positions.length ? positions : positions.slice(0, posIndex),
      3,
    ));

    return geometry;
  } catch (error) {
    if (error instanceof StlWebviewMemoryError) throw error;
    console.warn('[loadStlGeometry] Streaming STL failed; falling back to STLLoader.', error);
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Use the Rust-side STL parser via Tauri IPC. Returns a BufferGeometry with
 * pre-computed vertex normals, skipping the expensive JS-side computation.
 * Uses dynamic import to avoid loading @tauri-apps/api at module init time.
 */
type NativeStlLoadResult = {
  geometry: THREE.BufferGeometry;
  originalTriangleCount: number;
  previewTriangleCount: number;
  isPreview: boolean;
  /** meshopt achieved relative error for a decimated preview (0 for verbatim). */
  achievedError: number;
  /** The import-time governor triangle budget (0 when unreported). */
  budgetTriangles: number;
  /**
   * Ph1 wiring — what the Rust importer measured about the FULL-RESOLUTION
   * source. For a preview this describes the ORIGINAL file, not the geometry
   * above, so `model_triangle_count` indexes the returned geometry only when
   * `isPreview` is false.
   */
  classification: ImportClassificationJson | null;
  /**
   * Flat `[start0, len0, start1, len1, …]` model runs in SOURCE-FILE triangle
   * indices. `null` when there is no split, or when the map exceeded the
   * transport cap (`classification.run_count > runMap.length / 2` distinguishes
   * the two) and must be recomputed from the source file.
   */
  runMap: Uint32Array | null;
};

/**
 * WebView JS-heap ceiling forwarded to the Rust budget governor so the import
 * budget scales with the actual runtime (Chromium/WebView2). Undefined-safe:
 * non-Chromium WebViews lack `performance.memory`, so the governor falls back
 * to its system-RAM term / floor. See `stl_budget.rs`.
 */
function readJsHeapSizeLimit(): number | undefined {
  const memory = (performance as Performance & { memory?: { jsHeapSizeLimit?: number } }).memory;
  if (memory && typeof memory.jsHeapSizeLimit === 'number' && memory.jsHeapSizeLimit > 0) {
    return memory.jsHeapSizeLimit;
  }
  return undefined;
}

/**
 * DFST header — **32 bytes** since the Ph1 wiring.
 *
 * ```text
 *   off  size  field
 *     0     4  magic "DFST"
 *     4     4  flags u32               bit0 = payload is a reduced preview
 *     8     4  originalTriangleCount u32
 *    12     4  outputTriangleCount   u32
 *    16     4  achievedError f32       (0 for a verbatim load)      — Phase 2a
 *    20     4  budgetTriangles u32     (0 when unreported)          — Phase 2a
 *    24     4  runMapEntryCount u32    (entries present below)      — Ph1
 *    28     4  classificationJsonBytes u32 (0 when absent)          — Ph1
 * ```
 *
 * Payload: `positions (n·36 B) | normals (n·36 B) | run map (entries·8 B) |
 * classification JSON`. The run map sits before the JSON so it stays 4-byte
 * aligned for a direct `Uint32Array` view over the IPC buffer.
 *
 * This constant, the two Ph1 field reads, and the exact-length assertion below
 * are ONE unit with `STL_RESPONSE_HEADER_BYTES` in `mesh_repair.rs`. The length
 * check is an equality, so a writer and reader that disagree do not degrade
 * gracefully — every native import fails outright.
 */
const NATIVE_STL_HEADER_BYTES = 32;

/**
 * Decodes a DFST response into geometry + import classification + run map.
 *
 * Pure and exported so the wire format has a test that does not need a Tauri
 * runtime: the header and the Rust writer are one unit, and the exact-length
 * assertion below is the only thing standing between a version skew and a
 * silently misread buffer.
 *
 * Returns `null` for an empty or sub-header response (nothing to decode);
 * THROWS for a response that has a header but does not match it, because a
 * length that disagrees with its own header is a corrupt transfer, not a small
 * one.
 */
export function decodeNativeStlResponse(bytes: ArrayBuffer): NativeStlLoadResult | null {
  {
    if (!bytes || bytes.byteLength === 0) return null;

    if (bytes.byteLength < NATIVE_STL_HEADER_BYTES) return null;
    const header = new DataView(bytes, 0, NATIVE_STL_HEADER_BYTES);
    const hasMagic = header.getUint8(0) === 0x44
      && header.getUint8(1) === 0x46
      && header.getUint8(2) === 0x53
      && header.getUint8(3) === 0x54;
    if (!hasMagic) throw new Error('Native STL loader returned an unsupported response.');

    const flags = header.getUint32(4, true);
    const originalTriangleCount = header.getUint32(8, true);
    const previewTriangleCount = header.getUint32(12, true);
    const achievedError = header.getFloat32(16, true);
    const budgetTriangles = header.getUint32(20, true);
    const runMapEntryCount = header.getUint32(24, true);
    const classificationJsonBytes = header.getUint32(28, true);
    const geometryBytes = previewTriangleCount * 18 * Float32Array.BYTES_PER_ELEMENT;
    const expectedBytes =
      NATIVE_STL_HEADER_BYTES
      + geometryBytes
      + runMapEntryCount * IMPORT_RUN_MAP_BYTES_PER_ENTRY
      + classificationJsonBytes;
    if (previewTriangleCount === 0 || bytes.byteLength !== expectedBytes) {
      throw new Error('Native STL loader returned a truncated response.');
    }

    const positions = new Float32Array(bytes, NATIVE_STL_HEADER_BYTES, previewTriangleCount * 9);
    const normals = new Float32Array(
      bytes,
      NATIVE_STL_HEADER_BYTES + previewTriangleCount * 9 * Float32Array.BYTES_PER_ELEMENT,
      previewTriangleCount * 9,
    );

    // The run map is `[start, len]` pairs in SOURCE-FILE triangle indices —
    // never welded or preview indices. Copied out of the IPC buffer (unlike the
    // geometry, which deliberately keeps its view) because it is kilobytes at
    // most and outlives the geometry on `GeometryWithBounds`.
    const runMapBase = NATIVE_STL_HEADER_BYTES + geometryBytes;
    const runMap = runMapEntryCount > 0
      ? new Uint32Array(new Uint32Array(bytes, runMapBase, runMapEntryCount * 2))
      : null;
    const classification = classificationJsonBytes > 0
      ? parseImportClassification(
          JSON.parse(
            new TextDecoder().decode(
              new Uint8Array(bytes, runMapBase + runMapEntryCount * IMPORT_RUN_MAP_BYTES_PER_ENTRY, classificationJsonBytes),
            ),
          ),
        )
      : null;

    const geometry = new THREE.BufferGeometry();
    // Both attributes retain the IPC ArrayBuffer. Avoiding slice() here removes
    // two full-size allocation spikes immediately after the native transfer.
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

    console.log(
      `[loadStlGeometry] Tauri Rust parser loaded ${previewTriangleCount.toLocaleString()} triangles ` +
      `(${(bytes.byteLength / 1_000_000).toFixed(0)} MB IPC transfer).`,
    );
    if ((flags & 1) !== 0) {
      console.warn(
        `[loadStlGeometry] Using a reduced native preview: ` +
        `${originalTriangleCount.toLocaleString()} -> ${previewTriangleCount.toLocaleString()} triangles.`,
      );
    }
    if (classification) {
      console.log(
        `[loadStlGeometry] Import classification: model=${classification.model_triangle_count ?? '—'}`
        + `/${classification.source_triangle_count} tris, shells=${classification.connected_components ?? '—'}`
        + `, support=${classification.likely_support_geometry}`
        + `, runs=${runMapEntryCount}/${classification.run_count}`
        + ` (${(classification.classify_ms + classification.section_stats_ms).toFixed(0)} ms).`,
      );
      if (classification.run_count > runMapEntryCount) {
        console.warn(
          `[loadStlGeometry] Run map not transported: ${classification.run_count.toLocaleString()} runs `
          + 'exceed the transport cap. Section-aware output will recompute it from the source file.',
        );
      }
    }
    return {
      geometry,
      originalTriangleCount,
      previewTriangleCount,
      isPreview: (flags & 1) !== 0,
      achievedError,
      budgetTriangles,
      classification,
      runMap,
    };
  }
}

async function loadStlViaTauri(filePath: string): Promise<NativeStlLoadResult | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const bytes = await invoke<ArrayBuffer>('load_stl_file', {
      filePath,
      jsHeapSizeLimit: readJsHeapSizeLimit(),
    });
    return decodeNativeStlResponse(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[loadStlGeometry] Tauri Rust parser failed.', error);
    throw new Error(message || 'Native STL loading failed.');
  }
}

/**
 * Strips the internal `_importCPre` hand-off, promoting it to the public
 * `cPre` only when this geometry's source is genuinely re-readable at
 * `reReadableSourcePath`.
 *
 * That gate IS the safety property: a captured center is only a valid
 * subtrahend for raw-file coordinates when the geometry was built from that
 * very file. A VOXL reload re-runs `processGeometry` over the EMBEDDED,
 * already-centered mesh with no path — its captured center describes embedded
 * coordinates, and promoting it would manufacture exactly the frame bug this
 * work exists to remove (the reload restores `sourcePath`, so a raw-file
 * consumer would otherwise happily use it).
 */
function finalizeImportFrameDatum(
  processed: GeometryWithBounds,
  reReadableSourcePath: string | undefined,
): GeometryWithBounds {
  const captured = processed._importCPre;
  delete processed._importCPre;
  if (captured && typeof reReadableSourcePath === 'string' && reReadableSourcePath.trim().length > 0) {
    processed.cPre = captured;
  }
  return processed;
}

export async function loadStlGeometry(fileUrl: string, options: ProcessGeometryOptions = {}): Promise<GeometryWithBounds> {
  // In Tauri with a file path, use the Rust-side STL parser.
  // It reads the file directly from disk, computes normals, and avoids
  // holding the raw STL bytes in webview memory — critical for huge files.
  if (isTauriRuntime() && options.filePath) {
    const nativeResult = await loadStlViaTauri(options.filePath);
    if (nativeResult) {
      // Normals are already computed — skip computeVertexNormals in processGeometry
      const processed = await processGeometry(nativeResult.geometry, {
        ...options,
        _skipComputeNormals: true,
        _isNativePreview: nativeResult.isPreview,
        _importClassification: nativeResult.classification,
        ...(nativeResult.isPreview ? { nativeProcessingMode: 'none' as const } : {}),
      });

      // Ph1 wiring — the run map, in SOURCE-FILE indices, describing the
      // ORIGINAL file whether or not the payload above was decimated. Attached
      // for every native import that found a split; Ph3's splice is its
      // consumer, and `resolveImportRunMap` is how it must be read.
      const importRunMap = nativeResult.classification
        ? importRunMapFromResponse({
            runs: nativeResult.runMap,
            modelTriangleCount: nativeResult.classification.model_triangle_count,
            sourceTriangleCount: nativeResult.classification.source_triangle_count,
            droppedNonFiniteTriangles: nativeResult.classification.dropped_nonfinite_triangles,
            totalRunCount: nativeResult.classification.run_count,
          })
        : null;
      if (importRunMap) processed.importRunMap = importRunMap;

      if (nativeResult.isPreview) {
        // C_pre captured at the centering site inside processGeometry.
        // Stripped by finalizeImportFrameDatum on the way out.
        const cPre = processed._importCPre;

        // Staleness fingerprint for output-time full-res re-reads. The DFST
        // response carries no stat data, so one sub-millisecond stat IPC is
        // the least-invasive capture. Non-fatal: without it the splice still
        // runs, it only skips the changed-on-disk comparison.
        let sourceFingerprint: { sizeBytes: number; mtimeMs: number } | undefined;
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const stat = await invoke<{ sizeBytes: number; mtimeMs: number }>('stat_source_file', {
            filePath: options.filePath,
          });
          if (stat && Number.isFinite(stat.sizeBytes) && Number.isFinite(stat.mtimeMs)) {
            sourceFingerprint = { sizeBytes: stat.sizeBytes, mtimeMs: stat.mtimeMs };
          }
        } catch (statError) {
          console.warn(
            '[loadStlGeometry] Could not fingerprint the preview source file; ' +
            'full-res output will skip the staleness check.',
            statError,
          );
        }

        processed.nativePreview = {
          originalTriangleCount: nativeResult.originalTriangleCount,
          previewTriangleCount: nativeResult.previewTriangleCount,
          ...(cPre ? { cPre } : {}),
          ...(sourceFingerprint ? { sourceFingerprint } : {}),
          ...(Number.isFinite(nativeResult.achievedError)
            ? { achievedError: nativeResult.achievedError }
            : {}),
          ...(nativeResult.budgetTriangles > 0
            ? { budgetTriangles: nativeResult.budgetTriangles }
            : {}),
          // Ph1 wiring — the run-map SUMMARY rides with the rest of the
          // full-res linkage, because the splice that consumes the map is
          // gated on exactly this marker plus a re-readable `sourcePath`.
          // Written even when the array itself was dropped for exceeding the
          // cap: `totalRunCount` is what lets a reload tell "no split" from
          // "too fragmented to carry, recompute it".
          ...(importRunMap ? { runMap: summarizeImportRunMap(importRunMap) } : {}),
        };
      }
      return finalizeImportFrameDatum(processed, options.filePath);
    }
  }

  // Try streaming binary STL parser — avoids holding the entire file as ArrayBuffer
  const streamed = await loadStlBinaryStreaming(fileUrl);
  if (streamed) {
    console.log(`[${new Date().toISOString()}] [loadStlGeometry] Streaming parser succeeded, processing geometry.`);
    return finalizeImportFrameDatum(await processGeometry(streamed, options), options.filePath);
  }

  // Fall back to Three.js STLLoader (handles ASCII STL, edge cases, etc.)
  return new Promise((resolve, reject) => {
    const loader = new STLLoader();
    console.log(`[${new Date().toISOString()}] [loadStlGeometry] Starting STLLoader load for ${fileUrl}`);
    const startLoad = performance.now();

    loader.load(
      fileUrl,
      (bufferGeometry) => {
        console.log(`[${new Date().toISOString()}] [loadStlGeometry] STLLoader finished. Took ${(performance.now() - startLoad).toFixed(2)}ms`);
        processGeometry(bufferGeometry, options)
          .then((processed) => resolve(finalizeImportFrameDatum(processed, options.filePath)))
          .catch(reject);
      },
      undefined,
      (error) => {
        reject(error);
      }
    );
  });
}

function collectMergedGeometryFromObject3d(root: THREE.Object3D, sourceLabel: '3MF' | 'OBJ'): THREE.BufferGeometry {
  root.updateMatrixWorld(true);

  const geometries: THREE.BufferGeometry[] = [];

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!(mesh.geometry instanceof THREE.BufferGeometry)) return;

    const cloned = mesh.geometry.clone();
    // DragonFruit controls mesh tinting centrally; ignore per-file vertex colors.
    if (cloned.getAttribute('color')) {
      cloned.deleteAttribute('color');
    }
    cloned.applyMatrix4(mesh.matrixWorld);
    geometries.push(cloned);
  });

  if (geometries.length === 0) {
    throw new Error(`${sourceLabel} contains no mesh geometry.`);
  }

  if (geometries.length === 1) {
    return geometries[0];
  }

  const merged = mergeGeometries(geometries, false);
  geometries.forEach((g) => {
    if (g !== merged) {
      try {
        g.dispose();
      } catch {
        // ignore
      }
    }
  });

  if (!merged) {
    throw new Error(`Failed to merge ${sourceLabel} meshes.`);
  }

  return merged;
}

/**
 * Loads a 3MF file using the fast-3mf-loader (SAX parsing + WebWorkers).
 * Falls back to ThreeMFLoader if the fast loader fails or encounters
 * unsupported features (e.g. metallic display properties, print tickets).
 */
async function tryLoadFast3mf(fileUrl: string): Promise<THREE.Group | null> {
  try {
    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();

    const loader = new Fast3MFLoader();
    const data3mf = await loader.parse(buffer);
    const group = fast3mfBuilder(data3mf);

    if (group && group.type === 'Group' && group.children.length > 0) {
      return group;
    }
    return null;
  } catch (fastError) {
    console.warn('[load3mfGeometry] fast-3mf-loader failed; falling back to ThreeMFLoader.', fastError);
    return null;
  }
}

export async function load3mfGeometry(fileUrl: string, options?: ProcessGeometryOptions): Promise<GeometryWithBounds> {
  // Try the fast SAX/worker-based loader first for large archives
  const fastGroup = await tryLoadFast3mf(fileUrl);
  if (fastGroup) {
    console.log(`[${new Date().toISOString()}] [load3mfGeometry] fast-3mf-loader succeeded, processing geometry.`);
    try {
      const mergedGeometry = collectMergedGeometryFromObject3d(fastGroup, '3MF');
      return await processGeometry(mergedGeometry, options);
    } catch (error) {
      console.warn('[load3mfGeometry] fast-3mf-loader geometry processing failed; falling back to ThreeMFLoader.', error);
    }
  }

  // Fall back to the original ThreeMFLoader
  return new Promise((resolve, reject) => {
    const loader = new ThreeMFLoader();
    console.log(`[${new Date().toISOString()}] [load3mfGeometry] Starting ThreeMFLoader load for ${fileUrl}`);
    const startLoad = performance.now();

    loader.load(
      fileUrl,
      (object) => {
        console.log(`[${new Date().toISOString()}] [load3mfGeometry] ThreeMFLoader finished. Took ${(performance.now() - startLoad).toFixed(2)}ms`);

        try {
          const mergedGeometry = collectMergedGeometryFromObject3d(object, '3MF');
          void processGeometry(mergedGeometry, options)
            .then(resolve)
            .catch(reject);
        } catch (error) {
          reject(error);
        }
      },
      undefined,
      (error) => {
        reject(error);
      }
    );
  });
}

/**
 * Collects individual geometries from a 3MF scene group, preserving each
 * mesh's world transform. Returns one geometry per mesh child — used for
 * multi-body 3MF import where each body becomes a separate model.
 */
function collectIndividualGeometriesFromObject3d(root: THREE.Object3D): THREE.BufferGeometry[] {
  root.updateMatrixWorld(true);

  const geometries: THREE.BufferGeometry[] = [];

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!(mesh.geometry instanceof THREE.BufferGeometry)) return;

    const cloned = mesh.geometry.clone();
    // DragonFruit controls mesh tinting centrally; ignore per-file vertex colors.
    if (cloned.getAttribute('color')) {
      cloned.deleteAttribute('color');
    }
    cloned.applyMatrix4(mesh.matrixWorld);
    geometries.push(cloned);
  });

  return geometries;
}

/**
 * Loads a 3MF file and returns individual geometries for each mesh body,
 * processing each one independently (centering, auto-lift etc.) like loading
 * separate files. Used for multi-body 3MF import where each body becomes a
 * separate `LoadedModel` with auto-grouping.
 *
 * Returns an array of `GeometryWithBounds` — one per mesh found in the 3MF.
 * If the file contains a single mesh, returns a single-element array.
 */
export async function load3mfGeometryMulti(fileUrl: string, options?: ProcessGeometryOptions): Promise<GeometryWithBounds[]> {
  // Try the fast SAX/worker-based loader first for large archives
  const fastGroup = await tryLoadFast3mf(fileUrl);
  if (fastGroup) {
    console.log(`[${new Date().toISOString()}] [load3mfGeometryMulti] fast-3mf-loader succeeded, processing individual geometries.`);
    try {
      const individualGeometries = collectIndividualGeometriesFromObject3d(fastGroup);
      if (individualGeometries.length === 0) {
        throw new Error('3MF contains no mesh geometry.');
      }
      const results: GeometryWithBounds[] = [];
      for (const geom of individualGeometries) {
        results.push(await processGeometry(geom, options));
      }
      return results;
    } catch (error) {
      console.warn('[load3mfGeometryMulti] fast-3mf-loader geometry processing failed; falling back to ThreeMFLoader.', error);
    }
  }

  // Fall back to the original ThreeMFLoader
  return new Promise((resolve, reject) => {
    const loader = new ThreeMFLoader();
    console.log(`[${new Date().toISOString()}] [load3mfGeometryMulti] Starting ThreeMFLoader load for ${fileUrl}`);
    const startLoad = performance.now();

    loader.load(
      fileUrl,
      async (object) => {
        console.log(`[${new Date().toISOString()}] [load3mfGeometryMulti] ThreeMFLoader finished. Took ${(performance.now() - startLoad).toFixed(2)}ms`);

        try {
          const individualGeometries = collectIndividualGeometriesFromObject3d(object);
          if (individualGeometries.length === 0) {
            reject(new Error('3MF contains no mesh geometry.'));
            return;
          }
          const results: GeometryWithBounds[] = [];
          for (const geom of individualGeometries) {
            results.push(await processGeometry(geom, options));
          }
          resolve(results);
        } catch (error) {
          reject(error);
        }
      },
      undefined,
      (error) => {
        reject(error);
      }
    );
  });
}

/**
 * Loads a 3MF file and returns both a single merged geometry (all bodies
 * combined, preserving their relative positions) and individually-processed
 * body geometries for instant splitting.
 *
 * The merged result is used for the initial single-model import. The
 * `splitBodies` array stores each body independently centered (as if
 * imported separately) so "Split to Bodies" is instantaneous.
 */
export async function load3mfGeometryMergedWithSplitData(
  fileUrl: string,
  options?: ProcessGeometryOptions,
): Promise<{ merged: GeometryWithBounds; splitBodies: GeometryWithBounds[] }> {
  // Get raw individual geometries with their world transforms applied
  const getRawGeometries = async (group: THREE.Group): Promise<THREE.BufferGeometry[]> => {
    group.updateMatrixWorld(true);
    const geoms: THREE.BufferGeometry[] = [];
    group.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!(mesh.geometry instanceof THREE.BufferGeometry)) return;
      const cloned = mesh.geometry.clone();
      if (cloned.getAttribute('color')) cloned.deleteAttribute('color');
      cloned.applyMatrix4(mesh.matrixWorld);
      geoms.push(cloned);
    });
    return geoms;
  };

  // Try fast loader first
  const fastGroup = await tryLoadFast3mf(fileUrl);
  if (fastGroup) {
    console.log(`[${new Date().toISOString()}] [load3mfGeometryMerged] fast-3mf-loader succeeded.`);
    try {
      const rawGeoms = await getRawGeometries(fastGroup);
      if (rawGeoms.length === 0) throw new Error('3MF contains no mesh geometry.');

      // Merge raw geometries (preserving relative positions) → single model
      const mergedBuf = rawGeoms.length === 1
        ? rawGeoms[0]
        : mergeGeometries(rawGeoms, false);
      if (!mergedBuf) throw new Error('Failed to merge 3MF bodies.');
      const merged = await processGeometry(mergedBuf, options);

      // Process each body independently (with centering) → split bodies
      const splitBodies: GeometryWithBounds[] = [];
      for (const raw of rawGeoms) {
        splitBodies.push(await processGeometry(raw, options));
      }

      return { merged, splitBodies };
    } catch (error) {
      console.warn('[load3mfGeometryMerged] fast-3mf-loader failed; falling back to ThreeMFLoader.', error);
    }
  }

  // Fall back to ThreeMFLoader
  return new Promise((resolve, reject) => {
    const loader = new ThreeMFLoader();
    console.log(`[${new Date().toISOString()}] [load3mfGeometryMerged] ThreeMFLoader fallback for ${fileUrl}`);

    loader.load(
      fileUrl,
      async (object) => {
        try {
          const rawGeoms = await getRawGeometries(object);
          if (rawGeoms.length === 0) {
            reject(new Error('3MF contains no mesh geometry.'));
            return;
          }

          const mergedBuf = rawGeoms.length === 1
            ? rawGeoms[0]
            : mergeGeometries(rawGeoms, false);
          if (!mergedBuf) {
            reject(new Error('Failed to merge 3MF bodies.'));
            return;
          }
          const merged = await processGeometry(mergedBuf, options);

          const splitBodies: GeometryWithBounds[] = [];
          for (const raw of rawGeoms) {
            splitBodies.push(await processGeometry(raw, options));
          }

          resolve({ merged, splitBodies });
        } catch (error) {
          reject(error);
        }
      },
      undefined,
      reject,
    );
  });
}

export async function loadObjGeometry(fileUrl: string, options?: ProcessGeometryOptions): Promise<GeometryWithBounds> {
  return new Promise((resolve, reject) => {
    const loader = new OBJLoader();
    console.log(`[${new Date().toISOString()}] [loadObjGeometry] OBJLoader load for ${fileUrl}`);
    const startLoad = performance.now();

    loader.load(
      fileUrl,
      (object) => {
        console.log(`[${new Date().toISOString()}] [loadObjGeometry] OBJLoader finished. Took ${(performance.now() - startLoad).toFixed(2)}ms`);

        try {
          const mergedGeometry = collectMergedGeometryFromObject3d(object, 'OBJ');
          void processGeometry(mergedGeometry, options)
            .then(resolve)
            .catch(reject);
        } catch (error) {
          reject(error);
        }
      },
      undefined,
      (error) => {
        reject(error);
      }
    );
  });
}

export async function loadMeshGeometry(fileUrl: string, fileName?: string, options?: ProcessGeometryOptions): Promise<GeometryWithBounds> {
  const ext = (fileName ?? '').trim().toLowerCase();
  if (ext.endsWith('.3mf')) {
    return load3mfGeometry(fileUrl, options);
  }
  if (ext.endsWith('.obj')) {
    return loadObjGeometry(fileUrl, options);
  }
  return loadStlGeometry(fileUrl, options);
}

export function useStlGeometry(fileUrl: string | null, directGeometry?: THREE.BufferGeometry | null): GeometryWithBounds | null {
  const [geom, setGeom] = useState<GeometryWithBounds | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Case 1: Direct Geometry (e.g. from LYS import)
    if (directGeometry) {
      console.log(`[${new Date().toISOString()}] [useStlGeometry] Processing direct geometry`);
      processGeometry(directGeometry)
        .then((data) => {
          if (!cancelled) setGeom(data);
        })
        .catch((err) => {
          console.error("Failed to process direct geometry", err);
          if (!cancelled) setGeom(null);
        });
      return () => { cancelled = true; };
    }

    // Case 2: File URL (mesh import)
    if (fileUrl) {
      loadStlGeometry(fileUrl)
        .then((data) => {
          if (!cancelled) {
            console.log(`[${new Date().toISOString()}] [useStlGeometry] Calling setGeom`);
            setGeom(data);
          }
        })
        .catch((err) => {
          console.error("Failed to load STL", err);
          if (!cancelled) setGeom(null);
        });

      return () => { cancelled = true; };
    }

    // Case 3: No input
    setGeom(null);
    return;
  }, [fileUrl, directGeometry]);

  return geom;
}
