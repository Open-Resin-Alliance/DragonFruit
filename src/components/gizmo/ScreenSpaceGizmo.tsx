"use client";

import React, { useState } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { TransformGizmo } from './TransformGizmo';
import type { TransformGizmoProps } from './types';

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
  const [scale, setScale] = useState(1);
  const [livePosition, setLivePosition] = useState<[number, number, number]>([0, 0, 0]);
  const scaleFactor = props.scaleFactor ?? 0.04;
  
  // Update scale and position every frame based on mesh position
  useFrame(() => {
    let position: THREE.Vector3;
    
    // Read position directly from mesh if available (bypasses React state)
    if (props.meshRef?.current) {
      position = props.meshRef.current.position;
      // Only update state if position actually changed
      if (position.x !== livePosition[0] || position.y !== livePosition[1] || position.z !== livePosition[2]) {
        setLivePosition([position.x, position.y, position.z]);
      }
    } else if (Array.isArray(props.position)) {
      position = new THREE.Vector3(...props.position);
    } else {
      position = props.position as THREE.Vector3;
    }
    
    let newScale: number;
    if ((camera as any).isOrthographicCamera) {
      const ortho = camera as THREE.OrthographicCamera;
      const worldHeight = (ortho.top - ortho.bottom) / Math.max(1e-6, ortho.zoom);
      newScale = worldHeight * scaleFactor;
    } else {
      const distance = camera.position.distanceTo(position);
      newScale = distance * scaleFactor;
    }

    if (Math.abs(newScale - scale) > 1e-4) {
      setScale(newScale);
    }
  });

  // Use live position from mesh if available, otherwise use props
  const gizmoPosition = props.meshRef?.current ? livePosition : props.position;

  return <TransformGizmo {...props} position={gizmoPosition} size={scale} />;
}
