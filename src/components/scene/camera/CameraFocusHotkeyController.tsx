import * as React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useCameraFocusHotkey } from '@/hotkeys/useCameraFocusHotkey';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

type OrbitLikeControls = {
  target: THREE.Vector3;
  enabled?: boolean;
  enableDamping?: boolean;
  update: () => void;
};

function isOrbitLikeControls(value: unknown): value is OrbitLikeControls {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<OrbitLikeControls>;
  return !!maybe.target && typeof maybe.update === 'function';
}

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

type FocusTransition = {
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startTarget: THREE.Vector3;
  endTarget: THREE.Vector3;
  startZoom: number;
  endZoom: number;
  isOrthographic: boolean;
  startTime: number | null;
  durationMs: number;
  prevDamping: boolean | undefined;
  prevEnabled: boolean | undefined;
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

function computeModelWorldBoundingSphere(model: LoadedModel): THREE.Sphere {
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
  return localBounds.getBoundingSphere(new THREE.Sphere());
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
  const { camera, controls, size, invalidate } = useThree();
  const sizeRef = React.useRef(size);
  React.useEffect(() => { sizeRef.current = size; }, [size]);
  const transitionRef = React.useRef<FocusTransition | null>(null);

  useFrame(() => {
    const transition = transitionRef.current;
    if (!transition) return;
    if (!isOrbitLikeControls(controls)) return;

    const now = performance.now();
    if (transition.startTime === null) transition.startTime = now;
    const t = Math.min(1, (now - transition.startTime) / transition.durationMs);
    const eased = THREE.MathUtils.smootherstep(t, 0, 1);

    camera.position.lerpVectors(transition.startPos, transition.endPos, eased);
    controls.target.lerpVectors(transition.startTarget, transition.endTarget, eased);

    if (transition.isOrthographic && camera instanceof THREE.OrthographicCamera) {
      camera.zoom = THREE.MathUtils.lerp(transition.startZoom, transition.endZoom, eased);
      camera.updateProjectionMatrix();
    }

    controls.update();

    if (t >= 1) {
      camera.position.copy(transition.endPos);
      controls.target.copy(transition.endTarget);
      if (transition.isOrthographic && camera instanceof THREE.OrthographicCamera) {
        camera.zoom = transition.endZoom;
        camera.updateProjectionMatrix();
      }
      controls.update();

      if (typeof transition.prevDamping === 'boolean') controls.enableDamping = transition.prevDamping;
      if (typeof transition.prevEnabled === 'boolean') controls.enabled = transition.prevEnabled;
      transitionRef.current = null;
    }

    // Keep the demand-mode loop alive while the focus tween is running.
    invalidate();
  }, -1);

  const snapCameraToPoint = React.useCallback((point: THREE.Vector3, modelRadius?: number) => {
    if (!isOrbitLikeControls(controls)) {
      // No orbit controls yet — just update the pivot state
      setOrbitTargetFromPoint(point, { animate: false });
      return;
    }

    // Cancel existing transition and restore controls before starting a new one
    const existing = transitionRef.current;
    if (existing) {
      if (typeof existing.prevDamping === 'boolean') controls.enableDamping = existing.prevDamping;
      if (typeof existing.prevEnabled === 'boolean') controls.enabled = existing.prevEnabled;
      transitionRef.current = null;
    }

    const currentViewVector = camera.position.clone().sub(controls.target);
    const hasValidView = currentViewVector.lengthSq() > 1e-8;
    const viewDir = hasValidView
      ? currentViewVector.normalize()
      : new THREE.Vector3(-0.5, -0.7, 1).normalize();

    // FOV-aware fit distance — identical formula to CameraIntroController prepare mode
    let fitDistance = hasValidView ? currentViewVector.length() : 400;
    let fitOrthoZoom: number | null = null;
    if (modelRadius != null && modelRadius > 0) {
      const isPerspective = camera instanceof THREE.PerspectiveCamera;
      const vFov = isPerspective
        ? THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov)
        : THREE.MathUtils.degToRad(50);
      const { width, height } = sizeRef.current;
      const aspect = width / Math.max(1, height);
      const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * aspect);
      const minFov = Math.max(0.0001, Math.min(vFov, hFov));
      fitDistance = (modelRadius / Math.tan(minFov * 0.5)) * 1.05;

      // Orthographic cameras must fit via zoom, not distance.
      if (camera instanceof THREE.OrthographicCamera) {
        const ortho = camera as THREE.OrthographicCamera;
        const frustumHeight = Math.max(1e-6, ortho.top - ortho.bottom);
        const requiredWorldHeight = (modelRadius * 2) * 1.08;
        fitOrthoZoom = THREE.MathUtils.clamp(
          frustumHeight / Math.max(1e-6, requiredWorldHeight),
          0.0001,
          200,
        );
      }
    }

    const endTarget = point.clone();
    const endPos = endTarget.clone().add(viewDir.clone().multiplyScalar(fitDistance));

    // Disable damping so no pending velocity is applied during update()
    const prevDamping = controls.enableDamping;
    const prevEnabled = controls.enabled;
    if (typeof prevDamping === 'boolean') controls.enableDamping = false;
    if (typeof prevEnabled === 'boolean') controls.enabled = false;

    const isOrthographic = camera instanceof THREE.OrthographicCamera;
    const startZoom = isOrthographic ? camera.zoom : 1;
    const endZoom = fitOrthoZoom ?? startZoom;

    transitionRef.current = {
      startPos: camera.position.clone(),
      endPos,
      startTarget: controls.target.clone(),
      endTarget,
      startZoom,
      endZoom,
      isOrthographic,
      startTime: null,
      durationMs: 260,
      prevDamping,
      prevEnabled,
    };

    // Pre-emptive invalidate + rAF defer per R3F scaling-performance docs — ensures
    // the first rendered frame shows the animation from t=0, avoiding the jump caveat.
    invalidate();
    requestAnimationFrame(() => invalidate());
  }, [camera, controls, setOrbitTargetFromPoint, invalidate]);

  useCameraFocusHotkey(() => {
    const visibleModels = models.filter((model) => model.visible);
    const visibleById = new Map(visibleModels.map((model) => [model.id, model] as const));
    const hoverPoint = hoverPointRef.current;

    const hoveredSelectedModel = hoveredModelId
      && (
        hoveredModelId === activeModelId
        || selectedModelIds.includes(hoveredModelId)
      );

    // Hovering a selected model: re-target the orbit pivot to the hovered
    // surface point but keep the current zoom / distance unchanged.
    if (hoverPoint && hoveredSelectedModel) {
      snapCameraToPoint(hoverPoint);
      return;
    }

    if (visibleModels.length === 0) {
      if (hoverPoint) snapCameraToPoint(hoverPoint);
      return;
    }

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
      const sphere = computeModelWorldBoundingSphere(preferredModel);
      snapCameraToPoint(sphere.center, sphere.radius);
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

    const bestSphere = computeModelWorldBoundingSphere(bestModel);
    snapCameraToPoint(bestSphere.center, bestSphere.radius);
  });

  return null;
}
