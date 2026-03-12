import React, { useMemo, useState } from 'react';
import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { FlatteningPlane } from '../logic/computeFlatteningPlanes';

const OVERLAY_RENDER_BIAS_MM = 0.12;

interface PlaceOnFaceOverlayProps {
  geometry: GeometryWithBounds;
  onFaceSelect: (normal: THREE.Vector3) => void;
  active: boolean;
}

export function PlaceOnFaceOverlay({ geometry, onFaceSelect, active }: PlaceOnFaceOverlayProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const planes = geometry.flatteningPlanes || [];

  if (!active || planes.length === 0) {
    return null;
  }

  return (
    <group>
      {planes.map((plane, idx) => {
        const isHovered = hoveredIndex === idx;
        return (
          <PlanePolygon
            key={idx}
            plane={plane}
            isHovered={isHovered}
            onPointerOver={(e) => {
              e.stopPropagation();
              setHoveredIndex(idx);
            }}
            onPointerOut={() => setHoveredIndex(null)}
            onClick={(e) => {
              e.stopPropagation();
              onFaceSelect(plane.normal);
            }}
          />
        );
      })}
    </group>
  );
}

// A helper component to convert a 3D polygon (array of vertices) into a rendered mesh
function PlanePolygon({
  plane,
  isHovered,
  onPointerOver,
  onPointerOut,
  onClick,
}: {
  plane: FlatteningPlane;
  isHovered: boolean;
  onPointerOver: (e: any) => void;
  onPointerOut: (e: any) => void;
  onClick: (e: any) => void;
}) {
  const geom = useMemo(() => {
    // Build a triangle fan from the vertices
    // The vertices in computeFlatteningPlanes are already sorted angularly around the center.
    const pts = plane.vertices;
    if (pts.length < 3) return null;
    const normal = plane.normal.clone().normalize();

    const vertices: number[] = [];
    // Triangle fan starting from vertex 0
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[0].clone().addScaledVector(normal, OVERLAY_RENDER_BIAS_MM);
      const p1 = pts[i].clone().addScaledVector(normal, OVERLAY_RENDER_BIAS_MM);
      const p2 = pts[i + 1].clone().addScaledVector(normal, OVERLAY_RENDER_BIAS_MM);

      vertices.push(p0.x, p0.y, p0.z);
      vertices.push(p1.x, p1.y, p1.z);
      vertices.push(p2.x, p2.y, p2.z);
    }
    
    const bufferGeo = new THREE.BufferGeometry();
    bufferGeo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    bufferGeo.computeVertexNormals();
    return bufferGeo;
  }, [plane]);

  if (!geom) return null;

  return (
    <mesh
      geometry={geom}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      onClick={onClick}
    >
      <meshBasicMaterial
        color={isHovered ? 0x4f8cff : 0xdddddd}
        transparent
        opacity={isHovered ? 0.75 : 0.4}
        side={THREE.DoubleSide}
        depthTest={true}
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}
