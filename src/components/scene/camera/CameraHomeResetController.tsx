"use client";

import React from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

type CameraHomeResetControllerProps = {
  runId: number;
  homePosition: [number, number, number];
  homeTarget?: [number, number, number];
  onComplete?: (runId: number) => void;
};

type OrbitLikeControls = {
  target: THREE.Vector3;
  enableRotate: boolean;
  enablePan: boolean;
  enableZoom: boolean;
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
  onComplete,
}: CameraHomeResetControllerProps) {
  const { camera, controls } = useThree();

  const animatingRef = React.useRef(false);
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

    animatingRef.current = true;
    const duration = 650;
    let startTime: number | null = null;

    const animate = (now: number) => {
      if (!animatingRef.current) return;
      if (startTime === null) startTime = now;

      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      camera.position.lerpVectors(startPos, endPos, eased);
      controls.target.lerpVectors(startTarget, endTarget, eased);
      controls.update();

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        animatingRef.current = false;
        activeRunIdRef.current = 0;
        completedRunIdRef.current = runId;

        onComplete?.(runId);
      }
    };

    requestAnimationFrame(animate);

    return () => {
      animatingRef.current = false;
      if (activeRunIdRef.current === runId && completedRunIdRef.current !== runId) {
        activeRunIdRef.current = 0;
      }
    };
  }, [camera, controls, homePosition, homeTarget, onComplete, runId]);

  return null;
}
