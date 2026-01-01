"use client";

import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useThree, useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { GIZMO_COLORS, GIZMO_SIZES, GIZMO_LIGHTING } from '../constants';
import type { GizmoAxis } from '../types';
import { usePicking } from '@/components/picking';
import type { GizmoHandleType } from '@/components/picking/types';

interface GizmoRotationProps {
  axis: GizmoAxis;
  isHovered?: boolean;
  isActive?: boolean;
  isDimmed?: boolean;
  isHidden?: boolean;
  enableLighting?: boolean;
  gizmoPosition: THREE.Vector3;
  onDragStart: () => void;
  onDrag: (angle: number) => void;
  onDragEnd: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/**
 * GizmoRotation - Ring with diamond handle for rotation
 */
export function GizmoRotation({
  axis,
  isHovered,
  isActive,
  isDimmed,
  isHidden,
  enableLighting = true,
  gizmoPosition,
  onDragStart,
  onDrag,
  onDragEnd,
  onPointerEnter,
  onPointerLeave,
}: GizmoRotationProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [handleAngle, setHandleAngle] = useState(0);
  const [shouldFlip, setShouldFlip] = useState(false);
  const startAngle = useRef<number>(0);
  const lastMouseAngle = useRef<number>(0);
  const rafId = useRef<number | null>(null);
  const { camera, gl } = useThree();
  
  // GPU Picking registration
  const pickMeshRef = useRef<THREE.Mesh>(null);
  const pickIdRef = useRef<number | null>(null);
  const { register, unregister, hit } = usePicking();
  
  // Map axis to gizmo handle type
  const handleType: GizmoHandleType = `rotate-${axis}` as GizmoHandleType;
  
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
  const ringColors = axis === 'x' ? GIZMO_COLORS.xRing : axis === 'y' ? GIZMO_COLORS.yRing : GIZMO_COLORS.zRing;
  const axisColors = axis === 'x' ? GIZMO_COLORS.xAxis : axis === 'y' ? GIZMO_COLORS.yAxis : GIZMO_COLORS.zAxis;

  // Update flip state and handle angle every frame based on camera position
  useFrame(() => {
    // Detect if camera has crossed the axis plane
    if (axis === 'x') {
      const cameraRelativeX = camera.position.x - gizmoPosition.x;
      setShouldFlip(cameraRelativeX > 0);
    } else if (axis === 'y') {
      const cameraRelativeY = camera.position.y - gizmoPosition.y;
      setShouldFlip(cameraRelativeY > 0);
    } else if (axis === 'z') {
      const cameraRelativeZ = camera.position.z - gizmoPosition.z;
      setShouldFlip(cameraRelativeZ > 0);
    }
    
    // Update handle angle to follow camera
    if (isDragging) return; // Don't update while dragging
    
    // Get camera direction relative to gizmo
    const cameraDir = new THREE.Vector3().subVectors(camera.position, gizmoPosition).normalize();
    
    // Calculate angle based on which axis this ring is on
    let angle = 0;
    if (axis === 'x') {
      // X ring is in YZ plane, calculate angle from Y and Z components
      // Add +90 degree offset to align properly
      angle = Math.atan2(cameraDir.z, cameraDir.y) + Math.PI / 2;
    } else if (axis === 'y') {
      // Y ring is in XZ plane, calculate angle from X and Z components  
      angle = Math.atan2(cameraDir.z, cameraDir.x);
    } else {
      // Z ring is in XY plane, calculate angle from X and Y components
      angle = Math.atan2(cameraDir.y, cameraDir.x);
    }
    
    setHandleAngle(angle);
  });

  // Rotation for each axis
  const rotation: [number, number, number] =
    axis === 'x' ? [0, Math.PI / 2, 0] : axis === 'y' ? [Math.PI / 2, 0, 0] : [0, 0, 0];

  // Calculate diamond handle position on ring
  const handlePosition = useMemo(() => {
    const radius = GIZMO_SIZES.ringMajorRadius;
    return new THREE.Vector3(Math.cos(handleAngle) * radius, Math.sin(handleAngle) * radius, 0);
  }, [handleAngle]);

  // Calculate tangent direction (perpendicular to radius) for cone alignment
  const tangentAngle = handleAngle + Math.PI / 2;
  
  // Billboard rotation to face camera (updated each frame)
  const [billboardRotation, setBillboardRotation] = useState(0);
  
  // Update billboard rotation to face camera
  useFrame(() => {
    // Get camera direction in the ring's local XY plane
    const cameraDir = new THREE.Vector3().subVectors(camera.position, gizmoPosition).normalize();
    
    // Calculate angle to rotate cones to face camera (around Z axis in ring's local space)
    const cameraAngleInPlane = Math.atan2(cameraDir.y, cameraDir.x);
    setBillboardRotation(cameraAngleInPlane);
  });

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    // Ignore right-click to allow camera orbit controls
    if (e.button === 2) {
      return;
    }
    
    e.stopPropagation();
    (e as any).stopped = true; // Mark event as handled for OrbitControls
    
    // Calculate initial mouse angle
    const rect = gl.domElement.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    lastMouseAngle.current = Math.atan2(e.clientY - centerY, e.clientX - centerX);
    
    setIsDragging(true);
    startAngle.current = handleAngle;
    onDragStart();
  };

  const getMouseAngle = useCallback((clientX: number, clientY: number): number => {
    const rect = gl.domElement.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    return Math.atan2(clientY - centerY, clientX - centerX);
  }, [gl]);

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
        const currentMouseAngle = getMouseAngle(e.clientX, e.clientY);
        let deltaAngle = currentMouseAngle - lastMouseAngle.current;
        
        // Handle angle wrapping (crossing -π/π boundary)
        if (deltaAngle > Math.PI) deltaAngle -= 2 * Math.PI;
        if (deltaAngle < -Math.PI) deltaAngle += 2 * Math.PI;
        
        // X and Z axes need inverted visual feedback, Y axis is correct as-is
        let visualDelta = (axis === 'x' || axis === 'z') ? -deltaAngle : deltaAngle;
        let objectDelta = deltaAngle;
        
        // If camera has flipped to the other side, invert both visual and object rotation
        if (shouldFlip) {
          visualDelta = -visualDelta;
          objectDelta = -objectDelta;
        }
        
        // Flip both visual and object to match mouse direction (all axes)
        visualDelta = -visualDelta;
        objectDelta = -objectDelta;
        
        // Update handle angle for visual feedback
        setHandleAngle((prev) => prev + visualDelta);
        
        // Send rotation delta to parent (object rotation)
        onDrag(objectDelta);
        
        lastMouseAngle.current = currentMouseAngle;
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
  }, [isDragging, onDrag, onDragEnd, getMouseAngle]);

  // Use GPU picking hover state OR prop-based hover (fallback)
  const effectiveHovered = isPickingHovered || isHovered;

  const opacity = isHidden ? 0 : isDimmed ? 0.15 : 0.6;
  const dimmedColor = '#cccccc'; // Light grey for dimmed state
  const diamondColor = isDimmed ? dimmedColor : ringColors.diamond;
  const ringColor = isDimmed ? dimmedColor : ringColors.ring;

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

  // Create front arc (90 degrees) - quarter circle
  const frontArcPoints = useMemo(() => {
    const points = [];
    const segments = 32;
    // Front arc: from -45° to +45° (90° total)
    const arcAngle = Math.PI / 2; // 90° in radians
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * arcAngle - arcAngle / 2; // -45° to +45°
      points.push(
        new THREE.Vector3(
          Math.cos(angle) * GIZMO_SIZES.ringMajorRadius,
          Math.sin(angle) * GIZMO_SIZES.ringMajorRadius,
          0
        )
      );
    }
    return points;
  }, []);

  const backArcPoints = useMemo(() => {
    const points = [];
    const segments = 32;
    // Back arc: from +90° to +270° (relative to camera direction)
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI + Math.PI / 2; // +90° to +270°
      points.push(
        new THREE.Vector3(
          Math.cos(angle) * GIZMO_SIZES.ringMajorRadius,
          Math.sin(angle) * GIZMO_SIZES.ringMajorRadius,
          0
        )
      );
    }
    return points;
  }, []);

  // Ring rotation uses same logic as handle position
  // (The handleAngle already calculated above is what we need)

  // Create gradient tube geometry for the arc (to match axis line thickness)
  const arcGeometry = useMemo(() => {
    const segments = 32;
    const arcAngle = Math.PI / 2; // 90°
    
    // Get pure colors based on axis (center of arc)
    const pureCenterColor = axis === 'x' ? '#ff0000' : axis === 'y' ? '#0ce300' : '#0000ff';
    // Get end colors (lighter at arc ends)
    const arcEndColor = axis === 'x' ? '#ff9900' : axis === 'y' ? '#ffcc00' : '#1596ff';
    
    const pureColor = new THREE.Color(pureCenterColor);
    const endColor = new THREE.Color(arcEndColor);
    
    // Create curve path for the arc
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * arcAngle - arcAngle / 2;
      const x = Math.cos(angle) * GIZMO_SIZES.ringMajorRadius;
      const y = Math.sin(angle) * GIZMO_SIZES.ringMajorRadius;
      points.push(new THREE.Vector3(x, y, 0));
    }
    
    const curve = new THREE.CatmullRomCurve3(points);
    const tubeGeometry = new THREE.TubeGeometry(curve, segments, 0.02, 8, false); // radius 0.02 to match axis lines
    
    // Apply gradient colors to tube
    const colors = new Float32Array(tubeGeometry.attributes.position.count * 3);
    for (let i = 0; i < tubeGeometry.attributes.position.count; i++) {
      const x = tubeGeometry.attributes.position.getX(i);
      const y = tubeGeometry.attributes.position.getY(i);
      const angle = Math.atan2(y, x);
      const normalizedAngle = (angle + arcAngle / 2) / arcAngle; // 0 to 1 along arc
      
      // Gradient from ends to center
      const distFromCenter = Math.abs(normalizedAngle - 0.5) * 2;
      const t = Math.max(0, (distFromCenter - 0.4) / 0.6);
      const color = new THREE.Color().lerpColors(pureColor, endColor, t);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    
    tubeGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return tubeGeometry;
  }, [axis]);

  return (
    <group
      rotation={rotation}
      onPointerDown={handlePointerDown}
    >
      {/* Pickable mesh for GPU picking - invisible but rendered in pick pass */}
      <mesh ref={pickMeshRef} position={handlePosition}>
        <sphereGeometry args={[GIZMO_SIZES.ringDiamondRadius * 2, 16, 16]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      
      {/* Rotating group to keep colored arc facing camera - uses same angle as handle */}
      <group rotation={[0, 0, handleAngle]}>
        {/* Front arc with gradient - pure color at center, lighter at ends */}
        <mesh geometry={arcGeometry}>
          <meshBasicMaterial 
            vertexColors={!isDimmed}
            color={isDimmed ? dimmedColor : '#ffffff'}
            opacity={opacity}
            transparent
            depthTest={false} 
            toneMapped={false} 
          />
        </mesh>
      </group>

      {/* Double-pointed arrow handle (two cones) */}
      <group position={handlePosition} rotation={[0, 0, tangentAngle]}>
        {/* Billboard group to face camera */}
        <group rotation={[billboardRotation, 0, 0]}>
          {/* Clockwise-pointing cone along tangent */}
          <group position={[GIZMO_SIZES.ringDiamondRadius / 2, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
            {/* Outline - slightly larger with darker color */}
            <mesh scale={1.15}>
              <coneGeometry args={[GIZMO_SIZES.ringDiamondRadius * 0.4, GIZMO_SIZES.ringDiamondRadius, 8]} />
              <meshBasicMaterial
                color={new THREE.Color(diamondColor).multiplyScalar(0.3).getHex()}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
            {/* Main colored cone */}
            <mesh>
              <coneGeometry args={[GIZMO_SIZES.ringDiamondRadius * 0.4, GIZMO_SIZES.ringDiamondRadius, 8]} />
              <meshBasicMaterial
                color={diamondColor}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
          </group>
          
          {/* Counter-clockwise-pointing cone along tangent */}
          <group position={[-GIZMO_SIZES.ringDiamondRadius / 2, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            {/* Outline - slightly larger with darker color */}
            <mesh scale={1.15}>
              <coneGeometry args={[GIZMO_SIZES.ringDiamondRadius * 0.4, GIZMO_SIZES.ringDiamondRadius, 8]} />
              <meshBasicMaterial
                color={new THREE.Color(diamondColor).multiplyScalar(0.3).getHex()}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
            {/* Main colored cone */}
            <mesh>
              <coneGeometry args={[GIZMO_SIZES.ringDiamondRadius * 0.4, GIZMO_SIZES.ringDiamondRadius, 8]} />
              <meshBasicMaterial
                color={diamondColor}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
          </group>
        </group>
      </group>

      {/* Point light at diamond handle to cast colored light on model */}
      {enableLighting && !isDimmed && (
        <pointLight
          position={handlePosition}
          color={ringColors.diamond}
          intensity={lightIntensity}
          distance={GIZMO_LIGHTING.pointLightDistance}
          decay={GIZMO_LIGHTING.pointLightDecay}
        />
      )}
    </group>
  );
}
