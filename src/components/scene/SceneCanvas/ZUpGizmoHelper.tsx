"use client";

import * as React from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Group, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { OrthographicCamera as ThreeOrthographicCamera } from 'three';
import { GizmoHelperProps, Hud, OrthographicCamera } from '@react-three/drei';

type TweenCamera = (direction: Vector3) => void;

type OrbitControlsLike = {
  minPolarAngle: number;
  target: Vector3;
  enabled?: boolean;
  update: (delta?: number) => void;
};

type CameraControlsLike = {
  getTarget: (out: Vector3) => Vector3;
  setPosition: (x: number, y: number, z: number) => void;
  enabled?: boolean;
  update: (delta?: number) => void;
};

const Context = React.createContext<{ tweenCamera: TweenCamera }>({
  tweenCamera: () => undefined,
});

export const useGizmoContext = () => React.useContext(Context);

const turnRate = 4 * Math.PI;
const dummy = new Object3D();
const matrix = new Matrix4();
const q1 = new Quaternion();
const q2 = new Quaternion();
const targetDirection = new Vector3();
const targetPosition = new Vector3();
const worldUp = new Vector3(0, 0, 1);
/** Screen-up chosen for the poles, where world Z cannot serve (it is the view axis). */
const polarScreenUp = new Vector3(0, 1, 0);
/** Off-pole tilt (~0.5°) that keeps OrbitControls' spherical away from its singularity. */
const polarTilt = 0.0087;

/**
 * A view direction pointing straight along ±worldUp is a singularity for
 * OrbitControls: the camera's up-vector is the view axis, so the azimuth is
 * undefined and the roll snaps to a canonical value instead of animating. Tilt
 * such a direction a fraction of a degree off the pole toward the side that puts
 * `polarScreenUp` up on screen, so the whole tween (and the state it lands in) is
 * well-defined. Visually it is still a top/bottom view.
 */
function stabilizeDirection(direction: Vector3): Vector3 {
  const stabilized = direction.clone().normalize();
  const upDot = stabilized.dot(worldUp);
  if (Math.abs(upDot) < 0.999) return stabilized;

  const sign = upDot > 0 ? -1 : 1;
  stabilized.addScaledVector(polarScreenUp, Math.tan(polarTilt) * sign);
  return stabilized.normalize();
}

function isOrbitControls(
  controls: unknown,
): controls is OrbitControlsLike {
  return (
    !!controls
    && typeof controls === 'object'
    && 'minPolarAngle' in controls
    && 'target' in controls
    && 'update' in controls
  );
}

function isCameraControls(
  controls: unknown,
): controls is CameraControlsLike {
  return (
    !!controls
    && typeof controls === 'object'
    && 'getTarget' in controls
    && 'setPosition' in controls
    && 'update' in controls
  );
}

export function ZUpGizmoHelper({
  alignment = 'bottom-right',
  margin = [80, 80],
  renderPriority = 1,
  onUpdate,
  onTarget,
  children,
}: GizmoHelperProps) {
  const size = useThree((state) => state.size);
  const mainCamera = useThree((state) => state.camera);
  const defaultControls = useThree((state) => state.controls) as unknown;
  const invalidate = useThree((state) => state.invalidate);
  const gizmoRef = React.useRef<Group | null>(null);
  const virtualCam = React.useRef<ThreeOrthographicCamera | null>(null);
  const animating = React.useRef(false);
  const radius = React.useRef(0);
  const focusPoint = React.useRef(new Vector3(0, 0, 0));
  const savedControlsEnabled = React.useRef<boolean | null>(null);

  const restoreControls = React.useCallback(() => {
    if (isOrbitControls(defaultControls) || isCameraControls(defaultControls)) {
      if (savedControlsEnabled.current !== null && typeof defaultControls.enabled === 'boolean') {
        defaultControls.enabled = savedControlsEnabled.current;
      }
      if (isCameraControls(defaultControls)) {
        defaultControls.setPosition(mainCamera.position.x, mainCamera.position.y, mainCamera.position.z);
      }
      defaultControls.update();
    }
    savedControlsEnabled.current = null;
  }, [defaultControls, mainCamera]);

  const tweenCamera = React.useCallback<TweenCamera>(
    (direction) => {
      animating.current = true;
      if (onTarget) {
        focusPoint.current.copy(onTarget());
      } else if (isCameraControls(defaultControls)) {
        defaultControls.getTarget(focusPoint.current);
      } else if (isOrbitControls(defaultControls)) {
        focusPoint.current.copy(defaultControls.target);
      }
      radius.current = mainCamera.position.distanceTo(focusPoint.current);
      q1.copy(mainCamera.quaternion);
      targetDirection.copy(stabilizeDirection(direction));
      targetPosition.copy(targetDirection).multiplyScalar(radius.current).add(focusPoint.current);
      dummy.up.copy(worldUp);
      dummy.position.copy(focusPoint.current);
      dummy.lookAt(targetPosition);
      q2.copy(dummy.quaternion);

      // Take the camera out of OrbitControls' hands for the tween: its update()
      // rebuilds the orientation from position+up, which is singular near the
      // poles and would snap the roll instead of letting the slerp animate it.
      if (
        savedControlsEnabled.current === null
        && (isOrbitControls(defaultControls) || isCameraControls(defaultControls))
        && typeof defaultControls.enabled === 'boolean'
      ) {
        savedControlsEnabled.current = defaultControls.enabled;
        defaultControls.enabled = false;
      }
      invalidate();
    },
    [defaultControls, mainCamera, onTarget, invalidate],
  );

  useFrame((_, delta) => {
    if (virtualCam.current && gizmoRef.current) {
      if (animating.current) {
        if (q1.angleTo(q2) < 0.01) {
          mainCamera.position.copy(targetPosition);
          mainCamera.quaternion.copy(q2);
          mainCamera.up.copy(worldUp);
          animating.current = false;
          restoreControls();
        } else {
          const step = delta * turnRate;
          q1.rotateTowards(q2, step);
          mainCamera.position.set(0, 0, 1).applyQuaternion(q1).multiplyScalar(radius.current).add(focusPoint.current);
          mainCamera.quaternion.copy(q1);
          mainCamera.up.copy(worldUp);
          if (onUpdate) onUpdate();
          invalidate();
        }
      }

      matrix.copy(mainCamera.matrix).invert();
      gizmoRef.current.quaternion.setFromRotationMatrix(matrix);
    }
  });

  // Never leave OrbitControls disabled if this unmounts mid-tween (thumbnail
  // capture does exactly that).
  React.useEffect(() => {
    return () => {
      if (
        savedControlsEnabled.current !== null
        && (isOrbitControls(defaultControls) || isCameraControls(defaultControls))
        && typeof defaultControls.enabled === 'boolean'
      ) {
        defaultControls.enabled = savedControlsEnabled.current;
      }
      savedControlsEnabled.current = null;
    };
  }, [defaultControls]);

  const gizmoHelperContext = React.useMemo(
    () => ({
      tweenCamera,
    }),
    [tweenCamera],
  );

  const [marginX, marginY] = margin;
  const x = alignment.endsWith('-center')
    ? 0
    : alignment.endsWith('-left')
      ? -size.width / 2 + marginX
      : size.width / 2 - marginX;
  const y = alignment.startsWith('center-')
    ? 0
    : alignment.startsWith('top-')
      ? size.height / 2 - marginY
      : -size.height / 2 + marginY;

  return (
    <Hud renderPriority={renderPriority}>
      <Context.Provider value={gizmoHelperContext}>
        <OrthographicCamera makeDefault ref={virtualCam} position={[0, 0, 200]} />
        <group ref={gizmoRef} position={[x, y, 0]}>
          {children}
        </group>
      </Context.Provider>
    </Hud>
  );
}
