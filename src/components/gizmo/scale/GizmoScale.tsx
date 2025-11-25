"use client";

import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { GIZMO_COLORS, GIZMO_SIZES, GIZMO_LIGHTING } from '../constants';
import type { GizmoAxis } from '../types';
import { usePicking } from '@/components/picking';
import type { GizmoHandleType } from '@/components/picking/types';

interface GizmoScaleProps {
  axis: GizmoAxis;
  isHovered?: boolean;
  isActive?: boolean;
  isDimmed?: boolean;
  isHidden?: boolean;
  gizmoPosition: THREE.Vector3;
  onDragStart: (isUniform: boolean) => void;
  onDrag: (factor: number, isUniform: boolean) => void;
  onDragEnd: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/**
 * Cube with only front-facing edges visible
 */
function CubeWithFrontEdges({
  position,
  size,
  color,
  opacity,
  edgeOpacity,
  camera,
  gizmoPosition
}: {
  position: [number, number, number];
  size: number;
  color: string;
  opacity: number;
  edgeOpacity: number;
  camera: THREE.Camera;
  gizmoPosition: THREE.Vector3;
}) {
  const [visibleEdges, setVisibleEdges] = useState<[THREE.Vector3, THREE.Vector3][]>([]);
  
  // Calculate darker edge color (70% darker for more contrast)
  const edgeColor = useMemo(() => {
    const threeColor = new THREE.Color(color);
    threeColor.multiplyScalar(0.3); // Make 70% darker
    return '#' + threeColor.getHexString();
  }, [color]);
  
  // Calculate which edges are camera-facing
  useFrame(() => {
    const cubePos = new THREE.Vector3(...position).add(gizmoPosition);
    const cameraDir = new THREE.Vector3().subVectors(camera.position, cubePos).normalize();
    
    const half = size / 2;
    const edges: [THREE.Vector3, THREE.Vector3][] = [];
    
    // Define all 12 edges of the cube with their face normals
    const cubeEdges = [
      // Front face (Z+) edges
      { start: [-half, -half, half], end: [half, -half, half], normal: [0, 0, 1] },
      { start: [half, -half, half], end: [half, half, half], normal: [0, 0, 1] },
      { start: [half, half, half], end: [-half, half, half], normal: [0, 0, 1] },
      { start: [-half, half, half], end: [-half, -half, half], normal: [0, 0, 1] },
      // Back face (Z-) edges
      { start: [-half, -half, -half], end: [half, -half, -half], normal: [0, 0, -1] },
      { start: [half, -half, -half], end: [half, half, -half], normal: [0, 0, -1] },
      { start: [half, half, -half], end: [-half, half, -half], normal: [0, 0, -1] },
      { start: [-half, half, -half], end: [-half, -half, -half], normal: [0, 0, -1] },
      // Connecting edges
      { start: [-half, -half, -half], end: [-half, -half, half], normal: [-1, 0, 0] },
      { start: [half, -half, -half], end: [half, -half, half], normal: [1, 0, 0] },
      { start: [half, half, -half], end: [half, half, half], normal: [1, 0, 0] },
      { start: [-half, half, -half], end: [-half, half, half], normal: [-1, 0, 0] },
    ];
    
    // Only include edges whose face normal points toward camera
    const visible = cubeEdges
      .filter(edge => {
        const normal = new THREE.Vector3(...edge.normal as [number, number, number]);
        return normal.dot(cameraDir) > 0;
      })
      .map(edge => [
        new THREE.Vector3(...edge.start as [number, number, number]),
        new THREE.Vector3(...edge.end as [number, number, number])
      ] as [THREE.Vector3, THREE.Vector3]);
    
    setVisibleEdges(visible);
  });
  
  return (
    <group position={position}>
      {/* Solid cube */}
      <mesh>
        <boxGeometry args={[size, size, size]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity}
          depthTest={false}
        />
      </mesh>
      
      {/* Only visible edges */}
      {visibleEdges.map((edge, i) => (
        <Line
          key={i}
          points={edge}
          color={edgeColor}
          lineWidth={1}
          transparent
          opacity={edgeOpacity}
          depthTest={false}
        />
      ))}
    </group>
  );
}

/**
 * Create hexagonal prism with radial gradient
 */
function createGradientHexagonGeometry(
  startColor: string,
  endColor: string,
  radius: number,
  depth: number
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, depth, 6);
  const colors = new Float32Array(geometry.attributes.position.count * 3);

  const start = new THREE.Color(startColor);
  const end = new THREE.Color(endColor);

  // Apply gradient from center to edges
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    const x = geometry.attributes.position.getX(i);
    const z = geometry.attributes.position.getZ(i);
    const distFromCenter = Math.sqrt(x * x + z * z) / radius;
    const t = Math.min(distFromCenter, 1.0); // Normalize to 0-1
    const color = new THREE.Color().lerpColors(start, end, t);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * GizmoScale - Scale handle for scaling operations
 */
export function GizmoScale({
  axis,
  isHovered,
  isActive,
  isDimmed,
  isHidden,
  gizmoPosition,
  onDragStart,
  onDrag,
  onDragEnd,
  onPointerEnter,
  onPointerLeave,
}: GizmoScaleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUniformScale, setIsUniformScale] = useState(false);
  const [shouldFlipX, setShouldFlipX] = useState(false);
  const [shouldFlipY, setShouldFlipY] = useState(false);
  const [shouldFlipZ, setShouldFlipZ] = useState(false);
  const startDistance = useRef<number>(0);
  const rafId = useRef<number | null>(null);
  const { camera, gl } = useThree();

  // GPU Picking registration
  const pickMeshRef = useRef<THREE.Mesh>(null);
  const pickIdRef = useRef<number | null>(null);
  const { register, unregister, hit } = usePicking();
  
  // Map axis to gizmo handle type
  const handleType: GizmoHandleType = `scale-${axis}` as GizmoHandleType;
  
  // Register with picking system
  useEffect(() => {
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
  
  // Check if this handle is hovered via GPU picking
  const isPickingHovered = hit.category === 'gizmo' && 
    'gizmoHandle' in hit && 
    hit.gizmoHandle === handleType;

  // Get colors for this axis
  const axisColors = axis === 'x' ? GIZMO_COLORS.xAxis : axis === 'y' ? GIZMO_COLORS.yAxis : GIZMO_COLORS.zAxis;

  // Update axis flip states every frame based on camera position relative to gizmo
  useFrame(() => {
    // X axis flips when camera crosses X axis
    if (axis === 'x') {
      const cameraRelativeX = camera.position.x - gizmoPosition.x;
      setShouldFlipX(cameraRelativeX > 0);
    }
    
    // Y axis flips when camera crosses Y axis
    if (axis === 'y') {
      const cameraRelativeY = camera.position.y - gizmoPosition.y;
      setShouldFlipY(cameraRelativeY > 0);
    }
    
    // Z axis flips when camera crosses Z axis
    if (axis === 'z') {
      const cameraRelativeZ = camera.position.z - gizmoPosition.z;
      setShouldFlipZ(cameraRelativeZ > 0);
    }
  });

  // Create gradient hexagon geometry
  const hexGeometry = useMemo(
    () =>
      createGradientHexagonGeometry(
        axisColors.start,
        axisColors.end,
        GIZMO_SIZES.scaleHexagonRadius,
        GIZMO_SIZES.scaleHexagonDepth
      ),
    [axisColors.start, axisColors.end]
  );

  // Position for each axis (at end of line) with camera-relative flipping
  const length = GIZMO_SIZES.scaleLineLength;
  const position: [number, number, number] =
    axis === 'x'
      ? [shouldFlipX ? length : -length, 0, 0]
      : axis === 'y'
      ? [0, shouldFlipY ? length : -length, 0]
      : [0, 0, shouldFlipZ ? length : -length];

  // Rotate hexagon to face perpendicular to axis
  const rotation: [number, number, number] =
    axis === 'x' ? [0, 0, Math.PI / 2] : axis === 'y' ? [0, 0, 0] : [Math.PI / 2, 0, 0];

  // Connection line position (halfway between center and hexagon)
  const linePosition: [number, number, number] =
    axis === 'x'
      ? [GIZMO_SIZES.scaleLineLength / 2, 0, 0]
      : axis === 'y'
      ? [0, GIZMO_SIZES.scaleLineLength / 2, 0]
      : [0, 0, GIZMO_SIZES.scaleLineLength / 2];

  const lineRotation: [number, number, number] =
    axis === 'x' ? [0, 0, Math.PI / 2] : axis === 'z' ? [Math.PI / 2, 0, 0] : [0, 0, 0];

  const handlePointerEnter = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onPointerEnter();
  };

  const handlePointerLeave = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onPointerLeave();
  };

  const handleContextMenu = (e: ThreeEvent<MouseEvent>) => {
    // Prevent browser context menu on right-click
    e.stopPropagation();
    e.nativeEvent.preventDefault();
  };

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    (e as any).stopped = true; // Mark event as handled for OrbitControls
    
    // Detect mouse button: 0 = left (uniform), 2 = right (per-axis)
    const isUniform = e.button === 0;
    setIsUniformScale(isUniform);
    
    // Store initial distance from gizmo center
    const gizmoScreenPos = gizmoPosition.clone().project(camera);
    const canvas = gl.domElement;
    const rect = canvas.getBoundingClientRect();
    const gizmoCenterX = ((gizmoScreenPos.x + 1) / 2) * rect.width + rect.left;
    const gizmoCenterY = ((-gizmoScreenPos.y + 1) / 2) * rect.height + rect.top;
    
    const deltaX = e.clientX - gizmoCenterX;
    const deltaY = e.clientY - gizmoCenterY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    startDistance.current = distance;
    
    setIsDragging(true);
    onDragStart(isUniform);
  };

  const getScaleFactor = useCallback((clientX: number, clientY: number, gizmoCenterX: number, gizmoCenterY: number): number => {
    // Absolute distance-based scaling:
    // - Distance from center directly controls scale
    // - At center = scale approaches 0
    // - Away from center = scale increases proportionally
    
    // Current distance from mouse to gizmo center
    const currentDeltaX = clientX - gizmoCenterX;
    const currentDeltaY = clientY - gizmoCenterY;
    const currentDistance = Math.sqrt(currentDeltaX * currentDeltaX + currentDeltaY * currentDeltaY);
    
    // Calculate scale factor as ratio of current distance to start distance
    // This makes scaling proportional to distance from center
    const ratio = currentDistance / startDistance.current;
    
    // Clamp to reasonable values (0.01 to 100x)
    return Math.max(0.01, Math.min(100.0, ratio));
  }, []);

  const handlePointerUp = () => {
    if (!isDragging) return;

    setIsDragging(false);
    onDragEnd();
  };

  // Global pointer move and up listeners during drag
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalPointerMove = (e: PointerEvent) => {
      // Cancel any pending animation frame
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
      
      // Schedule update on next frame
      rafId.current = requestAnimationFrame(() => {
        // Convert gizmo 3D position to screen space
        const gizmoScreenPos = gizmoPosition.clone().project(camera);
        const canvas = gl.domElement;
        const rect = canvas.getBoundingClientRect();
        const gizmoCenterX = ((gizmoScreenPos.x + 1) / 2) * rect.width + rect.left;
        const gizmoCenterY = ((-gizmoScreenPos.y + 1) / 2) * rect.height + rect.top;
        
        const factor = getScaleFactor(e.clientX, e.clientY, gizmoCenterX, gizmoCenterY);
        onDrag(factor, isUniformScale);
        rafId.current = null;
      });
    };

    const handleGlobalPointerUp = () => {
      setIsDragging(false);
      onDragEnd();
    };

    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);
    
    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [isDragging, isUniformScale, onDrag, onDragEnd, getScaleFactor, gizmoPosition, camera, gl]);

  // Use GPU picking hover state OR prop-based hover (fallback)
  const effectiveHovered = isPickingHovered || isHovered;

  const opacity = isHidden ? 0 : isDimmed ? 0.15 : 1.0;
  const dimmedColor = '#cccccc'; // Light grey for dimmed state

  // Emissive intensity based on state (uses effectiveHovered for GPU picking support)
  const emissiveIntensity = isActive
    ? GIZMO_LIGHTING.emissiveIntensity.active
    : effectiveHovered
    ? GIZMO_LIGHTING.emissiveIntensity.hovered
    : GIZMO_LIGHTING.emissiveIntensity.idle;

  // Point light intensity based on state (uses effectiveHovered for GPU picking support)
  const lightIntensity = isActive
    ? GIZMO_LIGHTING.pointLightIntensity.active
    : effectiveHovered
    ? GIZMO_LIGHTING.pointLightIntensity.hovered
    : GIZMO_LIGHTING.pointLightIntensity.idle;

  return (
    <group>
      {/* Pickable mesh for GPU picking - invisible but rendered in pick pass */}
      <mesh 
        ref={pickMeshRef}
        position={position}
        renderOrder={1000}
        onPointerDown={handlePointerDown}
        onContextMenu={handleContextMenu}
      >
        <boxGeometry args={[
          GIZMO_SIZES.scaleHexagonRadius * 3,
          GIZMO_SIZES.scaleHexagonRadius * 3,
          GIZMO_SIZES.scaleHexagonRadius * 3
        ]} />
        <meshBasicMaterial visible={false} depthTest={false} />
      </mesh>
      {/* Connection line from center - DISABLED to avoid overlap with move arrows */}
      {/* <group rotation={lineRotation}>
        <Line
          points={[
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, GIZMO_SIZES.scaleLineLength, 0)
          ]}
          color={axisColors.end}
          lineWidth={4}
          depthTest={false}
        />
      </group> */}

      {/* Cube handle with camera-facing edges only */}
      <CubeWithFrontEdges 
        position={position}
        size={GIZMO_SIZES.scaleHexagonRadius}
        color={isDimmed ? dimmedColor : axisColors.end}
        opacity={opacity}
        edgeOpacity={opacity}
        camera={camera}
        gizmoPosition={gizmoPosition}
      />

      {/* Point light at hexagon to cast colored light on model */}
      {!isDimmed && (
        <pointLight
          position={position}
          color={axisColors.end}
          intensity={lightIntensity}
          distance={GIZMO_LIGHTING.pointLightDistance}
          decay={GIZMO_LIGHTING.pointLightDecay}
        />
      )}
    </group>
  );
}
