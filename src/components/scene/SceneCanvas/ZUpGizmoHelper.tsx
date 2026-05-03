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
  update: (delta?: number) => void;
};

type CameraControlsLike = {
  getTarget: (out: Vector3) => Vector3;
  setPosition: (x: number, y: number, z: number) => void;
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
const startDirection = new Vector3(0, 1, 0);
const poleHeading = new Vector3();
const poleRight = new Vector3();
const poleUp = new Vector3();

function getStableLookUp(direction: Vector3): Vector3 {
  const normalizedDirection = direction.clone().normalize();
  if (Math.abs(normalizedDirection.dot(worldUp)) < 0.999) {
    return worldUp;
  }

  poleHeading.copy(startDirection);
  poleHeading.z = 0;
  if (poleHeading.lengthSq() < 1e-8) {
    poleHeading.set(1, 0, 0);
  } else {
    poleHeading.normalize();
  }

  poleRight.crossVectors(worldUp, poleHeading);
  if (poleRight.lengthSq() < 1e-8) {
    poleRight.set(1, 0, 0);
  } else {
    poleRight.normalize();
  }

  return poleUp.crossVectors(normalizedDirection, poleRight).normalize();
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
      startDirection.copy(mainCamera.position).sub(focusPoint.current).normalize();
      radius.current = mainCamera.position.distanceTo(focusPoint.current);
      q1.copy(mainCamera.quaternion);
      targetDirection.copy(direction).normalize();
      targetPosition.copy(targetDirection).multiplyScalar(radius.current).add(focusPoint.current);
      dummy.up.copy(getStableLookUp(targetDirection));
      dummy.position.copy(focusPoint.current);
      dummy.lookAt(targetPosition);
      q2.copy(dummy.quaternion);
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
        } else {
          const step = delta * turnRate;
          q1.rotateTowards(q2, step);
          mainCamera.position.set(0, 0, 1).applyQuaternion(q1).multiplyScalar(radius.current).add(focusPoint.current);
          targetDirection.copy(mainCamera.position).sub(focusPoint.current).normalize();
          mainCamera.up.copy(worldUp);
          mainCamera.quaternion.copy(q1);
          if (isCameraControls(defaultControls)) {
            defaultControls.setPosition(mainCamera.position.x, mainCamera.position.y, mainCamera.position.z);
          }
          if (onUpdate) onUpdate();
          else if (isOrbitControls(defaultControls) || isCameraControls(defaultControls)) defaultControls.update(delta);
          invalidate();
        }
      }

      matrix.copy(mainCamera.matrix).invert();
      gizmoRef.current.quaternion.setFromRotationMatrix(matrix);
    }
  });

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
