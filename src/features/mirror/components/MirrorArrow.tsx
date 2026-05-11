import React from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { MirrorAxis } from '../types';
import {
  HANDLE_SHAFT_LENGTH_MM,
  HANDLE_SHAFT_RADIUS_MM,
  HANDLE_HEAD_LENGTH_MM,
  HANDLE_HEAD_RADIUS_MM,
  HANDLE_RENDER_ORDER,
} from '../constants';
import { GIZMO_COLORS, GIZMO_LIGHTING } from '@/components/gizmo/constants';
import { usePicking } from '@/components/picking';
import type { GizmoHandleType } from '@/components/picking/types';

interface MirrorArrowProps {
  axis: MirrorAxis;
  position: THREE.Vector3;
  direction: THREE.Vector3;
  isHovered: boolean;
  isActive: boolean;
  isDimmed: boolean;
  isHidden: boolean;
  suppressHover: boolean;
  opacityScale: number;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onClick: (axis: MirrorAxis) => void;
}

const ARROW_LOCAL_DIR = new THREE.Vector3(0, 1, 0);

export function MirrorArrow({
  axis,
  position,
  direction,
  isHovered,
  isActive,
  isDimmed,
  isHidden,
  suppressHover,
  opacityScale,
  onPointerEnter,
  onPointerLeave,
  onClick,
}: MirrorArrowProps) {
  const pickMeshRef = React.useRef<THREE.Group>(null);
  const pickIdRef = React.useRef<number | null>(null);
  const { register, unregister, hit } = usePicking();

  const handleType: GizmoHandleType = `mirror-${axis}` as GizmoHandleType;

  React.useEffect(() => {
    if (!pickMeshRef.current) return;

    pickIdRef.current = register({
      category: 'gizmo',
      objectId: null,
      gizmoHandle: handleType,
      object: pickMeshRef.current,
    });

    return () => {
      if (pickIdRef.current !== null) {
        unregister(pickIdRef.current);
        pickIdRef.current = null;
      }
    };
  }, [register, unregister, handleType]);

  const isPickingHovered = !suppressHover && hit.category === 'gizmo' && 'gizmoHandle' in hit && hit.gizmoHandle === handleType;

  const quaternion = React.useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(ARROW_LOCAL_DIR, direction.clone().normalize());
    return q;
  }, [direction]);

  const effectiveHovered = isPickingHovered || isHovered;
  const isHighlighted = !!isActive;

  // Use same GizmoMove opacity logic
  const baseOpacity = isHidden ? 0 : isDimmed ? 0.15 : isHighlighted ? 1.0 : 0.9;
  const opacity = baseOpacity * opacityScale;
  const hoverScale = isActive ? 1.18 : effectiveHovered ? 1.1 : 1.0;
  const dimmedColor = '#cccccc';

  // Get axis colors from gizmo constants
  const axisColors = axis === 'x'
    ? GIZMO_COLORS.xAxis
    : axis === 'y'
      ? GIZMO_COLORS.yAxis
      : GIZMO_COLORS.zAxis;

  const endColorHex = isActive
    ? GIZMO_COLORS.active
    : effectiveHovered
      ? GIZMO_COLORS.hover
      : axisColors.end;

  const lightIntensity = isActive
    ? GIZMO_LIGHTING.pointLightIntensity.active
    : effectiveHovered
      ? GIZMO_LIGHTING.pointLightIntensity.hovered
      : GIZMO_LIGHTING.pointLightIntensity.idle;

  const shaftLength = HANDLE_SHAFT_LENGTH_MM;
  const shaftRadius = HANDLE_SHAFT_RADIUS_MM;
  const headRadius = HANDLE_HEAD_RADIUS_MM;
  const headLength = HANDLE_HEAD_LENGTH_MM;

  // Create gradient geometry like GizmoMove
  const gradientGeometry = React.useMemo(() => {
    const geometry = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 8, 1);
    const colors = new Float32Array(geometry.attributes.position.count * 3);

    const pureCenterColor = axis === 'x' ? '#ff0000' : axis === 'y' ? '#0ce300' : '#0000ff';
    const secondaryColor = axis === 'x' ? '#ff9900' : axis === 'y' ? '#ffcc00' : '#1596ff';

    const startColor = new THREE.Color(pureCenterColor);
    const endColor = new THREE.Color(secondaryColor);

    for (let i = 0; i < geometry.attributes.position.count; i++) {
      const y = geometry.attributes.position.getY(i);
      const normalizedPos = (y + shaftLength / 2) / shaftLength;
      const t = Math.max(0, (normalizedPos - 0.33) / 0.67);
      const color = new THREE.Color().lerpColors(startColor, endColor, t);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }, [axis, shaftLength, shaftRadius]);

  const arrowTipPosition: [number, number, number] = [0, shaftLength, 0];
  const pickTipRadius = Math.max(0.14, headRadius * 2.35);

  const handlePointerDown = React.useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (e.button === 2) return;
      e.stopPropagation();
      (e as any).stopped = true;
      onClick(axis);
    },
    [axis, onClick]
  );

  const handlePointerEnterLocal = React.useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      onPointerEnter();
    },
    [onPointerEnter]
  );

  const handlePointerLeaveLocal = React.useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      onPointerLeave();
    },
    [onPointerLeave]
  );

  if (isHidden) return null;

  return (
    <group position={position} quaternion={quaternion}>
      {/* Invisible pick target */}
      <group ref={pickMeshRef} renderOrder={9999}>
        <mesh
          position={arrowTipPosition}
          onPointerDown={handlePointerDown}
          onPointerEnter={handlePointerEnterLocal}
          onPointerLeave={handlePointerLeaveLocal}
          renderOrder={9999}
        >
          <sphereGeometry args={[pickTipRadius, 12, 12]} />
          <meshBasicMaterial visible={false} depthTest={false} />
        </mesh>
      </group>

      {/* Gradient shaft */}
      <mesh position={[0, shaftLength / 2, 0]} geometry={gradientGeometry} renderOrder={HANDLE_RENDER_ORDER - 10}>
        <meshBasicMaterial
          vertexColors={!isDimmed}
          color={isDimmed ? dimmedColor : isActive ? '#ffffff' : '#f2f2f2'}
          opacity={opacity}
          transparent
          depthTest
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* Arrow head with shadow and highlight */}
      <group position={arrowTipPosition} scale={hoverScale}>
        {/* Shadow/outer cone */}
        <mesh scale={1.15} renderOrder={HANDLE_RENDER_ORDER}>
          <coneGeometry args={[headRadius, headLength, 8]} />
          <meshBasicMaterial
            color={
              isDimmed
                ? new THREE.Color(dimmedColor).multiplyScalar(0.7).getHex()
                : new THREE.Color(endColorHex).multiplyScalar(0.3).getHex()
            }
            opacity={opacity}
            transparent
            depthTest
            depthWrite={false}
          />
        </mesh>

        {/* Main cone */}
        <mesh renderOrder={HANDLE_RENDER_ORDER}>
          <coneGeometry args={[headRadius, headLength, 8]} />
          <meshBasicMaterial
            color={isDimmed ? dimmedColor : endColorHex}
            opacity={opacity}
            transparent
            depthTest
            depthWrite={false}
          />
        </mesh>
      </group>

      {/* Point light */}
      <pointLight
        position={arrowTipPosition}
        color={isActive ? GIZMO_COLORS.active : effectiveHovered ? GIZMO_COLORS.hover : axisColors.end}
        intensity={lightIntensity}
        distance={1.5}
      />
    </group>
  );
}
