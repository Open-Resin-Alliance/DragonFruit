import { isTauriRuntime } from '@/utils/tauriRuntime';
import { bakeAndAttachOcclusionForGeometry, rememberLoadedMeshMesh } from '@/features/scene/bakedOcclusion';
import { getSavedWorkspaceCameraSettings } from '@/components/settings/workspaceCameraPreferences';
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { Fast3MFLoader, fast3mfBuilder } from 'fast-3mf-loader';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadMeshBytes, loadMeshFileFromNativePath } from '@/features/slicing/tauri/nativeSlicerBridge';
import { loadMeshRangeFromNativePath } from '@/utils/tauriMeshBridge';
import type { VoxlMeshRange } from '@/features/scene/voxl/types';
import { accelerateGeometry } from '@/utils/bvh';
import { logToNativeFile } from '@/utils/nativeLog';
import { runWithConcurrency } from '@/utils/runWithConcurrency';
import { computeFlatteningPlanes, type FlatteningPlane } from '@/features/placeOnFace/logic/computeFlatteningPlanes';
import { refineCoarseFaces, shouldRefineCoarseFaces } from '@/utils/tauriMeshBridge';
import {
  analyzeFromGeometry,
  applyRepairedPositions,
  classifyFromGeometry,
  isHeavyRepair,
  repairFromGeometry,
  repairFromPath,
  repairPartsFromPath,
  type MeshAnalysisJson,
  type MeshHealthReport,
  type MeshRepairProgressSink,
} from '@/utils/meshRepair';
import { reportAddressesTriangleSoup } from '@/features/scene/voxl/classification';

export type MeshDefects = {
  /** Whether any non-finite vertex position values were found */
  hasDefects: boolean;
  /** Number of individual float components (x/y/z) replaced with 0 */
  repairedFloats: number;
  /** Total vertex count in the position buffer */
  totalVertices: number;
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
   * Hard-edge geometry (30°) for the Higher Contrast Model Edges overlay.
   *
   * Only built when the user has the overlay enabled — see
   * {@link buildModelEdgeGeometry} for why it is never built otherwise. It
   * caches on the geometry so every consumer and every remount reuses one
   * build, and so a geometry swap (hollow, punch, mirror, split) rebuilds
   * exactly once.
   */
  edgeGeometry?: THREE.EdgesGeometry;
  /** Present when an oversized native source was reduced for interactive use. */
  nativePreview?: {
    originalTriangleCount: number;
    previewTriangleCount: number;
  };
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

/** What the caller decided when a heavy repair was offered. */
export type HeavyRepairChoice = 'repair' | 'repair_parts' | 'skip';

export interface ProcessGeometryOptions {
  center?: boolean;
  /**
   * Controls native Tauri mesh processing behavior:
   * - `auto` (default): standard flow; may run repair path.
   * - `classify-only`: lightweight shell split classification (no heavy repair).
    * - `none`: skip native repair/classification entirely.
   * - `repair`: force full repair/classification path.
   */
    nativeProcessingMode?: 'auto' | 'classify-only' | 'none' | 'repair';
  /**
   * Called when analysis indicates a heavy solidification repair is needed.
   *
   * `'repair'` runs the whole-file pipeline, `'repair_parts'` repairs the file's separate objects
   * each on their own (which is what a plate needs: one verdict for 25 objects says nothing about
   * which object is the problem), and `'skip'` loads it as it came.
   * Only invoked when running under Tauri.
   */
  onConfirmHeavyRepair?: (analysis: MeshAnalysisJson) => Promise<HeavyRepairChoice>;
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
  assumeSupportGeometry?: boolean;
  /**
   * Hears each repair stage as it starts, and receives the run's token so the
   * caller can cancel it. Ignored when the geometry does not go through the
   * native repair.
   */
  repairProgressSink?: MeshRepairProgressSink;
  /**
   * The file this geometry came from, when it came from one.
   *
   * With a path the repair reads the file through the native loader, which is the same
   * path the import took: it classifies the mesh at load, refines what needs it, and
   * keeps the file's own indexing. Without one the geometry is expanded to a triangle
   * soup and staged, which costs an upload and re-derives every vertex.
   */
  sourcePath?: string;
  /** Skip nonessential analysis for a native reduced-detail preview. @internal */
  _isNativePreview?: boolean;
  /** Model section boundary offset extracted directly from the DFMX binary IPC header. @internal */
  _nativeModelTriangleCount?: number;
  /** Skip classification/repair in Tauri when loading a pre-repaired mesh */
  skipClassification?: boolean;
  /**
   * Classification the source container already carries for this exact
   * geometry (VOXL V3.3 model entries). When present the native classify pass
   * is skipped — the report describes the triangles as they are, so re-running
   * the classifier over the same bytes could only reproduce it. The report is
   * consumed exactly where a native classify-only result would be, including
   * the model/support section split.
   */
  bakedClassification?: MeshHealthReport;
  /**
   * Build the Higher Contrast Model Edges overlay geometry. Defaults to the
   * user's `higherContrastModelEdges` setting; pass `false` from a context that
   * knows the overlay is unwanted (e.g. a slicing-only geometry).
   */
  computeEdgeGeometry?: boolean;
  /**
   * Take the occlusion bake's promise instead of waiting for it.
   *
   * The bake is started at the same point either way — as soon as the geometry's
   * positions are final, before the BVH and the flattening planes — so it always
   * overlaps this model's own tail. This only moves the *wait*: a multi-model
   * import (a VOXL scene, a drop of several files) keeps every model's bake in
   * flight while the remaining meshes are still being prepared, and awaits them
   * before the models reach the scene.
   *
   * The caller MUST await it before the geometry is cloned or shown: the bake
   * attaches its attribute to the geometry it was handed, and anything cloned
   * from it before then misses the attribute. @internal
   */
  _deferOcclusionBake?: (bake: Promise<boolean>) => void;
  /**
   * Whether the native loader may refine coarse faces. Default true.
   *
   * A payload that is already a scene's own mesh — a VOXL `MESH` chunk — passes
   * false: refinement is not idempotent, so refining a stored mesh changes the
   * triangle count and order that any model/support boundary indexes, and a
   * save/load cycle grows it every time (81,282 triangles came back as 126,386 on
   * the reported scene). @internal
   */
  _refine?: boolean;
  /** Skip `computeVertexNormals()` - the geometry already has a `normal` attribute */
  _skipComputeNormals?: boolean;
  _isTauriRuntime?: () => boolean;
  _classifyFromGeometry?: typeof classifyFromGeometry;
  _repairFromGeometry?: typeof repairFromGeometry;
  _repairPartsFromPath?: typeof repairPartsFromPath;
  _analyzeFromGeometry?: typeof analyzeFromGeometry;
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
// EdgesGeometry builds an internal hash map keyed by unique vertex positions
// using a plain object, then iterates it with `for...in`. V8 throws "Too many
// properties to enumerate" when the hash map exceeds ~2M entries, so meshes
// above this threshold get no Higher Contrast Model Edges overlay at all.
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

/**
 * Splits the geometry's position soup at `modelTriangleCount` into the two
 * section geometries the scene renders: the support section (orange overlay)
 * and the model section (scopes the non-manifold red flag to the part, so it
 * never stripes the supports). Both classifiers and baked classifications
 * produce the same model-first ordering, so this is their single consumer.
 *
 * Returns null when the boundary does not address this geometry — out of
 * range, or the whole mesh is one section.
 */
function buildSectionGeometries(
  geometry: THREE.BufferGeometry,
  modelTriangleCount: number,
): Pick<MeshDefects, 'supportSectionGeometry' | 'modelSectionGeometry'> | null {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) return null;
  const allPos = posAttr.array as Float32Array;
  const modelFloatEnd = modelTriangleCount * 9; // 3 vertices × 3 floats per tri
  if (modelFloatEnd >= allPos.length) return null;

  const supportPositions = allPos.slice(modelFloatEnd);
  const supportGeo = new THREE.BufferGeometry();
  supportGeo.setAttribute('position', new THREE.BufferAttribute(supportPositions, 3));
  supportGeo.computeVertexNormals();

  const modelPositions = allPos.slice(0, modelFloatEnd);
  const modelGeo = new THREE.BufferGeometry();
  modelGeo.setAttribute('position', new THREE.BufferAttribute(modelPositions, 3));

  return { supportSectionGeometry: supportGeo, modelSectionGeometry: modelGeo };
}

/**
 * Builds the Higher Contrast Model Edges overlay geometry, or returns undefined
 * when the mesh is too large for it (see `EDGE_GEOMETRY_MAX_TRIANGLES`).
 *
 * This is the single most expensive thing an import does — measured ~1.9 s per
 * 500k-triangle non-indexed model, ~93% of all post-processing — and the overlay
 * is off by default, so every caller must gate it on
 * `higherContrastModelEdges`. Building it speculatively (which is what import
 * did) is what made a six-model scene take 18 s of long tasks.
 */
/**
 * The model edge overlay is disabled while its build path is reworked. It was
 * O(triangles) per model (about 1.9 s for a 500k-triangle mesh), and enabling it
 * turned imports, geometry swaps and duplication into long idle tasks. The
 * builder stays here for the replacement; every caller funnels through it, so
 * this flag is the single switch.
 */
export const MODEL_EDGE_OVERLAY_ENABLED = false;

export function buildModelEdgeGeometry(geometry: THREE.BufferGeometry): THREE.EdgesGeometry | undefined {
  if (!MODEL_EDGE_OVERLAY_ENABLED) return undefined;
  const triangleCount = (geometry.getIndex()?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3;
  if (triangleCount >= EDGE_GEOMETRY_MAX_TRIANGLES) return undefined;

  try {
    return new THREE.EdgesGeometry(geometry, 30);
  } catch (edgeError) {
    console.warn('[useStlGeometry] Edge geometry build failed; the model edge overlay stays off.', edgeError);
    return undefined;
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
  // A baked classification is the answer the native classify pass would
  // produce for this geometry, so there is nothing left to compute.
  const bakedClassification = options.bakedClassification ?? null;
  const skipAll = options.skipClassification === true || bakedClassification != null;
  const checkTauri = options._isTauriRuntime ?? isTauriRuntime;
  
  if (checkTauri() && !skipAll) {
    const nativeMode = options.nativeProcessingMode ?? 'auto';
    const skipAutoNativeProcessingForSize = nativeMode === 'auto'
      && sourceTriangleEstimate >= AUTO_NATIVE_PROCESSING_TRIANGLE_THRESHOLD;

    if (skipAutoNativeProcessingForSize) {
      console.warn(
        `[processGeometry] Skipping native auto repair/classification for gigantic mesh (` +
        `${sourceTriangleEstimate.toLocaleString()} triangles). Use manual Repair to force.`
      );
    } else try {
      let classifyOnly = nativeMode === 'classify-only' || nativeMode === 'none';
      const forceRepair = nativeMode === 'repair';
      let repairParts = false;

      // If a confirmation callback is wired up, run a quick pre-repair analysis
      // so we can ask the user before committing to a heavy solidification pass.
      if (!classifyOnly && !forceRepair && options.onConfirmHeavyRepair) {
        try {
          options.onNativeProcessingStage?.('analyzing');
          console.log(`[${new Date().toISOString()}] [processGeometry] Running pre-repair analysis`);
          const runAnalysis = options._analyzeFromGeometry ?? analyzeFromGeometry;
          const analysis = await runAnalysis(geometry);
          if (analysis && isHeavyRepair(analysis)) {
            console.log(
              `[processGeometry] Heavy repair detected (components=${analysis.component_count}, ` +
              `self_intersections=${analysis.self_intersections}). Requesting user confirmation.`,
            );
            const choice = await options.onConfirmHeavyRepair(analysis);
            if (choice === 'skip') {
              console.log('[processGeometry] User declined heavy repair — running classify-only shell split pass.');
              classifyOnly = true;
            } else if (choice === 'repair_parts') {
              console.log('[processGeometry] Repairing the file part by part.');
              repairParts = Boolean(options.sourcePath);
              if (!repairParts) {
                console.warn(
                  '[processGeometry] A part-by-part repair needs the source file, and this import has no path; repairing whole instead.',
                );
              }
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
      console.log(`[${new Date().toISOString()}] [processGeometry] Running native ${classifyOnly ? 'classification' : 'repair/classification'}`);
      const nativeStart = performance.now();
      const repairOpts = options.assumeSupportGeometry != null
        ? { assumeSupportGeometry: options.assumeSupportGeometry }
        : {};
      const runClassify = options._classifyFromGeometry ?? classifyFromGeometry;
      const runRepair = options._repairFromGeometry ?? repairFromGeometry;
      const runParts = options._repairPartsFromPath ?? repairPartsFromPath;
      const useLoaderPath = !options._repairFromGeometry && Boolean(options.sourcePath);
      const result = classifyOnly
        ? await runClassify(geometry, repairOpts)
        : repairParts && useLoaderPath
          ? await runParts(options.sourcePath!, repairOpts, options.repairProgressSink)
          : useLoaderPath
            ? await repairFromPath(options.sourcePath!, repairOpts, options.repairProgressSink)
            : await runRepair(geometry, repairOpts, options.repairProgressSink);
      if (result) {
        let effectiveResult = result;
        let usedFallbackClassification = false;
        let shouldApplyPositions = true;

        if (!classifyOnly) {
          const qualityGate = evaluateNativeRepairQualityGate(result.report);
          if (qualityGate.reject) {
            console.warn(`[processGeometry] Rejecting native auto-repair result: ${qualityGate.reason}. Falling back to classify-only pass.`);
            try {
              options.onNativeProcessingStage?.('classifying');
              const fallbackClassification = await runClassify(geometry, repairOpts);
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
          `[processGeometry] Native ${classifyOnly ? 'classification' : usedFallbackClassification ? 'repair/classification (fallback classify applied)' : 'repair/classification'} finished in ${(performance.now() - nativeStart).toFixed(2)}ms ` +
          `(rust ${report.total_ms.toFixed(1)}ms; the rest is soup expand + staging IPC + apply). ` +
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

        // If the repaired mesh has a model/support split, extract the support
        // section as a separate geometry for orange overlay rendering.
        const positionsWereApplied = shouldApplyPositions;
        const effectiveModelTriCount = report.model_triangle_count ?? options._nativeModelTriangleCount;

        if ((positionsWereApplied || options._skipComputeNormals) && effectiveModelTriCount != null && effectiveModelTriCount > 0) {
          if (!report.model_triangle_count) {
            report.model_triangle_count = effectiveModelTriCount;
          }
          const sections = buildSectionGeometries(geometry, effectiveModelTriCount);
          if (sections) {
            meshDefects = { ...meshDefects, ...sections };
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
  }

  // Baked classification: restore what a native classify-only pass would have
  // produced, minus the round trip. Everything downstream reads the report
  // (Split Supports, orange support tint, shells, non-manifold red flag, slicing).
  if (bakedClassification) {
    const sections = bakedClassification.model_triangle_count != null
      && bakedClassification.model_triangle_count > 0
      ? buildSectionGeometries(geometry, bakedClassification.model_triangle_count)
      : null;
    meshDefects = {
      ...meshDefects,
      nativeRepairReport: bakedClassification,
      ...(sections ?? {}),
    };
    console.log(
      `[${new Date().toISOString()}] [processGeometry] Restored baked mesh classification ` +
      `(model section: ${bakedClassification.model_triangle_count ?? 'none'}t).`,
    );
  }

  // Yield to let the loading indicator repaint before each heavy synchronous op
  await new Promise<void>(r => setTimeout(r, 0));

  // A geometry with no `normal` attribute at all must be given one, whatever the
  // caller asked for: `_skipComputeNormals` means "the loader already computed
  // them", and a native repair invalidates that promise by rewriting the
  // positions and index and dropping the stale normals for the caller to
  // recompute. Without this the repaired geometry kept no normals, so it shaded
  // from a zeroed attribute — which reads as garbage on exactly the imports that
  // needed repair, and is easy to mistake for the baked occlusion being wrong.
  if (!options._skipComputeNormals || nativeModifiedGeometry || !geometry.getAttribute('normal')) {
    console.log(`[${new Date().toISOString()}] [processGeometry] Computing Normals${nativeModifiedGeometry ? ' (geometry modified by native processing)' : geometry.getAttribute('normal') ? '' : ' (geometry has none)'}`);
    geometry.computeVertexNormals();
  } else {
    console.log(`[${new Date().toISOString()}] [processGeometry] Normals already present — skipping computeVertexNormals`);
  }

  console.log(`[${new Date().toISOString()}] [processGeometry] Computing BBox`);
  geometry.computeBoundingBox();

  const preBBox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
  const preCenter = preBBox.getCenter(new THREE.Vector3());

  // Normalize: center X/Z at 0 and set bottom (minY) to 0 in local space
  if (options.center) {
    geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z);
  }
  geometry.computeBoundingBox();
  const prepMs = performance.now() - startPrep;
  console.log(`[${new Date().toISOString()}] [processGeometry] Geometry Prep finished. Took ${prepMs.toFixed(2)}ms`);
  void logToNativeFile('info', `[processGeometry] prep ${prepMs.toFixed(0)}ms`);

  // Yield before BVH (expensive synchronous tree build)
  await new Promise<void>(r => setTimeout(r, 0));

  // The occlusion bake starts here, not at the end of prep: it is native work —
  // a GPU kernel where the machine has one, 0.4-1.2 s per model on the scene
  // measured below — while the BVH, the flattening planes and the edge overlay
  // are main-thread work. Both are wanted before the model reaches the scene, and
  // in that order they were one after the other; started here the bake runs during
  // them. What it reads is the geometry's positions, final by now (the centering
  // translate above is the last write to them) and its corner table, which
  // `bakeOcclusionForGeometry` snapshots with the request — so whatever prep does
  // to either afterwards cannot move the values. It does do something: the BVH
  // build gives a non-indexed geometry an index it did not have.
  //
  // Deferring the bake to idle was tried and reverted: paying it while the user is
  // already waiting beats stuttering while they are interacting. Moving the *wait*
  // is a different thing, and only a caller that owns the rest of the batch
  // (`_deferOcclusionBake`) does that.
  const occlusionBake = bakeAndAttachOcclusionForGeometry(geometry).catch((error) => {
    console.warn('[ao] bake during prep failed', error);
    return false;
  });

  // Add BVH acceleration for fast raycasting (critical for support placement)
  console.log(`[${new Date().toISOString()}] [processGeometry] Starting BVH Construction`);
  const startBVH = performance.now();
  accelerateGeometry(geometry);
  const bvhMs = performance.now() - startBVH;
  console.log(`[${new Date().toISOString()}] [processGeometry] BVH Construction finished. Took ${bvhMs.toFixed(2)}ms`);
  void logToNativeFile('info', `[processGeometry] bvh ${bvhMs.toFixed(0)}ms`);

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
    const planesMs = performance.now() - startPlanes;
  console.log(`[${new Date().toISOString()}] [processGeometry] Flattening Planes finished. Took ${planesMs.toFixed(2)}ms`);
  void logToNativeFile('info', `[processGeometry] planes ${planesMs.toFixed(0)}ms`);
  }

  // Yield before the optional edge overlay build
  await new Promise<void>(r => setTimeout(r, 0));

  // Built only when the user actually has the overlay on: it costs ~1.9 s for a
  // 500k-triangle model and is off by default, so a scene that never enables it
  // must never pay for it. A later toggle is handled by the scene
  // (useSceneCollectionManager's ensure pass), which builds for already-loaded
  // models one at a time.
  const computeEdgeGeometry = options.computeEdgeGeometry
    ?? getSavedWorkspaceCameraSettings().higherContrastModelEdges;
  let edgeGeometry: THREE.EdgesGeometry | undefined;
  if (MODEL_EDGE_OVERLAY_ENABLED && computeEdgeGeometry) {
    console.log(`[${new Date().toISOString()}] [processGeometry] Computing Edge Geometry`);
    const startEdges = performance.now();
    edgeGeometry = buildModelEdgeGeometry(geometry);
    console.log(`[${new Date().toISOString()}] [processGeometry] Edge Geometry finished. Took ${(performance.now() - startEdges).toFixed(2)}ms`);
  }

  const shouldSurfaceDefects = meshDefects.hasDefects || meshDefects.nativeRepairReport != null;
  // The model is not added to the scene until this resolves, so its first frame
  // already carries the occlusion, and the import's progress modal is still up
  // while it runs. A batch import takes the promise instead and awaits every
  // model's bake before it places any of them — same guarantee, one wait.
  if (options._deferOcclusionBake) {
    options._deferOcclusionBake(occlusionBake);
  } else if (await occlusionBake) {
    console.log(`[${new Date().toISOString()}] [processGeometry] Baked occlusion attached during prep`);
  }

  return { geometry, bbox, center, size, flatteningPlanes, edgeGeometry, ...(shouldSurfaceDefects ? { meshDefects } : {}) };
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
    void logToNativeFile('warn', `[loadStlGeometry] Streaming STL failed; falling back to STLLoader: ${String(error)}`);
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
  modelTriangleCount?: number;
  isPreview: boolean;
  /** The classification the native loader already ran, for a single-body load. */
  bakedClassification?: MeshHealthReport;
};

async function loadStlViaTauri(filePath: string, classify: boolean): Promise<NativeStlLoadResult | null> {
  try {
    const bytes = await loadMeshFileFromNativePath(filePath, classify);
    if (!bytes || bytes.byteLength === 0) return null;
    const decoded = await decodeDfmx(bytes);
    const geometry = mergeBodyGeometries(decoded.bodies);

    console.log(
      `[loadStlGeometry] Native loader loaded ${decoded.previewTriangleCount.toLocaleString()} triangles ` +
      `(${(bytes.byteLength / 1_000_000).toFixed(0)} MB IPC transfer).`,
    );
    if (decoded.isPreview) {
      console.warn(
        `[loadStlGeometry] Using a reduced native preview: ` +
        `${decoded.originalTriangleCount.toLocaleString()} -> ` +
        `${decoded.previewTriangleCount.toLocaleString()} triangles.`,
      );
    }
    return {
      geometry,
      originalTriangleCount: decoded.originalTriangleCount,
      previewTriangleCount: decoded.previewTriangleCount,
      modelTriangleCount: decoded.modelTriangleCount,
      isPreview: decoded.isPreview,
      bakedClassification: decoded.report,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[loadStlGeometry] Native STL loading failed.', error);
    void logToNativeFile('error', `[loadStlGeometry] Native STL loading failed: ${message}`);
    throw new Error(message || 'Native STL loading failed.');
  }
}

// ---------------------------------------------------------------------------
// DFMX — the multi-body native payload. The layout is specified in
// docs/dev/mesh-wire-formats.md; keep these offsets in step with it.
// ---------------------------------------------------------------------------
const MESH_RESPONSE_HEADER_BYTES = 32;
const MESH_RESPONSE_BODY_ENTRY_BYTES = 8;
const SOUP_BYTES_PER_TRIANGLE = 9 * Float32Array.BYTES_PER_ELEMENT * 2;
/**
 * Version 2: each body is a zlib stream holding that body's soup (positions, then
 * one normal per corner). A scene's payloads are 910 MB across thirteen models, and
 * the channel only does ~75 MB/s effective during an import because the transfer
 * and the main thread that receives each model take turns — the volume is what the
 * load pays. The native encoder packs each body at zlib level 1 (2.7x on real
 * geometry) and the bodies are unpacked here with the platform's
 * `DecompressionStream`, off the main thread.
 */
const MESH_RESPONSE_VERSION = 2;
/** Bodies unpacked at once: 52-129 MB each once inflated, so not all at once. */
const BODY_INFLATE_CONCURRENCY = 4;

/** One decoded native payload: its bodies plus the header facts the STL preview
 *  path needs. */
export type DecodedMesh = {
  bodies: THREE.BufferGeometry[];
  /** The payload's preview bit: the body (or bodies) are a decimation. */
  isPreview: boolean;
  /** Triangles in the file the payload was made from. */
  originalTriangleCount: number;
  /** Triangles actually in this payload. */
  previewTriangleCount: number;
  /** Model-section triangles for a preview, when the loader classified them. */
  modelTriangleCount?: number;
  /** The classification report the loader produced for a single-body load, when
   *  it did. Passing this to `processGeometry` skips the native classify pass. */
  report?: MeshHealthReport;
  /** The mesh the loader kept for this payload's AO bake, when it kept one (a
   *  single-body load). The bake asks for it by token instead of being sent the
   *  soup back: 36 bytes a triangle, 430 MB across a scene. 0 or absent means the
   *  caller sends the soup, which is what every other geometry does. */
  meshToken?: number;
};

/**
 * Unpack one packed body into its geometry.
 *
 * The stream is the platform's own decompressor — genuinely off the main thread,
 * unlike `fflate`'s pool, which waits on its workers through `SharedArrayBuffer` in
 * a `crossOriginIsolated` webview and blocks the thread it should free. Its output
 * is a fresh `ArrayBuffer`, so the geometry can view it directly rather than copying
 * the soup again.
 */
async function decodeBody(packed: Uint8Array, triangleCount: number): Promise<THREE.BufferGeometry> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      // `BufferSource` wants an `ArrayBuffer`-backed view; the bytes are the same.
      controller.enqueue(packed as BufferSource);
      controller.close();
    },
  });
  const stream = source.pipeThrough<Uint8Array>(new DecompressionStream('deflate'));
  const soup = new Uint8Array(await new Response(stream).arrayBuffer());
  const expected = triangleCount * SOUP_BYTES_PER_TRIANGLE;
  if (soup.byteLength !== expected) {
    throw new Error(
      `Native mesh loader returned a body that unpacks to ${soup.byteLength} bytes, ` +
      `not the ${expected} its table entry claims.`,
    );
  }
  const corners = triangleCount * 9;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(soup.buffer, soup.byteOffset, corners), 3),
  );
  geometry.setAttribute(
    'normal',
    new THREE.BufferAttribute(
      new Float32Array(soup.buffer, soup.byteOffset + corners * Float32Array.BYTES_PER_ELEMENT, corners),
      3,
    ),
  );
  return geometry;
}

/**
 * Decode a DFMX payload into one geometry per body.
 *
 * Each body arrives packed (version 2) and is unpacked four at a time; the packed
 * bytes are views into the payload buffer, which belongs to this call — Tauri's IPC
 * is a `fetch` against a custom-protocol URL (`tauri`'s `ipc-protocol.js`), so
 * `response.arrayBuffer()` hands back a buffer nothing reuses or shortens.
 */
export async function decodeDfmx(payload: Uint8Array | ArrayBuffer): Promise<DecodedMesh> {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.byteLength < MESH_RESPONSE_HEADER_BYTES) {
    throw new Error('Native mesh loader returned a truncated DFMX header.');
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(
    header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3),
  );
  if (magic !== 'DFMX') {
    throw new Error(`Native mesh loader returned an unsupported payload (${magic}).`);
  }
  if (header.getUint32(4, true) !== MESH_RESPONSE_VERSION) {
    throw new Error('Native mesh loader returned an unsupported DFMX version.');
  }

  const bodyCount = header.getUint32(12, true);
  // The table first: each entry carries the body's triangle count and the length of
  // its packed stream, so the bodies no longer follow from the header alone.
  let offset = MESH_RESPONSE_HEADER_BYTES + bodyCount * MESH_RESPONSE_BODY_ENTRY_BYTES;
  const table: Array<{ index: number; triangleCount: number; packed: Uint8Array }> = [];
  for (let index = 0; index < bodyCount; index += 1) {
    const entry = MESH_RESPONSE_HEADER_BYTES + index * MESH_RESPONSE_BODY_ENTRY_BYTES;
    const triangleCount = header.getUint32(entry, true);
    const packedBytes = header.getUint32(entry + 4, true);
    if (offset + packedBytes > bytes.byteLength) {
      throw new Error('Native mesh loader returned a truncated DFMX body.');
    }
    table.push({ index, triangleCount, packed: bytes.subarray(offset, offset + packedBytes) });
    offset += packedBytes;
  }

  const bodies = new Array<THREE.BufferGeometry>(bodyCount);
  await runWithConcurrency(table, BODY_INFLATE_CONCURRENCY, async (body) => {
    bodies[body.index] = await decodeBody(body.packed, body.triangleCount);
  });
  const previewTriangleCount = table.reduce((sum, body) => sum + body.triangleCount, 0);

  const meshToken = header.getUint32(28, true);
  const modelTriangleCount = header.getUint32(20, true);
  const metadataLength = header.getUint32(24, true);
  let report: MeshHealthReport | undefined;
  if (metadataLength > 0 && metadataLength <= bytes.byteLength) {
    const json = new TextDecoder().decode(bytes.subarray(bytes.byteLength - metadataLength));
    try {
      report = JSON.parse(json) as MeshHealthReport;
    } catch (error) {
      // A report we cannot read is not worth failing the mesh over: dropping it
      // sends the caller back to the staging classify pass, which is correct.
      console.warn('[loadMeshFile] could not parse the native classification report.', error);
    }
  }

  return {
    bodies,
    isPreview: (header.getUint32(8, true) & 1) !== 0,
    originalTriangleCount: header.getUint32(16, true),
    previewTriangleCount,
    modelTriangleCount: modelTriangleCount > 0 ? modelTriangleCount : undefined,
    ...(meshToken > 0 ? { meshToken } : {}),
    report,
  };
}

/**
 * Load every body of a mesh file natively. Tauri with an on-disk path only;
 * returns null everywhere else (and on any failure) so the caller falls back to
 * the renderer's own loaders.
 */
async function loadNativeMeshBodies(filePath: string | undefined): Promise<THREE.BufferGeometry[] | null> {
  if (!isTauriRuntime()) return null;
  if (!filePath) {
    // The native loader reads from disk, so a File with no path — a zip entry or
    // a synthesized file — can only go through the renderer's own loaders.
    console.warn('[loadMeshFile] no on-disk path for this file; using the renderer loaders.');
    void logToNativeFile('warn', '[loadMeshFile] no on-disk path for this file; using the renderer loaders.');
    return null;
  }
  try {
    // This path does not consume the report yet, so do not pay for the classify.
    const decoded = await decodeDfmx(await loadMeshFileFromNativePath(filePath, false));
    if (decoded.bodies.length === 0) return null;
    console.log(
      `[${new Date().toISOString()}] [loadMeshFile] native loader returned ${decoded.bodies.length} bodies`,
    );
    return decoded.bodies;
  } catch (error) {
    console.warn('[loadMeshFile] native mesh load failed; falling back to the renderer loaders.', error);
    void logToNativeFile('warn', `[loadMeshFile] native mesh load failed; using the renderer loaders: ${String(error)}`);
    return null;
  }
}

/**
 * Whether this import wants the loader's classification.
 *
 * A classify-only import does: it has nothing else to run. One that may
 * auto-repair does not, because that pass classifies too. Nor does a mesh already
 * known to be support-only, which skips classification entirely. Nor, finally,
 * one whose report is *already in hand*: a VOXL scene stores a classification per
 * model (V3.3), and paying the loader's whole pass — 0.6-1.7 s on a
 * million-triangle model, measured on a 13-model scene where it was the largest
 * single cost — to replace the stored answer with an identical one is the wrong
 * trade. {@link classificationForPayload} still checks the stored report against
 * the payload that comes back, and drops it when the two do not fit.
 */
function wantsLoaderClassification(options: ProcessGeometryOptions): boolean {
  if (options.skipClassification) return false;
  if (options.bakedClassification) return false;
  const mode = options.nativeProcessingMode ?? 'auto';
  return mode === 'none' || mode === 'classify-only';
}

/**
 * Whether a model-only import may skip the native pass.
 *
 * {@link ProcessGeometryOptions.skipClassification} suppresses repair as well as
 * classification, so a mesh that carries no support section can only claim it
 * while the import is not auto-repairing. A LYS scene supplies its supports
 * separately and is not pre-repaired, which is the case this separates.
 */
export function skipsNativePassForModelOnly(
  modelOnly: boolean,
  autoRepair: boolean,
): boolean {
  return modelOnly && !autoRepair;
}

/**
 * The classification report that describes the payload the loader just produced.
 *
 * The loader's own report when it classified, since it describes exactly what it
 * built. Otherwise a caller's stored one — a VOXL model carries the report its
 * file was written with, and the format requires a reader that honours it *not*
 * to re-run the classifier — but only while it still addresses this payload:
 * `reportAddressesTriangleSoup` compares the boundary's `post.triangle_count`,
 * the mesh the pass ended with, against the triangles just loaded. Refinement is
 * deterministic but versioned, and a section boundary is a triangle index, so a
 * file written under a different refinement rule describes a mesh this build does
 * not produce.
 *
 * A split boundary in a stored report is honoured as written. The writer's rule
 * (same document) is that a report is stamped only when that same predicate holds
 * for the bytes it stores — and the classifier reorders the mesh as it reports —
 * so the payload is in the order the boundary addresses, and the sections can be
 * sliced by count alone.
 *
 * Dropping the report is safe: prep falls back to the classify pass, which is a
 * round trip and the cost this reuse exists to avoid, paid only by a file whose
 * refinement no longer matches the app's.
 */
export function classificationForPayload(
  loaderReport: MeshHealthReport | undefined,
  storedReport: MeshHealthReport | undefined,
  triangles: number,
): MeshHealthReport | undefined {
  if (loaderReport) return loaderReport;
  if (!storedReport) return undefined;
  if (!reportAddressesTriangleSoup(storedReport, triangles)) {
    console.warn(
      `[loadMeshFile] Ignoring the stored mesh classification: its boundary addresses ` +
      `${storedReport.post.triangle_count} triangles and this mesh has ${triangles}. Running the classify pass.`,
    );
    return undefined;
  }
  return storedReport;
}

/** The byte-source twin of {@link loadNativeMeshBodies}: null means fall back. */
async function loadNativeMeshBytes(
  buffer: Uint8Array,
  classify: boolean,
  refine: boolean,
): Promise<DecodedMesh | null> {
  if (!isTauriRuntime()) return null;
  try {
    // The phase nobody else can see, and the one a scene of print-sized models
    // waits on. "Round trip", not "transfer": the window contains the native
    // command too (parse, refine and encode, whose duration the Rust log line has
    // on its own). The wire is not the problem — measured with a plain
    // `read_print_file_bytes` from the page, it delivers 110-135 MB/s with about
    // 3 ms of latency — so the interesting half of this number is the native side.
    // Logged to the file as well: it is what the import is argued with.
    const requested = performance.now();
    const payload = await loadMeshBytes(buffer, classify, refine);
    const received = performance.now();
    const decoded = await decodeDfmx(payload);
    const timing =
      `[loadMeshFile] native payload ${(payload.byteLength / 1_000_000).toFixed(1)} MB, ` +
      `round trip ${(received - requested).toFixed(0)}ms including the native load ` +
      `(${decoded.bodies.length} bodies, ${decoded.previewTriangleCount.toLocaleString()} triangles)`;
    console.log(timing);
    void logToNativeFile('info', timing);
    return decoded.bodies.length > 0 ? decoded : null;
  } catch (error) {
    console.warn('[loadMeshFile] native byte load failed; falling back to the renderer loaders.', error);
    void logToNativeFile('warn', `[loadMeshFile] native byte load failed; using the renderer loaders: ${String(error)}`);
    return null;
  }
}

/**
 * Load a mesh from a byte range of a file on disk, natively.
 *
 * The VOXL twin of the byte-source loader: the container already told us where each
 * model's mesh chunk sits, so the native side reads and inflates it and nothing
 * crosses the IPC until the finished `DFMX` payload comes back. Same payload, same
 * decode, same prep as every other native load — which is what keeps the two paths
 * from drifting.
 */
export async function loadMeshGeometryFromRange(
  sourcePath: string,
  range: VoxlMeshRange,
  fileName: string | undefined,
  options: ProcessGeometryOptions = {},
): Promise<GeometryWithBounds> {
  const payload = await loadMeshRangeFromNativePath({
    sourcePath,
    offset: range.offset,
    compressedSize: range.compressedSize,
    compression: range.compression,
    classify: wantsLoaderClassification(options),
    refine: options._refine !== false,
  });
  const decoded = await decodeDfmx(payload);
  const merged = mergeBodyGeometries(decoded.bodies);
  // Before prep, while `merged` is still the loader's soup: a classify or repair pass
  // below replaces the position attribute, and the token has to go stale with it.
  if (decoded.meshToken) rememberLoadedMeshMesh(merged, decoded.meshToken);
  return processGeometry(merged, {
    ...options,
    _skipComputeNormals: true,
    bakedClassification: classificationForPayload(
      decoded.report,
      options.bakedClassification,
      decoded.previewTriangleCount,
    ),
  });
}
/** Merge native bodies into one geometry, preserving their relative positions. */
function mergeBodyGeometries(bodies: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (bodies.length === 1) return bodies[0];
  const merged = mergeGeometries(bodies, false);
  if (!merged) throw new Error('Failed to merge mesh bodies.');
  return merged;
}

export async function loadStlGeometry(fileUrl: string, options: ProcessGeometryOptions = {}): Promise<GeometryWithBounds> {
  // In Tauri with a file path, use the Rust-side STL parser.
  // It reads the file directly from disk, computes normals, and avoids
  // holding the raw STL bytes in webview memory — critical for huge files.
  if (isTauriRuntime() && options.filePath) {
    // A classify-only import has nothing left to run: ask the loader to classify
    // so it ships the report and the geometry already section-ordered, rather
    // than staging the mesh back for the same answer.
    const nativeResult = await loadStlViaTauri(options.filePath, wantsLoaderClassification(options));
    if (nativeResult) {
      // Normals are already computed — skip computeVertexNormals in processGeometry
      const processed = await processGeometry(nativeResult.geometry, {
        ...options,
        _skipComputeNormals: true,
        _isNativePreview: nativeResult.isPreview,
        _nativeModelTriangleCount: nativeResult.modelTriangleCount,
        // The loader's report when it classified, the caller's stored one when it
        // still fits this payload, and nothing when neither holds: that last case
        // is what sends prep down the classify pass.
        bakedClassification: classificationForPayload(
          nativeResult.bakedClassification,
          options.bakedClassification,
          nativeResult.previewTriangleCount,
        ),
        ...(nativeResult.isPreview ? { nativeProcessingMode: 'none' as const } : {}),
      });
      if (nativeResult.isPreview) {
        processed.nativePreview = {
          originalTriangleCount: nativeResult.originalTriangleCount,
          previewTriangleCount: nativeResult.previewTriangleCount,
        };
      }
      return processed;
    }
  }

  // Try streaming binary STL parser — avoids holding the entire file as ArrayBuffer
  const streamed = await loadStlBinaryStreaming(fileUrl);
  if (streamed) {
    console.log(`[${new Date().toISOString()}] [loadStlGeometry] Streaming parser succeeded, processing geometry.`);
    return processGeometry(streamed, options);
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
        processGeometry(bufferGeometry, options).then(resolve).catch(reject);
      },
      undefined,
      (error) => {
        reject(error);
      }
    );
  });
}

/**
 * Parse a complete binary STL already in memory and prepare it for the scene.
 *
 * This is where a VOXL scene's embedded mesh arrives: the MESH chunk is the
 * original STL bytes, and `loadMeshGeometry` routes them here rather than to the
 * native file loaders. Those refine coarse faces and return face normals as they
 * read; a buffer parsed by three does neither, so the same command the plugin
 * import asks is asked here, and only when the mesh is small enough for the round
 * trip to be free (see `REFINE_MAX_TRIANGLES`). The command returns the normals
 * with the payload, which is why the caller then has to skip
 * `computeVertexNormals`.
 */
export async function loadStlGeometryFromBuffer(buffer: Uint8Array, options: ProcessGeometryOptions = {}): Promise<GeometryWithBounds> {
  // Native first when there is one: a single round trip parses, refines and
  // classifies the bytes, where the renderer path parses in JS and then stages the
  // mesh back for the classifier. A VOXL model or a file out of a zip arrives as
  // bytes, so it never has a path for `load_mesh_file` to use.
  const decoded = await loadNativeMeshBytes(
    buffer,
    wantsLoaderClassification(options),
    options._refine !== false,
  );
  if (decoded) {
    return processGeometry(mergeBodyGeometries(decoded.bodies), {
      ...options,
      _skipComputeNormals: true,
      bakedClassification: classificationForPayload(
        decoded.report,
        options.bakedClassification,
        decoded.previewTriangleCount,
      ),
    });
  }

  const loader = new STLLoader();
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const source = loader.parse(arrayBuffer);

  let geometry = source;
  let refined = false;
  if (shouldRefineCoarseFaces(source)) {
    try {
      const result = await refineCoarseFaces(source);
      if (result) {
        geometry = result;
        refined = true;
      }
    } catch (error) {
      console.warn('[loadStlGeometry] buffer geometry left unrefined', error);
    }
  }

  // No native decode here, so nothing produced a report to check the stored one
  // against — check it against what three parsed: the same rule the native paths
  // apply, because a boundary that does not address these triangles would slice them
  // at the wrong index. Dropping it just means the classify pass runs.
  const position = geometry.getAttribute('position');
  const triangles = Math.floor((geometry.getIndex()?.count ?? position?.count ?? 0) / 3);
  return processGeometry(geometry, {
    ...options,
    ...(refined ? { _skipComputeNormals: true } : {}),
    bakedClassification: classificationForPayload(undefined, options.bakedClassification, triangles),
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
    // Its unzip worker swallows any error and never answers, so a file it cannot
    // open hangs the import instead of failing it. An empty one is the case seen.
    if (buffer.byteLength === 0) throw new Error('3MF file is empty.');

    const loader = new Fast3MFLoader();
    const data3mf = await loader.parse(buffer);
    const group = fast3mfBuilder(data3mf);

    if (group && group.type === 'Group' && group.children.length > 0) {
      return group;
    }
    return null;
  } catch (fastError) {
    console.warn('[load3mfGeometry] fast-3mf-loader failed; falling back to ThreeMFLoader.', fastError);
    void logToNativeFile('warn', `[load3mfGeometry] fast-3mf-loader failed; falling back to ThreeMFLoader: ${String(fastError)}`);
    return null;
  }
}

export async function load3mfGeometry(fileUrl: string, options?: ProcessGeometryOptions): Promise<GeometryWithBounds> {
  const nativeBodies = await loadNativeMeshBodies(options?.filePath);
  if (nativeBodies) {
    return processGeometry(mergeBodyGeometries(nativeBodies), options);
  }

  // Try the fast SAX/worker-based loader first for large archives
  const fastGroup = await tryLoadFast3mf(fileUrl);
  if (fastGroup) {
    console.log(`[${new Date().toISOString()}] [load3mfGeometry] fast-3mf-loader succeeded, processing geometry.`);
    try {
      const mergedGeometry = collectMergedGeometryFromObject3d(fastGroup, '3MF');
      return await processGeometry(mergedGeometry, options);
    } catch (error) {
      console.warn('[load3mfGeometry] fast-3mf-loader geometry processing failed; falling back to ThreeMFLoader.', error);
      void logToNativeFile('warn', `[load3mfGeometry] fast-3mf-loader geometry processing failed; falling back to ThreeMFLoader: ${String(error)}`);
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
      void logToNativeFile('warn', `[load3mfGeometryMulti] fast-3mf-loader geometry processing failed; falling back to ThreeMFLoader: ${String(error)}`);
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
  const nativeBodies = await loadNativeMeshBodies(options?.filePath);
  if (nativeBodies) {
    const merged = await processGeometry(mergeBodyGeometries(nativeBodies), options);
    // With one body the merged geometry *is* that body, and the split result is
    // discarded by the caller. Re-processing it would run prep (and the AO bake)
    // a second time on the same geometry.
    const splitBodies: GeometryWithBounds[] = [];
    if (nativeBodies.length > 1) {
      for (const body of nativeBodies) {
        splitBodies.push(await processGeometry(body, options));
      }
    }
    return { merged, splitBodies };
  }

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
      // One body means the merged geometry is that body, and the caller drops a
      // one-entry split list, so processing it again only re-runs prep and the bake.
      const splitBodies: GeometryWithBounds[] = [];
      if (rawGeoms.length > 1) {
        for (const raw of rawGeoms) {
          splitBodies.push(await processGeometry(raw, options));
        }
      }

      return { merged, splitBodies };
    } catch (error) {
      console.warn('[load3mfGeometryMerged] fast-3mf-loader failed; falling back to ThreeMFLoader.', error);
      void logToNativeFile('warn', `[load3mfGeometryMerged] fast-3mf-loader failed; falling back to ThreeMFLoader: ${String(error)}`);
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
          if (rawGeoms.length > 1) {
            for (const raw of rawGeoms) {
              splitBodies.push(await processGeometry(raw, options));
            }
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
  const nativeBodies = await loadNativeMeshBodies(options?.filePath);
  if (nativeBodies) {
    return processGeometry(mergeBodyGeometries(nativeBodies), options);
  }

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

export async function loadMeshGeometry(fileUrlOrBuffer: string | Uint8Array, fileName?: string, options?: ProcessGeometryOptions): Promise<GeometryWithBounds> {
  const opts = options?.skipClassification ? { ...options, nativeProcessingMode: 'none' as const } : options;
  
  if (fileUrlOrBuffer instanceof Uint8Array) {
    return loadStlGeometryFromBuffer(fileUrlOrBuffer, opts);
  }

  const fileUrl = fileUrlOrBuffer;
  const ext = (fileName ?? '').trim().toLowerCase();
  if (ext.endsWith('.3mf')) {
    return load3mfGeometry(fileUrl, opts);
  }
  if (ext.endsWith('.obj')) {
    return loadObjGeometry(fileUrl, opts);
  }
  return loadStlGeometry(fileUrl, opts);
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
