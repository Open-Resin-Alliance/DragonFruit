import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
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
  if (isTauriRuntime()) {
    const nativeMode = options.nativeProcessingMode ?? 'auto';
    const skipAutoNativeProcessingForSize = nativeMode === 'auto'
      && sourceTriangleEstimate >= AUTO_NATIVE_PROCESSING_TRIANGLE_THRESHOLD;

    if (nativeMode === 'none') {
      console.log('[processGeometry] Native processing skipped (mode=none)');
    } else if (skipAutoNativeProcessingForSize) {
      console.warn(
        `[processGeometry] Skipping native auto repair/classification for gigantic mesh (` +
        `${sourceTriangleEstimate.toLocaleString()} triangles). Use manual Repair to force.`
      );
    } else try {
      let classifyOnly = nativeMode === 'classify-only';
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

  console.log(`[${new Date().toISOString()}] [processGeometry] Computing Normals`);
  geometry.computeVertexNormals();

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

  console.log(`[${new Date().toISOString()}] [processGeometry] Computing Flattening Planes`);
  const startPlanes = performance.now();
  const flatteningPlanes = computeFlatteningPlanes(geometry);
  console.log(`[${new Date().toISOString()}] [processGeometry] Flattening Planes finished. Took ${(performance.now() - startPlanes).toFixed(2)}ms`);

  const shouldSurfaceDefects = meshDefects.hasDefects || meshDefects.nativeRepairReport != null;
  return { geometry, bbox, center, size, flatteningPlanes, ...(shouldSurfaceDefects ? { meshDefects } : {}) };
}

export async function loadStlGeometry(fileUrl: string, options?: ProcessGeometryOptions): Promise<GeometryWithBounds> {
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

export async function load3mfGeometry(fileUrl: string, options?: ProcessGeometryOptions): Promise<GeometryWithBounds> {
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
