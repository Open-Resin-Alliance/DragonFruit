"use client";
import React from 'react';
import * as THREE from 'three';
import type { PivotOrbitControls } from './orbitControlsPivot';

/**
 * "Orbit pivot: Cursor" — the orbit centre follows the pointer.
 *
 * A rotate drag adopts the world point under the pointer as the controls' target
 * and stores that point's own pixel as `anchorNdc`, so the pick changes nothing:
 * the solve in `anchoredAim.ts` reproduces the current pose for the new target.
 * From there the camera is the ordinary one — OrbitControls' damping, speeds,
 * pan and zoom all unchanged — turning about the point the user pointed at.
 *
 * The anchor is dropped when the app frames the view itself (Home, the intro,
 * focus, a plate switch), because that framing is meant to be centred.
 */

type CursorOrbitPivotProps = {
  active: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  cameraRef: React.RefObject<THREE.Camera | null>;
  controlsRef: React.RefObject<PivotOrbitControls | null>;
  /** The live orbit target, mirrored from scene state. */
  orbitTarget: [number, number, number];
  setOrbitTargetFromPoint: (point: THREE.Vector3, options?: { animate?: boolean }) => void;
  /** The world point under the pointer, or null when there is nothing to orbit. */
  resolvePivot: (clientX: number, clientY: number) => THREE.Vector3 | null;
  /** False while another owner of the camera (home, focus, gizmo drag) has it. */
  enabled: boolean;
};

const _target = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _toPivot = new THREE.Vector3();
const _projected = new THREE.Vector3();
const TARGET_EPSILON_SQ = 1e-6;

export function CursorOrbitPivot({
  active,
  containerRef,
  cameraRef,
  controlsRef,
  orbitTarget,
  setOrbitTargetFromPoint,
  resolvePivot,
  enabled,
}: CursorOrbitPivotProps) {
  const enabledRef = React.useRef(enabled);
  React.useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  /** The point this component last adopted, so app framing can be told apart. */
  const pickedRef = React.useRef(new THREE.Vector3());
  const pickedRefValid = React.useRef(false);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!enabledRef.current) return;
      if (event.button !== 2) return;

      const controls = controlsRef.current;
      if (!controls) return;

      const rect = container.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return;

      const pivot = resolvePivot(event.clientX, event.clientY);
      if (!pivot) return;

      // Ortho's apparent scale *is* the camera-to-target distance, so a pivot at
      // a different depth would zoom the view. In a parallel projection the
      // camera may slide along its own view axis without changing the image, so
      // restore the dolly distance that way and leave the pivot on the surface.
      const camera = cameraRef.current;
      const dollyRadius = camera ? camera.position.distanceTo(controls.target) : 0;
      controls.target.copy(pivot);
      if (camera instanceof THREE.OrthographicCamera) {
        const forward = camera.getWorldDirection(_forward);
        const toPivot = _toPivot.subVectors(pivot, camera.position);
        const depth = toPivot.dot(forward);
        const lateralSq = Math.max(0, toPivot.lengthSq() - depth * depth);
        const reach = dollyRadius * dollyRadius - lateralSq;
        const shift = depth - Math.sqrt(Math.max(0, reach));
        if (Math.abs(shift) > 1e-9) {
          camera.position.addScaledVector(forward, shift);
          camera.updateMatrixWorld();
        }
      }
      // Anchor the pivot where it already is, not where the pointer is. A
      // surface hit puts the two in the same place, but the fallback pivots (the
      // model centre, the plate) sit somewhere else on screen: anchoring those to
      // the pointer would swing the view to bring them under the cursor.
      const cameraForAnchor = cameraRef.current;
      let anchorX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      let anchorY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      if (cameraForAnchor) {
        cameraForAnchor.updateMatrixWorld();
        const projected = _projected.copy(pivot).project(cameraForAnchor);
        if (Number.isFinite(projected.x) && Number.isFinite(projected.y) && projected.z < 1) {
          anchorX = projected.x;
          anchorY = projected.y;
        }
      }
      controls.anchorNdc.set(anchorX, anchorY);
      pickedRef.current.copy(pivot);
      pickedRefValid.current = true;
      setOrbitTargetFromPoint(pivot, { animate: false });
    };

    container.addEventListener('pointerdown', onPointerDown, true);
    return () => container.removeEventListener('pointerdown', onPointerDown, true);
  }, [active, cameraRef, containerRef, controlsRef, resolvePivot, setOrbitTargetFromPoint]);

  // Someone else framing the scene means their target, not the picked one.
  React.useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    _target.fromArray(orbitTarget);
    if (pickedRefValid.current && _target.distanceToSquared(pickedRef.current) <= TARGET_EPSILON_SQ) {
      return;
    }
    pickedRefValid.current = false;
    controls.anchorNdc.set(0, 0);
  }, [controlsRef, orbitTarget]);

  React.useEffect(() => {
    if (active) return;
    pickedRefValid.current = false;
    controlsRef.current?.anchorNdc.set(0, 0);
  }, [active, controlsRef]);

  return null;
}
