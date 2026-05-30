import React, { useMemo } from 'react';
import * as THREE from 'three';
import { useSupportPainterState } from '@/features/supportPainter/supportPainterStore';

/**
 * High-Performance Viewport Overlay for Point Path drawing mode.
 * Renders interactive 3D control point handles and skeleton path lines
 * overlaying the model mesh, using depth-offsetting to ensure 100% visibility.
 */
export default function PointPathOverlay() {
  const { activeBrush, pointPathPoints, pointPathMode } = useSupportPainterState();

  // 1. Line Material
  const lineMaterial = useMemo(() => {
    return new THREE.LineBasicMaterial({
      color: 0x10B981,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    });
  }, []);

  // Build the line segment vertices array
  const linePoints = useMemo(() => {
    const pts = pointPathPoints.map((pt) => new THREE.Vector3(...pt.point));
    // If in polygon mode and we have at least 3 points, close the loop visual skeleton
    if (pointPathMode === 'polygon' && pts.length >= 3) {
      pts.push(pts[0].clone());
    }
    return pts;
  }, [pointPathPoints, pointPathMode]);

  const lineGeometry = useMemo(() => {
    return new THREE.BufferGeometry().setFromPoints(linePoints);
  }, [linePoints]);

  const lineObject = useMemo(() => {
    if (linePoints.length < 2) return null;
    return new THREE.Line(lineGeometry, lineMaterial);
  }, [linePoints, lineGeometry, lineMaterial]);

  // Only render when PointPath brush is active and has placed control points
  if (activeBrush !== 'PointPath' || pointPathPoints.length === 0) {
    return null;
  }

  return (
    <group renderOrder={9999}>
      {/* 1. Connecting path lines rendered as primitive */}
      {lineObject && <primitive object={lineObject} />}

      {/* 2. Control Point Sphere Handles */}
      {pointPathPoints.map((pt, index) => {
        // Highlight the first point uniquely in polygon mode as the closure target
        const isFirst = index === 0;
        const color = isFirst && pointPathMode === 'polygon' && pointPathPoints.length >= 3
          ? '#F59E0B' // Amber/Gold close target
          : '#10B981'; // Standard Emerald green

        const size = isFirst && pointPathMode === 'polygon' && pointPathPoints.length >= 3
          ? 1.25 // Slightly larger closing target
          : 0.9;

        return (
          <mesh key={index} position={pt.point}>
            <sphereGeometry args={[size, 16, 16]} />
            <meshBasicMaterial
              color={color}
              depthTest={false}
              depthWrite={false}
              transparent={true}
              opacity={0.95}
            />
          </mesh>
        );
      })}
    </group>
  );
}
