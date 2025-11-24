"use client";

import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { Island } from '@/modules/island';
import type { ScanResults } from '@/modules/island/ScanOrchestrator';

type IslandIdLabelsProps = {
  islands: Island[];
  scanResults: ScanResults;
  layerHeightMm: number;
  enabled: boolean;
  bboxMinZ: number;
};

/**
 * Temporary component for debugging: Shows island IDs as billboarded text labels
 * in 3D space next to island overlay positions.
 * 
 * TO REMOVE: Delete this file and remove from SceneCanvas when no longer needed.
 */
export function IslandIdLabels({ islands, scanResults, layerHeightMm, enabled, bboxMinZ }: IslandIdLabelsProps) {
  if (!enabled || !scanResults) return null;

  // Calculate label positions (at the base of each island, same as overlay markers)
  const labelData = useMemo(() => {
    console.log('IslandIdLabels: Processing islands:', islands.map(i => ({ id: i.id, firstLayer: i.firstLayer, volumeMm3: i.volumeMm3 })));
    return islands.map(island => {
      // Get first layer where island appears
      // The model is normalized so bottom is at Z=0, so just use layer height
      const layerIdx = island.firstLayer;
      const baseZ = layerIdx * layerHeightMm;

      // Find center of island pixels at base layer
      const labels = scanResults.islandLabelsPerLayer[layerIdx];
      if (!labels) return null;

      const { grid } = scanResults;
      let sumX = 0, sumZ = 0, count = 0;

      // Iterate RLE rows
      for (let y = 0; y < labels.height; y++) {
        const row = labels.rows[y];
        for (let i = 0; i < row.length; i += 3) {
          const start = row[i];
          const len = row[i + 1];
          const id = row[i + 2];

          if (id === island.id) {
            // Calculate center of this run
            const runCenterX = start + (len - 1) / 2;

            // Convert grid coordinates to world coordinates (Z-up system)
            const worldX = grid.originX + runCenterX * grid.px_mm;
            const worldY = -(grid.originZ + y * grid.px_mm); // grid.originZ stores -Y, negate to get +Y

            sumX += worldX * len; // Weight by length
            sumZ += worldY * len;
            count += len;
          }
        }
      }

      if (count === 0) return null;

      const centerX = sumX / count;
      const centerY = sumZ / count; // World Y coordinate

      return {
        id: island.id,
        position: [centerX, centerY, baseZ + 1] as [number, number, number], // [X, Y, Z] in world space, +1mm above base
      };
    }).filter(Boolean) as Array<{ id: number; position: [number, number, number] }>;
  }, [islands, scanResults, layerHeightMm, bboxMinZ]);

  return (
    <>
      {labelData.map(({ id, position }) => (
        <IslandLabel key={id} id={id} position={position} />
      ))}
    </>
  );
}

/**
 * Single island ID label that always faces the camera (billboard effect)
 */
function IslandLabel({ id, position }: { id: number; position: [number, number, number] }) {
  // Create canvas texture with island ID
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;

    canvas.width = 128;
    canvas.height = 64;

    // Background
    context.fillStyle = 'rgba(0, 0, 0, 0.7)';
    context.fillRect(0, 0, canvas.width, canvas.height);

    // Border
    context.strokeStyle = '#00ff00';
    context.lineWidth = 2;
    context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

    // Text
    context.fillStyle = '#00ff00';
    context.font = 'Bold 32px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(`#${id}`, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    return texture;
  }, [id]);

  if (!texture) return null;

  return (
    <sprite position={position} scale={[4, 2, 1]}>
      <spriteMaterial
        map={texture}
        transparent
        sizeAttenuation={true}
        depthTest={true}
        depthWrite={false}
      />
    </sprite>
  );
}
