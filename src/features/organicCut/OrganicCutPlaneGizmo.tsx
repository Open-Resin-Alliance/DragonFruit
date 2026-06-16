import React, { useCallback, useMemo } from 'react';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { ScreenSpaceGizmo } from '@/components/gizmo';
import type { GizmoAxis } from '@/components/gizmo';

export interface OrganicCutPlaneGizmoProps {
  /** All loaded models. */
  models: LoadedModel[];
  /** The active model's id. */
  activeModelId: string | null;
  /** The active model's transform (plate position/rotation/scale). */
  activeTransform?: ModelTransform;
  /** Bounded plane position in model-local space. */
  planePosition: [number, number, number];
  /** Bounded plane rotation in model-local space (radians, XYZ order). */
  planeRotation: [number, number, number];
  /** Bounded plane radius. */
  radius: number;
  /** Callback when position or rotation changes in local space. */
  onPlaneTransformChange: (position: [number, number, number], rotation: [number, number, number]) => void;
  /** Callback when radius changes. */
  onRadiusChange: (radius: number) => void;
  /** Notifies the host that a gizmo drag started/ended. */
  onDragStateChange?: (dragging: boolean) => void;
}

export function OrganicCutPlaneGizmo({
  models,
  activeModelId,
  activeTransform,
  planePosition,
  planeRotation,
  radius,
  onPlaneTransformChange,
  onRadiusChange,
  onDragStateChange,
}: OrganicCutPlaneGizmoProps) {
  const activeModel = useMemo(
    () => models.find((m) => m.id === activeModelId),
    [models, activeModelId],
  );
  const transform = activeTransform ?? activeModel?.transform;

  // Inner mesh offset (same as StlMesh/OrganicCutKeyGizmo)
  const meshLocalOffset = useMemo(() => {
    if (!activeModel) return new THREE.Vector3();
    const geometry = activeModel.geometry.geometry;
    const bbox =
      geometry.boundingBox ??
      new THREE.Box3().setFromBufferAttribute(
        geometry.getAttribute('position') as THREE.BufferAttribute,
      );
    const center = bbox.getCenter(new THREE.Vector3());
    return new THREE.Vector3(-center.x, -center.y, -center.z);
  }, [activeModel]);

  // Transform snapshot primitives for cache stability
  const tpx = transform?.position.x ?? 0;
  const tpy = transform?.position.y ?? 0;
  const tpz = transform?.position.z ?? 0;
  const trx = transform?.rotation.x ?? 0;
  const try_ = transform?.rotation.y ?? 0;
  const trz = transform?.rotation.z ?? 0;
  const tsx = transform?.scale.x ?? 1;
  const tsy = transform?.scale.y ?? 1;
  const tsz = transform?.scale.z ?? 1;
  const hasTransform = !!transform;

  // Local to world matrix and decomposed world coordinates for the plane
  const worldTransform = useMemo(() => {
    if (!transform) return null;

    const modelQuat = quaternionFromGlobalEuler(transform.rotation);
    const outer = new THREE.Matrix4().compose(
      new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
      modelQuat,
      new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
    );
    const inner = new THREE.Matrix4().makeTranslation(
      meshLocalOffset.x,
      meshLocalOffset.y,
      meshLocalOffset.z,
    );
    const localToWorld = outer.multiply(inner);

    // Create local plane matrix
    const localPlaneMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...planePosition),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...planeRotation, 'XYZ')),
      new THREE.Vector3(1, 1, 1),
    );

    const worldMatrix = localToWorld.clone().multiply(localPlaneMatrix);
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    worldMatrix.decompose(worldPos, worldQuat, worldScale);

    const worldEuler = new THREE.Euler().setFromQuaternion(worldQuat);

    return {
      localToWorld,
      worldPos,
      worldQuat,
      worldEuler,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planePosition, planeRotation, meshLocalOffset, hasTransform, tpx, tpy, tpz, trx, try_, trz, tsx, tsy, tsz]);

  const handleGizmoMove = useCallback(
    (delta: THREE.Vector3) => {
      if (!worldTransform) return;
      const { localToWorld, worldPos, worldQuat } = worldTransform;

      // Translate world position
      const newWorldPos = worldPos.clone().add(delta);

      // Re-compose new world matrix (no rotation change during translation)
      const newWorldMatrix = new THREE.Matrix4().compose(
        newWorldPos,
        worldQuat,
        new THREE.Vector3(1, 1, 1),
      );

      // Convert back to local space
      const localToWorldInv = localToWorld.clone().invert();
      const newLocalMatrix = localToWorldInv.multiply(newWorldMatrix);
      const newLocalPos = new THREE.Vector3();
      const newLocalQuat = new THREE.Quaternion();
      const newLocalScale = new THREE.Vector3();
      newLocalMatrix.decompose(newLocalPos, newLocalQuat, newLocalScale);

      onPlaneTransformChange(
        [newLocalPos.x, newLocalPos.y, newLocalPos.z],
        [planeRotation[0], planeRotation[1], planeRotation[2]],
      );
    },
    [worldTransform, planeRotation, onPlaneTransformChange],
  );

  const handleGizmoRotate = useCallback(
    (axis: GizmoAxis, angle: number) => {
      if (!worldTransform) return;
      const { localToWorld, worldPos, worldQuat } = worldTransform;

      // Define local axis of rotation
      const localAxis = new THREE.Vector3(
        axis === 'x' ? 1 : 0,
        axis === 'y' ? 1 : 0,
        axis === 'z' ? 1 : 0,
      );

      // Transform local axis to world space axis of the gizmo
      const worldAxis = localAxis.clone().applyQuaternion(worldQuat).normalize();
      const rotationQuat = new THREE.Quaternion().setFromAxisAngle(worldAxis, angle);
      const newWorldQuat = rotationQuat.multiply(worldQuat);

      // Re-compose new world matrix
      const newWorldMatrix = new THREE.Matrix4().compose(
        worldPos,
        newWorldQuat,
        new THREE.Vector3(1, 1, 1),
      );

      // Convert back to local space
      const localToWorldInv = localToWorld.clone().invert();
      const newLocalMatrix = localToWorldInv.multiply(newWorldMatrix);
      const newLocalPos = new THREE.Vector3();
      const newLocalQuat = new THREE.Quaternion();
      const newLocalScale = new THREE.Vector3();
      newLocalMatrix.decompose(newLocalPos, newLocalQuat, newLocalScale);

      const newLocalEuler = new THREE.Euler().setFromQuaternion(newLocalQuat, 'XYZ');

      onPlaneTransformChange(
        [planePosition[0], planePosition[1], planePosition[2]],
        [newLocalEuler.x, newLocalEuler.y, newLocalEuler.z],
      );
    },
    [worldTransform, planePosition, onPlaneTransformChange],
  );

  const handleGizmoScale = useCallback(
    (_axis: GizmoAxis | 'uniform', factor: number) => {
      // Scale changes the radius parameter uniformly
      const newRadius = Math.max(1.0, radius * factor);
      onRadiusChange(newRadius);
    },
    [radius, onRadiusChange],
  );

  const handleGizmoDragState = useCallback(
    (dragging: boolean) => {
      onDragStateChange?.(dragging);
    },
    [onDragStateChange],
  );

  if (!worldTransform) return null;

  const { worldPos, worldEuler } = worldTransform;

  return (
    <ScreenSpaceGizmo
      position={[worldPos.x, worldPos.y, worldPos.z]}
      rotation={[worldEuler.x, worldEuler.y, worldEuler.z]}
      followMeshRef={false}
      enableMove
      enableRotate
      enableScale
      showCenter={false}
      showMovePlanes={false}
      onMove={handleGizmoMove}
      onRotate={handleGizmoRotate}
      onScale={handleGizmoScale}
      onDragStateChange={handleGizmoDragState}
    />
  );
}
