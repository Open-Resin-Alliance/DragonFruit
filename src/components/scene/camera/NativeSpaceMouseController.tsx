"use client";

import React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
  getSavedSpaceMouseSettings,
  subscribeToSpaceMouseSettings,
} from '@/components/settings/spacemousePreferences';
import {
  getNativeSpaceMouseActive,
  nativeSpaceMouseSync,
  requestNativeSpaceMouse,
  type NativeCameraInput,
  type NativeNavOutput,
} from './nativeSpaceMouseBridge';
import { ORTHO_MAX_RADIUS, ORTHO_MIN_RADIUS, applyOrthoFrustum, orthoAspectOf } from './orthoDolly';

type OrbitLikeControls = {
  target: THREE.Vector3;
  enabled?: boolean;
  update: () => void;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

function isOrbitLikeControls(value: unknown): value is OrbitLikeControls {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<OrbitLikeControls>;
  return !!maybe.target && typeof maybe.update === 'function';
}

// Recompute the model bounding box at most this often (frames) — it only feeds
// navlib's speed/zoom scaling, so it doesn't need to be exact every frame.
const MODEL_EXTENTS_REFRESH_FRAMES = 30;

// navlib's Camera / Target-Camera / Fly / Walk modes are PERSPECTIVE-ONLY by
// design — in an orthographic view the driver produces zero motion (it expects
// a perspective projection to translate the eye). Our scene is usually ortho, so
// to let those modes drive an ortho camera we deliberately report
// `view.perspective = true` to navlib even when the live camera is orthographic.
// navlib then drives everything through `view.affine`: lateral eye translation =
// pan and eye rotation = orbit (both correct for ortho as-is), while its "zoom"
// dollies the eye forward — which is a no-op for an ortho projection. `applyAffine`
// intercepts that forward dolly and converts it into `camera.zoom` instead.
// Object mode still works in ortho with this on (navlib treats it as perspective
// object mode). Flip to `false` to restore the native extents-based ortho path.
const FORCE_PERSPECTIVE_IN_ORTHO = true;

/**
 * Native 3DxWare / navlib SpaceMouse driver (Windows/macOS).
 *
 * Unlike {@link SpaceMouseController} (which reads raw Gamepad axes and computes
 * the camera itself), here the 3Dconnexion driver computes the camera pose and
 * we simply apply it. Each frame we push the current camera to navlib via the
 * Rust bridge and apply the pose it returns while it is navigating.
 *
 * When this controller is live it sets a shared flag so the Gamepad-API
 * controller stands down (both APIs can see the same physical puck). If the
 * driver is absent, `start` resolves to `null`, this controller stays dormant,
 * and the Gamepad path takes over.
 */
export function NativeSpaceMouseController({
  pivotPoint,
  fallbackPivot,
  sceneRadius,
  onNavigationActiveChange,
  onNavigationFrame,
}: {
  pivotPoint?: THREE.Vector3 | null;
  fallbackPivot?: THREE.Vector3 | null;
  sceneRadius?: number;
  onNavigationActiveChange?: (active: boolean) => void;
  onNavigationFrame?: () => void;
}) {
  const { camera, controls, scene } = useThree();

  const settings = React.useSyncExternalStore(
    subscribeToSpaceMouseSettings,
    getSavedSpaceMouseSettings,
    getSavedSpaceMouseSettings,
  );

  // Latest navlib output; the frame loop applies it and issues the next sync.
  const latestOutRef = React.useRef<NativeNavOutput | null>(null);
  const inFlightRef = React.useRef(false);
  const lastAppliedSeqRef = React.useRef(0);
  const prevMotionRef = React.useRef(false);
  const weDisabledOrbitRef = React.useRef(false);
  // Camera→target distance captured when navlib takes over, so handback can
  // re-seat the orbit pivot in front of the camera at the same radius.
  const focusDistRef = React.useRef(50);
  // Set on handback: navlib may have rolled the horizon, and constrained orbit is
  // always world Z-up. We don't level on release (the tilt is kept for viewing) —
  // only when the user next starts a mouse orbit/pan (the controls 'start' event).
  const pendingLevelRef = React.useRef(false);
  // Ortho dolly radius while navlib owns the camera. navlib's absolute axial
  // distance is offset by the pivot it orbits (the selected model centre), which
  // need not equal the current look target, so we integrate navlib's OWN per-frame
  // axial delta onto the radius the derived frustum already had — no start jump.
  const navRadiusRef = React.useRef(50);
  const navPrevAxialRef = React.useRef(0);
  const navHasAxialRef = React.useRef(false);
  // Cached model extents + refresh counter.
  const modelBoxRef = React.useRef(new THREE.Box3());
  const modelBoxAgeRef = React.useRef(MODEL_EXTENTS_REFRESH_FRAMES);

  // Scratch objects reused across frames.
  const tmpMatrix = React.useRef(new THREE.Matrix4());
  const tmpScale = React.useRef(new THREE.Vector3());
  const tmpTarget = React.useRef(new THREE.Vector3());
  const tmpPan = React.useRef(new THREE.Vector3());
  const tmpPos = React.useRef(new THREE.Vector3());
  const tmpDir = React.useRef(new THREE.Vector3());
  const tmpQuat = React.useRef(new THREE.Quaternion());

  // ── Request the bridge on/off with the SpaceMouse enabled setting ──
  // The reconciler in the bridge owns the async lifecycle (StrictMode-safe);
  // the shared active flag it sets gates the frame loop below.
  React.useEffect(() => {
    requestNativeSpaceMouse(settings.enabled);
    return () => {
      requestNativeSpaceMouse(false);
      prevMotionRef.current = false;
      weDisabledOrbitRef.current = false;
    };
  }, [settings.enabled]);

  // ── Re-level the horizon when the mouse takes back over ──
  // navlib can roll the view; we keep that roll after release, but constrained orbit
  // is world Z-up. When the user starts a mouse orbit/pan (OrbitControls 'start'),
  // snap up back to Z and re-aim at the target — a roll-only change (view direction
  // is preserved) so the drag begins on a level horizon.
  React.useEffect(() => {
    if (!isOrbitLikeControls(controls) || !controls.addEventListener) return;
    const onStart = () => {
      if (!pendingLevelRef.current) return;
      pendingLevelRef.current = false;
      camera.up.set(0, 0, 1);
      camera.lookAt(controls.target);
      camera.updateMatrixWorld();
      controls.update();
    };
    controls.addEventListener('start', onStart);
    return () => controls.removeEventListener?.('start', onStart);
  }, [controls, camera]);

  const getTarget = React.useCallback(
    (out: THREE.Vector3): THREE.Vector3 => {
      if (pivotPoint) return out.copy(pivotPoint);
      if (isOrbitLikeControls(controls)) return out.copy(controls.target);
      if (fallbackPivot) return out.copy(fallbackPivot);
      return out.set(0, 0, 0);
    },
    [controls, fallbackPivot, pivotPoint],
  );

  const refreshModelExtents = React.useCallback(() => {
    const box = modelBoxRef.current;
    box.makeEmpty();
    scene.traverseVisible((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (!object.geometry) return;
      if (!object.userData || typeof object.userData.modelId !== 'string') return;
      box.expandByObject(object);
    });
    if (box.isEmpty()) {
      // No model yet — a small box around the target keeps navlib's scaling sane.
      const t = getTarget(tmpTarget.current);
      box.setFromCenterAndSize(t, new THREE.Vector3(20, 20, 20));
    }
  }, [getTarget, scene]);

  const applyAffine = React.useCallback(
    (affine: number[]) => {
      if (affine.length < 16) return;
      const m = tmpMatrix.current.fromArray(affine);

      const lie =
        FORCE_PERSPECTIVE_IN_ORTHO &&
        (camera as THREE.OrthographicCamera).isOrthographicCamera === true;

      if (!lie) {
        m.decompose(camera.position, camera.quaternion, tmpScale.current);
        // Preserve roll: take the camera up-vector straight from the matrix rather
        // than re-deriving it via lookAt.
        camera.up.set(affine[4], affine[5], affine[6]).normalize();
        camera.updateMatrixWorld();
        return;
      }

      // ── Ortho + forced-perspective lie ──
      // navlib thinks it is driving a perspective camera: it trucks the eye
      // laterally for pan, rotates it for orbit, and dollies it forward for
      // "zoom". We apply that absolute pose unchanged (so presets, which
      // reposition the eye in one reorientation, land where navlib framed them)
      // and derive the ortho scale from the axial camera→pivot distance, which is
      // the same radius the derived-frustum sync resumes from on hand-back.
      m.decompose(tmpPos.current, tmpQuat.current, tmpScale.current);
      const fwd = tmpDir.current.set(0, 0, -1).applyQuaternion(tmpQuat.current).normalize();
      const pivot = getTarget(tmpTarget.current);
      const axial = tmpPan.current.copy(tmpPos.current).sub(pivot).dot(fwd);
      // Integrate navlib's own axial delta. Under orbit fwd tracks the pivot, so
      // axial is the (constant) orbit distance and only a real dolly moves it;
      // lateral pan is perpendicular and contributes nothing.
      if (navHasAxialRef.current) {
        const delta = axial - navPrevAxialRef.current;
        navRadiusRef.current = THREE.MathUtils.clamp(
          navRadiusRef.current - delta,
          ORTHO_MIN_RADIUS,
          ORTHO_MAX_RADIUS,
        );
      }
      navPrevAxialRef.current = axial;
      navHasAxialRef.current = true;

      camera.position.copy(tmpPos.current);
      camera.quaternion.copy(tmpQuat.current);
      camera.up.set(affine[4], affine[5], affine[6]).normalize();
      camera.updateMatrixWorld();

      const ortho = camera as THREE.OrthographicCamera;
      applyOrthoFrustum(ortho, navRadiusRef.current, orthoAspectOf(ortho), { sceneRadius });
      focusDistRef.current = navRadiusRef.current;
    },
    [camera, getTarget, sceneRadius],
  );

  const handBackToOrbit = React.useCallback(() => {
    if (!weDisabledOrbitRef.current) return;
    if (isOrbitLikeControls(controls)) {
      // Re-seat the orbit pivot in FRONT of wherever navlib left the camera, at
      // the current dolly radius. navlib moves the camera freely (orbit sweeps it
      // far from the old target); copying that stale pivot back is what snapped the
      // camera on release after a rotation. A point along the current view direction
      // keeps the pose — and the ortho scale — OrbitControls resumes from.
      const dir = camera.getWorldDirection(tmpPan.current); // into-screen, unit
      controls.target
        .copy(camera.position)
        .addScaledVector(dir, focusDistRef.current);
      controls.enabled = true;
      controls.update();
      // Keep navlib's roll for now — the horizon only re-levels to Z-up when the
      // user actually starts a mouse orbit/pan (see the controls 'start' listener).
      pendingLevelRef.current = true;
    }
    weDisabledOrbitRef.current = false;
  }, [controls, camera]);

  // Current orthographic view extents in camera/eye space, matching three's
  // OrthographicCamera projection (frustum scaled by zoom). navlib needs these to
  // scale ortho pan and to drive ortho zoom. `[[-1,-1,-1],[1,1,1]]` in perspective
  // mode, where navlib ignores them.
  const computeOrthoExtents = React.useCallback((): {
    min: [number, number, number];
    max: [number, number, number];
  } => {
    const ortho = camera as THREE.OrthographicCamera;
    if (ortho.isOrthographicCamera !== true) {
      return { min: [-1, -1, -1], max: [1, 1, 1] };
    }
    const zoom = ortho.zoom || 1;
    const dx = (ortho.right - ortho.left) / (2 * zoom);
    const dy = (ortho.top - ortho.bottom) / (2 * zoom);
    const cx = (ortho.right + ortho.left) / 2;
    const cy = (ortho.top + ortho.bottom) / 2;
    return {
      min: [cx - dx, cy - dy, -ortho.far],
      max: [cx + dx, cy + dy, -ortho.near],
    };
  }, [camera]);

  const buildCameraInput = React.useCallback((): NativeCameraInput => {
    camera.updateMatrixWorld();
    const target = getTarget(tmpTarget.current);
    const focusDistance = Math.max(0.1, camera.position.distanceTo(target));
    const isPerspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
    const isOrtho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
    // Report perspective to navlib when the camera really is perspective, OR when
    // we're forcing the lie on an ortho camera so its camera-family modes engage.
    const reportPerspective = isPerspective || (FORCE_PERSPECTIVE_IN_ORTHO && isOrtho);
    const fov = isPerspective
      ? THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov)
      : 0.8;

    // In the ortho lie, size the reported focus distance so navlib's perspective
    // view half-height at the focus plane (focusDistance·tan(fov/2)) equals the
    // ortho view's half-height. Otherwise navlib pans/zooms at the wrong world
    // scale (the real eye→target distance makes pan feel far too slow).
    let focusDistanceForNav = focusDistance;
    if (FORCE_PERSPECTIVE_IN_ORTHO && isOrtho) {
      const oc = camera as THREE.OrthographicCamera;
      const zoom = oc.zoom || 1;
      const halfH = (oc.top - oc.bottom) / (2 * zoom);
      const t = Math.tan(fov / 2);
      if (halfH > 1e-6 && t > 1e-6) focusDistanceForNav = halfH / t;
    }

    if (modelBoxAgeRef.current >= MODEL_EXTENTS_REFRESH_FRAMES) {
      refreshModelExtents();
      modelBoxAgeRef.current = 0;
    }
    modelBoxAgeRef.current++;
    const box = modelBoxRef.current;
    const extents = computeOrthoExtents();

    return {
      affine: Array.from(camera.matrixWorld.elements),
      fov,
      focusDistance: focusDistanceForNav,
      perspective: reportPerspective,
      target: [target.x, target.y, target.z],
      modelMin: [box.min.x, box.min.y, box.min.z],
      modelMax: [box.max.x, box.max.y, box.max.z],
      orthoMin: extents.min,
      orthoMax: extents.max,
    };
  }, [camera, computeOrthoExtents, getTarget, refreshModelExtents]);

  useFrame(() => {
    if (!getNativeSpaceMouseActive() || !settings.enabled) return;
    if (!isOrbitLikeControls(controls)) return;

    // Ignore SpaceMouse input unless our window is the active/focused window —
    // mirrors SpaceMouseController's Gamepad-path guard. The 3Dconnexion driver
    // keeps tracking the puck for background windows, so without this navlib
    // would drive our camera while another app is in front. document.hasFocus()
    // (unlike document.hidden / visibilitychange) is false whenever the window
    // is not active, even while it stays visible. While unfocused we neither
    // apply navlib's pose nor push ours to it, and we cleanly hand orbit back.
    if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) {
      if (prevMotionRef.current) {
        prevMotionRef.current = false;
        onNavigationActiveChange?.(false);
      }
      navHasAxialRef.current = false;
      handBackToOrbit();
      return;
    }

    // 1. Apply navlib's latest camera (from the previous frame's sync).
    const out = latestOutRef.current;
    if (out) {
      const motionStarting = out.motion && !prevMotionRef.current;
      const motionEnding = !out.motion && prevMotionRef.current;

      if (motionStarting) {
        // Start the ortho radius from the current derived value before the first
        // applied pose, so there is no scale jump at gesture start.
        navRadiusRef.current = THREE.MathUtils.clamp(
          camera.position.distanceTo(controls.target),
          ORTHO_MIN_RADIUS,
          ORTHO_MAX_RADIUS,
        );
        navHasAxialRef.current = false;
        focusDistRef.current = navRadiusRef.current;
        if (!weDisabledOrbitRef.current) {
          controls.enabled = false;
          weDisabledOrbitRef.current = true;
        }
        onNavigationActiveChange?.(true);
      }

      // Apply navlib's pose BEFORE handing back on the final frame, so hand-back
      // re-seats the pivot against the pose OrbitControls actually resumes from.
      //
      // Only apply while navlib is actually navigating. Idle output is an echo of
      // the pose we reported; applying it re-asserts navlib's up-vector, which
      // leaves the regular mouse orbiting a rolled horizon from app start until the
      // first SpaceMouse gesture re-arms the horizon reset.
      if (out.seq !== lastAppliedSeqRef.current && (out.motion || motionEnding)) {
        lastAppliedSeqRef.current = out.seq;
        applyAffine(out.affine); // pan + orbit + dolly
        onNavigationFrame?.();
      }

      if (motionEnding) {
        navHasAxialRef.current = false;
        focusDistRef.current = navRadiusRef.current;
        handBackToOrbit();
        onNavigationActiveChange?.(false);
      }

      prevMotionRef.current = out.motion;
    }

    // 2. Push the current camera to navlib for the next frame (one call in
    //    flight at a time — the result is picked up above next frame).
    if (!inFlightRef.current) {
      inFlightRef.current = true;
      const cam = buildCameraInput();
      nativeSpaceMouseSync(cam)
        .then((res) => {
          if (res) latestOutRef.current = res;
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    }
  });

  return null;
}
