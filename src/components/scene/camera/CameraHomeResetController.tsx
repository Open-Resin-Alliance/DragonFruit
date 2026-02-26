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
  enableRotate: boolean;
  enablePan: boolean;
  enableZoom: boolean;
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
  const { camera, controls } = useThree();

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
    const startTarget = controls.target.clone();
    const endPos = new THREE.Vector3(homePosition[0], homePosition[1], homePosition[2]);
    const endTarget = new THREE.Vector3(homeTarget[0], homeTarget[1], homeTarget[2]);
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
    if (typeof prevEnableDamping === 'boolean') {
      controls.enableDamping = false;
    }
    const duration = 650;
    let startTime: number | null = null;

    const animate = (now: number) => {
      if (!animatingRef.current) return;
      if (startTime === null) startTime = now;

      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = THREE.MathUtils.smootherstep(t, 0, 1);

      camera.position.lerpVectors(startPos, endPos, eased);
      controls.target.lerpVectors(startTarget, endTarget, eased);

      if (isOrthographic) {
        const ortho = camera as THREE.OrthographicCamera;
        ortho.zoom = THREE.MathUtils.lerp(startZoom, endZoom, eased);
        ortho.updateProjectionMatrix();
      }

      controls.update();

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

        camera.position.copy(endPos);
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
      if (activeRunIdRef.current === runId && completedRunIdRef.current !== runId) {
        activeRunIdRef.current = 0;
      }
    };
  }, [camera, controls, homeFovDeg, homePosition, homeTarget, onComplete, runId]);

  return null;
}
