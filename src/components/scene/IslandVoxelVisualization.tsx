"use client";

import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { ScanResults } from '@/modules/island/ScanOrchestrator';
import { rleDecode } from '@/modules/island/rle'; // Import rleDecode

import type { ModelTransform } from '@/hooks/useModelTransform';
import { getScanVisualPosition } from '@/utils/scanPositioning';

interface IslandVoxelVisualizationProps {
  scanResults: ScanResults | null;
  layerHeightMm: number;
  enabled: boolean;
  opacity?: number;
  colorScheme?: 'unique' | 'lifecycle' | 'height';
  selectedIslandId?: number | null;
  showMerged?: boolean;
  centerOffset?: THREE.Vector3;
  zOffset?: number; // Z offset from build plate (bbox.min.z)
  clipLower?: number | null; // Lower clipping plane in world Z
  clipUpper?: number | null; // Upper clipping plane in world Z
  transform?: ModelTransform; // Model transform to follow
}

/**
 * Generate a mesh from voxel positions by creating faces between neighboring voxels
 * This creates a blocky but accurate mesh that follows the voxel structure
 */
function generateIslandMesh(positions: THREE.Vector3[], voxelSize: number, layerHeight: number): THREE.BufferGeometry {
  if (positions.length === 0) {
    return new THREE.BoxGeometry(0.1, 0.1, 0.1);
  }

  // Create a spatial hash map for quick neighbor lookup
  const voxelMap = new Map<string, THREE.Vector3>();
  positions.forEach(pos => {
    const key = `${Math.round(pos.x * 1000)},${Math.round(pos.y * 1000)},${Math.round(pos.z * 1000)}`;
    voxelMap.set(key, pos);
  });

  const vertices: number[] = [];
  const indices: number[] = [];
  let vertexIndex = 0;

  const halfSize = voxelSize / 2;
  const halfHeight = layerHeight / 2;

  // Helper to check if a voxel exists at a position
  const hasVoxel = (x: number, y: number, z: number): boolean => {
    const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    return voxelMap.has(key);
  };

  // For each voxel, create faces for exposed sides
  positions.forEach(pos => {
    const { x, y, z } = pos;

    // Check each of 6 directions and create a face if no neighbor
    // Front face (+Y)
    if (!hasVoxel(x, y + voxelSize, z)) {
      const v0 = [x - halfSize, y + halfSize, z - halfHeight];
      const v1 = [x + halfSize, y + halfSize, z - halfHeight];
      const v2 = [x + halfSize, y + halfSize, z + halfHeight];
      const v3 = [x - halfSize, y + halfSize, z + halfHeight];
      addQuad(vertices, indices, vertexIndex, v0, v1, v2, v3);
      vertexIndex += 4;
    }

    // Back face (-Y)
    if (!hasVoxel(x, y - voxelSize, z)) {
      const v0 = [x - halfSize, y - halfSize, z - halfHeight];
      const v1 = [x - halfSize, y - halfSize, z + halfHeight];
      const v2 = [x + halfSize, y - halfSize, z + halfHeight];
      const v3 = [x + halfSize, y - halfSize, z - halfHeight];
      addQuad(vertices, indices, vertexIndex, v0, v1, v2, v3);
      vertexIndex += 4;
    }

    // Right face (+X)
    if (!hasVoxel(x + voxelSize, y, z)) {
      const v0 = [x + halfSize, y - halfSize, z - halfHeight];
      const v1 = [x + halfSize, y - halfSize, z + halfHeight];
      const v2 = [x + halfSize, y + halfSize, z + halfHeight];
      const v3 = [x + halfSize, y + halfSize, z - halfHeight];
      addQuad(vertices, indices, vertexIndex, v0, v1, v2, v3);
      vertexIndex += 4;
    }

    // Left face (-X)
    if (!hasVoxel(x - voxelSize, y, z)) {
      const v0 = [x - halfSize, y - halfSize, z - halfHeight];
      const v1 = [x - halfSize, y + halfSize, z - halfHeight];
      const v2 = [x - halfSize, y + halfSize, z + halfHeight];
      const v3 = [x - halfSize, y - halfSize, z + halfHeight];
      addQuad(vertices, indices, vertexIndex, v0, v1, v2, v3);
      vertexIndex += 4;
    }

    // Top face (+Z)
    if (!hasVoxel(x, y, z + layerHeight)) {
      const v0 = [x - halfSize, y - halfSize, z + halfHeight];
      const v1 = [x - halfSize, y + halfSize, z + halfHeight];
      const v2 = [x + halfSize, y + halfSize, z + halfHeight];
      const v3 = [x + halfSize, y - halfSize, z + halfHeight];
      addQuad(vertices, indices, vertexIndex, v0, v1, v2, v3);
      vertexIndex += 4;
    }

    // Bottom face (-Z)
    if (!hasVoxel(x, y, z - layerHeight)) {
      const v0 = [x - halfSize, y - halfSize, z - halfHeight];
      const v1 = [x + halfSize, y - halfSize, z - halfHeight];
      const v2 = [x + halfSize, y + halfSize, z - halfHeight];
      const v3 = [x - halfSize, y + halfSize, z - halfHeight];
      addQuad(vertices, indices, vertexIndex, v0, v1, v2, v3);
      vertexIndex += 4;
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

/**
 * Helper to add a quad (2 triangles) to the mesh
 */
function addQuad(
  vertices: number[],
  indices: number[],
  startIdx: number,
  v0: number[],
  v1: number[],
  v2: number[],
  v3: number[]
) {
  // Add vertices
  vertices.push(...v0, ...v1, ...v2, ...v3);

  // Add indices for two triangles
  indices.push(
    startIdx, startIdx + 1, startIdx + 2,
    startIdx, startIdx + 2, startIdx + 3
  );
}

/**
 * Generates a unique color for each island using golden ratio hue distribution
 */
function getIslandColor(islandId: number, scheme: 'unique' | 'lifecycle' | 'height', island?: any, maxLayer?: number): THREE.Color {
  if (scheme === 'unique') {
    // Golden ratio hue distribution for visually distinct colors
    const hue = (islandId * 0.618033988749895) % 1.0;
    return new THREE.Color().setHSL(hue, 0.8, 0.6);
  } else if (scheme === 'lifecycle' && island) {
    // Green for active, orange for merged
    if (island.status === 'active') {
      return new THREE.Color(0x00ff00); // Green
    } else {
      return new THREE.Color(0xff8800); // Orange
    }
  } else if (scheme === 'height' && island && maxLayer) {
    // Blue to red gradient based on layer height
    const normalizedHeight = island.firstLayer / maxLayer;
    return new THREE.Color().setHSL((1 - normalizedHeight) * 0.66, 0.8, 0.5); // Blue (high) to red (low)
  }

  // Fallback
  return new THREE.Color(0xff0000);
}

/**
 * Renders islands as colored voxels using InstancedMesh for performance.
 * Each pixel from islandLabelsPerLayer becomes a small cube colored by its island ID.
 */
export function IslandVoxelVisualization({
  scanResults,
  layerHeightMm,
  enabled,
  opacity = 0.7,
  colorScheme = 'unique',
  selectedIslandId = null,
  showMerged = false,
  centerOffset,
  zOffset = 0,
  clipLower = null,
  clipUpper = null,
  transform,
}: IslandVoxelVisualizationProps) {

  // Generate island mesh data (geometry, color, etc.) - expensive, cached
  const islandMeshData = useMemo(() => {
    if (!enabled || !scanResults || !scanResults.islandLabelsPerLayer || scanResults.islandLabelsPerLayer.length === 0) {
      return [];
    }

    const { grid, islandLabelsPerLayer, islands } = scanResults;
    const meshData: Array<{
      id: number;
      geometry: THREE.BufferGeometry;
      color: THREE.Color;
      opacity: number;
      isSelected: boolean;
    }> = [];

    // Create a map of island ID to island data for quick lookup
    const islandMap = new Map(islands.map(island => [island.id, island]));

    // Filter islands based on showMerged setting
    const visibleIslands = islands.filter(island => {
      if (!showMerged && island.parentId !== undefined) {
        return false; // Hide merged islands
      }
      return true;
    });

    // Find max layer for height-based coloring
    const maxLayer = islandLabelsPerLayer.length - 1;

    // Pre-calculate grid constants to avoid repeated property access
    const { originX, originZ, px_mm, width, height } = grid;
    const negOriginZ = -originZ; // Pre-negate for Y calculation
    const layerSize = width * height;

    // Build a map of actual layer ranges for each island by scanning islandLabelsPerLayer
    // This is needed because placeholder island pixels get reassigned to parents,
    // but the parent's lastLayer doesn't get updated
    const islandLayerRanges = new Map<number, { first: number; last: number }>();

    // Iterate RLE layers to find ranges
    for (let layer = 0; layer < islandLabelsPerLayer.length; layer++) {
      const layerLabels = islandLabelsPerLayer[layer];
      // Iterate rows
      for (let y = 0; y < layerLabels.height; y++) {
        const row = layerLabels.rows[y];
        for (let i = 0; i < row.length; i += 3) {
          const islandId = row[i + 2];
          if (islandId > 0) {
            const range = islandLayerRanges.get(islandId);
            if (!range) {
              islandLayerRanges.set(islandId, { first: layer, last: layer });
            } else {
              range.last = layer;
            }
          }
        }
      }
    }

    // Strategy: Create one InstancedMesh per island for easy selection/highlighting
    for (const island of visibleIslands) {
      // Get actual layer range from the pixel data (accounts for reassigned placeholder pixels)
      const layerRange = islandLayerRanges.get(island.id);
      if (!layerRange) continue; // No pixels found for this island

      const startLayer = layerRange.first;
      const endLayer = layerRange.last;

      // Use simple array - push is fast enough for modern JS engines
      const positions: THREE.Vector3[] = [];

      // Collect SURFACE voxel positions only (not solid interior)
      // A voxel is on the surface if it has at least one neighbor that's not part of this island

      // Sliding window buffers for neighbor checking
      // We decode 3 layers at a time: prev, current, next
      let prevBuffer: Int32Array | null = null;
      let currBuffer: Int32Array | null = null;
      let nextBuffer: Int32Array | null = null;

      // Initialize buffers for startLayer
      if (startLayer > 0) {
        prevBuffer = new Int32Array(layerSize);
        // We need a helper to decode RLE labels to Int32Array grid
        // rleDecode returns Uint8Array (binary), we need ID grid.
        // We need a custom decode function here or update rleDecode.
        // I'll inline a simple decoder here.
        decodeRleLabelsToBuffer(islandLabelsPerLayer[startLayer - 1], prevBuffer, width);
      }

      currBuffer = new Int32Array(layerSize);
      decodeRleLabelsToBuffer(islandLabelsPerLayer[startLayer], currBuffer, width);

      if (startLayer < islandLabelsPerLayer.length - 1) {
        nextBuffer = new Int32Array(layerSize);
        decodeRleLabelsToBuffer(islandLabelsPerLayer[startLayer + 1], nextBuffer, width);
      }

      for (let layer = startLayer; layer <= endLayer; layer++) {
        const layerZ = zOffset + layer * layerHeightMm;

        // Iterate current buffer pixels
        for (let i = 0; i < layerSize; i++) {
          if (currBuffer![i] === island.id) {
            // Check neighbors
            const row = Math.floor(i / width);
            const col = i % width;

            const left = col > 0 ? currBuffer![i - 1] : 0;
            const right = col < width - 1 ? currBuffer![i + 1] : 0;
            const up = row > 0 ? currBuffer![i - width] : 0;
            const down = row < height - 1 ? currBuffer![i + width] : 0;

            const below = prevBuffer ? prevBuffer[i] : 0;
            const above = nextBuffer ? nextBuffer[i] : 0;

            const isSurface =
              left !== island.id ||
              right !== island.id ||
              up !== island.id ||
              down !== island.id ||
              below !== island.id ||
              above !== island.id;

            if (isSurface) {
              const worldX = originX + col * px_mm;
              const worldY = negOriginZ - row * px_mm;
              positions.push(new THREE.Vector3(worldX, worldY, layerZ));
            }
          }
        }

        // Shift buffers for next layer
        if (layer < endLayer) {
          prevBuffer = currBuffer; // Reuse buffer if possible? No, types match.
          currBuffer = nextBuffer;

          // Load new next buffer
          if (layer + 2 < islandLabelsPerLayer.length) {
            nextBuffer = new Int32Array(layerSize);
            decodeRleLabelsToBuffer(islandLabelsPerLayer[layer + 2], nextBuffer, width);
          } else {
            nextBuffer = null;
          }

          // If currBuffer was null (start of loop edge case?), create it
          // But logic ensures it's populated.
          // Wait, if nextBuffer was null in previous iter, currBuffer becomes null.
          // But we loop until endLayer.
          // If layer == endLayer, we don't need next iter buffers.
          // So this shift logic is fine.
          // Except if nextBuffer was null (last layer), currBuffer becomes null, but we exit loop.
          // Actually, if layer < endLayer, we enter next iter.
          // So currBuffer must be valid.
          // If nextBuffer was null (because layer+1 was out of bounds), then layer must be last layer?
          // No, endLayer could be last layer.
          // If layer < endLayer, then layer+1 exists. So nextBuffer was valid.
        }
      }

      if (positions.length === 0) continue;

      // Determine color for this island
      const isSelected = selectedIslandId !== null && island.id === selectedIslandId;
      const color = isSelected
        ? new THREE.Color(0xffff00) // Yellow for selected
        : getIslandColor(island.id, colorScheme, island, maxLayer);

      // Determine opacity
      const finalOpacity = isSelected ? 0.9 : opacity;

      // Generate mesh from voxel positions by creating faces for exposed sides
      const geometry = generateIslandMesh(positions, px_mm, layerHeightMm);

      meshData.push({
        id: island.id,
        geometry,
        color,
        opacity: finalOpacity,
        isSelected,
      });
    }

    return meshData;
  }, [enabled, scanResults, layerHeightMm, opacity, colorScheme, selectedIslandId, showMerged, centerOffset, zOffset]);

  // Create clipping planes (cheap, can update every frame)
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

  if (!enabled) return null;

  return (
    <group position={getScanVisualPosition(transform)}>
      {islandMeshData.map((data) => (
        <IslandSmoothMesh
          key={data.id}
          geometry={data.geometry}
          color={data.color}
          opacity={data.opacity}
          isSelected={data.isSelected}
          clippingPlanes={clippingPlanes}
        />
      ))}
    </group>
  );
}

function decodeRleLabelsToBuffer(rle: any, buffer: Int32Array, width: number) {
  if (!rle) return;
  // rle is RleLabels { rows: Int32Array[], width, height }
  const { rows, height } = rle;
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    const rowOffset = y * width;
    for (let i = 0; i < row.length; i += 3) {
      const start = row[i];
      const len = row[i + 1];
      const id = row[i + 2];
      if (id !== 0) {
        buffer.fill(id, rowOffset + start, rowOffset + start + len);
      }
    }
  }
}

/**
 * Component to render a smooth mesh for an island
 */
function IslandSmoothMesh({
  geometry,
  color,
  opacity,
  isSelected,
  clippingPlanes,
}: {
  geometry: THREE.BufferGeometry;
  color: THREE.Color;
  opacity: number;
  isSelected: boolean;
  clippingPlanes: THREE.Plane[];
}) {
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={color}
        transparent={opacity < 1}
        opacity={opacity}
        metalness={0.0}
        roughness={0.7}
        emissive={isSelected ? color : new THREE.Color(0x000000)}
        emissiveIntensity={isSelected ? 0.3 : 0}
        side={THREE.DoubleSide}
        clippingPlanes={clippingPlanes}
        clipIntersection
      />
    </mesh>
  );
}
