import * as React from 'react';
import * as THREE from 'three';
import { useCameraFocusHotkey } from '@/hotkeys/useCameraFocusHotkey';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

type CameraFocusHotkeyControllerProps = {
  hoverPointRef: React.MutableRefObject<THREE.Vector3 | null>;
  setOrbitTargetFromPoint: (point: THREE.Vector3, options?: { animate?: boolean }) => void;
  models: LoadedModel[];
  activeModelId: string | null;
  selectedModelIds: string[];
  hoveredModelId: string | null;
  orbitTarget: [number, number, number];
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  orbitControlsRef: React.MutableRefObject<{ target: THREE.Vector3; update: () => void } | null>;
};

function computeModelWorldCenter(model: LoadedModel): THREE.Vector3 {
  const localBounds = model.geometry.bbox.clone();
  localBounds.translate(new THREE.Vector3(
    -model.geometry.center.x,
    -model.geometry.center.y,
    -model.geometry.center.z,
  ));

  const worldMatrix = new THREE.Matrix4().compose(
    model.transform.position,
    quaternionFromGlobalEuler(model.transform.rotation),
    model.transform.scale,
  );
  localBounds.applyMatrix4(worldMatrix);
  return localBounds.getCenter(new THREE.Vector3());
}

export function CameraFocusHotkeyController({
  hoverPointRef,
  setOrbitTargetFromPoint,
  models,
  activeModelId,
  selectedModelIds,
  hoveredModelId,
  orbitTarget,
  cameraRef,
  orbitControlsRef,
}: CameraFocusHotkeyControllerProps) {
  const snapCameraToPoint = React.useCallback((point: THREE.Vector3) => {
    const controls = orbitControlsRef.current;
    const camera = cameraRef.current;

    if (!controls || !camera) {
      setOrbitTargetFromPoint(point, { animate: false });
      return;
    }

    const currentTarget = controls.target?.clone()
      ?? new THREE.Vector3(orbitTarget[0], orbitTarget[1], orbitTarget[2]);
    const offset = camera.position.clone().sub(currentTarget);
    if (offset.lengthSq() < 1e-6) {
      offset.set(-220, -220, 260);
    }

    controls.target.copy(point);
    camera.position.copy(point.clone().add(offset));
    controls.update();
    setOrbitTargetFromPoint(point, { animate: false });
  }, [cameraRef, orbitControlsRef, orbitTarget, setOrbitTargetFromPoint]);

  useCameraFocusHotkey(() => {
    const visibleModels = models.filter((model) => model.visible);
    const hoverPoint = hoverPointRef.current;

    const hoveredSelectedModel = hoveredModelId
      && (
        hoveredModelId === activeModelId
        || selectedModelIds.includes(hoveredModelId)
      );

    // Preserve legacy behavior: if user is hovering a selected model, animate
    // pivot focus to the hovered point rather than snapping model-center.
    if (hoverPoint && hoveredSelectedModel) {
      setOrbitTargetFromPoint(hoverPoint, { animate: true });
      return;
    }

    if (visibleModels.length === 0) {
      if (hoverPoint) {
        snapCameraToPoint(hoverPoint);
      }
      return;
    }

    const visibleById = new Map(visibleModels.map((model) => [model.id, model] as const));
    const preferredIds: string[] = [];
    const seen = new Set<string>();
    const pushPreferred = (id: string | null | undefined) => {
      if (!id || seen.has(id) || !visibleById.has(id)) return;
      seen.add(id);
      preferredIds.push(id);
    };

    pushPreferred(activeModelId);
    selectedModelIds.forEach((id) => pushPreferred(id));
    pushPreferred(hoveredModelId);

    const preferredModel = preferredIds.length > 0 ? visibleById.get(preferredIds[0]) ?? null : null;
    if (preferredModel) {
      snapCameraToPoint(computeModelWorldCenter(preferredModel));
      return;
    }

    const currentTarget = new THREE.Vector3(orbitTarget[0], orbitTarget[1], orbitTarget[2]);
    let bestModel = visibleModels[0];
    let bestDistanceSq = Number.POSITIVE_INFINITY;

    for (const model of visibleModels) {
      const center = computeModelWorldCenter(model);
      const distanceSq = center.distanceToSquared(currentTarget);
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        bestModel = model;
      }
    }

    snapCameraToPoint(computeModelWorldCenter(bestModel));
  });

  return null;
}
