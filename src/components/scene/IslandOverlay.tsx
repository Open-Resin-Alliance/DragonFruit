
import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import { applyIslandOverlay as drawIslandOverlay } from '@/volumeAnalysis/IslandScan/islandOverlayPainter';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { getScanVisualPosition } from '@/utils/scanPositioning';

type IslandOverlayProps = {
  markers: IslandMarker[];
  meshRef?: THREE.Mesh | null;
  brushRadiusMm: number;
  color: string;
  opacity: number;
  transform?: ModelTransform;
  centerOffset?: THREE.Vector3;
  selectedIslandId?: number | null;
  clipLower?: number | null;
  clipUpper?: number | null;
};

/**
 * Renders 3D island shapes based on actual island geometry.
 * Creates low-poly 3D objects from the first few layers of each island.
 * Applies the same transform as the main mesh to keep overlays aligned.
 */
export function IslandOverlay({ markers, meshRef, brushRadiusMm, color, opacity, transform, centerOffset, selectedIslandId, clipLower, clipUpper }: IslandOverlayProps) {
  // console.log(`[${ new Date().toISOString() }][IslandOverlay] Render start`);
  const threeColor = useMemo(() => new THREE.Color(color), [color]);
  const visibleColor = useMemo(() => new THREE.Color('#ffff00'), []); // Bright yellow when visible
  const occludedColor = useMemo(() => new THREE.Color('#fF6600'), []); // Vibrant red-orange when behind mesh

  // Create clipping planes for layer slider support
  const clippingPlanes = useMemo(() => {
    const planes: THREE.Plane[] = [];

    if (clipLower != null) {
      planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
    }
    if (clipUpper != null) {
      planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
    }

    return planes;
  }, [clipLower, clipUpper]);

  // console.log('[IslandOverlay] Rendering with:', {
  //   markerCount: markers.length,
  //   color,
  //   opacity,
  //   hasTransform: !!transform,
  //   hasCenterOffset: !!centerOffset,
  //   centerOffset: centerOffset ? { x: centerOffset.x, y: centerOffset.y, z: centerOffset.z } : null,
  //   selectedIslandId
  // });

  if (markers.length === 0) {
    // console.log('[IslandOverlay] No markers to render');
    return null;
  }

  // Apply X/Y translation only - marker geometries are already in world space (including auto-lift and rotation)
  return (
    <group position={getScanVisualPosition(transform)}>
      {markers.map((marker) => {
        if (!marker.geometry) return null;

        // Special handling for Markers (Negative IDs)
        if (marker.id < 0) {
          const isSeed = marker.id < -1_000_000;
          const markerColor = isSeed ? '#00ff00' : '#ffff00'; // Green for Seed, Yellow for Center

          return (
            <mesh
              key={marker.id}
              geometry={marker.geometry}
              renderOrder={99999}
            >
              <meshBasicMaterial
                color={markerColor}
                depthTest={false}
                depthWrite={false}
                clippingPlanes={clippingPlanes}
              />
            </mesh>
          );
        }

        const isSelected = marker.id === selectedIslandId;

        if (isSelected) {
          // Render selected island twice:
          // 1. Orange version without depth test (always visible, shows when occluded)
          // 2. Yellow version with depth test (only visible when not occluded)
          return (
            <group key={marker.id}>
              {/* Occluded state - orange, no depth test, renders behind */}
              <mesh
                geometry={marker.geometry}
                renderOrder={999}
              >
                <meshStandardMaterial
                  color={occludedColor}
                  transparent
                  opacity={0.95}
                  depthTest={false}
                  depthWrite={false}
                  roughness={0.8}
                  metalness={0.0}
                  clippingPlanes={clippingPlanes}
                  clipIntersection
                />
              </mesh>

              {/* Visible state - yellow, with depth test, renders on top */}
              <mesh
                geometry={marker.geometry}
                renderOrder={1000}
              >
                <meshStandardMaterial
                  color={visibleColor}
                  transparent
                  opacity={0.95}
                  depthTest={true}
                  depthWrite={false}
                  roughness={0.8}
                  metalness={0.0}
                  clippingPlanes={clippingPlanes}
                  clipIntersection
                />
              </mesh>
            </group>
          );
        } else {
          // Non-selected islands render normally
          return (
            <mesh
              key={marker.id}
              geometry={marker.geometry}
            >
              <meshStandardMaterial
                color={threeColor}
                transparent
                opacity={opacity}
                depthTest={true}
                roughness={0.8}
                metalness={0.0}
                clippingPlanes={clippingPlanes}
                clipIntersection
              />
            </mesh>
          );
        }
      })}
    </group>
  );
}
