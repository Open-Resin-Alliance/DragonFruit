"use client";

import React from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

type CameraIntroControllerProps = {
  bounds: THREE.Box3 | null;
  runId: number;
  onComplete?: (runId: number) => void;
  preserveCurrentViewDirection?: boolean;
};

type OrbitLikeControls = {
  target: THREE.Vector3;
  update: () => void;
};

function isOrbitLikeControls(value: unknown): value is OrbitLikeControls {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<OrbitLikeControls>;
  return !!maybe.target && typeof maybe.update === 'function';
}

export function CameraIntroController({ bounds, runId, onComplete, preserveCurrentViewDirection = false }: CameraIntroControllerProps) {
  const { camera, controls, size } = useThree();
  const animatingRef = React.useRef(false);
  const activeRunIdRef = React.useRef<number>(0);
  const completedRunIdRef = React.useRef<number>(0);

  React.useLayoutEffect(() => {
    if (!runId) return;
    if (completedRunIdRef.current === runId) return;
    if (activeRunIdRef.current === runId) return;
    if (!bounds) return;
    if (!isOrbitLikeControls(controls)) return;

    const orbitControls = controls;

    activeRunIdRef.current = runId;

    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const center = sphere.center.clone();
    const radius = Math.max(0.001, sphere.radius);

    const isPerspective = camera instanceof THREE.PerspectiveCamera;
    const isOrthographic = camera instanceof THREE.OrthographicCamera;
    const vFov = isPerspective
      ? THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov)
      : THREE.MathUtils.degToRad(50);
    const aspect = size.width / Math.max(1, size.height);

    const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * aspect);
    const minFov = Math.max(0.0001, Math.min(vFov, hFov));
    const distance = (radius / Math.sin(minFov * 0.5)) * 1.2;

    const fallbackViewDir = new THREE.Vector3(-1, -1, 1).normalize();
    const currentViewVector = camera.position.clone().sub(orbitControls.target);
    const hasValidCurrentView = currentViewVector.lengthSq() > 1e-8;
    const viewDir = preserveCurrentViewDirection && hasValidCurrentView
      ? currentViewVector.normalize()
      : fallbackViewDir;
    const endPos = center.clone().add(viewDir.clone().multiplyScalar(distance));
    const startPos = camera.position.clone();
    const startTarget = orbitControls.target.clone();
    const startZoom = isOrthographic ? (camera as THREE.OrthographicCamera).zoom : 1;

    let endZoom = startZoom;
    if (isOrthographic) {
      const ortho = camera as THREE.OrthographicCamera;
      const frustumHeight = Math.max(1e-6, ortho.top - ortho.bottom);
      const worldHeightAtDistance = Math.max(1e-6, 2 * Math.tan(vFov * 0.5) * distance);
      endZoom = THREE.MathUtils.clamp(frustumHeight / worldHeightAtDistance, 0.0001, 200);
    }

    if (preserveCurrentViewDirection) {
      orbitControls.target.copy(center);
      orbitControls.update();
    }

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

      if (isOrthographic) {
        const ortho = camera as THREE.OrthographicCamera;
        ortho.zoom = THREE.MathUtils.lerp(startZoom, endZoom, eased);
        ortho.updateProjectionMatrix();
      }

      if (preserveCurrentViewDirection) {
        orbitControls.target.copy(center);
      } else {
        orbitControls.target.lerpVectors(startTarget, center, eased);
      }
      orbitControls.update();

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
  }, [bounds, camera, controls, onComplete, preserveCurrentViewDirection, runId, size.height, size.width]);

  return null;
}
