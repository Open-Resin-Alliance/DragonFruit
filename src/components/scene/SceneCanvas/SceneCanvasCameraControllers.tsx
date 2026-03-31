import React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { CameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';

export function CameraProjectionController({ mode }: { mode: CameraProjectionMode }) {
  const { camera, controls, set, size } = useThree();
  const ORTHO_NEAR = -20000;
  const ORTHO_FAR = 20000;
  const PERSPECTIVE_NEAR = 0.005;
  const PERSPECTIVE_FAR = 50000;

  React.useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    if (mode === 'orthographic' && camera instanceof THREE.OrthographicCamera) {
      camera.left = -aspect;
      camera.right = aspect;
      camera.top = 1;
      camera.bottom = -1;
      camera.near = ORTHO_NEAR;
      camera.far = ORTHO_FAR;
      camera.updateProjectionMatrix();
      return;
    }

    if (mode === 'perspective' && camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = aspect;
      camera.near = PERSPECTIVE_NEAR;
      camera.far = PERSPECTIVE_FAR;
      camera.updateProjectionMatrix();
      return;
    }

    const target = (controls as any)?.target instanceof THREE.Vector3
      ? ((controls as any).target as THREE.Vector3).clone()
      : new THREE.Vector3(0, 0, 0);

    if (mode === 'orthographic') {
      const next = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, ORTHO_NEAR, ORTHO_FAR);
      next.position.copy(camera.position);
      next.up.copy(camera.up);

      if (camera instanceof THREE.PerspectiveCamera) {
        const distance = Math.max(0.001, camera.position.distanceTo(target));
        const fov = THREE.MathUtils.degToRad(camera.fov);
        const worldHeight = Math.max(1e-6, 2 * Math.tan(fov * 0.5) * distance);
        next.zoom = Math.max(0.0001, 2 / worldHeight);
      } else {
        next.zoom = (camera as THREE.OrthographicCamera).zoom;
      }

      next.updateProjectionMatrix();
      set({ camera: next });
      if (controls && typeof controls === 'object' && 'object' in controls) {
        (controls as any).object = next;
        (controls as any).update?.();
      }
      return;
    }

    const next = new THREE.PerspectiveCamera(50, aspect, PERSPECTIVE_NEAR, PERSPECTIVE_FAR);
    next.up.copy(camera.up);

    if (camera instanceof THREE.OrthographicCamera) {
      const span = Math.max(1e-6, (camera.top - camera.bottom) / Math.max(1e-6, camera.zoom));
      const fov = THREE.MathUtils.degToRad(next.fov);
      const distance = Math.max(0.001, span / (2 * Math.tan(fov * 0.5)));
      const direction = camera.position.clone().sub(target);
      if (direction.lengthSq() < 1e-10) direction.set(-1, -1, 1);
      direction.normalize();
      next.position.copy(target.clone().addScaledVector(direction, distance));
    } else {
      next.position.copy(camera.position);
    }

    next.updateProjectionMatrix();
    set({ camera: next });
    if (controls && typeof controls === 'object' && 'object' in controls) {
      (controls as any).object = next;
      (controls as any).update?.();
    }
  }, [camera, controls, mode, set, size.height, size.width]);

  return null;
}

export function OrbitPivotIndicator({
  visible,
  color = '#58ff6a',
}: {
  visible: boolean;
  color?: string;
}) {
  const { controls } = useThree();
  const markerRef = React.useRef<THREE.Points>(null);
  const markerPoint = React.useMemo(() => new Float32Array([0, 0, 0]), []);
  const markerTexture = React.useMemo(() => {
    if (typeof document === 'undefined') return null;

    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }, []);

  React.useEffect(() => {
    return () => {
      markerTexture?.dispose();
    };
  }, [markerTexture]);

  useFrame(() => {
    if (!visible) return;
    if (!markerRef.current) return;
    if (!controls || typeof controls !== 'object' || !('target' in controls)) return;

    const orbit = controls as unknown as { target: THREE.Vector3 };
    markerRef.current.position.copy(orbit.target);
  });

  if (!visible) return null;

  return (
    <points ref={markerRef} raycast={() => null} renderOrder={32}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[markerPoint, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        color={color}
        size={8}
        sizeAttenuation={false}
        map={markerTexture}
        alphaTest={0.5}
        transparent
        opacity={0.6}
        depthTest={false}
        depthWrite={false}
      />
    </points>
  );
}

export function CameraModeEntryFramingController({
  runId,
  restoreRunId,
  target,
  plateWidthMm,
  plateDepthMm,
}: {
  runId: number;
  restoreRunId: number;
  target: THREE.Vector3;
  plateWidthMm: number;
  plateDepthMm: number;
}) {
  const { camera, controls, size } = useThree();

  const activeRunIdRef = React.useRef<number | null>(null);
  const completedFrameRunIdRef = React.useRef(0);
  const completedRestoreRunIdRef = React.useRef(0);
  const animatingRef = React.useRef(false);
  const rafRef = React.useRef<number | null>(null);
  const savedDampingRef = React.useRef<boolean | null>(null);
  const savedEnabledRef = React.useRef<boolean | null>(null);
  const savedEnableRotateRef = React.useRef<boolean | null>(null);
  const savedEnablePanRef = React.useRef<boolean | null>(null);
  const savedEnableZoomRef = React.useRef<boolean | null>(null);
  const cameraSnapshotRef = React.useRef<{
    position: THREE.Vector3;
    target: THREE.Vector3;
    zoom: number | null;
  } | null>(null);

  const cancelAnimation = React.useCallback(() => {
    animatingRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const animateTo = React.useCallback((params: {
    startPos: THREE.Vector3;
    endPos: THREE.Vector3;
    startTarget: THREE.Vector3;
    endTarget: THREE.Vector3;
    startZoom: number;
    endZoom: number;
    isOrthographic: boolean;
    durationMs: number;
    onComplete?: () => void;
  }) => {
    const {
      startPos,
      endPos,
      startTarget,
      endTarget,
      startZoom,
      endZoom,
      isOrthographic,
      durationMs,
      onComplete,
    } = params;

    cancelAnimation();
    animatingRef.current = true;

    let startTime: number | null = null;
    const orbit = controls as unknown as {
      target: THREE.Vector3;
      enabled?: boolean;
      enableRotate?: boolean;
      enablePan?: boolean;
      enableZoom?: boolean;
      enableDamping?: boolean;
      update: () => void;
    };

    if (savedDampingRef.current === null && typeof orbit.enableDamping === 'boolean') {
      savedDampingRef.current = orbit.enableDamping;
      orbit.enableDamping = false;
    }
    if (savedEnabledRef.current === null && typeof orbit.enabled === 'boolean') {
      savedEnabledRef.current = orbit.enabled;
      orbit.enabled = false;
    }
    if (savedEnableRotateRef.current === null && typeof orbit.enableRotate === 'boolean') {
      savedEnableRotateRef.current = orbit.enableRotate;
      orbit.enableRotate = false;
    }
    if (savedEnablePanRef.current === null && typeof orbit.enablePan === 'boolean') {
      savedEnablePanRef.current = orbit.enablePan;
      orbit.enablePan = false;
    }
    if (savedEnableZoomRef.current === null && typeof orbit.enableZoom === 'boolean') {
      savedEnableZoomRef.current = orbit.enableZoom;
      orbit.enableZoom = false;
    }

    const tick = (now: number) => {
      if (!animatingRef.current) return;
      if (startTime == null) startTime = now;

      const t = Math.min(1, (now - startTime) / durationMs);
      const eased = THREE.MathUtils.smootherstep(t, 0, 1);

      camera.position.lerpVectors(startPos, endPos, eased);
      orbit.target.lerpVectors(startTarget, endTarget, eased);

      if (isOrthographic) {
        const ortho = camera as THREE.OrthographicCamera;
        ortho.zoom = THREE.MathUtils.lerp(startZoom, endZoom, eased);
        ortho.updateProjectionMatrix();
      }

      orbit.update();

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        animatingRef.current = false;
        rafRef.current = null;
        if (savedDampingRef.current !== null && typeof orbit.enableDamping === 'boolean') {
          orbit.enableDamping = savedDampingRef.current;
          savedDampingRef.current = null;
        }
        if (savedEnabledRef.current !== null && typeof orbit.enabled === 'boolean') {
          orbit.enabled = savedEnabledRef.current;
          savedEnabledRef.current = null;
        }
        if (savedEnableRotateRef.current !== null && typeof orbit.enableRotate === 'boolean') {
          orbit.enableRotate = savedEnableRotateRef.current;
          savedEnableRotateRef.current = null;
        }
        if (savedEnablePanRef.current !== null && typeof orbit.enablePan === 'boolean') {
          orbit.enablePan = savedEnablePanRef.current;
          savedEnablePanRef.current = null;
        }
        if (savedEnableZoomRef.current !== null && typeof orbit.enableZoom === 'boolean') {
          orbit.enableZoom = savedEnableZoomRef.current;
          savedEnableZoomRef.current = null;
        }
        onComplete?.();
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [camera, cancelAnimation, controls]);

  React.useLayoutEffect(() => {
    if (!runId) return;
    if (completedFrameRunIdRef.current === runId) return;
    if (activeRunIdRef.current === runId) return;
    if (!controls || typeof controls !== 'object' || !('target' in controls) || !('update' in controls)) return;

    const orbit = controls as unknown as {
      target: THREE.Vector3;
      update: () => void;
    };

    activeRunIdRef.current = runId;

    const startPos = camera.position.clone();
    const startTarget = orbit.target.clone();

    cameraSnapshotRef.current = {
      position: startPos.clone(),
      target: startTarget.clone(),
      zoom: camera instanceof THREE.OrthographicCamera ? camera.zoom : null,
    };

    const padding = 1.04;
    const fov = camera instanceof THREE.PerspectiveCamera
      ? THREE.MathUtils.degToRad(camera.fov)
      : THREE.MathUtils.degToRad(50);
    const aspect = size.width / Math.max(1, size.height);
    const hFov = 2 * Math.atan(Math.tan(fov * 0.5) * aspect);
    const minFov = Math.max(0.0001, Math.min(fov, hFov));

    const halfDiagonal = 0.5 * Math.hypot(plateWidthMm, plateDepthMm) * padding;
    const distance = Math.max(90, halfDiagonal / Math.sin(minFov * 0.5));
    const viewDir = new THREE.Vector3(0, -0.52, 1).normalize();
    const endTarget = target.clone().add(new THREE.Vector3(0, -plateDepthMm * 0.055, 0));
    const endPos = endTarget.clone().addScaledVector(viewDir, distance);

    const isOrthographic = camera instanceof THREE.OrthographicCamera;
    const startZoom = isOrthographic ? (camera as THREE.OrthographicCamera).zoom : 1;
    let endZoom = startZoom;

    if (isOrthographic) {
      const ortho = camera as THREE.OrthographicCamera;
      const frustumHeight = Math.max(1e-6, ortho.top - ortho.bottom);
      const requiredWorldHeight = Math.max(plateWidthMm, plateDepthMm) * padding;
      endZoom = THREE.MathUtils.clamp(frustumHeight / Math.max(1e-6, requiredWorldHeight), 0.0001, 200);
    }

    animateTo({
      startPos,
      endPos,
      startTarget,
      endTarget,
      startZoom,
      endZoom,
      isOrthographic,
      durationMs: 700,
      onComplete: () => {
        activeRunIdRef.current = null;
        completedFrameRunIdRef.current = runId;
      },
    });

    return () => {
      if (activeRunIdRef.current === runId && completedFrameRunIdRef.current !== runId) {
        activeRunIdRef.current = null;
      }
    };
  }, [animateTo, camera, controls, plateDepthMm, plateWidthMm, runId, size.height, size.width, target]);

  React.useLayoutEffect(() => {
    if (!restoreRunId) return;
    if (completedRestoreRunIdRef.current === restoreRunId) return;
    if (activeRunIdRef.current === restoreRunId) return;
    if (!controls || typeof controls !== 'object' || !('target' in controls) || !('update' in controls)) return;

    const snapshot = cameraSnapshotRef.current;
    if (!snapshot) {
      completedRestoreRunIdRef.current = restoreRunId;
      return;
    }

    const orbit = controls as unknown as {
      target: THREE.Vector3;
      update: () => void;
    };

    activeRunIdRef.current = restoreRunId;

    const isOrthographic = camera instanceof THREE.OrthographicCamera;
    const startPos = camera.position.clone();
    const endPos = snapshot.position.clone();
    const startTarget = orbit.target.clone();
    const endTarget = snapshot.target.clone();
    const startZoom = isOrthographic ? (camera as THREE.OrthographicCamera).zoom : 1;
    const endZoom = (isOrthographic && snapshot.zoom != null) ? snapshot.zoom : startZoom;

    animateTo({
      startPos,
      endPos,
      startTarget,
      endTarget,
      startZoom,
      endZoom,
      isOrthographic,
      durationMs: 520,
      onComplete: () => {
        activeRunIdRef.current = null;
        completedRestoreRunIdRef.current = restoreRunId;
        cameraSnapshotRef.current = null;
      },
    });

    return () => {
      if (activeRunIdRef.current === restoreRunId && completedRestoreRunIdRef.current !== restoreRunId) {
        activeRunIdRef.current = null;
      }
    };
  }, [animateTo, camera, controls, restoreRunId]);

  React.useEffect(() => {
    return () => {
      cancelAnimation();
      const orbit = controls as unknown as {
        enabled?: boolean;
        enableRotate?: boolean;
        enablePan?: boolean;
        enableZoom?: boolean;
        enableDamping?: boolean;
      };
      if (savedDampingRef.current !== null && orbit && typeof orbit.enableDamping === 'boolean') {
        orbit.enableDamping = savedDampingRef.current;
        savedDampingRef.current = null;
      }
      if (savedEnabledRef.current !== null && orbit && typeof orbit.enabled === 'boolean') {
        orbit.enabled = savedEnabledRef.current;
        savedEnabledRef.current = null;
      }
      if (savedEnableRotateRef.current !== null && orbit && typeof orbit.enableRotate === 'boolean') {
        orbit.enableRotate = savedEnableRotateRef.current;
        savedEnableRotateRef.current = null;
      }
      if (savedEnablePanRef.current !== null && orbit && typeof orbit.enablePan === 'boolean') {
        orbit.enablePan = savedEnablePanRef.current;
        savedEnablePanRef.current = null;
      }
      if (savedEnableZoomRef.current !== null && orbit && typeof orbit.enableZoom === 'boolean') {
        orbit.enableZoom = savedEnableZoomRef.current;
        savedEnableZoomRef.current = null;
      }
    };
  }, [cancelAnimation, controls]);

  return null;
}
