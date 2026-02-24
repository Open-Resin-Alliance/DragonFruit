"use client";

import React from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { TransformGizmo } from './TransformGizmo';
import type { TransformGizmoProps } from './types';

function toPositionArray(position: TransformGizmoProps['position']): [number, number, number] {
  return Array.isArray(position)
    ? position
    : [position.x, position.y, position.z];
}

function computeScreenSpaceScale(
  camera: THREE.Camera,
  position: [number, number, number],
  scaleFactor: number,
): number {
  const point = new THREE.Vector3(position[0], position[1], position[2]);
  if ((camera as any).isOrthographicCamera) {
    const ortho = camera as THREE.OrthographicCamera;
    const worldHeight = (ortho.top - ortho.bottom) / Math.max(1e-6, ortho.zoom);
    return worldHeight * scaleFactor;
  }

  const perspective = camera as THREE.PerspectiveCamera;
  const distance = perspective.position.distanceTo(point);
  return distance * scaleFactor;
}

/**
 * ScreenSpaceGizmo - Wrapper that makes the gizmo maintain constant screen size
 * 
 * Calculates scale based on camera distance so the gizmo appears the same size
 * regardless of zoom level, like standard 3D software gizmos.
 */
export function ScreenSpaceGizmo(props: Omit<TransformGizmoProps, 'size'> & { 
  meshRef?: React.RefObject<THREE.Group | THREE.Mesh | null>;
  scaleFactor?: number;
}) {
  const { camera } = useThree();
  const scaleFactor = props.scaleFactor ?? 0.04;
  const gizmoRootRef = React.useRef<THREE.Group | null>(null);

  const resolveCurrentPosition = React.useCallback((): [number, number, number] => {
    const meshPos = props.meshRef?.current?.position;
    if (meshPos) {
      return [meshPos.x, meshPos.y, meshPos.z];
    }
    return toPositionArray(props.position);
  }, [props.meshRef, props.position]);

  const initialPosition = React.useMemo(() => resolveCurrentPosition(), [resolveCurrentPosition]);
  const initialScale = React.useMemo(
    () => computeScreenSpaceScale(camera, initialPosition, scaleFactor),
    [camera, initialPosition, scaleFactor],
  );
  const lastPositionRef = React.useRef<[number, number, number]>(initialPosition);
  const lastScaleRef = React.useRef<number>(initialScale);

  React.useLayoutEffect(() => {
    const root = gizmoRootRef.current;
    if (!root) return;

    const nextPosition = resolveCurrentPosition();
    const prev = lastPositionRef.current;
    if (prev[0] !== nextPosition[0] || prev[1] !== nextPosition[1] || prev[2] !== nextPosition[2]) {
      lastPositionRef.current = nextPosition;
      root.position.set(nextPosition[0], nextPosition[1], nextPosition[2]);
    }

    const nextScale = computeScreenSpaceScale(camera, nextPosition, scaleFactor);
    if (Math.abs(nextScale - lastScaleRef.current) > 1e-4) {
      lastScaleRef.current = nextScale;
      root.scale.setScalar(nextScale);
    }
  }, [camera, resolveCurrentPosition, scaleFactor]);
  
  // Imperative per-frame sync keeps gizmo visually glued to the target
  // without React state scheduling overhead.
  useFrame(() => {
    const root = gizmoRootRef.current;
    if (!root) return;

    const nextPosition = resolveCurrentPosition();
    const prevPosition = lastPositionRef.current;
    if (
      prevPosition[0] !== nextPosition[0]
      || prevPosition[1] !== nextPosition[1]
      || prevPosition[2] !== nextPosition[2]
    ) {
      lastPositionRef.current = nextPosition;
      root.position.set(nextPosition[0], nextPosition[1], nextPosition[2]);
    }

    const newScale = computeScreenSpaceScale(camera, nextPosition, scaleFactor);
    if (Math.abs(newScale - lastScaleRef.current) > 1e-4) {
      lastScaleRef.current = newScale;
      root.scale.setScalar(newScale);
    }
  });

  return <TransformGizmo {...props} position={initialPosition} size={initialScale} rootRef={gizmoRootRef} />;
}
