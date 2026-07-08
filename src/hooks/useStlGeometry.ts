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
  isHeavyRepair,
  isTauriRuntime,
  repairFromGeometry,
  type MeshAnalysisJson,
  type MeshHealthReport,
} from '@/utils/meshRepair';

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
   * Return true to proceed with repair, false to skip repair and load as-is.
   * Only invoked when running under Tauri.
   */
  onConfirmHeavyRepair?: (analysis: MeshAnalysisJson) => Promise<boolean>;
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
  if (isTauriRuntime()) {
    const nativeMode = options.nativeProcessingMode ?? 'auto';
    const skipAutoNativeProcessingForSize = nativeMode === 'auto'
      && sourceTriangleEstimate >= AUTO_NATIVE_PROCESSING_TRIANGLE_THRESHOLD;

    if (nativeMode === 'none') {
      console.log('[processGeometry] Native repair skipped (mode=none) — running classification for support geometry detection');
    }

    if (skipAutoNativeProcessingForSize) {
      console.warn(
        `[processGeometry] Skipping native auto repair/classification for gigantic mesh (` +
        `${sourceTriangleEstimate.toLocaleString()} triangles). Use manual Repair to force.`
      );
    } else try {
      let classifyOnly = nativeMode === 'classify-only' || nativeMode === 'none';
      const forceRepair = nativeMode === 'repair';

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
            const confirmed = await options.onConfirmHeavyRepair(analysis);
            if (!confirmed) {
              console.log('[processGeometry] User declined heavy repair — running classify-only shell split pass.');
              classifyOnly = true;
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
      const result = classifyOnly
        ? await classifyFromGeometry(geometry)
        : await repairFromGeometry(geometry);
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

        // If the repaired mesh has a model/support split, extract the support
        // section as a separate geometry for orange overlay rendering.
        const positionsWereApplied = shouldApplyPositions;

        if (positionsWereApplied && report.model_triangle_count != null && report.model_triangle_count > 0) {
          const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
          const allPos = posAttr.array as Float32Array;
          const modelFloatEnd = report.model_triangle_count * 9; // 3 vertices × 3 floats per tri
          if (modelFloatEnd < allPos.length) {
            const supportPositions = allPos.slice(modelFloatEnd);
            const supportGeo = new THREE.BufferGeometry();
            supportGeo.setAttribute('position', new THREE.BufferAttribute(supportPositions, 3));
            supportGeo.computeVertexNormals();
            meshDefects = { ...meshDefects, supportSectionGeometry: supportGeo };
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
};

async function loadStlViaTauri(filePath: string): Promise<NativeStlLoadResult | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const bytes = await invoke<ArrayBuffer>('load_stl_file', { filePath });
    if (!bytes || bytes.byteLength === 0) return null;

    if (bytes.byteLength < 16) return null;
    const header = new DataView(bytes, 0, 16);
    const hasMagic = header.getUint8(0) === 0x44
      && header.getUint8(1) === 0x46
      && header.getUint8(2) === 0x53
      && header.getUint8(3) === 0x54;
    if (!hasMagic) throw new Error('Native STL loader returned an unsupported response.');

    const flags = header.getUint32(4, true);
    const originalTriangleCount = header.getUint32(8, true);
    const previewTriangleCount = header.getUint32(12, true);
    const expectedBytes = 16 + previewTriangleCount * 18 * Float32Array.BYTES_PER_ELEMENT;
    if (previewTriangleCount === 0 || bytes.byteLength !== expectedBytes) {
      throw new Error('Native STL loader returned a truncated response.');
    }

    const positions = new Float32Array(bytes, 16, previewTriangleCount * 9);
    const normals = new Float32Array(
      bytes,
      16 + previewTriangleCount * 9 * Float32Array.BYTES_PER_ELEMENT,
      previewTriangleCount * 9,
    );

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
    return {
      geometry,
      originalTriangleCount,
      previewTriangleCount,
      isPreview: (flags & 1) !== 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[loadStlGeometry] Tauri Rust parser failed.', error);
    throw new Error(message || 'Native STL loading failed.');
  }
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
