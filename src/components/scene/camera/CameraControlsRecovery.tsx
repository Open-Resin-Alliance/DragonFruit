"use client";

import React from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

type OrbitLikeControls = {
  target: THREE.Vector3;
  enabled?: boolean;
  enableRotate?: boolean;
  enablePan?: boolean;
  enableZoom?: boolean;
};

function isOrbitLikeControls(value: unknown): value is OrbitLikeControls {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<OrbitLikeControls>;
  return !!maybe.target;
}

/**
 * Number of consecutive still frames required before a stale disable is healed.
 * A real camera animation moves the camera every frame, so a sustained stillness
 * window guarantees no animation is in flight.
 */
const STILL_FRAMES_TO_RECOVER = 45; // ~0.75s at 60fps

/**
 * Recovery safety net for the camera-animation snapshot/restore race.
 *
 * Several camera-animation controllers (CameraHomeResetController,
 * CameraModeEntryFramingController, CameraFocusHotkeyController) snapshot
 * controls.enabled / enableRotate / enablePan / enableZoom, force them false
 * during an animation, then restore the snapshot. When animations overlap
 * (e.g. rapid model loads), one controller can snapshot another's transient
 * "disabled" state and restore it permanently, leaving orbit dead while
 * selection still works.
 *
 * This component re-enables orbit when controls are disabled AND the camera has
 * been completely still for a sustained window AND it moved at some point while
 * disabled. A real animation moves the camera every frame, so a still camera
 * means no animation is running; the "moved while disabled" guard distinguishes
 * a stale animation disable from a legitimate UI disable (gizmo drag, marquee
 * select, placement) that never moves the camera.
 */
export function CameraControlsRecovery() {
  const { camera, controls } = useThree();

  const stillFramesRef = React.useRef(0);
  const movedWhileDisabledRef = React.useRef(false);
  const wasDisabledRef = React.useRef(false);
  const lastPosRef = React.useRef<THREE.Vector3 | null>(null);
  const lastTargetRef = React.useRef<THREE.Vector3 | null>(null);

  useFrame(() => {
    if (!isOrbitLikeControls(controls)) return;
    const orbit = controls;

    const disabled =
      orbit.enabled === false ||
      orbit.enableRotate === false ||
      orbit.enablePan === false ||
      orbit.enableZoom === false;

    // Reset the "moved while disabled" flag on the transition into a disabled
    // state, so a legitimate UI disable that never moves the camera is not
    // mistaken for a stale animation disable.
    if (disabled && !wasDisabledRef.current) {
      movedWhileDisabledRef.current = false;
    }
    wasDisabledRef.current = disabled;

    const pos = camera.position;
    const target = orbit.target;
    const lastPos = lastPosRef.current;
    const lastTarget = lastTargetRef.current;
    const moved =
      lastPos != null &&
      lastTarget != null &&
      (pos.distanceToSquared(lastPos) > 1e-8 ||
        target.distanceToSquared(lastTarget) > 1e-8);

    lastPosRef.current = pos.clone();
    lastTargetRef.current = target.clone();

    if (moved) {
      stillFramesRef.current = 0;
      if (disabled) movedWhileDisabledRef.current = true;
      return;
    }

    if (!disabled) {
      stillFramesRef.current = 0;
      return;
    }

    stillFramesRef.current += 1;

    if (stillFramesRef.current >= STILL_FRAMES_TO_RECOVER && movedWhileDisabledRef.current) {
      if (typeof orbit.enabled === 'boolean') orbit.enabled = true;
      if (typeof orbit.enableRotate === 'boolean') orbit.enableRotate = true;
      if (typeof orbit.enablePan === 'boolean') orbit.enablePan = true;
      if (typeof orbit.enableZoom === 'boolean') orbit.enableZoom = true;
      stillFramesRef.current = 0;
      movedWhileDisabledRef.current = false;
    }
  });

  return null;
}
