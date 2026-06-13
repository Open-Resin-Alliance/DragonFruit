import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { useSupportPainterState } from '@/features/supportPainter/supportPainterStore';
import { BRUSH_COLORS } from '@/features/supportPainter/supportPainterTypes';

interface VectorPathOverlayProps {
  modelId: string;
}

export default function VectorPathOverlay({ modelId }: VectorPathOverlayProps) {
  const { regionsByModel } = useSupportPainterState();

  // Get all committed regions for this model that have vectorPath
  const committedVectorRegions = useMemo(() => {
    const modelRegions = regionsByModel?.get(modelId);
    if (!modelRegions) return [];
    return Array.from(modelRegions.values()).filter(
      (r) => !r.proposedOnly && r.vectorPath && r.vectorPath.length > 0
    );
  }, [regionsByModel, modelId]);

  if (committedVectorRegions.length === 0) return null;

  return (
    <group renderOrder={9999}>
      {committedVectorRegions.map((region) => {
        const pts = region.vectorPath!.map((pt) => {
          const v = new THREE.Vector3(...pt.point);
          if (pt.normal) {
            const n = new THREE.Vector3(...pt.normal).normalize();
            v.addScaledVector(n, 0.15); // Offset by 0.15mm along surface normal to prevent Z-fighting and convex surface clipping
          }
          return v;
        });
        
        // If it's a PointPerimeter (closed loop), append the first point to close the path
        if (region.brushType === 'PointPerimeter' && pts.length >= 3) {
          pts.push(pts[0].clone());
        }

        const color = region.color || BRUSH_COLORS[region.brushType] || '#10B981';

        return (
          <group key={region.id}>
            {/* Outline Line (Thicker, Dark) */}
            <Line
              points={pts}
              color="#1a1a1a"
              lineWidth={4.5}
              transparent
              opacity={0.7}
              depthTest={true}
              depthWrite={false}
            />
            {/* Core Line (Thinner, Colored) */}
            <Line
              points={pts}
              color={color}
              lineWidth={2.2}
              transparent
              opacity={0.95}
              depthTest={true}
              depthWrite={false}
            />
          </group>
        );
      })}
    </group>
  );
}
