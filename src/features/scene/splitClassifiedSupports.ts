import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { LoadedModel } from './useSceneCollectionManager';
import { accelerateGeometry } from '@/utils/bvh';
import { computeFlatteningPlanes } from '@/features/placeOnFace/logic/computeFlatteningPlanes';

/**
 * Ph3 (scene path) — does the native classification's `model_triangle_count`
 * index THIS geometry, or the file it came from?
 *
 * `model_triangle_count` is measured on the FULL-RESOLUTION source file
 * (`ImportClassificationJson` / `NativeStlLoadResult` state that contract). A
 * `nativePreview` geometry is a decimated stand-in for that file, so the count
 * addresses triangles this buffer does not contain — cutting at
 * `modelTriangleCount * 9` lands at an arbitrary offset.
 *
 * This is the same structural question `resolveOutputSectionPlan` asks on the
 * output path, and it is asked ONCE, here, because both paths must answer it
 * identically: the slice-time assertion in `sliceExportOrchestrator` refuses to
 * slice a model this predicate says is splittable but nobody split.
 *
 * Deliberately structural, not arithmetic. The pre-Ph3 output guard compared
 * the count against the geometry's own triangle count and bailed when the
 * former was larger; that happened to hold for the usual 11M-file-vs-2M-preview
 * shape and hid the real defect, so a preview whose model SECTION was smaller
 * than the preview itself would have been cut with complete confidence
 * (Ph2 finding F3).
 */
export function classificationIndexesGeometry(geometry: Pick<GeometryWithBounds, 'nativePreview'>): boolean {
  return !geometry.nativePreview;
}

export type ClassifiedSupportGeometrySplit = {
  modelGeometry: GeometryWithBounds;
  supportGeometry: GeometryWithBounds;
  modelPosition: THREE.Vector3;
  supportPosition: THREE.Vector3;
  modelTriangleCount: number;
  supportTriangleCount: number;
  totalTriangleCount: number;
};

function buildGeometryWithBounds(
  positions: Float32Array,
  triangleCount: number,
  interactive: boolean,
): GeometryWithBounds {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (interactive) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());

  if (!interactive) {
    return { geometry, bbox, center, size, flatteningPlanes: [] };
  }

  accelerateGeometry(geometry);
  const flatteningPlanes = triangleCount * 3 < 15_000_000
    ? computeFlatteningPlanes(geometry)
    : [];
  let edgeGeometry: THREE.EdgesGeometry | undefined;
  if (triangleCount < 2_000_000) {
    try {
      edgeGeometry = new THREE.EdgesGeometry(geometry, 30);
    } catch {
      // Edge geometry is optional for very large meshes.
    }
  }

  return { geometry, bbox, center, size, flatteningPlanes, edgeGeometry };
}

export function splitClassifiedSupportGeometry(
  source: LoadedModel,
  options: { interactive?: boolean } = {},
): ClassifiedSupportGeometrySplit | null {
  const modelTriangleCount = Math.floor(
    source.geometry.meshDefects?.nativeRepairReport?.model_triangle_count ?? 0,
  );
  if (modelTriangleCount <= 0) return null;

  // The count must index the buffer this function is about to slice. It does
  // not for a decimated preview — see `classificationIndexesGeometry`. Callers
  // gate on the same predicate (`resolveOutputSectionPlan`) so the affordance
  // is already off; this is the load-bearing refusal, not the message.
  if (!classificationIndexesGeometry(source.geometry)) return null;

  const geometry = source.geometry.geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!position) return null;

  const sourcePositions = position.array;
  const positions = sourcePositions instanceof Float32Array
    ? sourcePositions
    : new Float32Array(sourcePositions as unknown as ArrayLike<number>);
  const totalTriangleCount = Math.floor(positions.length / 9);
  const supportTriangleCount = totalTriangleCount - modelTriangleCount;
  if (supportTriangleCount <= 0) return null;

  const modelFloatEnd = modelTriangleCount * 9;
  if (modelFloatEnd >= positions.length) return null;

  // Native classification rewrites the position soup model-first. The
  // context-menu behavior that is known to work slices this storage directly;
  // an index may be attached later and must not redefine this boundary.
  const modelPositions = positions.slice(0, modelFloatEnd);
  const supportPositions = positions.slice(modelFloatEnd);
  const interactive = options.interactive === true;
  const modelGeometry = buildGeometryWithBounds(
    modelPositions,
    modelTriangleCount,
    interactive,
  );
  const supportGeometry = buildGeometryWithBounds(
    supportPositions,
    supportTriangleCount,
    interactive,
  );

  const originalCenter = source.geometry.center;
  const rotation = new THREE.Quaternion().setFromEuler(source.transform.rotation);
  const adjustedPosition = (partCenter: THREE.Vector3) => {
    const offset = partCenter.clone().sub(originalCenter);
    offset.multiply(source.transform.scale).applyQuaternion(rotation);
    return source.transform.position.clone().add(offset);
  };

  return {
    modelGeometry,
    supportGeometry,
    modelPosition: adjustedPosition(modelGeometry.center),
    supportPosition: adjustedPosition(supportGeometry.center),
    modelTriangleCount,
    supportTriangleCount,
    totalTriangleCount,
  };
}
