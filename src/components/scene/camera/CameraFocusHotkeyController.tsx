import * as React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useCameraFocusHotkey } from '@/hotkeys/useCameraFocusHotkey';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

/**
 * How far below the middle of the view a plate lands when one is picked, as a fraction of
 * what the camera can see: the models stand above the bed, and that is the space worth
 * leaving room for.
 */
const PLATE_FOCUS_DROP_RATIO = 0.2;

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
  /**
   * Which models F may frame. A model on a bed that is not the one being worked on
   * is scenery, and framing it would move the camera off the plate you are on to
   * look at something you cannot even click.
   */
  isModelFocusable?: (model: LoadedModel) => boolean;
  activeModelId: string | null;
  selectedModelIds: string[];
  hoveredModelId: string | null;
  orbitTarget: [number, number, number];
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  orbitControlsRef: React.MutableRefObject<{ target: THREE.Vector3; update: () => void } | null>;
  perspectiveFov?: number;
  /**
   * A request to move the view to the plate being worked on, bumped when one is clicked:
   * a click on a bed picks what to work on, and the plate you picked may be off screen.
   * No radius, so this is a pan — the view keeps its angle and its distance.
   */
  plateFocus?: { runId: number; center: THREE.Vector3 };
};

type FocusTransition = {
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startTarget: THREE.Vector3;
  endTarget: THREE.Vector3;
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
  plateFocus,
  hoverPointRef,
  setOrbitTargetFromPoint,
  models,
  isModelFocusable,
  activeModelId,
  selectedModelIds,
  hoveredModelId,
  orbitTarget,
  cameraRef,
  orbitControlsRef,
  perspectiveFov = 50,
}: CameraFocusHotkeyControllerProps) {
  const { size } = useThree();
  const sizeRef = React.useRef(size);
  React.useEffect(() => { sizeRef.current = size; }, [size]);
  const transitionRef = React.useRef<FocusTransition | null>(null);

  useFrame(() => {
    const transition = transitionRef.current;
    if (!transition) return;
    const camera = cameraRef.current;
    const controls = orbitControlsRef.current;
    if (!camera || !controls || !isOrbitLikeControls(controls)) return;

    const now = performance.now();
    if (transition.startTime === null) transition.startTime = now;
    const t = Math.min(1, (now - transition.startTime) / transition.durationMs);
    const eased = THREE.MathUtils.smootherstep(t, 0, 1);

    camera.position.lerpVectors(transition.startPos, transition.endPos, eased);
    controls.target.lerpVectors(transition.startTarget, transition.endTarget, eased);

    controls.update();

    if (t >= 1) {
      camera.position.copy(transition.endPos);
      controls.target.copy(transition.endTarget);
      controls.update();

      // Tell the pivot state where the view ended up: it feeds the controls' `target`
      // prop and the focus hotkey, and a pan that left it pointing at the old plate would
      // have the next focus start from the wrong place.
      setOrbitTargetFromPoint(transition.endTarget, { animate: false });

      if (typeof transition.prevDamping === 'boolean') controls.enableDamping = transition.prevDamping;
      if (typeof transition.prevEnabled === 'boolean') controls.enabled = transition.prevEnabled;
      transitionRef.current = null;
    }
  }, -1);

  const snapCameraToPoint = React.useCallback((
    point: THREE.Vector3,
    modelRadius?: number,
    options?: { durationMs?: number },
  ) => {
    const camera = cameraRef.current;
    const controls = orbitControlsRef.current;
    if (!camera || !controls || !isOrbitLikeControls(controls)) {
      // No orbit controls yet — just update the pivot state
      setOrbitTargetFromPoint(point, { animate: false });
      return;
    }

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
    // Read the radius before normalising: Vector3.normalize() mutates in place,
    // so length() afterwards would always be 1.
    const currentRadius = currentViewVector.length();
    const viewDir = hasValidView
      ? currentViewVector.normalize()
      : new THREE.Vector3(-0.5, -0.7, 1).normalize();

    // FOV-aware fit distance — identical formula to CameraIntroController prepare mode
    let fitDistance = hasValidView ? currentRadius : 400;
    if (modelRadius != null && modelRadius > 0) {
      const isPerspective = camera instanceof THREE.PerspectiveCamera;
      const vFov = isPerspective
        ? THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov)
        : THREE.MathUtils.degToRad(perspectiveFov);
      const { width, height } = sizeRef.current;
      const aspect = width / Math.max(1, height);
      const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * aspect);
      const minFov = Math.max(0.0001, Math.min(vFov, hFov));
      fitDistance = (modelRadius / Math.tan(minFov * 0.5)) * 1.05;
    }

    const endTarget = point.clone();
    // Keeping the camera at the fit distance (rather than its current position)
    // preserves the on-screen scale while re-targeting the pivot — for an
    // orthographic camera the frustum is derived from that distance.
    const endPos = endTarget.clone().add(viewDir.clone().multiplyScalar(fitDistance));

    // Disable damping so no pending velocity is applied during update()
    const prevDamping = controls.enableDamping;
    const prevEnabled = controls.enabled;
    if (typeof prevDamping === 'boolean') controls.enableDamping = false;
    if (typeof prevEnabled === 'boolean') controls.enabled = false;

    transitionRef.current = {
      startPos: camera.position.clone(),
      endPos,
      startTarget: controls.target.clone(),
      endTarget,
      startTime: null,
      // The caller can stretch the slide: a far pan benefits from a longer, calmer
      // ease, while re-framing a model is best kept quick.
      durationMs: options?.durationMs ?? 260,
      prevDamping,
      prevEnabled,
    };
  }, [cameraRef, orbitControlsRef, perspectiveFov, setOrbitTargetFromPoint]);

  // A clicked plate brings the view with it. The run id and the new active plate's centre
  // arrive in the same commit, so the pan reads the plate that was picked.
  const plateFocusRunId = plateFocus?.runId ?? 0;
  const lastPlateFocusRunIdRef = React.useRef(plateFocusRunId);
  React.useEffect(() => {
    if (plateFocusRunId === lastPlateFocusRunIdRef.current) return;
    lastPlateFocusRunIdRef.current = plateFocusRunId;
    const center = plateFocus?.center;
    if (!center) return;

    // No radius: keep the current view distance and angle, and move the pivot — the view
    // slides across to the plate instead of re-framing it. The slide is eased over longer
    // the further the view has to travel, so one bed's pitch reads as a glide rather than
    // a snap, and a small nudge does not crawl.
    const from = orbitControlsRef.current?.target;
    const travelMm = from ? from.distanceTo(center) : 0;
    const durationMs = THREE.MathUtils.clamp(240 + travelMm * 0.6, 260, 440);

    // The pivot lands above the bed, so the plate ends up a fifth of a screen below the
    // middle: the models stand above it, and that is the space worth looking at. How far
    // "a fifth of a screen" is in millimetres depends on what the camera can see there.
    const camera = cameraRef.current;
    const viewSpanMm = camera instanceof THREE.OrthographicCamera
      ? (camera.top - camera.bottom)
      : 2 * (camera && from ? camera.position.distanceTo(from) : 0)
        * Math.tan(THREE.MathUtils.degToRad(
          camera instanceof THREE.PerspectiveCamera ? camera.fov : perspectiveFov,
        ) * 0.5);

    snapCameraToPoint(
      new THREE.Vector3(center.x, center.y, center.z + viewSpanMm * PLATE_FOCUS_DROP_RATIO),
      undefined,
      { durationMs },
    );
    // `plateFocus` carries both the run id and the centre; the guard above means only the
    // run id actually starts a pan.
  }, [cameraRef, orbitControlsRef, perspectiveFov, plateFocus, plateFocusRunId, snapCameraToPoint]);

  const runFocus = React.useCallback(() => {
    const visibleModels = models.filter(
      (model) => model.visible && (isModelFocusable?.(model) ?? true),
    );
    const visibleById = new Map(visibleModels.map((model) => [model.id, model] as const));
    const hoverPoint = hoverPointRef.current;

    const hoveredSelectedModel = hoveredModelId
      && (
        hoveredModelId === activeModelId
        || selectedModelIds.includes(hoveredModelId)
      );

    // Hovering a selected model: re-target the orbit pivot to the hovered
    // surface point while keeping the current on-screen scale (the camera stays
    // at the same distance from the new pivot).
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
  }, [activeModelId, hoveredModelId, isModelFocusable, models, orbitTarget, selectedModelIds, snapCameraToPoint]);

  useCameraFocusHotkey(runFocus);

  // The SpaceMouse's Fit button is delivered through navlib, whose fit distance is
  // sized for a perspective projection and lands too close in ortho. Run the same
  // focus the F key does instead — it frames the model properly.
  React.useEffect(() => {
    window.addEventListener('camera-fit-request', runFocus);
    return () => window.removeEventListener('camera-fit-request', runFocus);
  }, [runFocus]);

  return null;
}
