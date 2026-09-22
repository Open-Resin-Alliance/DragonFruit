import React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { CameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';
import {
  ORTHO_FAR,
  ORTHO_NEAR,
  orthoRadiusForPerspectiveFraming,
  syncOrthoFrustum,
} from '@/components/scene/camera/orthoDolly';

function orbitTargetOf(controls: unknown): THREE.Vector3 | null {
  if (!controls || typeof controls !== 'object') return null;
  const target = (controls as { target?: unknown }).target;
  return target instanceof THREE.Vector3 ? target : null;
}

export function CameraProjectionController({
  mode,
  perspectiveFov = 50,
  sceneRadius,
}: {
  mode: CameraProjectionMode;
  perspectiveFov?: number;
  sceneRadius?: number;
}) {
  const { camera, controls, set, size } = useThree();
  const PERSPECTIVE_NEAR = 0.005;
  const PERSPECTIVE_FAR = 50000;

  React.useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    if (mode === 'orthographic' && camera instanceof THREE.OrthographicCamera) {
      // The frustum is derived from the dolly radius (see orthoDolly.ts), so a
      // resize only needs to re-derive it at the new aspect ratio.
      const target = orbitTargetOf(controls) ?? new THREE.Vector3();
      syncOrthoFrustum(camera, target, aspect, { sceneRadius });
      // NOTE: Do NOT call controls.update() here. If we do, and the user
      // hasn't interacted with the camera since the intro animation,
      // OrbitControls may apply internal constraints that cause the view
      // to zoom out unexpectedly when the frustum changes.
      return;
    }

    if (mode === 'perspective' && camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = aspect;
      camera.near = PERSPECTIVE_NEAR;
      camera.far = PERSPECTIVE_FAR;
      camera.fov = perspectiveFov;
      camera.updateProjectionMatrix();
      return;
    }

    const target = (controls as any)?.target instanceof THREE.Vector3
      ? ((controls as any).target as THREE.Vector3).clone()
      : new THREE.Vector3(0, 0, 0);

    if (mode === 'orthographic') {
      // The frustum is derived from the dolly radius: halfHeight =
      // tan(DEFAULT_FOV/2) * |position - target|, zoom pinned to 1. Keeping the
      // camera's position means the ortho view frames the same world region the
      // perspective view did at the reference FOV (see orthoDolly.ts). The
      // reference FOV is the default, not the user's, so the FOV slider never
      // changes the orthographic scale (ADR-0032).
      const next = new THREE.OrthographicCamera(
        -1, 1, 1, -1,
        ORTHO_NEAR, ORTHO_FAR,
      );
      // Prevent R3F's internal updateCamera() from overwriting camera.top with
      // size.height/2 (pixel units) on the first window resize.  Our frustum
      // uses world-space mm, so R3F's pixel-mapped values would cause a sudden
      // scale jump that makes the build plate appear to zoom far out.  With
      // manual=true R3F skips updateCamera entirely and OrthoFrustumSync is the
      // sole authority on left/right/top/bottom.
      (next as any).manual = true;
      // Ortho derives from the reference FOV, perspective uses the user's FOV, so
      // scale the distance to keep the apparent size. Without this, a switch at a
      // non-default FOV changes the framing and every round trip compounds it.
      const viewOffset = camera.position.clone().sub(target);
      const viewDistance = viewOffset.length();
      if (viewDistance < 1e-10) viewOffset.set(-1, -1, 1);
      viewOffset.normalize();
      const orthoDistance = orthoRadiusForPerspectiveFraming(viewDistance, perspectiveFov);
      next.position.copy(target).addScaledVector(viewOffset, orthoDistance);
      // Preserve view direction. Without copying quaternion, the new camera has identity
      // rotation (looking down -Z) until OrbitControls.update() corrects it. At initial
      // app load controls is null, so update() is never called — the camera stays
      // mis-oriented for every pick frame until the first gl.render().
      next.quaternion.copy(camera.quaternion);
      next.up.copy(camera.up);

      syncOrthoFrustum(next, target, aspect, { sceneRadius });
      // Force matrixWorld to be set from position+quaternion immediately so the
      // PickingRenderer (which runs in useFrame, before gl.render) gets a valid
      // camera matrix on the very first frame after the switch.
      next.updateMatrixWorld();
      set({ camera: next });
      if (controls && typeof controls === 'object' && 'object' in controls) {
        (controls as any).object = next;
        (controls as any).update?.();
        // Re-sync matrixWorld after OrbitControls corrects position/orientation.
        next.updateMatrixWorld();
      }
      return;
    }

    const next = new THREE.PerspectiveCamera(perspectiveFov, aspect, PERSPECTIVE_NEAR, PERSPECTIVE_FAR);
    next.up.copy(camera.up);

    if (camera instanceof THREE.OrthographicCamera) {
      // span is the vertical world-space height currently visible in the ortho
      // frustum at its current zoom (OrthographicCamera scales the frustum by
      // 1/zoom). Keep the user's perspective FOV and place the camera at the
      // distance that reproduces that same world height, so the model keeps its
      // on-screen size across the projection switch. (Setting a matching FOV
      // instead doesn't survive: this effect re-runs right after set() swaps in
      // the new camera, resets fov to perspectiveFov, and the camera is left too
      // close — appearing to zoom in.)
      const span = Math.max(1e-6, (camera.top - camera.bottom) / Math.max(1e-6, camera.zoom));
      const fovDeg = THREE.MathUtils.clamp(perspectiveFov, 5, 175);
      next.fov = fovDeg;
      const distance = Math.max(0.001, span / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg * 0.5))));

      const direction = camera.position.clone().sub(target);
      if (direction.lengthSq() < 1e-10) direction.set(-1, -1, 1);
      direction.normalize();
      next.position.copy(target.clone().addScaledVector(direction, distance));
      // Preserve approximate orientation so pick/raycast work before controls.update().
      next.quaternion.copy(camera.quaternion);
    } else {
      next.position.copy(camera.position);
      next.quaternion.copy(camera.quaternion);
    }

    next.updateProjectionMatrix();
    // Force matrixWorld before the first useFrame pick run.
    next.updateMatrixWorld();
    set({ camera: next });
    if (controls && typeof controls === 'object' && 'object' in controls) {
      (controls as any).object = next;
      (controls as any).update?.();
      next.updateMatrixWorld();
    }
  }, [camera, controls, mode, perspectiveFov, sceneRadius, set, size.height, size.width]);

  return null;
}

/**
 * Keeps the orthographic frustum derived from the dolly radius.
 *
 * Runs on OrbitControls' `change` (so the frustum is fresh the moment a
 * rotation/pan/dolly settles, before picking or render), on resize, and once
 * per frame as a safety net for programmatic moves that skip `controls.update`.
 *
 * While a SpaceMouse owns the camera (`suspended`) its existing zoom path runs
 * unopposed; on hand-back we bake that zoom into the radius so the derived
 * frustum matches the last visible scale, then resume deriving.
 */
export function OrthoFrustumSync({
  mode,
  suspended,
  sceneRadius,
}: {
  mode: CameraProjectionMode;
  suspended: boolean;
  sceneRadius?: number;
}) {
  const { camera, controls, size } = useThree();
  const aspect = size.width / Math.max(1, size.height);

  const sync = React.useCallback(() => {
    if (suspended) return;
    if (mode !== 'orthographic') return;
    if (!(camera instanceof THREE.OrthographicCamera)) return;
    syncOrthoFrustum(camera, orbitTargetOf(controls) ?? new THREE.Vector3(), aspect, { sceneRadius });
  }, [aspect, camera, controls, mode, sceneRadius, suspended]);

  React.useLayoutEffect(() => {
    sync();
  }, [sync]);

  React.useEffect(() => {
    if (!controls || typeof controls !== 'object') return;
    const orbit = controls as {
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
    };
    if (typeof orbit.addEventListener !== 'function') return;
    const onChange = () => sync();
    orbit.addEventListener('change', onChange);
    return () => orbit.removeEventListener?.('change', onChange);
  }, [controls, sync]);

  useFrame(() => {
    sync();
  });

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

  return (
    <points ref={markerRef} raycast={() => null} renderOrder={32} frustumCulled={false}>
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
        opacity={visible ? 0.6 : 0}
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
  const sizeRef = React.useRef(size);

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
  } | null>(null);

  React.useEffect(() => {
    sizeRef.current = size;
  }, [size]);

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
    durationMs: number;
    onComplete?: () => void;
  }) => {
    const {
      startPos,
      endPos,
      startTarget,
      endTarget,
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
    };

    const padding = 1.04;
    const fov = camera instanceof THREE.PerspectiveCamera
      ? THREE.MathUtils.degToRad(camera.fov)
      : THREE.MathUtils.degToRad(50);
    const viewport = sizeRef.current;
    const aspect = viewport.width / Math.max(1, viewport.height);
    const hFov = 2 * Math.atan(Math.tan(fov * 0.5) * aspect);
    const minFov = Math.max(0.0001, Math.min(fov, hFov));

    const halfDiagonal = 0.5 * Math.hypot(plateWidthMm, plateDepthMm) * padding;
    const distance = Math.max(90, halfDiagonal / Math.sin(minFov * 0.5));
    const viewDir = new THREE.Vector3(0, -0.52, 1).normalize();
    const endTarget = target.clone().add(new THREE.Vector3(0, -plateDepthMm * 0.055, 0));
    const endPos = endTarget.clone().addScaledVector(viewDir, distance);

    animateTo({
      startPos,
      endPos,
      startTarget,
      endTarget,
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
  }, [animateTo, camera, controls, plateDepthMm, plateWidthMm, runId, target]);

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

    const startPos = camera.position.clone();
    const endPos = snapshot.position.clone();
    const startTarget = orbit.target.clone();
    const endTarget = snapshot.target.clone();

    animateTo({
      startPos,
      endPos,
      startTarget,
      endTarget,
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
