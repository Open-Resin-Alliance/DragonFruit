import React from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { MirrorAxis } from '../types';
import {
  HANDLE_SHAFT_LENGTH_MM,
  HANDLE_SHAFT_RADIUS_MM,
  HANDLE_HEAD_LENGTH_MM,
  HANDLE_HEAD_RADIUS_MM,
  HANDLE_AXIS_COLORS,
  HANDLE_HOVER_COLOR,
  HANDLE_RENDER_ORDER,
} from '../constants';

interface MirrorArrowProps {
  axis: MirrorAxis;
  position: THREE.Vector3;
  direction: THREE.Vector3;
  onClick: (axis: MirrorAxis) => void;
}

const ARROW_LOCAL_DIR = new THREE.Vector3(0, 1, 0);

export function MirrorArrow({ axis, position, direction, onClick }: MirrorArrowProps) {
  const [hovered, setHovered] = React.useState(false);

  const quaternion = React.useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(ARROW_LOCAL_DIR, direction.clone().normalize());
    return q;
  }, [direction]);

  const baseColor = HANDLE_AXIS_COLORS[axis];
  const color = hovered ? HANDLE_HOVER_COLOR : baseColor;

  const handlePointerOver = React.useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setHovered(true);
    document.body.style.cursor = 'pointer';
  }, []);

  const handlePointerOut = React.useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setHovered(false);
    document.body.style.cursor = '';
  }, []);

  const handleClick = React.useCallback((event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onClick(axis);
  }, [axis, onClick]);

  return (
    <group
      position={position}
      quaternion={quaternion}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
      onClick={handleClick}
    >
      <mesh
        position={[0, HANDLE_SHAFT_LENGTH_MM / 2, 0]}
        renderOrder={HANDLE_RENDER_ORDER}
      >
        <cylinderGeometry args={[HANDLE_SHAFT_RADIUS_MM, HANDLE_SHAFT_RADIUS_MM, HANDLE_SHAFT_LENGTH_MM, 16]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
      </mesh>
      <mesh
        position={[0, HANDLE_SHAFT_LENGTH_MM + HANDLE_HEAD_LENGTH_MM / 2, 0]}
        renderOrder={HANDLE_RENDER_ORDER}
      >
        <coneGeometry args={[HANDLE_HEAD_RADIUS_MM, HANDLE_HEAD_LENGTH_MM, 20]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
      </mesh>
    </group>
  );
}
