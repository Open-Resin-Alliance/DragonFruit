"use client";

import React from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

type CameraIntroControllerProps = {
  bounds: THREE.Box3 | null;
  runId: number;
  onComplete?: (runId: number) => void;
};

export function CameraIntroController({ bounds, runId, onComplete }: CameraIntroControllerProps) {
  const { camera, controls, size } = useThree();
  const animatingRef = React.useRef(false);
  const activeRunIdRef = React.useRef<number>(0);
  const completedRunIdRef = React.useRef<number>(0);
  const savedControlsStateRef = React.useRef<{ enableRotate: boolean; enablePan: boolean; enableZoom: boolean } | null>(null);

  React.useLayoutEffect(() => {
    if (!runId) return;
    if (completedRunIdRef.current === runId) return;
    if (activeRunIdRef.current === runId) return;
    if (!bounds || !controls) return;

    const orbitControls = controls as any;
    if (!orbitControls?.target) {
      return;
    }

    activeRunIdRef.current = runId;

    if (!savedControlsStateRef.current) {
      savedControlsStateRef.current = {
        enableRotate: orbitControls.enableRotate,
        enablePan: orbitControls.enablePan,
        enableZoom: orbitControls.enableZoom,
      };
    }
    orbitControls.enableRotate = false;
    orbitControls.enablePan = false;
    orbitControls.enableZoom = false;

    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const center = sphere.center.clone();
    const radius = Math.max(0.001, sphere.radius);

    const perspective = camera as THREE.PerspectiveCamera;
    const isPerspective = (perspective as any).isPerspectiveCamera === true;
    const vFov = isPerspective ? THREE.MathUtils.degToRad(perspective.fov) : THREE.MathUtils.degToRad(50);
    const aspect = size.width / Math.max(1, size.height);

    const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * aspect);
    const minFov = Math.max(0.0001, Math.min(vFov, hFov));
    const distance = (radius / Math.sin(minFov * 0.5)) * 1.2;

    const viewDir = new THREE.Vector3(-1, -1, 1).normalize();
    const endPos = center.clone().add(viewDir.clone().multiplyScalar(distance));
    const startPos = center
      .clone()
      .add(viewDir.clone().multiplyScalar(distance * 2.0))
      .add(new THREE.Vector3(0, 0, distance * 0.35));

    if (isPerspective) {
      perspective.near = Math.max(0.01, distance / 200);
      perspective.far = Math.max(1000, distance * 200);
      perspective.updateProjectionMatrix();
    }

    orbitControls.target.copy(center);
    camera.position.copy(startPos);
    if (typeof camera.lookAt === 'function') {
      camera.lookAt(center);
    }
    orbitControls.update();

    animatingRef.current = true;
    const duration = 1000;
    let startTime: number | null = null;

    const animate = (now: number) => {
      if (!animatingRef.current) return;
      if (startTime === null) startTime = now;

      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      camera.position.lerpVectors(startPos, endPos, eased);
      orbitControls.target.copy(center);
      orbitControls.update();

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        animatingRef.current = false;
        activeRunIdRef.current = 0;
        completedRunIdRef.current = runId;

        if (savedControlsStateRef.current) {
          orbitControls.enableRotate = savedControlsStateRef.current.enableRotate;
          orbitControls.enablePan = savedControlsStateRef.current.enablePan;
          orbitControls.enableZoom = savedControlsStateRef.current.enableZoom;
          savedControlsStateRef.current = null;
        }

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
  }, [bounds, camera, controls, onComplete, runId, size.height, size.width]);

  return null;
}
