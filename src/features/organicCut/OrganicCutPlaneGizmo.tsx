import React, { useCallback, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';
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

  // World coordinates for the plane, composed directly from world-space state parameters.
  const worldTransform = useMemo(() => {
    const worldPos = new THREE.Vector3(...planePosition);
    const worldQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(planeRotation[0], planeRotation[1], planeRotation[2], 'XYZ'));
    const worldEuler = new THREE.Euler(planeRotation[0], planeRotation[1], planeRotation[2], 'XYZ');
    const worldMatrix = new THREE.Matrix4().compose(
      worldPos,
      worldQuat,
      new THREE.Vector3(1, 1, 1),
    );

    return {
      worldPos,
      worldQuat,
      worldEuler,
      worldMatrix,
    };
  }, [planePosition, planeRotation]);

  const initialRadiusRef = React.useRef<number | null>(null);
  const initialWorldSizeRef = React.useRef<number>(1.0);

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
  }, [radius, computeGizmoWorldSize]);

  const handleScaleEnd = useCallback(() => {
    initialRadiusRef.current = null;
  }, []);

  const handleGizmoMove = useCallback(
    (delta: THREE.Vector3) => {
      onPlaneTransformChange(
        [
          planePosition[0] + delta.x,
          planePosition[1] + delta.y,
          planePosition[2] + delta.z,
        ],
        [planeRotation[0], planeRotation[1], planeRotation[2]],
      );
    },
    [planePosition, planeRotation, onPlaneTransformChange],
  );

  const handleGizmoRotate = useCallback(
    (axis: GizmoAxis, angle: number) => {
      const currentEuler = new THREE.Euler(planeRotation[0], planeRotation[1], planeRotation[2], 'XYZ');
      const currentQuat = new THREE.Quaternion().setFromEuler(currentEuler);

      // Define axis of rotation in world space (as the gizmo is world-aligned)
      const worldAxis = new THREE.Vector3(
        axis === 'x' ? 1 : 0,
        axis === 'y' ? 1 : 0,
        axis === 'z' ? 1 : 0,
      );

      // Rotate around world axis by -angle to match cursor drag direction
      const deltaQuat = new THREE.Quaternion().setFromAxisAngle(worldAxis, -angle);
      const newQuat = deltaQuat.clone().multiply(currentQuat);

      // Convert back to Euler angles
      const newEuler = new THREE.Euler().setFromQuaternion(newQuat, 'XYZ');

      onPlaneTransformChange(
        [planePosition[0], planePosition[1], planePosition[2]],
        [newEuler.x, newEuler.y, newEuler.z],
      );
    },
    [planePosition, planeRotation, onPlaneTransformChange],
  );

  const handleGizmoScale = useCallback(
    (_axis: GizmoAxis | 'uniform', factor: number) => {
      const baseRadius = initialRadiusRef.current ?? radius;
      const worldSize = initialWorldSizeRef.current;

      // Scale in world-space by the exact distance the mouse moved
      const deltaRadiusWorld = worldSize * (factor - 1);
      const newRadius = Math.max(1.0, baseRadius + deltaRadiusWorld);
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

  if (!transform || !worldTransform) return null;

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
