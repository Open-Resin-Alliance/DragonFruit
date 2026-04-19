"use client";

import React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
  getSavedSpaceMouseSettings,
  subscribeToSpaceMouseSettings,
  type SpaceMouseSettings,
} from '@/components/settings/spacemousePreferences';

type OrbitLikeControls = {
  target: THREE.Vector3;
  enabled?: boolean;
  update: () => void;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

function isOrbitLikeControls(value: unknown): value is OrbitLikeControls {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<OrbitLikeControls>;
  return !!maybe.target && typeof maybe.update === 'function';
}

function alignCameraToHorizon(camera: THREE.Camera, target: THREE.Vector3, worldUp: THREE.Vector3) {
  camera.up.copy(worldUp);
  camera.lookAt(target);
  camera.updateMatrixWorld();
}

function deadzoneAxis(value: number, deadzone: number) {
  const abs = Math.abs(value);
  if (abs <= deadzone) return 0;
  const normalized = (abs - deadzone) / Math.max(1e-6, 1 - deadzone);
  return Math.sign(value) * normalized;
}

function getActiveSpaceMousePad(): Gamepad | null {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
  const pads = navigator.getGamepads();
  const list = Array.from(pads).filter((pad): pad is Gamepad => !!pad);
  if (list.length === 0) return null;

  const named = list.find((pad) => /spacemouse|3dconnexion|space navigator|spacepilot/i.test(pad.id));
  if (named && named.axes.length >= 6) return named;

  const nonSpaceMouseGamepads = /xbox|wireless controller|dualshock|dualsense|joy-?con|switch pro|stadia/i;
  return list.find((pad) => pad.axes.length >= 6 && !nonSpaceMouseGamepads.test(pad.id)) ?? null;
}

/**
 * Read 6 raw axes, apply deadzone + inversion, return semantic channels.
 *
 * 3Dconnexion SpaceMouse standard HID axis layout:
 *   0 = TX (side)   1 = TY (fore/aft)   2 = TZ (up/down)
 *   3 = RX (pitch)  4 = RY (yaw/twist)  5 = RZ (roll)
 *
 * Semantic mapping we want:
 *   pan_x  = side-side    (axis 0)
 *   pan_z  = up-down      (axis 2)
 *   dolly  = fore-aft     (axis 1)
 *   pitch  = tilt fwd/bk  (axis 3)
 *   yaw    = twist        (axis 5)
 *   roll   = tilt l/r     (axis 4)
 */
function readAxes(settings: SpaceMouseSettings, pad: Gamepad) {
  const ax = (i: number) => deadzoneAxis(pad.axes[i] ?? 0, settings.deadzone);

  return {
    panX:  ax(0) * (settings.invertTx ? -1 : 1),
    panZ:  ax(2) * (settings.invertTy ? -1 : 1),
    dolly: ax(1) * (settings.invertTz ? -1 : 1),
    pitch: ax(3) * (settings.invertRx ? -1 : 1),
    yaw:   ax(5) * (settings.invertRy ? -1 : 1),
    roll:  ax(4) * (settings.invertRz ? -1 : 1),
  };
}

// ─── Controller component ────────────────────────────────────────────

export function SpaceMouseController({
  pivotPoint,
  pivotCandidates,
  fallbackPivot,
  mouseOrbitDragRunId,
  onNavigationActiveChange,
  onNavigationFrame,
}: {
  pivotPoint?: THREE.Vector3 | null;
  pivotCandidates?: THREE.Vector3[];
  fallbackPivot?: THREE.Vector3 | null;
  mouseOrbitDragRunId?: number;
  onNavigationActiveChange?: (active: boolean) => void;
  onNavigationFrame?: () => void;
}) {
  const { camera, controls, scene, invalidate } = useThree();

  const worldUp = React.useMemo(() => new THREE.Vector3(0, 0, 1), []);
  const defaultPivot = React.useMemo(
    () => fallbackPivot?.clone() ?? new THREE.Vector3(0, 0, 0),
    [fallbackPivot?.x, fallbackPivot?.y, fallbackPivot?.z],
  );

  const settings = React.useSyncExternalStore(
    subscribeToSpaceMouseSettings,
    getSavedSpaceMouseSettings,
    getSavedSpaceMouseSettings,
  );

  // Track whether *we* disabled OrbitControls so we can restore it.
  const weDisabledOrbitRef = React.useRef(false);
  // If true, reset any SpaceMouse-induced tilt on next regular mouse orbit start.
  const pendingHorizonResetRef = React.useRef(false);
  // Persistent pivot — survives across idle gaps (Fusion 360 style).
  // Once established, pan accumulates onto it; only reset on explicit selection change.
  const activePivotRef = React.useRef<THREE.Vector3>(defaultPivot.clone());
  const hasActivePivotRef = React.useRef(false);
  // Camera look target can be offset from pivot (Fusion-style framing pan).
  const lookTargetRef = React.useRef<THREE.Vector3>(defaultPivot.clone());
  const hasLookTargetRef = React.useRef(false);
  // Track the last pivotPoint prop so we know when user selection changed.
  const lastPivotPointRef = React.useRef<THREE.Vector3 | null>(null);
  // Frames since last SpaceMouse activity — used for idle detection.
  const idleFramesRef = React.useRef(0);
  // How many idle frames before we hand control back to OrbitControls.
  const IDLE_HANDBACK_FRAMES = 6;
  const pivotMarkerRef = React.useRef<THREE.Mesh | null>(null);
  const raycasterRef = React.useRef(new THREE.Raycaster());
  const rayDirectionRef = React.useRef(new THREE.Vector3());
  const raycastTargetsRef = React.useRef<THREE.Object3D[]>([]);
  const isNavigatingRef = React.useRef(false);

  React.useEffect(() => {
    if (pivotPoint) return;
    if (pivotCandidates && pivotCandidates.length > 0) return;

    if (!hasActivePivotRef.current) {
      activePivotRef.current.copy(defaultPivot);
    }
    if (!hasLookTargetRef.current) {
      lookTargetRef.current.copy(defaultPivot);
    }
  }, [defaultPivot, pivotCandidates, pivotPoint]);

  const getHandoffTarget = React.useCallback(() => {
    if (hasLookTargetRef.current) return lookTargetRef.current;
    if (pivotPoint) return pivotPoint;
    if (hasActivePivotRef.current) return activePivotRef.current;
    if (isOrbitLikeControls(controls)) return controls.target;
    return defaultPivot;
  }, [controls, defaultPivot, pivotPoint]);

  const tryAcquirePivotFromCameraRay = React.useCallback((force = false) => {
    if (settings.pivotMode !== 'camera-ray') return false;
    if (hasActivePivotRef.current && !force) return true;

    const direction = rayDirectionRef.current.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const raycaster = raycasterRef.current;
    raycaster.set(camera.position, direction);

    const targets = raycastTargetsRef.current;
    targets.length = 0;
    scene.traverseVisible((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (object === pivotMarkerRef.current) return;
      if (!object.geometry) return;
      if (!object.userData || typeof object.userData.modelId !== 'string') return;
      targets.push(object);
    });

    if (targets.length === 0) return false;

    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0 || !hits[0].point) return false;

    activePivotRef.current.copy(hits[0].point);
    hasActivePivotRef.current = true;
    if (!hasLookTargetRef.current) {
      lookTargetRef.current.copy(hits[0].point);
      hasLookTargetRef.current = true;
    }
    return true;
  }, [camera, scene, settings.pivotMode]);

  React.useEffect(() => {
    if (!pendingHorizonResetRef.current) return;
    if (!mouseOrbitDragRunId || mouseOrbitDragRunId <= 0) return;
    if (!isOrbitLikeControls(controls)) return;

    alignCameraToHorizon(camera, controls.target, worldUp);
    controls.update();
    pendingHorizonResetRef.current = false;
  }, [camera, controls, mouseOrbitDragRunId, worldUp]);

  React.useEffect(() => {
    return () => {
      if (isNavigatingRef.current) {
        isNavigatingRef.current = false;
        onNavigationActiveChange?.(false);
      }
    };
  }, [onNavigationActiveChange]);

  const resolvePivot = React.useCallback(
    (cameraPosition: THREE.Vector3): THREE.Vector3 => {
      if (pivotPoint) return pivotPoint;

      if (!pivotCandidates || pivotCandidates.length === 0) return defaultPivot;
      if (pivotCandidates.length === 1) return pivotCandidates[0];

      if (settings.pivotMode === 'camera-ray') {
        const viewForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

        let bestOnBeam: THREE.Vector3 | null = null;
        let bestPerpSq = Number.POSITIVE_INFINITY;
        let bestDepth = Number.POSITIVE_INFINITY;

        for (const candidate of pivotCandidates) {
          const toCandidate = candidate.clone().sub(cameraPosition);
          const depth = toCandidate.dot(viewForward);
          if (depth <= 0) continue;

          const lenSq = toCandidate.lengthSq();
          const perpSq = Math.max(0, lenSq - depth * depth);

          if (
            perpSq < bestPerpSq - 1e-6 ||
            (Math.abs(perpSq - bestPerpSq) <= 1e-6 && depth < bestDepth)
          ) {
            bestPerpSq = perpSq;
            bestDepth = depth;
            bestOnBeam = candidate;
          }
        }

        if (bestOnBeam) {
          return bestOnBeam;
        }
      }

      let closest = pivotCandidates[0];
      let closestDistSq = cameraPosition.distanceToSquared(closest);

      for (let i = 1; i < pivotCandidates.length; i++) {
        const candidate = pivotCandidates[i];
        const d2 = cameraPosition.distanceToSquared(candidate);
        if (d2 < closestDistSq) {
          closestDistSq = d2;
          closest = candidate;
        }
      }

      return closest;
    },
    [camera, defaultPivot, pivotCandidates, pivotPoint, settings.pivotMode],
  );

  // When SpaceMouse is turned off, ensure OrbitControls is re-enabled.
  React.useEffect(() => {
    if (settings.enabled) return;

    if (isNavigatingRef.current) {
      isNavigatingRef.current = false;
      onNavigationActiveChange?.(false);
    }

    if (weDisabledOrbitRef.current && isOrbitLikeControls(controls)) {
      controls.enabled = true;
      controls.update();
      weDisabledOrbitRef.current = false;
      pendingHorizonResetRef.current = true;
    }

    hasActivePivotRef.current = false;
    hasLookTargetRef.current = false;
    if (pivotMarkerRef.current) {
      pivotMarkerRef.current.visible = false;
    }
  }, [controls, onNavigationActiveChange, settings.enabled]);

  useFrame((_, delta) => {
    if (pivotMarkerRef.current) {
      pivotMarkerRef.current.visible = false;
    }

    if (!settings.enabled) return;
    if (!isOrbitLikeControls(controls)) {
      if (isNavigatingRef.current) {
        isNavigatingRef.current = false;
        onNavigationActiveChange?.(false);
      }
      return;
    }

    const pad = getActiveSpaceMousePad();
    if (!pad) {
      if (isNavigatingRef.current) {
        isNavigatingRef.current = false;
        onNavigationActiveChange?.(false);
      }
      // No device → hand back to OrbitControls, but keep pivot for next session.
      if (weDisabledOrbitRef.current) {
        const handoffTarget = getHandoffTarget();
        controls.target.copy(handoffTarget);
        controls.enabled = true;
        controls.update();
        weDisabledOrbitRef.current = false;
        pendingHorizonResetRef.current = true;
      }
      return;
    }

    // ── Snap pivot to newly selected model for auto mode.
    // Camera-ray mode acquires once from center-screen surface hit, then locks.
    if (settings.pivotMode !== 'camera-ray') {
      if (pivotPoint && (!lastPivotPointRef.current || !pivotPoint.equals(lastPivotPointRef.current))) {
        activePivotRef.current.copy(pivotPoint);
        hasActivePivotRef.current = true;
        lookTargetRef.current.copy(pivotPoint);
        hasLookTargetRef.current = true;
        lastPivotPointRef.current = pivotPoint.clone();
      } else if (!pivotPoint && lastPivotPointRef.current) {
        // Selection cleared — keep current pivot position, just clear tracking.
        lastPivotPointRef.current = null;
      }
    } else {
      // Acquire only when we do not have a locked pivot yet.
      tryAcquirePivotFromCameraRay(false);
    }

    const raw = readAxes(settings, pad);

    const totalMag =
      Math.abs(raw.panX) + Math.abs(raw.panZ) + Math.abs(raw.dolly) +
      Math.abs(raw.pitch) + Math.abs(raw.yaw) + Math.abs(raw.roll);

    // If input is near-zero, count idle frames and eventually release OrbitControls.
    // Pivot is NOT reset — it persists for the next input burst (Fusion 360 style).
    if (totalMag < 0.02) {
      if (isNavigatingRef.current) {
        isNavigatingRef.current = false;
        onNavigationActiveChange?.(false);
      }
      idleFramesRef.current++;
      if (idleFramesRef.current >= IDLE_HANDBACK_FRAMES && weDisabledOrbitRef.current) {
        const handoffTarget = getHandoffTarget();
        controls.target.copy(handoffTarget);
        controls.enabled = true;
        controls.update();
        weDisabledOrbitRef.current = false;
        pendingHorizonResetRef.current = true;
      }
      return;
    }

    // ── Active input: take exclusive control ──
    if (!isNavigatingRef.current) {
      isNavigatingRef.current = true;
      onNavigationActiveChange?.(true);
    }

    idleFramesRef.current = 0;
    if (!weDisabledOrbitRef.current) {
      controls.enabled = false;
      weDisabledOrbitRef.current = true;
    }

    // First-ever activation: resolve pivot from scene. After that it remains locked.
    if (!hasActivePivotRef.current) {
      if (!tryAcquirePivotFromCameraRay(false)) {
        activePivotRef.current.copy(resolvePivot(camera.position));
        hasActivePivotRef.current = true;
      }
    }

    if (!hasLookTargetRef.current) {
      lookTargetRef.current.copy(activePivotRef.current);
      hasLookTargetRef.current = true;
    }

    const pivot = activePivotRef.current;
    const lookTarget = lookTargetRef.current;
    const dt = Math.min(delta, 0.05);

    // Fusion 360 style: all 6 DOF work simultaneously — no mode separation.
    // Hardware crosstalk is handled by per-axis deadzones in readAxes().
    const { panX, panZ, dolly, pitch, yaw, roll } = raw;

    const toPivot = pivot.clone().sub(camera.position);
    const toLook = lookTarget.clone().sub(camera.position);
    const distance = Math.max(0.1, toPivot.length());
    const isOrthographic = (camera as any).isOrthographicCamera === true;
    const orthoCamera = isOrthographic ? (camera as THREE.OrthographicCamera) : null;

    // ── Translation (pan trucks camera + pivot together, dolly moves camera only) ──
    if (Math.abs(panX) > 1e-4 || Math.abs(panZ) > 1e-4 || Math.abs(dolly) > 1e-4) {
      // Use camera-local frame for panning so up/down remains stable even when
      // camera.up is freely tilted during unconstrained orbit.
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();

      const orthoWorldHeight = orthoCamera ? (orthoCamera.top - orthoCamera.bottom) / Math.max(1e-6, orthoCamera.zoom) : null;
      const panDistanceBase = orthoWorldHeight ?? distance;
      const scale = settings.translationSensitivity * panDistanceBase * 0.9 * dt;
      const zoomScale = settings.zoomSensitivity * distance * 1.2 * dt;

      const panOffset = new THREE.Vector3()
        .addScaledVector(right, -panX * scale)
        .addScaledVector(cameraUp, -panZ * scale);

      // Fusion-style framing offset: pan moves camera + view center, pivot stays on the part.
      camera.position.add(panOffset);
      lookTarget.add(panOffset);

      if (orthoCamera) {
        // Orthographic zoom should change camera.zoom, not dolly camera position.
        const zoomFactor = Math.exp(dolly * settings.zoomSensitivity * 2.0 * dt);
        orthoCamera.zoom = THREE.MathUtils.clamp(orthoCamera.zoom * zoomFactor, 0.0001, 2000);
        orthoCamera.updateProjectionMatrix();
      } else {
        camera.position.addScaledVector(forward, dolly * zoomScale);
      }
    }

    // ── Rotation (orbit around pivot with free orientation) ──
    if (Math.abs(pitch) > 1e-4 || Math.abs(yaw) > 1e-4 || Math.abs(roll) > 1e-4) {
      const rotScale = settings.rotationSensitivity * 1.8 * dt;

      const offset = camera.position.clone().sub(pivot);
      const lookOffset = lookTarget.clone().sub(pivot);
      const localUpAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
      const localRightAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();

      // Yaw: rotate around camera-local up axis.
      if (Math.abs(yaw) > 1e-4) {
        const q = new THREE.Quaternion().setFromAxisAngle(localUpAxis, -yaw * rotScale);
        offset.applyQuaternion(q);
        lookOffset.applyQuaternion(q);
        camera.up.applyQuaternion(q).normalize();
        localRightAxis.applyQuaternion(q).normalize();
      }

      // Pitch: rotate around camera-local right axis.
      // Using the camera-local basis avoids the pole singularity that occurs when
      // deriving pitch axis from cross(offset, up) near top-down orientation.
      if (Math.abs(pitch) > 1e-4) {
        const q = new THREE.Quaternion().setFromAxisAngle(localRightAxis, -pitch * rotScale);
        offset.applyQuaternion(q);
        lookOffset.applyQuaternion(q);
        camera.up.applyQuaternion(q).normalize();
      }

      camera.position.copy(pivot.clone().add(offset));
      lookTarget.copy(pivot.clone().add(lookOffset));

      // Roll: rotate camera up-vector around current view direction.
      if (Math.abs(roll) > 1e-4) {
        const viewDir = lookTarget.clone().sub(camera.position).normalize();
        camera.up.applyAxisAngle(viewDir, roll * rotScale * 0.75).normalize();
      }
    }

    if (pivotMarkerRef.current) {
      pivotMarkerRef.current.position.copy(pivot);
      pivotMarkerRef.current.visible = true;
    }

    camera.lookAt(lookTarget);
    camera.updateMatrixWorld();
    onNavigationFrame?.();
    // Continuous-motion path per R3F discussion #1800 — keeps the loop alive in demand mode
    // while the SpaceMouse is driving input. Idle-handback branches above don't invalidate:
    // drei's OrbitControls.update() in those paths emits 'change' which invalidates for us.
    invalidate();
  });

  return (
    <mesh ref={pivotMarkerRef} visible={false} raycast={() => null}>
      <sphereGeometry args={[0.4, 12, 12]} />
      <meshBasicMaterial color="#58ff6a" transparent opacity={0.6} depthTest={false} />
    </mesh>
  );
}
