"use client";

import React from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

type CameraIntroControllerProps = {
  bounds: THREE.Box3 | null;
  runId: number;
  onComplete?: (runId: number) => void;
  preserveCurrentViewDirection?: boolean;
  mode?: 'prepare' | 'analysis' | 'support' | 'export';
  plateWidthMm?: number;
  plateDepthMm?: number;
};

type OrbitLikeControls = {
  target: THREE.Vector3;
  enableDamping?: boolean;
  update: () => void;
};

function isOrbitLikeControls(value: unknown): value is OrbitLikeControls {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<OrbitLikeControls>;
  return !!maybe.target && typeof maybe.update === 'function';
}

function easeInOutQuint(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5
    ? 16 * t * t * t * t * t
    : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

export function CameraIntroController({
  bounds,
  runId,
  onComplete,
  preserveCurrentViewDirection = false,
  mode = 'prepare',
  plateWidthMm,
  plateDepthMm,
}: CameraIntroControllerProps) {
  const { camera, controls, size } = useThree();
  const animatingRef = React.useRef(false);
  const rafRef = React.useRef<number | null>(null);
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
    const modelDistance = (radius / Math.sin(minFov * 0.5));

    const hasPlateDims = Number.isFinite(plateWidthMm) && Number.isFinite(plateDepthMm)
      && (plateWidthMm ?? 0) > 0
      && (plateDepthMm ?? 0) > 0;

    const plateHalfDiagonal = hasPlateDims
      ? 0.5 * Math.hypot(plateWidthMm as number, plateDepthMm as number)
      : 0;
    const plateDistance = hasPlateDims
      ? (plateHalfDiagonal / Math.sin(minFov * 0.5))
      : 0;

    const yawRad = THREE.MathUtils.degToRad(20);
    // Adaptive support framing: smaller models get a tighter fit, larger models get more margin.
    const supportFitMargin = THREE.MathUtils.clamp(1.08 + (radius * 0.0012), 1.08, 1.26);
    const prepareFitDistance = Math.max(modelDistance * 0.95, plateDistance * 0.9) * 0.8;
    const supportFitDistance = modelDistance * supportFitMargin;
    const distance = mode === 'support'
      ? supportFitDistance
      : prepareFitDistance;
    const fallbackViewDir = new THREE.Vector3(-Math.sin(yawRad), -Math.cos(yawRad), 1).normalize();
    const currentViewVector = camera.position.clone().sub(orbitControls.target);
    const hasValidCurrentView = currentViewVector.lengthSq() > 1e-8;
    const viewDir = preserveCurrentViewDirection && hasValidCurrentView
      ? currentViewVector.normalize()
      : fallbackViewDir;

    if (mode === 'support' && viewDir.z < 0.18) {
      viewDir.z = Math.abs(viewDir.z) + 0.24;
      viewDir.normalize();
    }

    const endPos = center.clone().add(viewDir.clone().multiplyScalar(distance));

    if (mode === 'support') {
      const minVerticalClearance = Math.max(10, radius * 0.35);
      if (endPos.z < center.z + minVerticalClearance) {
        endPos.z = center.z + minVerticalClearance;
      }
    }

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
    const prevEnableDamping = orbitControls.enableDamping;
    if (typeof prevEnableDamping === 'boolean') {
      orbitControls.enableDamping = false;
    }
    const duration = 1000;
    let startTime: number | null = null;

    const animate = (now: number) => {
      if (!animatingRef.current) return;
      if (startTime === null) startTime = now;

      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const smoothStep = THREE.MathUtils.smootherstep(t, 0, 1);
      const eased = THREE.MathUtils.lerp(smoothStep, easeInOutQuint(t), 0.72);

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
        rafRef.current = requestAnimationFrame(animate);
      } else {
        animatingRef.current = false;
        rafRef.current = null;
        activeRunIdRef.current = 0;
        completedRunIdRef.current = runId;
        if (typeof prevEnableDamping === 'boolean') {
          orbitControls.enableDamping = prevEnableDamping;
        }

        camera.position.copy(endPos);
        orbitControls.target.copy(center);
        orbitControls.update();

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
        orbitControls.enableDamping = prevEnableDamping;
      }
      if (activeRunIdRef.current === runId && completedRunIdRef.current !== runId) {
        activeRunIdRef.current = 0;
      }
    };
  }, [bounds, camera, controls, mode, onComplete, plateDepthMm, plateWidthMm, preserveCurrentViewDirection, runId, size.height, size.width]);

  return null;
}
