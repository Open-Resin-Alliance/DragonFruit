import React, { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { useSupportPainterState } from '@/features/supportPainter/supportPainterStore';
import { PointPathMarker } from './PointPathMarker';
import { expandPathWithDijkstra } from '@/features/supportPainter/useClientAdjacencyMap';

/**
 * High-Performance Viewport Overlay for Point Path and Point Perimeter drawing mode.
 * Renders interactive 3D control point handles (0.2mm radius) with a
 * custom pulsating glow-fade shader that changes colors dynamically
 * when loop closure is within connecting range.
 */
export default function PointPathOverlay({ matrixWorld }: { matrixWorld?: THREE.Matrix4 }) {
  const { activeBrush, pointPathPoints, pointPathMode, hoveredWorldPoint, clientAdjacencyMap, pointPathClosed } = useSupportPainterState();

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

  // Calculate if the mouse is in range of closing the polygon loop (within 15px in screen space / 0.3mm local)
  const isInClosingRange = useMemo(() => {
    if (pointPathPoints.length < 3 || (pointPathMode !== 'polygon' && activeBrush !== 'PointPerimeter') || !hoveredWorldPoint) {
      return false;
    }
    const firstPos = new THREE.Vector3(...pointPathPoints[0].point);
    if (matrixWorld) {
      firstPos.applyMatrix4(matrixWorld);
    }
    const hoverPos = new THREE.Vector3(...hoveredWorldPoint);
    return firstPos.distanceTo(hoverPos) < 0.3;
  }, [pointPathPoints, pointPathMode, activeBrush, hoveredWorldPoint, matrixWorld]);

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
    let path = pointPathPoints.map(p => ({
      point: [...p.point] as [number, number, number],
      faceIndex: p.faceIndex,
      normal: p.normal ? [...p.normal] as [number, number, number] : undefined,
    }));

    if (clientAdjacencyMap && activeBrush !== 'SharpCorner') {
      const isClosed = (pointPathMode === 'polygon' || activeBrush === 'PointPerimeter');
      path = expandPathWithDijkstra(clientAdjacencyMap, path, isClosed);
    }

    const pts = path.map((pt) => {
      const v = new THREE.Vector3(...pt.point);
      if (pt.normal) {
        const n = new THREE.Vector3(...pt.normal).normalize();
        const offset = activeBrush === 'SharpCorner' ? 0.005 : 0.15;
        v.addScaledVector(n, offset); // Offset by normal to prevent Z-fighting
      }
      return v;
    });

    const isClosedPath = (pointPathMode === 'polygon' || activeBrush === 'PointPerimeter');
    if (isClosedPath && pts.length >= 3) {
      pts.push(pts[0].clone());
    }

    return pts;
  }, [pointPathPoints, pointPathMode, activeBrush, clientAdjacencyMap]);

  // Handle other points shader refs array allocations
  const registerOtherShaderRef = (index: number) => (el: THREE.ShaderMaterial | null) => {
    if (el) {
      otherPointsShaderRefs.current[index] = el;
    }
  };

  // Only render when PointPath, PointPerimeter or SharpCorner brush is active
  if (
    (activeBrush !== 'PointPath' &&
     activeBrush !== 'PointPerimeter' &&
     activeBrush !== 'SharpCorner') ||
    pointPathPoints.length === 0
  ) {
    return null;
  }

  return (
    <group renderOrder={9999}>
      {/* 1. Connecting path lines */}
      {linePoints.length >= 2 && (
        <>
          {/* Outline Line (Thicker, Dark) */}
          <Line
            points={linePoints}
            color="#1a1a1a"
            lineWidth={4.5}
            transparent
            opacity={0.7}
            depthTest={true}
            depthWrite={false}
          />
          {/* Core Line (Thinner, Colored) */}
          <Line
            points={linePoints}
            color={isInClosingRange ? '#00FF66' : '#10B981'}
            lineWidth={2.2}
            transparent
            opacity={0.95}
            depthTest={true}
            depthWrite={false}
          />
        </>
      )}

      {/* 2. Control Point Pulsating Glow Handles */}
      {activeBrush !== 'SharpCorner' && pointPathPoints.map((pt, index) => {
        const isFirst = index === 0;
        const color = isFirst ? firstPointColor : standardOrangeColor;

        const pos = new THREE.Vector3(...pt.point);
        if (pt.normal) {
          const n = new THREE.Vector3(...pt.normal).normalize();
          pos.addScaledVector(n, 0.15); // Offset by 0.15mm along normal
        }

        return (
          <PointPathMarker
            key={index}
            position={[pos.x, pos.y, pos.z]}
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

