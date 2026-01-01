"use client";

import React from 'react';
import * as THREE from 'three';
import { ShaftSegment as ShaftSegmentType } from '../Joints/types';

interface ShaftSegmentProps {
  segment: ShaftSegmentType;
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
}

/**
 * Renders a single shaft segment as a cylinder between two points.
 * Used for multi-segment supports with joints.
 */
export function ShaftSegment({
  segment,
  color = '#ff8800',
  emissive = '#000000',
  emissiveIntensity = 0,
}: ShaftSegmentProps) {
  const { startPosition, endPosition, diameterMm } = segment;
  const radius = diameterMm / 2;

  // Calculate segment properties
  const start = new THREE.Vector3(startPosition.x, startPosition.y, startPosition.z);
  const end = new THREE.Vector3(endPosition.x, endPosition.y, endPosition.z);
  
  const length = start.distanceTo(end);
  
  // Calculate midpoint
  const midpoint = new THREE.Vector3(
    (start.x + end.x) / 2,
    (start.y + end.y) / 2,
    (start.z + end.z) / 2
  );
  
  // Calculate rotation to align cylinder with segment direction
  // CylinderGeometry is vertical (along Y axis), we need to rotate it
  const direction = new THREE.Vector3().subVectors(end, start).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);

  // Handle degenerate case (zero-length segment)
  if (length < 0.001) {
    return null;
  }

  return (
    <group position={[midpoint.x, midpoint.y, midpoint.z]} quaternion={quaternion}>
      <mesh>
        <cylinderGeometry args={[radius, radius, length, 8]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
        />
      </mesh>
    </group>
  );
}
