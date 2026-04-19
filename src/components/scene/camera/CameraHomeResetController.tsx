"use client";

import React from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

type CameraHomeResetControllerProps = {
  runId: number;
  homePosition: [number, number, number];
  homeTarget?: [number, number, number];
  homeFovDeg?: number;
  onComplete?: (runId: number) => void;
};

type OrbitLikeControls = {
  target: THREE.Vector3;
  enabled?: boolean;
  enableRotate: boolean;
  enablePan: boolean;
  enableZoom: boolean;
  minPolarAngle?: number;
  maxPolarAngle?: number;
  enableDamping?: boolean;
  update: () => void;
};

function isOrbitLikeControls(value: unknown): value is OrbitLikeControls {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<OrbitLikeControls>;
  return (
    !!maybe.target &&
    typeof maybe.enableRotate === 'boolean' &&
    typeof maybe.enablePan === 'boolean' &&
    typeof maybe.enableZoom === 'boolean' &&
    typeof maybe.update === 'function'
  );
}

export function CameraHomeResetController({
  runId,
  homePosition,
  homeTarget = [0, 0, 0],
  homeFovDeg = 50,
  onComplete,
}: CameraHomeResetControllerProps) {
  const { camera, controls, invalidate } = useThree();

  const animatingRef = React.useRef(false);
  const rafRef = React.useRef<number | null>(null);
  const activeRunIdRef = React.useRef<number>(0);
  const completedRunIdRef = React.useRef<number>(0);

  React.useLayoutEffect(() => {
    if (!runId) return;
    if (completedRunIdRef.current === runId) return;
    if (activeRunIdRef.current === runId) return;
    if (!isOrbitLikeControls(controls)) return;

    activeRunIdRef.current = runId;

    const startPos = camera.position.clone();
    const endPos = new THREE.Vector3(homePosition[0], homePosition[1], homePosition[2]);
    const endTarget = new THREE.Vector3(homeTarget[0], homeTarget[1], homeTarget[2]);
    const worldUp = new THREE.Vector3(0, 0, 1);

    // Keep reset motion above the plate/horizon to avoid under-plate flips.
    const minDirectionZ = 0.08;
    const startOffset = startPos.clone().sub(endTarget);
    const endOffset = endPos.clone().sub(endTarget);
    const startDistance = Math.max(0.001, startOffset.length());
    const endDistance = Math.max(0.001, endOffset.length());
    const startDirection = (startOffset.lengthSq() > 1e-10
      ? startOffset.clone().normalize()
      : new THREE.Vector3(0, -1, 1).normalize());
    const endDirection = (endOffset.lengthSq() > 1e-10
      ? endOffset.clone().normalize()
      : startDirection.clone());

    if (startDirection.z < minDirectionZ) {
      startDirection.z = minDirectionZ;
      startDirection.normalize();
    }
    if (endDirection.z < minDirectionZ) {
      endDirection.z = minDirectionZ;
      endDirection.normalize();
    }

    const directionArc = new THREE.Quaternion().setFromUnitVectors(startDirection, endDirection);
    const directionQuat = new THREE.Quaternion();
    const currentDirection = new THREE.Vector3();

    const isOrthographic = camera instanceof THREE.OrthographicCamera;
    const startZoom = isOrthographic ? (camera as THREE.OrthographicCamera).zoom : 1;
    let endZoom = 1;

    if (isOrthographic) {
      const ortho = camera as THREE.OrthographicCamera;
      const frustumHeight = Math.max(1e-6, ortho.top - ortho.bottom);
      const homeDistance = Math.max(0.001, endPos.distanceTo(endTarget));
      const homeWorldHeight = Math.max(1e-6, 2 * Math.tan(THREE.MathUtils.degToRad(homeFovDeg) * 0.5) * homeDistance);
      endZoom = THREE.MathUtils.clamp(frustumHeight / homeWorldHeight, 0.0001, 200);
    }

    animatingRef.current = true;
    const prevEnableDamping = controls.enableDamping;
    const prevEnabled = controls.enabled;
    const prevEnableRotate = controls.enableRotate;
    const prevEnablePan = controls.enablePan;
    const prevEnableZoom = controls.enableZoom;
    const prevMinPolarAngle = controls.minPolarAngle;
    const prevMaxPolarAngle = controls.maxPolarAngle;

    if (typeof prevEnableDamping === 'boolean') {
      controls.enableDamping = false;
    }
    if (typeof prevEnabled === 'boolean') {
      controls.enabled = false;
    }

    controls.enableRotate = false;
    controls.enablePan = false;
    controls.enableZoom = false;

    if (typeof controls.minPolarAngle === 'number') {
      controls.minPolarAngle = 0.0;
    }
    if (typeof controls.maxPolarAngle === 'number') {
      controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
    }

    const duration = 650;
    let startTime: number | null = null;

    const animate = (now: number) => {
      if (!animatingRef.current) return;
      if (startTime === null) startTime = now;

      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = THREE.MathUtils.smootherstep(t, 0, 1);

      controls.target.copy(endTarget);

      directionQuat.identity().slerp(directionArc, eased);
      currentDirection.copy(startDirection).applyQuaternion(directionQuat).normalize();
      if (currentDirection.z < minDirectionZ) {
        currentDirection.z = minDirectionZ;
        currentDirection.normalize();
      }

      const currentDistance = THREE.MathUtils.lerp(startDistance, endDistance, eased);
      camera.position.copy(endTarget).addScaledVector(currentDirection, currentDistance);

      camera.up.copy(worldUp);

      if (isOrthographic) {
        const ortho = camera as THREE.OrthographicCamera;
        ortho.zoom = THREE.MathUtils.lerp(startZoom, endZoom, eased);
        ortho.updateProjectionMatrix();
      }

      controls.update();
      // Drei's OrbitControls.update() emits 'change' on state diff and
      // auto-invalidates; the explicit invalidate here is defensive in case
      // an idle step produces no diff but we still need the frame rendered.
      invalidate();

      if (t < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        animatingRef.current = false;
        rafRef.current = null;
        activeRunIdRef.current = 0;
        completedRunIdRef.current = runId;
        if (typeof prevEnableDamping === 'boolean') {
          controls.enableDamping = prevEnableDamping;
        }
        if (typeof prevEnabled === 'boolean') {
          controls.enabled = prevEnabled;
        }
        controls.enableRotate = prevEnableRotate;
        controls.enablePan = prevEnablePan;
        controls.enableZoom = prevEnableZoom;
        if (typeof prevMinPolarAngle === 'number') {
          controls.minPolarAngle = prevMinPolarAngle;
        }
        if (typeof prevMaxPolarAngle === 'number') {
          controls.maxPolarAngle = prevMaxPolarAngle;
        }

        camera.position.copy(endPos);
  camera.up.copy(worldUp);
        controls.target.copy(endTarget);
        controls.update();

        onComplete?.(runId);
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      animatingRef.current = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (typeof prevEnableDamping === 'boolean') {
        controls.enableDamping = prevEnableDamping;
      }
      if (typeof prevEnabled === 'boolean') {
        controls.enabled = prevEnabled;
      }
      controls.enableRotate = prevEnableRotate;
      controls.enablePan = prevEnablePan;
      controls.enableZoom = prevEnableZoom;
      if (typeof prevMinPolarAngle === 'number') {
        controls.minPolarAngle = prevMinPolarAngle;
      }
      if (typeof prevMaxPolarAngle === 'number') {
        controls.maxPolarAngle = prevMaxPolarAngle;
      }
      if (activeRunIdRef.current === runId && completedRunIdRef.current !== runId) {
        activeRunIdRef.current = 0;
      }
    };
  }, [camera, controls, homeFovDeg, homePosition, homeTarget, onComplete, runId]);

  return null;
}
