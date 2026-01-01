"use client";

import React from 'react';

interface JointPreviewSphereProps {
  position: { x: number; y: number; z: number };
  diameter: number;
}

/**
 * Renders a preview sphere for joint creation mode.
 * Shows where a new joint will be placed when the user clicks.
 */
export function JointPreviewSphere({ position, diameter }: JointPreviewSphereProps) {
  const radius = diameter / 2;
  
  return (
    <mesh position={[position.x, position.y, position.z]}>
      <sphereGeometry args={[radius, 16, 16]} />
      <meshStandardMaterial
        color="#00ffff" // Cyan for preview
        transparent
        opacity={0.6}
        emissive="#00ffff"
        emissiveIntensity={0.3}
      />
    </mesh>
  );
}
