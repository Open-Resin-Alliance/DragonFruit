import * as React from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useCameraFocusHotkey } from '@/hotkeys/useCameraFocusHotkey';

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
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  orbitControlsRef: React.MutableRefObject<{ target: THREE.Vector3; update: () => void } | null>;
};

type FocusTransition = {
  startPos: THREE.Vector3;
  startTarget: THREE.Vector3;
  endTarget: THREE.Vector3;
  startTime: number | null;
  durationMs: number;
  prevDamping: boolean | undefined;
  prevEnabled: boolean | undefined;
};

export function CameraFocusHotkeyController({
  hoverPointRef,
  setOrbitTargetFromPoint,
  cameraRef,
  orbitControlsRef,
}: CameraFocusHotkeyControllerProps) {
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

    // The camera stays where it is; only the orbit target moves. The
    // controls.update() lookAt then re-orients the camera so the focused
    // point glides to the screen centre with no zoom/distance change.
    camera.position.copy(transition.startPos);
    controls.target.lerpVectors(transition.startTarget, transition.endTarget, eased);
    controls.update();

    if (t >= 1) {
      controls.target.copy(transition.endTarget);
      controls.update();

      if (typeof transition.prevDamping === 'boolean') controls.enableDamping = transition.prevDamping;
      if (typeof transition.prevEnabled === 'boolean') controls.enabled = transition.prevEnabled;
      transitionRef.current = null;
    }
  }, -1);

  const focusCameraOnPoint = React.useCallback((point: THREE.Vector3) => {
    const camera = cameraRef.current;
    const controls = orbitControlsRef.current;
    if (!camera || !controls || !isOrbitLikeControls(controls)) {
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

    // Disable damping so no pending velocity is applied during update()
    const prevDamping = controls.enableDamping;
    const prevEnabled = controls.enabled;
    if (typeof prevDamping === 'boolean') controls.enableDamping = false;
    if (typeof prevEnabled === 'boolean') controls.enabled = false;

    transitionRef.current = {
      startPos: camera.position.clone(),
      startTarget: controls.target.clone(),
      endTarget: point.clone(),
      startTime: null,
      durationMs: 260,
      prevDamping,
      prevEnabled,
    };
  }, [cameraRef, orbitControlsRef, setOrbitTargetFromPoint]);

  useCameraFocusHotkey(() => {
    // Focus is strictly hover-driven: re-pivot to the surface point under
    // the cursor. When the cursor is not over a model there is no hover
    // point and the hotkey does nothing — never fall back to framing a
    // model, which used to fly the camera far out to fit it.
    const hoverPoint = hoverPointRef.current;
    if (!hoverPoint) return;
    focusCameraOnPoint(hoverPoint.clone());
  });

  return null;
}
