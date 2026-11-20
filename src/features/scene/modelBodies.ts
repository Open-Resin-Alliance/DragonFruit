import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { computeFlatteningPlanes } from '@/features/placeOnFace/logic/computeFlatteningPlanes';
import { buildModelEdgeGeometry, type GeometryWithBounds } from '@/hooks/useStlGeometry';
import { countTriangles } from '@/utils/geometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import type { LoadedModel } from './useSceneCollectionManager';

export type RemoveModelBodiesResult =
  | { kind: 'unchanged' }
  | { kind: 'emptied' }
  | { kind: 'updated'; model: LoadedModel };

/** Merges body geometries on the attributes they all share, so a body with an extra attribute cannot fail the merge. */
function mergeBodyGeometries(bodies: GeometryWithBounds[]): THREE.BufferGeometry | null {
  const parts = bodies.map((body) => body.geometry);
  const indexed = parts.every((part) => part.index !== null);
  const sources = indexed ? parts : parts.map((part) => (part.index ? part.toNonIndexed() : part));
  const names = Object.keys(sources[0].attributes)
    .filter((name) => sources.every((part) => part.getAttribute(name) !== undefined));
  const prepared = sources.map((part) => {
    const view = new THREE.BufferGeometry();
    if (indexed && part.index) view.setIndex(part.index);
    for (const name of names) view.setAttribute(name, part.getAttribute(name));
    return view;
  });
  return mergeGeometries(prepared, false);
}

function boundsCenter(geometry: THREE.BufferGeometry): THREE.Vector3 {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  return geometry.boundingBox?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
}

function geometryWithBounds(geometry: THREE.BufferGeometry, computeEdgeGeometry: boolean): GeometryWithBounds {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();
  const flatteningPlanes = countTriangles(geometry) * 3 < 15_000_000 ? computeFlatteningPlanes(geometry) : [];
  return {
    geometry,
    bbox,
    center: bbox.getCenter(new THREE.Vector3()),
    size: bbox.getSize(new THREE.Vector3()),
    flatteningPlanes,
    ...(computeEdgeGeometry ? { edgeGeometry: buildModelEdgeGeometry(geometry) } : {}),
  };
}

/** Removes bodies from a multi-body 3MF model, rebuilding its mesh from the rest without moving them. */
export function removeModelBodies(
  model: LoadedModel,
  bodyIndices: readonly number[],
  options: { computeEdgeGeometry?: boolean } = {},
): RemoveModelBodiesResult {
  const bodies = model.splitBodies;
  if (!bodies || bodies.length < 2) return { kind: 'unchanged' };
  const removed = new Set(bodyIndices.filter((index) => Number.isInteger(index) && index >= 0 && index < bodies.length));
  if (removed.size === 0) return { kind: 'unchanged' };

  const kept = bodies.map((_, index) => index).filter((index) => !removed.has(index));
  if (kept.length === 0) return { kind: 'emptied' };

  const keptBodies = kept.map((index) => bodies[index]);
  let geometry: GeometryWithBounds;
  if (keptBodies.length === 1) {
    const [body] = keptBodies;
    geometry = options.computeEdgeGeometry && !body.edgeGeometry
      ? { ...body, edgeGeometry: buildModelEdgeGeometry(body.geometry) }
      : body;
  } else {
    const merged = mergeBodyGeometries(keptBodies);
    if (!merged) return { kind: 'unchanged' };
    geometry = geometryWithBounds(merged, options.computeEdgeGeometry === true);
  }

  // The renderer centres a mesh on its bounds, so the model follows the bounds centre.
  const shift = boundsCenter(geometry.geometry).sub(boundsCenter(model.geometry.geometry))
    .multiply(model.transform.scale)
    .applyQuaternion(quaternionFromGlobalEuler(model.transform.rotation));
  const transform = {
    position: model.transform.position.clone().add(shift),
    rotation: model.transform.rotation.clone(),
    scale: model.transform.scale.clone(),
  };
  const polygonCount = keptBodies.reduce(
    (total, body) => total + (body.nativePreview?.originalTriangleCount ?? countTriangles(body.geometry)),
    0,
  );

  if (kept.length === 1) {
    const [index] = kept;
    const materialProfileId = model.bodyMaterialProfileIds?.[index] ?? model.materialProfileId;
    const plain: LoadedModel = {
      ...model,
      geometry,
      transform,
      polygonCount,
      color: model.bodyColors?.[index] ?? model.color,
      ...(materialProfileId ? { materialProfileId } : {}),
    };
    delete plain.splitBodies;
    delete plain.bodyMaterialProfileIds;
    delete plain.bodyColors;
    return { kind: 'updated', model: plain };
  }

  return {
    kind: 'updated',
    model: {
      ...model,
      geometry,
      transform,
      polygonCount,
      splitBodies: keptBodies,
      ...(model.bodyMaterialProfileIds ? { bodyMaterialProfileIds: kept.map((index) => model.bodyMaterialProfileIds?.[index]) } : {}),
      ...(model.bodyColors ? { bodyColors: kept.map((index) => model.bodyColors?.[index]) } : {}),
    },
  };
}
