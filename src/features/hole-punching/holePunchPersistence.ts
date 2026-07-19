import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { ModelTransform } from '@/hooks/useModelTransform';
import type { ModelHolePunchPlacement } from '@/features/mesh-modifiers/types';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import {
  createHolePunchWorldFrame,
  normalizeDirectionTuple,
  type HolePunchPlacementState,
} from './holePunchGeometry';

export function toPersistedHolePunchPlacements(
  model: { geometry: GeometryWithBounds; transform?: ModelTransform },
  placements: HolePunchPlacementState[],
): ModelHolePunchPlacement[] {
  const geometry = model.geometry.geometry;
  const bbox = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as THREE.BufferAttribute,
  );
  const size = bbox.getSize(new THREE.Vector3());
  const toNorm = (value: number, min: number, span: number) => (span <= 1e-9 ? 0.5 : (value - min) / span);

  // When a model transform is available, derive localPoint/localNormal from
  // worldPoint/worldNormal at serialization time so they always stay consistent
  // with the model's current transform — even if the draft state has drifted
  // (e.g. after gizmo manipulation). When transform is unavailable (legacy
  // callers like hollow-apply that only pass a bare geometry), fall back to
  // the stored localPoint/localNormal in the draft state.
  let inverseModelMatrix: THREE.Matrix4 | null = null;
  let inverseNormalMatrix: THREE.Matrix3 | null = null;
  if (model.transform) {
    const meshMatrix = new THREE.Matrix4()
      .compose(
        model.transform.position.clone(),
        quaternionFromGlobalEuler(model.transform.rotation),
        model.transform.scale.clone(),
      )
      .multiply(new THREE.Matrix4().makeTranslation(
        -model.geometry.center.x,
        -model.geometry.center.y,
        -model.geometry.center.z,
      ));
    inverseModelMatrix = meshMatrix.clone().invert();

    const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshMatrix);
    inverseNormalMatrix = normalMatrix.clone().invert();
  }

  return placements.map((placement) => {
    let localPoint: THREE.Vector3;
    let localNormal: THREE.Vector3;
    if (inverseModelMatrix && inverseNormalMatrix) {
      // Derive from world-space values — always consistent with current transform.
      localPoint = placement.worldPoint.clone().applyMatrix4(inverseModelMatrix);
      localNormal = placement.worldNormal
        .clone()
        .applyMatrix3(inverseNormalMatrix)
        .normalize();
    } else {
      // Fallback: use stored values (legacy path).
      localPoint = placement.localPoint;
      localNormal = placement.localNormal;
    }

    const direction = normalizeDirectionTuple(localNormal.x, localNormal.y, localNormal.z);
    return {
      id: placement.id,
      centerNorm: [
        toNorm(localPoint.x, bbox.min.x, size.x),
        toNorm(localPoint.y, bbox.min.y, size.y),
        toNorm(localPoint.z, bbox.min.z, size.z),
      ],
      radiusMm: placement.radiusMm,
      radiusYMm: placement.radiusYMm,
      depthMm: placement.depthMm,
      direction,
      depthMode: placement.depthMode,
    };
  });
}

export function fromPersistedHolePunchPlacements(
  model: { id: string; geometry: GeometryWithBounds; transform: ModelTransform },
  persisted: ModelHolePunchPlacement[],
): HolePunchPlacementState[] {
  if (persisted.length === 0) return [];

  const bbox = model.geometry.bbox;
  const size = model.geometry.size;
  const toMm = (norm: number, min: number, span: number) => min + (norm * (span <= 1e-9 ? 0 : span));

  const meshMatrix = new THREE.Matrix4()
    .compose(
      model.transform.position.clone(),
      quaternionFromGlobalEuler(model.transform.rotation),
      model.transform.scale.clone(),
    )
    .multiply(new THREE.Matrix4().makeTranslation(
      -model.geometry.center.x,
      -model.geometry.center.y,
      -model.geometry.center.z,
    ));

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshMatrix);

  return persisted.map((placement) => {
    const localPoint = new THREE.Vector3(
      toMm(placement.centerNorm[0], bbox.min.x, size.x),
      toMm(placement.centerNorm[1], bbox.min.y, size.y),
      toMm(placement.centerNorm[2], bbox.min.z, size.z),
    );

    const localNormal = new THREE.Vector3(
      placement.direction[0],
      placement.direction[1],
      placement.direction[2],
    );
    if (localNormal.lengthSq() <= 1e-12) {
      localNormal.set(0, 0, -1);
    } else {
      localNormal.normalize();
    }

    const worldPoint = localPoint.clone().applyMatrix4(meshMatrix);
    const worldNormal = localNormal.clone().applyNormalMatrix(normalMatrix).normalize();
    const worldFrame = createHolePunchWorldFrame(worldNormal);

    return {
      id: placement.id,
      modelId: model.id,
      worldPoint,
      worldNormal,
      worldFrame,
      localPoint,
      localNormal,
      radiusMm: placement.radiusMm,
      radiusYMm: placement.radiusYMm,
      depthMm: placement.depthMm,
      depthMode: placement.depthMode ?? 'manual',
    };
  });
}

export function serializeHolePunchPlacements(placements: ModelHolePunchPlacement[]): string {
  const normalizePlacement = (placement: ModelHolePunchPlacement) => ({
    id: placement.id,
    centerNorm: placement.centerNorm.map((value) => Number(value.toFixed(6))),
    radiusMm: Number(placement.radiusMm.toFixed(4)),
    radiusYMm: placement.radiusYMm != null ? Number(placement.radiusYMm.toFixed(4)) : undefined,
    depthMm: Number(placement.depthMm.toFixed(4)),
    direction: placement.direction.map((value) => Number(value.toFixed(6))),
    depthMode: placement.depthMode ?? 'manual',
  });

  const sorted = [...placements]
    .map(normalizePlacement)
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify(sorted);
}

export function serializeSingleHolePunchPlacement(placement: ModelHolePunchPlacement): string {
  return JSON.stringify({
    id: placement.id,
    centerNorm: placement.centerNorm.map((value) => Number(value.toFixed(6))),
    radiusMm: Number(placement.radiusMm.toFixed(4)),
    radiusYMm: placement.radiusYMm != null ? Number(placement.radiusYMm.toFixed(4)) : undefined,
    depthMm: Number(placement.depthMm.toFixed(4)),
    direction: placement.direction.map((value) => Number(value.toFixed(6))),
    depthMode: placement.depthMode ?? 'manual',
  });
}
