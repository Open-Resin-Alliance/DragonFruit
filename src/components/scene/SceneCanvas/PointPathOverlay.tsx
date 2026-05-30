import React, { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useSupportPainterState } from '@/features/supportPainter/supportPainterStore';
import { PointPathMarker } from './PointPathMarker';

/**
 * High-Performance Viewport Overlay for Point Path drawing mode.
 * Renders interactive 3D control point handles (0.2mm radius) with a
 * custom pulsating glow-fade shader that changes colors dynamically
 * when loop closure is within connecting range.
 */
export default function PointPathOverlay() {
  const { activeBrush, pointPathPoints, pointPathMode, hoveredWorldPoint } = useSupportPainterState();

  // Reference lists of shader materials to animate uniforms
  const firstPointShaderRef = useRef<THREE.ShaderMaterial>(null);
  const otherPointsShaderRefs = useRef<THREE.ShaderMaterial[]>([]);

  // Update time uniform in R3F frame tick
  useFrame(({ clock }) => {
    const elapsed = clock.getElapsedTime();
    if (firstPointShaderRef.current) {
      firstPointShaderRef.current.uniforms.uTime.value = elapsed;
    }
    otherPointsShaderRefs.current.forEach((shader) => {
      if (shader) {
        shader.uniforms.uTime.value = elapsed;
      }
    });
  });

  // Calculate if the mouse is in range of closing the polygon loop (within 0.3mm)
  const isInClosingRange = useMemo(() => {
    if (pointPathPoints.length < 3 || pointPathMode !== 'polygon' || !hoveredWorldPoint) {
      return false;
    }
    const firstPos = new THREE.Vector3(...pointPathPoints[0].point);
    const hoverPos = new THREE.Vector3(...hoveredWorldPoint);
    return firstPos.distanceTo(hoverPos) < 0.3;
  }, [pointPathPoints, pointPathMode, hoveredWorldPoint]);

  // Color assignments
  const firstPointColor = useMemo(() => {
    // Green glow when in closing range, otherwise orange
    return new THREE.Color(isInClosingRange ? '#00FF66' : '#FF5B00');
  }, [isInClosingRange]);

  const standardOrangeColor = useMemo(() => {
    return new THREE.Color('#FF5B00'); // Orange placing glow
  }, []);

  // Line segment path rendering setup
  const linePoints = useMemo(() => {
    const pts = pointPathPoints.map((pt) => new THREE.Vector3(...pt.point));
    if (pointPathMode === 'polygon' && pts.length >= 3) {
      pts.push(pts[0].clone());
    }
    return pts;
  }, [pointPathPoints, pointPathMode]);

  const lineGeometry = useMemo(() => {
    return new THREE.BufferGeometry().setFromPoints(linePoints);
  }, [linePoints]);

  const lineMaterial = useMemo(() => {
    return new THREE.LineBasicMaterial({
      color: 0x00FF66,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    });
  }, []);

  const lineObject = useMemo(() => {
    if (linePoints.length < 2) return null;
    return new THREE.Line(lineGeometry, lineMaterial);
  }, [linePoints, lineGeometry, lineMaterial]);

  // Handle other points shader refs array allocations
  const registerOtherShaderRef = (index: number) => (el: THREE.ShaderMaterial | null) => {
    if (el) {
      otherPointsShaderRefs.current[index] = el;
    }
  };

  // Only render when PointPath brush is active
  if (activeBrush !== 'PointPath' || pointPathPoints.length === 0) {
    return null;
  }

  return (
    <group renderOrder={9999}>
      {/* 1. Connecting path lines */}
      {lineObject && <primitive object={lineObject} />}

      {/* 2. Control Point Pulsating Glow Handles */}
      {pointPathPoints.map((pt, index) => {
        const isFirst = index === 0;
        const color = isFirst ? firstPointColor : standardOrangeColor;

        return (
          <PointPathMarker
            key={index}
            position={pt.point}
            color={color}
            isFirst={isFirst}
            firstPointShaderRef={firstPointShaderRef}
            registerRef={registerOtherShaderRef(index)}
          />
        );
      })}
    </group>
  );
}
