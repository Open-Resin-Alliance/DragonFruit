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
import {
  ORTHO_MAX_RADIUS,
  ORTHO_MIN_RADIUS,
  ORTHO_REFERENCE_FOV_DEG,
  applyOrthoFrustum,
  isOrthoFitFrame,
  orthoAspectOf,
  resolveOrthoNavRadius,
} from './orthoDolly';
import { getWindowFocused, retainWindowFocus } from './windowFocus';

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
// `view.perspective = true` and a synthetic `view.focusDistance` to navlib even
// when the live camera is orthographic (see `buildCameraInput`). navlib then
// drives everything through `view.affine`: lateral eye translation = pan, eye
// rotation = orbit, and its "zoom" dollies the eye forward. `applyAffine` turns
// that forward dolly into the ortho dolly radius (the scale source). Object mode
// still works in ortho with this on (navlib treats it as perspective object
// mode). Flip to `false` to restore the native extents-based ortho path.
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
  fovDeg,
  onNavigationActiveChange,
  onNavigationFrame,
}: {
  pivotPoint?: THREE.Vector3 | null;
  fallbackPivot?: THREE.Vector3 | null;
  sceneRadius?: number;
  fovDeg?: number;
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
  const lastAppliedExtentsSeqRef = React.useRef(0);
  const prevMotionRef = React.useRef(false);
  const weDisabledOrbitRef = React.useRef(false);
  // Camera→target distance captured when navlib takes over, so handback can
  // re-seat the orbit pivot in front of the camera at the same radius.
  const focusDistRef = React.useRef(50);
  // Ortho dolly radius while navlib owns the camera. navlib's absolute axial
  // distance is offset by the pivot it orbits (the selected model centre), which
  // need not equal the current look target, so we integrate navlib's OWN per-frame
  // axial delta onto the radius the derived frustum already had — no start jump.
  const navRadiusRef = React.useRef(50);
  const navPrevAxialRef = React.useRef(0);
  const navHasAxialRef = React.useRef(false);
  const navPrevFwdRef = React.useRef(new THREE.Vector3(0, 0, -1));
  const navPrevEyeRef = React.useRef(new THREE.Vector3());
  // Set when a frame looks like navlib's Fit; the app's focus is run for it.
  const fitRequestedRef = React.useRef(false);
  // Pose-ownership generations. `syncGenRef` counts pushes; `latestOutGenRef`
  // stamps the output they returned. `resyncFromGenRef` marks the first push
  // after the window regained focus — outputs at or before it were produced while
  // we were not listening, and are consumed without being applied (see the frame
  // loop).
  const syncGenRef = React.useRef(0);
  const latestOutGenRef = React.useRef(0);
  const resyncFromGenRef = React.useRef(0);
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

  // The frame loop gates on the window's OS focus; keep it tracked while this
  // controller is mounted (released on unmount).
  React.useEffect(() => retainWindowFocus(), []);

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

      // Seed the "previous pose" from the camera on the first applied frame, so an
      // idle view command (Fit) that arrives before any gesture is still measured
      // as a jump rather than passing through as a no-op.
      if (!navHasAxialRef.current) {
        const seedPivot = getTarget(tmpTarget.current);
        const seedForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
        navPrevEyeRef.current.copy(camera.position);
        navPrevFwdRef.current.copy(seedForward);
        navPrevAxialRef.current = new THREE.Vector3().copy(camera.position).sub(seedPivot).dot(seedForward);
        // Seed the dolly radius from the live camera too: it otherwise starts at a
        // hardcoded value, so the first applied frame (e.g. an idle command after a
        // bridge restart) would set the ortho scale to that wrong radius.
        navRadiusRef.current = THREE.MathUtils.clamp(
          camera.position.distanceTo(seedPivot),
          ORTHO_MIN_RADIUS,
          ORTHO_MAX_RADIUS,
        );
        navHasAxialRef.current = true;
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
      // Resolve the new scale. Interactive dollies integrate navlib's own axial
      // delta; view commands do not, because navlib sizes their eye distance for a
      // perspective projection. A Fit keeps the scale and asks the app to run its
      // own focus (the F action), which frames the model properly.
      const hasPrevious = navHasAxialRef.current;
      const navFrame = {
        currentRadius: navRadiusRef.current,
        prevAxial: navPrevAxialRef.current,
        axial,
        hasPrevious,
        turn: hasPrevious ? navPrevFwdRef.current.angleTo(fwd) : 0,
        eyeJump: hasPrevious ? tmpPos.current.distanceTo(navPrevEyeRef.current) : 0,
      };
      if (isOrthoFitFrame(navFrame)) {
        fitRequestedRef.current = true;
      }
      navRadiusRef.current = resolveOrthoNavRadius(navFrame);
      navPrevAxialRef.current = axial;
      navPrevFwdRef.current.copy(fwd);
      navPrevEyeRef.current.copy(tmpPos.current);
      navHasAxialRef.current = true;

      camera.position.copy(tmpPos.current);
      camera.quaternion.copy(tmpQuat.current);
      camera.up.set(affine[4], affine[5], affine[6]).normalize();
      camera.updateMatrixWorld();

      const ortho = camera as THREE.OrthographicCamera;
      applyOrthoFrustum(ortho, navRadiusRef.current, orthoAspectOf(ortho), { sceneRadius, fovDeg });
      focusDistRef.current = navRadiusRef.current;
    },
    [camera, fovDeg, getTarget, sceneRadius],
  );

  /**
   * Apply a navlib-written ortho view box.
   *
   * In the ortho modes navlib drives pan and "zoom" through `view.extents`: the
   * box height is the world height it wants visible and its centre offset is an
   * incremental pan (we send a camera-centred box each frame). That is how a Fit
   * command can arrive without a usable affine, so map the height onto the dolly
   * radius instead of dropping it.
   */
  const applyNavlibOrthoExtents = React.useCallback(
    (min: [number, number, number], max: [number, number, number]) => {
      const ortho = camera as THREE.OrthographicCamera;
      if (ortho.isOrthographicCamera !== true) return;

      const height = Math.abs(max[1] - min[1]);
      if (!Number.isFinite(height) || height <= 1e-3) return;

      const fov = THREE.MathUtils.degToRad(fovDeg ?? ORTHO_REFERENCE_FOV_DEG);
      navRadiusRef.current = THREE.MathUtils.clamp(
        height / (2 * Math.tan(fov * 0.5)),
        ORTHO_MIN_RADIUS,
        ORTHO_MAX_RADIUS,
      );

      const centreX = (min[0] + max[0]) * 0.5;
      const centreY = (min[1] + max[1]) * 0.5;
      if (Math.abs(centreX) > 1e-6 || Math.abs(centreY) > 1e-6) {
        camera.updateMatrixWorld();
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
        const pan = new THREE.Vector3()
          .addScaledVector(right, centreX)
          .addScaledVector(up, centreY);
        camera.position.add(pan);
        if (isOrbitLikeControls(controls)) controls.target.add(pan);
      }

      applyOrthoFrustum(ortho, navRadiusRef.current, orthoAspectOf(ortho), { sceneRadius, fovDeg });
      camera.updateMatrixWorld();
    },
    [camera, controls, fovDeg, sceneRadius],
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
      // The roll navlib left is corrected by HorizonLock once navigation ends.
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
    // Report the FOV the ortho frustum is actually derived from (the app's FOV
    // setting), not an arbitrary constant: navlib's virtual perspective camera is
    // then exactly the virtual camera behind the ortho view, so its own framing
    // math (presets, fit) lands where ours does.
    const fov = isPerspective
      ? THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov)
      : THREE.MathUtils.degToRad(fovDeg ?? ORTHO_REFERENCE_FOV_DEG);

    // In the ortho lie, size the reported focus distance so navlib's perspective
    // view half-height at the focus plane (focusDistance·tan(fov/2)) equals the
    // ortho view's half-height. With the real FOV that is simply the dolly radius.
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
      lastAppliedSeq: lastAppliedSeqRef.current,
      lastAppliedExtentsSeq: lastAppliedExtentsSeqRef.current,
    };
  }, [camera, computeOrthoExtents, getTarget, refreshModelExtents]);

  useFrame(() => {
    if (!getNativeSpaceMouseActive() || !settings.enabled) return;
    if (!isOrbitLikeControls(controls)) return;

    // Ignore SpaceMouse input unless our window is the active/focused window.
    // The 3Dconnexion driver keeps tracking the puck for background windows, so
    // without this navlib would drive our camera while another app is in front.
    // `windowFocus` follows the OS window event (the same one the Rust bridge
    // mirrors into navlib's `active`/`focus`), so it is false for as long as
    // another application is active, even while this window stays visible. While
    // unfocused we neither apply navlib's pose nor push ours to it, and we
    // cleanly hand orbit back.
    if (!getWindowFocused()) {
      // Everything navlib writes from here until we are back is produced for a
      // window that is not listening; the first sync after focus returns is
      // consumed without being applied (see `resyncFromGenRef`).
      resyncFromGenRef.current = syncGenRef.current + 1;
      if (prevMotionRef.current) {
        prevMotionRef.current = false;
        onNavigationActiveChange?.(false);
      }
      handBackToOrbit();
      return;
    }

    // 1. Apply navlib's latest camera (from the previous frame's sync).
    const out = latestOutRef.current;
    if (out && latestOutGenRef.current <= resyncFromGenRef.current) {
      // Produced at or before the first sync after the window regained focus.
      // navlib kept writing poses while we were not listening, and the Rust bridge
      // dropped its ownership of them (see `nav::set_focus`). Record them as
      // consumed without moving the camera: applying one would replay everything
      // the puck did while another application was in front as a single jump, and
      // — because the ownership handshake keys off the last applied `seq` —
      // leaving it unconsumed would stop JS re-asserting its own camera while
      // navlib is idle.
      lastAppliedSeqRef.current = out.seq;
      lastAppliedExtentsSeqRef.current = out.extentsSeq;
      prevMotionRef.current = false;
    } else if (out) {
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
      // Apply while navigating, and also for a view command (fit / preset) that
      // arrives without motion — it moves the eye a long way. Idle output, by
      // contrast, echoes the pose we reported; applying it re-asserts navlib's
      // up-vector and leaves the regular mouse orbiting a rolled horizon.
      const seqAdvanced = out.seq !== lastAppliedSeqRef.current;
      const idleEyeJump = Math.hypot(
        out.affine[12] - camera.position.x,
        out.affine[13] - camera.position.y,
        out.affine[14] - camera.position.z,
      );
      const idleViewCommand = seqAdvanced
        && !out.motion
        && !motionEnding
        && idleEyeJump > Math.max(1, 0.05 * navRadiusRef.current);
      if (seqAdvanced && (out.motion || motionEnding || idleViewCommand)) {
        lastAppliedSeqRef.current = out.seq;
        applyAffine(out.affine); // pan + orbit + dolly
        onNavigationFrame?.();
      }

      if (fitRequestedRef.current) {
        fitRequestedRef.current = false;
        window.dispatchEvent(new Event('camera-fit-request'));
      }

      // A view box write is a pan/zoom/Fit command (navlib only writes extents
      // when it is driving them, not as an echo of what we sent).
      if (out.extentsSeq !== lastAppliedExtentsSeqRef.current) {
        lastAppliedExtentsSeqRef.current = out.extentsSeq;
        applyNavlibOrthoExtents(out.orthoMin, out.orthoMax);
        onNavigationFrame?.();
      }

      if (motionEnding) {
        // Deliberately keep navHasAxialRef/prev refs: an idle view command (fit)
        // after the gesture diffs against this final pose.
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
      const gen = syncGenRef.current + 1;
      syncGenRef.current = gen;
      nativeSpaceMouseSync(cam)
        .then((res) => {
          if (!res) return;
          latestOutRef.current = res;
          latestOutGenRef.current = gen;
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    }
  });

  return null;
}
