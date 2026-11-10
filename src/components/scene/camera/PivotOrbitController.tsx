import React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { applyOrthoFrustum } from './orthoDolly';
import {
  applyPivotOrbitState,
  createPivotOrbitState,
  orbitPivotBy,
  type PivotOrbitState,
} from './pivotOrbit';
import { perspectiveWheelRadiusScale } from './wheelZoomPose';

/**
 * The scene camera while "Orbit pivot: Cursor" is active.
 *
 * OrbitControls cannot express this mode: it orbits its `target` and re-aims at
 * it every update, so an off-centre pivot is impossible to keep. This controller
 * owns the camera instead, with `pivotOrbit.ts`'s state — pivot, Z-up spherical
 * orbit angles, radius and a constant focal offset — so right-drag orbits the
 * point under the cursor while the pivot keeps its pixel, middle-drag trucks, and
 * the wheel dollies. Everything eases at the same camera-feel rate as the rest of
 * the app.
 *
 * It exposes an OrbitControls-shaped shim through `controlsRef` so the rest of
 * the scene (focus/home controllers, SpaceMouse, ortho framing) keeps working;
 * any camera pose written by someone else is adopted as a fresh state whose pivot
 * is the shim's target.
 */

type ControlsShim = {
  target: THREE.Vector3;
  enabled?: boolean;
  update: () => void;
  rotateSpeed: number;
  panSpeed: number;
  zoomSpeed: number;
  minDistance?: number;
  maxDistance?: number;
  state?: number;
  enableRotate: boolean;
  enablePan: boolean;
  enableZoom: boolean;
  enableDamping: boolean;
  /** Some scene controllers subscribe to OrbitControls' 'change' event. */
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  dispatchEvent: (event: { type: string }) => void;
};

type PivotOrbitControllerProps = {
  active: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  cameraRef: React.RefObject<THREE.Camera | null>;
  controlsRef: React.RefObject<{
    target: THREE.Vector3;
    update: () => void;
    enabled?: boolean;
    rotateSpeed: number;
    panSpeed: number;
    zoomSpeed: number;
    minDistance?: number;
    maxDistance?: number;
    state?: number;
  } | null>;
  enabled: boolean;
  resolvePivot: (clientX: number, clientY: number) => THREE.Vector3 | null;
  /** Per-frame orbit/pan damping, the same factor OrbitControls is given. */
  damping: number;
  tauMs: number;
  fovDeg: number;
  sceneRadius?: number;
  minRadius: number;
  maxRadius: number;
  onStart: () => void;
  onEnd: () => void;
  onChange: () => void;
};

const MIN_ORBIT_POLAR = 0.08;
const WHEEL_ZOOM_END_MS = 140;
const EPSILON = 1e-4;

export function PivotOrbitController({
  active,
  containerRef,
  cameraRef,
  controlsRef,
  enabled,
  resolvePivot,
  damping,
  tauMs,
  fovDeg,
  sceneRadius,
  minRadius,
  maxRadius,
  onStart,
  onEnd,
  onChange,
}: PivotOrbitControllerProps) {
  const { gl, set, get } = useThree();

  const stateRef = React.useRef<PivotOrbitState | null>(null);
  const goalAzimuthRef = React.useRef(0);
  const goalPolarRef = React.useRef(0);
  const goalRadiusRef = React.useRef(0);
  /**
   * Orthographic scale, kept apart from the orbit radius. In ortho the frustum is
   * derived from a radius, and picking a pivot changes the camera's distance to
   * it — deriving the frustum from the new distance would make picking a nearer
   * point zoom in. This only changes on dolly (and when another owner hands the
   * camera back), so a pivot pick never touches the scale.
   */
  const zoomRadiusRef = React.useRef(0);
  const zoomRadiusGoalRef = React.useRef(0);
  const goalPivotRef = React.useRef(new THREE.Vector3());
  const dragRef = React.useRef<
    | {
      button: 2 | 1;
      pointerId: number;
      startX: number;
      startY: number;
      azimuth: number;
      polar: number;
      /** Where the pivot was when the drag began: pan deltas are absolute from it. */
      startPivot: THREE.Vector3;
      startRight: THREE.Vector3;
      startUp: THREE.Vector3;
    }
    | null
  >(null);
  const pressRef = React.useRef<{ pointerId: number } | null>(null);
  const lastAppliedRef = React.useRef<{ position: THREE.Vector3; quaternion: THREE.Quaternion }>({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  });
  const hasAppliedRef = React.useRef(false);
  const wheelTimeoutRef = React.useRef<number | null>(null);
  const wheelActiveRef = React.useRef(false);
  const pointerDownHandlerRef = React.useRef<((event: PointerEvent) => void) | null>(null);
  const detachRef = React.useRef<(() => void) | null>(null);

  const shim = React.useMemo<ControlsShim>(() => {
    const listeners = new Map<string, Set<() => void>>();
    return {
      target: new THREE.Vector3(),
      enabled: true,
      update: () => {
        // A caller moved the camera (focus, home, SpaceMouse): adopt it next frame.
        hasAppliedRef.current = false;
      },
      rotateSpeed: 0.72,
      panSpeed: 0.82,
      zoomSpeed: 1.25,
      minDistance: minRadius,
      maxDistance: maxRadius,
      state: undefined,
      enableRotate: true,
      enablePan: true,
      enableZoom: true,
      enableDamping: false,
      addEventListener: (type, listener) => {
        const set = listeners.get(type) ?? new Set<() => void>();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener: (type, listener) => {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent: (event) => {
        listeners.get(event.type)?.forEach((listener) => listener());
      },
    };
  }, [minRadius, maxRadius]);


  React.useEffect(() => {
    if (!active) return;
    controlsRef.current = shim;
    // The scene's other camera controllers (intro, home, focus, ortho framing)
    // reach the camera through R3F's default controls; register this one so they
    // keep working while OrbitControls is unmounted.
    const previous = get().controls;
    set({ controls: shim as unknown as typeof previous });
    return () => {
      if (controlsRef.current === shim) controlsRef.current = null;
      // Only unregister if it is still ours: OrbitControls' own makeDefault may
      // already have replaced it.
      if (get().controls === (shim as unknown)) set({ controls: previous });
    };
  }, [active, controlsRef, get, set, shim]);

  const seedFromCamera = React.useCallback((pivot: THREE.Vector3, options?: { preserveScale?: boolean }) => {
    const camera = cameraRef.current;
    if (!camera) return;
    // The state remembers the pixel the pivot occupies now; applying it
    // reproduces the current pose exactly.
    const state = createPivotOrbitState(camera, pivot);
    stateRef.current = state;
    goalAzimuthRef.current = state.azimuth;
    goalPolarRef.current = state.polar;
    goalRadiusRef.current = state.radius;
    if (camera instanceof THREE.OrthographicCamera) {
      if (options?.preserveScale) {
        // Picking a pivot must not rescale the view: keep the frustum's radius.
        const halfHeight = Math.max(1e-6, (camera.top - camera.bottom) * 0.5);
        zoomRadiusRef.current = halfHeight / Math.max(1e-6, Math.tan((fovDeg * Math.PI) / 360));
      } else {
        // Anyone else's move (focus, home, intro, a projection switch) frames by
        // the camera-to-target distance, which is this app's ortho zoom.
        zoomRadiusRef.current = state.radius;
      }
    } else {
      zoomRadiusRef.current = state.radius;
    }
    zoomRadiusGoalRef.current = zoomRadiusRef.current;
    goalPivotRef.current.copy(state.pivot);
    shim.target.copy(state.pivot);
    lastAppliedRef.current.position.copy(camera.position);
    lastAppliedRef.current.quaternion.copy(camera.quaternion);
    hasAppliedRef.current = true;
  }, [cameraRef, shim]);

  React.useLayoutEffect(() => {
    if (!active) {
      stateRef.current = null;
      hasAppliedRef.current = false;
      return;
    }
    // Start from the camera as it is, orbiting whatever is under the middle of
    // the viewport (the model, or the selected model / plate the resolver falls
    // back to).
    const camera = cameraRef.current;
    if (!camera) return;
    const container = containerRef.current;
    let pivot: THREE.Vector3 | null = null;
    if (container) {
      const rect = container.getBoundingClientRect();
      pivot = resolvePivot(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    seedFromCamera(
      pivot ?? camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(100).add(camera.position),
      { preserveScale: true },
    );
  }, [active, cameraRef, containerRef, resolvePivot, seedFromCamera, shim]);

  // ---- input ---------------------------------------------------------------

  const endDrag = React.useCallback((notify: boolean) => {
    detachRef.current?.();
    detachRef.current = null;
    pressRef.current = null;
    const wasDragging = dragRef.current !== null;
    dragRef.current = null;
    if (wasDragging && notify) {
      shim.state = undefined;
      onEnd();
    }
  }, [onEnd, shim]);

  const beginDrag = React.useCallback((event: PointerEvent) => {
    const camera = cameraRef.current;
    if (!camera || !enabled) return;
    if (event.pointerType !== 'mouse') return;
    const isOrbit = event.button === 2;
    const isPan = event.button === 1;
    if (!isOrbit && !isPan) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;

    if (isOrbit) {
      const pivot = resolvePivot(event.clientX, event.clientY);
      if (!pivot) return;
      seedFromCamera(pivot, { preserveScale: true });
    }

    const state = stateRef.current;
    if (!state) return;

    event.preventDefault();
    event.stopPropagation();

    pressRef.current = { pointerId: event.pointerId };
    dragRef.current = {
      button: isOrbit ? 2 : 1,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      azimuth: state.azimuth,
      polar: state.polar,
      startPivot: state.pivot.clone(),
      startRight: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize(),
      startUp: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize(),
    };
    shim.state = isOrbit ? 0 : 2;
    onStart();

    const onPointerMove = (move: PointerEvent) => {
      if (move.pointerId !== event.pointerId) return;
      const drag = dragRef.current;
      const current = stateRef.current;
      if (!drag || !current) return;
      const dx = move.clientX - drag.startX;
      const dy = move.clientY - drag.startY;

      if (drag.button === 2) {
        const target = { ...current, azimuth: drag.azimuth, polar: drag.polar };
        orbitPivotBy(target, dx, dy, gl.domElement.clientHeight, shim.rotateSpeed);
        goalAzimuthRef.current = target.azimuth;
        goalPolarRef.current = target.polar;
      } else {
        // Truck: move the orbit centre and the eye together in the screen plane.
        // Deltas are absolute from the *gesture's* pivot — re-basing them on the
        // easing pivot re-applied the whole travel every sample and shot the
        // camera off.
        const worldRadius = camera instanceof THREE.OrthographicCamera ? zoomRadiusRef.current : current.radius;
        const scale = (2 * Math.max(1e-6, worldRadius) * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, gl.domElement.clientHeight);
        goalPivotRef.current
          .copy(drag.startPivot)
          .addScaledVector(drag.startRight, -dx * scale * shim.panSpeed)
          .addScaledVector(drag.startUp, dy * scale * shim.panSpeed);
      }
    };
    const onPointerUp = (up: PointerEvent) => {
      if (up.pointerId !== event.pointerId) return;
      endDrag(true);
      onChange();
    };
    const detach = () => {
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      detachRef.current = null;
    };
    detachRef.current?.();
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    detachRef.current = detach;
  }, [cameraRef, enabled, endDrag, fovDeg, gl, onChange, onStart, resolvePivot, seedFromCamera, shim]);

  React.useLayoutEffect(() => {
    pointerDownHandlerRef.current = (event: PointerEvent) => {
      if (!active) return;
      beginDrag(event);
    };
  }, [active, beginDrag]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;
    const onPointerDown = (event: PointerEvent) => pointerDownHandlerRef.current?.(event);
    container.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown, true);
      detachRef.current?.();
      detachRef.current = null;
    };
  }, [active, containerRef]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;

    const endWheel = () => {
      if (wheelTimeoutRef.current !== null) {
        window.clearTimeout(wheelTimeoutRef.current);
        wheelTimeoutRef.current = null;
      }
      if (!wheelActiveRef.current) return;
      wheelActiveRef.current = false;
      window.dispatchEvent(new CustomEvent('picking-zoom-end', { detail: { resumeAfterMs: tauMs } }));
    };

    const onWheel = (event: WheelEvent) => {
      if (!enabled || !stateRef.current) return;
      event.preventDefault();
      event.stopPropagation();

      const scale = perspectiveWheelRadiusScale(event.deltaY, shim.zoomSpeed);
      const camera = cameraRef.current;
      if (camera instanceof THREE.OrthographicCamera) {
        // The eye does not move for an orthographic zoom: only the frustum does.
        zoomRadiusGoalRef.current = THREE.MathUtils.clamp(
          zoomRadiusGoalRef.current * scale,
          shim.minDistance ?? minRadius,
          shim.maxDistance ?? maxRadius,
        );
      } else {
        goalRadiusRef.current = THREE.MathUtils.clamp(
          goalRadiusRef.current * scale,
          shim.minDistance ?? minRadius,
          shim.maxDistance ?? maxRadius,
        );
      }

      if (!wheelActiveRef.current) {
        wheelActiveRef.current = true;
        window.dispatchEvent(new Event('picking-zoom-start'));
      }
      window.dispatchEvent(new Event('picking-zoom-change'));
      if (wheelTimeoutRef.current !== null) window.clearTimeout(wheelTimeoutRef.current);
      wheelTimeoutRef.current = window.setTimeout(() => {
        wheelTimeoutRef.current = null;
        endWheel();
      }, WHEEL_ZOOM_END_MS);
    };

    container.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => {
      container.removeEventListener('wheel', onWheel, true);
      endWheel();
    };
  }, [active, containerRef, enabled, maxRadius, minRadius, shim, tauMs]);

  // ---- per-frame -----------------------------------------------------------

  useFrame((_state, delta) => {
    if (!active) return;
    const camera = cameraRef.current;
    if (!camera) return;
    if (!enabled || shim.enabled === false) {
      // The camera is not ours right now: the intro/home/focus animations, a
      // SpaceMouse gesture, a gizmo drag. Stand down and adopt the pose when it is
      // handed back — applying a stale state here would fight the animation and
      // keep `cameraInteractionEnabled` false forever.
      //
      // Orthographic framing still has to follow: those animations zoom by moving
      // the camera to the target distance, and in ortho that distance *is* the
      // zoom, so the frustum is derived from it every frame or the animation's
      // zoom is invisible.
      if (camera instanceof THREE.OrthographicCamera && shim.target.lengthSq() > 0) {
        const aspect = (camera.right - camera.left) / Math.max(1e-6, camera.top - camera.bottom);
        const radius = camera.position.distanceTo(shim.target);
        zoomRadiusRef.current = Math.max(1e-6, radius);
        zoomRadiusGoalRef.current = zoomRadiusRef.current;
        applyOrthoFrustum(camera, zoomRadiusRef.current, aspect, { sceneRadius, fovDeg });
      }
      hasAppliedRef.current = false;
      return;
    }

    const state = stateRef.current;
    if (!state) return;

    // Someone else moved the camera, or the shim's target (focus, home): adopt.
    const external =
      !hasAppliedRef.current
      || (dragRef.current === null
        && (camera.position.distanceToSquared(lastAppliedRef.current.position) > EPSILON * EPSILON
          || 1 - Math.abs(camera.quaternion.dot(lastAppliedRef.current.quaternion)) > EPSILON))
      || shim.target.distanceToSquared(state.pivot) > EPSILON * EPSILON;
    if (external) {
      seedFromCamera(shim.target.lengthSq() > 0 ? shim.target : state.pivot.clone());
      return;
    }

    const ranged = (current: number, goal: number, alpha: number) => {
      const next = current + (goal - current) * alpha;
      return Math.abs(goal - next) < 1e-4 ? goal : next;
    };

    // Orbit and pan use OrbitControls' per-frame damping so the two modes feel
    // identical (its damping is frame-based, not time-based). Zoom keeps the
    // time-based ease the wheel already has in the other mode.
    const orbitAlpha = damping <= 0 ? 1 : Math.min(1, damping);
    const zoomAlpha = tauMs <= 0 ? 1 : 1 - Math.exp(-(delta * 1000) / tauMs);

    state.azimuth = ranged(state.azimuth, goalAzimuthRef.current, orbitAlpha);
    state.polar = THREE.MathUtils.clamp(
      ranged(state.polar, goalPolarRef.current, orbitAlpha),
      MIN_ORBIT_POLAR,
      Math.PI - MIN_ORBIT_POLAR,
    );
    state.radius = ranged(state.radius, goalRadiusRef.current, zoomAlpha);
    zoomRadiusRef.current = ranged(zoomRadiusRef.current, zoomRadiusGoalRef.current, zoomAlpha);
    state.pivot.lerp(goalPivotRef.current, orbitAlpha);

    const beforeX = camera.position.x;
    const beforeY = camera.position.y;
    const beforeZ = camera.position.z;
    applyPivotOrbitState(state, camera);
    shim.target.copy(state.pivot);

    if (camera instanceof THREE.OrthographicCamera) {
      const aspect = (camera.right - camera.left) / Math.max(1e-6, camera.top - camera.bottom);
      applyOrthoFrustum(camera, zoomRadiusRef.current, aspect, { sceneRadius, fovDeg });
    }

    lastAppliedRef.current.position.copy(camera.position);
    lastAppliedRef.current.quaternion.copy(camera.quaternion);
    hasAppliedRef.current = true;

    // Only a frame that actually moved the camera is a change: subscribers
    // (CameraFocusController) update React state, and firing on every idle frame
    // re-renders the scene and restarts the home/intro animations.
    if (
      Math.abs(camera.position.x - beforeX) > 1e-6
      || Math.abs(camera.position.y - beforeY) > 1e-6
      || Math.abs(camera.position.z - beforeZ) > 1e-6
    ) {
      shim.dispatchEvent({ type: 'change' });
    }
  });

  return null;
}
