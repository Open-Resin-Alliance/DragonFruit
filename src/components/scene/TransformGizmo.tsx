"use client";

import React, { useRef, useEffect } from 'react';
import { TransformControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { TransformMode } from '@/hooks/useModelTransform';

interface TransformGizmoProps {
  mode: TransformMode;
  meshRef: React.RefObject<THREE.Mesh | null>;
  onTransformChange?: (position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3) => void;
  onTransformEnd?: (mode: TransformMode) => void; // Called when widget is released
}

export function TransformGizmo({ mode, meshRef, onTransformChange, onTransformEnd }: TransformGizmoProps) {
  const transformRef = useRef<any>(null);
  const [isReady, setIsReady] = React.useState(false);

  // Check if mesh is ready and in the scene
  React.useEffect(() => {
    if (meshRef.current && meshRef.current.parent) {
      setIsReady(true);
    } else {
      setIsReady(false);
    }
  }, [meshRef.current, meshRef.current?.parent]);

  // Don't show gizmo in select mode or if mesh is not ready
  if (mode === 'select' || !isReady || !meshRef.current || !meshRef.current.parent) {
    return null;
  }

  // Map our mode to TransformControls mode
  const gizmoMode = mode === 'move' ? 'translate' : mode === 'rotate' ? 'rotate' : 'scale';

  const handleChange = () => {
    if (meshRef.current && onTransformChange) {
      onTransformChange(
        meshRef.current.position.clone(),
        meshRef.current.rotation.clone(),
        meshRef.current.scale.clone()
      );
    }
  };

  const handleMouseUp = () => {
    // Called when user releases the widget
    if (onTransformEnd) {
      onTransformEnd(mode);
    }
  };

  return (
    <TransformControls
      ref={transformRef}
      object={meshRef.current}
      mode={gizmoMode}
      onObjectChange={handleChange}
      onMouseUp={handleMouseUp}
    />
  );
}
