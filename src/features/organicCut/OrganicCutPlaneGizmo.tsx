import React, { useCallback, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
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
  const { camera } = useThree();
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
      worldMatrix,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planePosition, planeRotation, meshLocalOffset, hasTransform, tpx, tpy, tpz, trx, try_, trz, tsx, tsy, tsz]);

  const initialRadiusRef = React.useRef<number | null>(null);
  const initialWorldSizeRef = React.useRef<number>(1.0);
  const initialModelScaleRef = React.useRef<number>(1.0);

  const computeGizmoWorldSize = useCallback(() => {
    if (!camera || !worldTransform) return 1.0;
    const { worldPos } = worldTransform;
    const scaleFactor = 0.04; // default scaleFactor of ScreenSpaceGizmo
    if (camera instanceof THREE.OrthographicCamera) {
      const ortho = camera;
      const worldHeight = (ortho.top - ortho.bottom) / Math.max(1e-6, ortho.zoom);
      return worldHeight * scaleFactor;
    }
    const perspective = camera as THREE.PerspectiveCamera;
    const distance = perspective.position.distanceTo(worldPos);
    return distance * scaleFactor;
  }, [camera, worldTransform]);

  const handleScaleStart = useCallback(() => {
    initialRadiusRef.current = radius;
    initialWorldSizeRef.current = computeGizmoWorldSize();

    if (transform) {
      const scaleX = transform.scale.x ?? 1;
      const scaleY = transform.scale.y ?? 1;
      const scaleZ = transform.scale.z ?? 1;
      initialModelScaleRef.current = (Math.abs(scaleX) + Math.abs(scaleY) + Math.abs(scaleZ)) / 3;
    } else {
      initialModelScaleRef.current = 1.0;
    }
  }, [radius, computeGizmoWorldSize, transform]);

  const handleScaleEnd = useCallback(() => {
    initialRadiusRef.current = null;
  }, []);

  const handleGizmoMove = useCallback(
    (delta: THREE.Vector3) => {
      if (!transform || !worldTransform) return;

      // Translate in local space: transform the world delta displacement using localToWorld's inverse.
      // Set W component to 0 to treat it as a displacement/direction, which handles rotation and scale.
      const localToWorldInv = worldTransform.localToWorld.clone().invert();
      const localDelta4 = new THREE.Vector4(delta.x, delta.y, delta.z, 0).applyMatrix4(localToWorldInv);
      const localDelta = new THREE.Vector3(localDelta4.x, localDelta4.y, localDelta4.z);

      onPlaneTransformChange(
        [
          planePosition[0] + localDelta.x,
          planePosition[1] + localDelta.y,
          planePosition[2] + localDelta.z,
        ],
        [planeRotation[0], planeRotation[1], planeRotation[2]],
      );
    },
    [transform, worldTransform, planePosition, planeRotation, onPlaneTransformChange],
  );

  const handleGizmoRotate = useCallback(
    (axis: GizmoAxis, angle: number) => {
      if (!worldTransform) return;

      const { worldQuat, worldPos, localToWorld } = worldTransform;

      // Define axis of rotation in the gizmo's world space (which is aligned to world axes)
      const worldAxis = new THREE.Vector3(
        axis === 'x' ? 1 : 0,
        axis === 'y' ? 1 : 0,
        axis === 'z' ? 1 : 0,
      );

      // Rotate worldQuat around that world axis by -angle to match cursor drag
      const deltaQuat = new THREE.Quaternion().setFromAxisAngle(worldAxis, -angle);
      const newWorldQuat = deltaQuat.clone().multiply(worldQuat);

      // Create new world matrix (position remains unchanged during pure rotation)
      const newWorldMatrix = new THREE.Matrix4().compose(
        worldPos,
        newWorldQuat,
        new THREE.Vector3(1, 1, 1),
      );

      // Transform new world matrix back to local matrix
      const localToWorldInv = localToWorld.clone().invert();
      const newLocalMatrix = localToWorldInv.multiply(newWorldMatrix);

      const localPos = new THREE.Vector3();
      const localQuat = new THREE.Quaternion();
      const localScale = new THREE.Vector3();
      newLocalMatrix.decompose(localPos, localQuat, localScale);

      // Convert back to Euler angles
      const newLocalEuler = new THREE.Euler().setFromQuaternion(localQuat, 'XYZ');

      onPlaneTransformChange(
        [planePosition[0], planePosition[1], planePosition[2]],
        [newLocalEuler.x, newLocalEuler.y, newLocalEuler.z],
      );
    },
    [worldTransform, planePosition, onPlaneTransformChange],
  );

  const handleGizmoScale = useCallback(
    (_axis: GizmoAxis | 'uniform', factor: number) => {
      const baseRadius = initialRadiusRef.current ?? radius;
      const worldSize = initialWorldSizeRef.current;
      const modelScale = initialModelScaleRef.current;

      // Scale in world-space by the exact distance the mouse moved, then convert to local
      const deltaRadiusLocal = (worldSize * (factor - 1)) / modelScale;
      const newRadius = Math.max(1.0, baseRadius + deltaRadiusLocal);
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

  const { worldPos } = worldTransform;

  return (
    <ScreenSpaceGizmo
      position={[worldPos.x, worldPos.y, worldPos.z]}
      rotation={[0, 0, 0]}
      followMeshRef={false}
      enableMove
      enableRotate
      enableScale
      showCenter={false}
      showMovePlanes={false}
      onMove={handleGizmoMove}
      onRotate={handleGizmoRotate}
      onScale={handleGizmoScale}
      onScaleStart={handleScaleStart}
      onScaleEnd={handleScaleEnd}
      onDragStateChange={handleGizmoDragState}
    />
  );
}
