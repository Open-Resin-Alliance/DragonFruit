import React, { useMemo, useState } from 'react';
import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { FlatteningPlane } from '../logic/computeFlatteningPlanes';

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

    const vertices: number[] = [];
    // Triangle fan starting from vertex 0
    for (let i = 1; i < pts.length - 1; i++) {
        vertices.push(pts[0].x, pts[0].y, pts[0].z);
        vertices.push(pts[i].x, pts[i].y, pts[i].z);
        vertices.push(pts[i+1].x, pts[i+1].y, pts[i+1].z);
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
      />
    </mesh>
  );
}
