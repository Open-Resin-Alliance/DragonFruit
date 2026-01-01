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
  setOrbitTargetFromPoint: (point: THREE.Vector3) => void;
  introBoundsSnapshot: THREE.Box3 | null;
  cameraIntroRunId: number;
};

export function useStlLoadCameraIntro(models: LoadedModel[]): StlLoadCameraIntroState {
  const [cameraIntroRunId, setCameraIntroRunId] = React.useState(0);
  const prevModelCountRef = React.useRef(0);
  React.useLayoutEffect(() => {
    const prev = prevModelCountRef.current;
    const next = models.length;
    prevModelCountRef.current = next;
    if (prev === 0 && next > 0) {
      setCameraIntroRunId((id) => id + 1);
    }
  }, [models.length]);

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

  const defaultCamera = React.useMemo<DefaultCameraConfig>(() => ({
    position: [-220, -220, 260],
    fov: 50,
    up: [0, 0, 1],
  }), []);

  const [introBoundsSnapshot, setIntroBoundsSnapshot] = React.useState<THREE.Box3 | null>(null);
  const [orbitTarget, setOrbitTarget] = React.useState<[number, number, number]>([0, 0, 0]);

  const setOrbitTargetFromPoint = React.useCallback((point: THREE.Vector3) => {
    setOrbitTarget([point.x, point.y, point.z]);
  }, []);

  React.useLayoutEffect(() => {
    if (!cameraIntroRunId) return;
    if (!sceneWorldBounds) return;

    const snap = sceneWorldBounds.clone();
    const center = snap.getCenter(new THREE.Vector3());
    setIntroBoundsSnapshot(snap);
    setOrbitTarget([center.x, center.y, center.z]);
  }, [cameraIntroRunId, sceneWorldBounds]);

  return {
    defaultCamera,
    orbitTarget,
    setOrbitTargetFromPoint,
    introBoundsSnapshot,
    cameraIntroRunId,
  };
}
