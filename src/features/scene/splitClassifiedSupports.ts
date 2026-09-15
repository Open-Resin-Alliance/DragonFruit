import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { buildModelEdgeGeometry } from '@/hooks/useStlGeometry';
import type { LoadedModel } from './useSceneCollectionManager';
import { accelerateGeometry } from '@/utils/bvh';
import { computeFlatteningPlanes } from '@/features/placeOnFace/logic/computeFlatteningPlanes';

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
  computeEdgeGeometry: boolean,
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
  const edgeGeometry = computeEdgeGeometry ? buildModelEdgeGeometry(geometry) : undefined;

  return { geometry, bbox, center, size, flatteningPlanes, edgeGeometry };
}

export function splitClassifiedSupportGeometry(
  source: LoadedModel,
  options: { interactive?: boolean; computeEdgeGeometry?: boolean } = {},
): ClassifiedSupportGeometrySplit | null {
  const modelTriangleCount = Math.floor(
    source.geometry.meshDefects?.nativeRepairReport?.model_triangle_count ?? 0,
  );
  if (modelTriangleCount <= 0) return null;

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
  const computeEdgeGeometry = options.computeEdgeGeometry === true;
  const modelGeometry = buildGeometryWithBounds(
    modelPositions,
    modelTriangleCount,
    interactive,
    computeEdgeGeometry,
  );
  const supportGeometry = buildGeometryWithBounds(
    supportPositions,
    supportTriangleCount,
    interactive,
    computeEdgeGeometry,
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
