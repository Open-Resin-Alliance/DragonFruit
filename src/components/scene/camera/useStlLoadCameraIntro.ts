"use client";

import React from 'react';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

type DefaultCameraConfig = {
  position: [number, number, number];
  fov: number;
  up: [number, number, number];
};

type StlLoadCameraIntroState = {
  defaultCamera: DefaultCameraConfig;
  orbitTarget: [number, number, number];
  setOrbitTargetFromPoint: (point: THREE.Vector3, options?: { animate?: boolean }) => void;
  introBoundsSnapshot: THREE.Box3 | null;
  cameraIntroRunId: number;
  cameraHomeResetRunId: number;
};

export function useStlLoadCameraIntro(models: LoadedModel[], fallbackOrbitTarget?: THREE.Vector3): StlLoadCameraIntroState {
  const [cameraIntroRunId, setCameraIntroRunId] = React.useState(0);
  const [cameraHomeResetRunId, setCameraHomeResetRunId] = React.useState(0);
  const prevModelCountRef = React.useRef(0);
  const lastAppliedIntroRunIdRef = React.useRef(0);
  const lastFallbackTargetRef = React.useRef<THREE.Vector3 | null>(null);

  const defaultCamera = React.useMemo<DefaultCameraConfig>(() => ({
    position: [
      (fallbackOrbitTarget?.x ?? 0) - 220,
      (fallbackOrbitTarget?.y ?? 0) - 220,
      (fallbackOrbitTarget?.z ?? 0) + 260,
    ],
    fov: 50,
    up: [0, 0, 1],
  }), [fallbackOrbitTarget?.x, fallbackOrbitTarget?.y, fallbackOrbitTarget?.z]);

  const defaultOrbitTarget = React.useMemo(
    () => fallbackOrbitTarget?.clone() ?? new THREE.Vector3(0, 0, 0),
    [fallbackOrbitTarget?.x, fallbackOrbitTarget?.y, fallbackOrbitTarget?.z],
  );

  const [introBoundsSnapshot, setIntroBoundsSnapshot] = React.useState<THREE.Box3 | null>(null);
  const [orbitTarget, setOrbitTarget] = React.useState<[number, number, number]>(() => [defaultOrbitTarget.x, defaultOrbitTarget.y, defaultOrbitTarget.z]);
  const orbitTargetRef = React.useRef(new THREE.Vector3(defaultOrbitTarget.x, defaultOrbitTarget.y, defaultOrbitTarget.z));
  const orbitTargetAnimFrameRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    orbitTargetRef.current.set(orbitTarget[0], orbitTarget[1], orbitTarget[2]);
  }, [orbitTarget]);

  React.useEffect(() => {
    if (models.length > 0) return;

    const target = defaultOrbitTarget;
    if (orbitTargetRef.current.distanceToSquared(target) < 1e-8) return;

    setOrbitTarget([target.x, target.y, target.z]);
  }, [defaultOrbitTarget, models.length]);

  React.useEffect(() => {
    if (models.length > 0) {
      lastFallbackTargetRef.current = defaultOrbitTarget.clone();
      return;
    }

    const previous = lastFallbackTargetRef.current;
    if (previous && previous.distanceToSquared(defaultOrbitTarget) < 1e-8) return;

    lastFallbackTargetRef.current = defaultOrbitTarget.clone();
    setCameraHomeResetRunId((id) => id + 1);
  }, [defaultOrbitTarget, models.length]);

  React.useEffect(() => {
    return () => {
      if (orbitTargetAnimFrameRef.current !== null) {
        cancelAnimationFrame(orbitTargetAnimFrameRef.current);
        orbitTargetAnimFrameRef.current = null;
      }
    };
  }, []);

  React.useLayoutEffect(() => {
    const prev = prevModelCountRef.current;
    const next = models.length;
    prevModelCountRef.current = next;

    if (prev === 0 && next > 0) {
      setCameraIntroRunId((id) => id + 1);
      return;
    }

    if (prev > 0 && next === 0) {
      setCameraHomeResetRunId((id) => id + 1);
      setOrbitTarget([defaultOrbitTarget.x, defaultOrbitTarget.y, defaultOrbitTarget.z]);
      setIntroBoundsSnapshot(null);
    }
  }, [defaultOrbitTarget.x, defaultOrbitTarget.y, defaultOrbitTarget.z, models.length]);

  const sceneWorldBounds = React.useMemo(() => {
    if (models.length === 0) return null;
    const unionBox = new THREE.Box3();
    let hasVisible = false;

    for (const model of models) {
      if (!model.visible) continue;

      const modelBox = model.geometry.bbox.clone();
      const center = model.geometry.center;
      modelBox.translate(new THREE.Vector3(-center.x, -center.y, -center.z));

      const t = model.transform;
      const matrix = new THREE.Matrix4().compose(
        t.position,
        new THREE.Quaternion().setFromEuler(t.rotation),
        t.scale,
      );
      modelBox.applyMatrix4(matrix);

      if (!hasVisible) {
        unionBox.copy(modelBox);
        hasVisible = true;
      } else {
        unionBox.union(modelBox);
      }
    }

    return hasVisible ? unionBox : null;
  }, [models]);

  const setOrbitTargetFromPoint = React.useCallback((point: THREE.Vector3, options?: { animate?: boolean }) => {
    const shouldAnimate = options?.animate ?? true;
    const start = orbitTargetRef.current.clone();
    const end = point.clone();

    if (start.distanceToSquared(end) < 1e-8) return;

    if (orbitTargetAnimFrameRef.current !== null) {
      cancelAnimationFrame(orbitTargetAnimFrameRef.current);
      orbitTargetAnimFrameRef.current = null;
    }

    if (!shouldAnimate) {
      orbitTargetRef.current.copy(end);
      setOrbitTarget([end.x, end.y, end.z]);
      return;
    }

    const durationMs = 220;
    let startTime: number | null = null;

    const animate = (now: number) => {
      if (startTime == null) startTime = now;
      const t = Math.min(1, (now - startTime) / durationMs);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      const next = start.clone().lerp(end, eased);
      orbitTargetRef.current.copy(next);
      setOrbitTarget([next.x, next.y, next.z]);

      if (t < 1) {
        orbitTargetAnimFrameRef.current = requestAnimationFrame(animate);
      } else {
        orbitTargetAnimFrameRef.current = null;
      }
    };

    orbitTargetAnimFrameRef.current = requestAnimationFrame(animate);
  }, []);

  React.useLayoutEffect(() => {
    if (!cameraIntroRunId) return;
    if (!sceneWorldBounds) return;
    if (lastAppliedIntroRunIdRef.current === cameraIntroRunId) return;

    const snap = sceneWorldBounds.clone();

    // Apply focus target once per intro run to avoid camera following during transform/move.
    setIntroBoundsSnapshot(snap);

    const center = snap.getCenter(new THREE.Vector3());
    setOrbitTarget([center.x, center.y, center.z]);
    lastAppliedIntroRunIdRef.current = cameraIntroRunId;
  }, [cameraIntroRunId, introBoundsSnapshot, sceneWorldBounds]);

  return {
    defaultCamera,
    orbitTarget,
    setOrbitTargetFromPoint,
    introBoundsSnapshot,
    cameraIntroRunId,
    cameraHomeResetRunId,
  };
}
