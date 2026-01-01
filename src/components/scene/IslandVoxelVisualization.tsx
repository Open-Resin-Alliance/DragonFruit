
"use client";

import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { Island } from '@/volumeAnalysis/IslandScan/types';
import { getIslandPixelsByLayer } from '@/volumeAnalysis/VoxelSystem/IslandVolume';
import { VOXEL_OFFSET_X, VOXEL_OFFSET_Y, VOXEL_OFFSET_Z, type ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { rleDecode } from '@/volumeAnalysis/IslandScan/rle';

import type { ModelTransform } from '@/hooks/useModelTransform';
import { getScanVisualPosition } from '@/utils/scanPositioning';
import { generateMeshFromRLE } from '@/volumeAnalysis/VoxelSystem/RleMeshing';

interface IslandVoxelVisualizationProps {
  scanResults: ScanResults | null;
  layerHeightMm: number;
  enabled: boolean;
  opacity?: number;
  colorScheme?: 'unique' | 'lifecycle' | 'height';
  selectedIslandId?: number | null;
  showMerged?: boolean;
  showTerritory?: boolean;
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
/**
 * Generate a mesh from voxel positions by creating faces between neighboring voxels.
 * Returns an array of geometries to handle WebGL index limits (chunking).
 */
function generateIslandMesh(positions: THREE.Vector3[], voxelSize: number, layerHeight: number): THREE.BufferGeometry[] {
  if (positions.length === 0) {
    return [new THREE.BoxGeometry(0.1, 0.1, 0.1)];
  }

  // Create a spatial hash map for quick neighbor lookup
  // Optimization: Use nested Maps/Sets instead of String keys to avoid massive GC pressure
  // Map<x, Map<y, Set<z>>>
  const xMap = new Map<number, Map<number, Set<number>>>();

  positions.forEach(pos => {
    const ix = Math.round(pos.x * 1000);
    const iy = Math.round(pos.y * 1000);
    const iz = Math.round(pos.z * 1000);

    let yMap = xMap.get(ix);
    if (!yMap) {
      yMap = new Map<number, Set<number>>();
      xMap.set(ix, yMap);
    }

    let zSet = yMap.get(iy);
    if (!zSet) {
      zSet = new Set<number>();
      yMap.set(iy, zSet);
    }

    zSet.add(iz);
  });

  const geometries: THREE.BufferGeometry[] = [];

  // Safe limit for indices per mesh. WebGL often maxes at ~30M-60M. 
  // Let's use 20M to be safe across distinct draw calls.
  // 6 faces * 6 indices = 36 indices per voxel ("worst" case of isolated voxel).
  const MAX_INDICES = 20_000_000;

  let vertices: number[] = [];
  let indices: number[] = [];
  let vertexIndex = 0;

  const halfSize = voxelSize / 2;
  const halfHeight = layerHeight / 2;

  // Helper to commit current arrays to a geometry
  const commitGeometry = () => {
    if (vertices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometries.push(geometry);

    // Reset
    vertices = [];
    indices = [];
    vertexIndex = 0;
  };

  // Helper to check if a voxel exists at a position
  const hasVoxel = (x: number, y: number, z: number): boolean => {
    const ix = Math.round(x * 1000);
    const iy = Math.round(y * 1000);
    const iz = Math.round(z * 1000);

    // Fast lookup without string allocation
    const yMap = xMap.get(ix);
    if (!yMap) return false;

    const zSet = yMap.get(iy);
    if (!zSet) return false;

    return zSet.has(iz);
  };

  const addFaces = (v0: number[], v1: number[], v2: number[], v3: number[]) => {
    // Check limits before adding
    if (indices.length + 6 > MAX_INDICES) {
      commitGeometry();
    }

    addQuad(vertices, indices, vertexIndex, v0, v1, v2, v3);
    vertexIndex += 4;
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
      addFaces(v0, v1, v2, v3);
    }

    // Back face (-Y)
    if (!hasVoxel(x, y - voxelSize, z)) {
      const v0 = [x - halfSize, y - halfSize, z - halfHeight];
      const v1 = [x - halfSize, y - halfSize, z + halfHeight];
      const v2 = [x + halfSize, y - halfSize, z + halfHeight];
      const v3 = [x + halfSize, y - halfSize, z - halfHeight];
      addFaces(v0, v1, v2, v3);
    }

    // Right face (+X)
    if (!hasVoxel(x + voxelSize, y, z)) {
      const v0 = [x + halfSize, y - halfSize, z - halfHeight];
      const v1 = [x + halfSize, y - halfSize, z + halfHeight];
      const v2 = [x + halfSize, y + halfSize, z + halfHeight];
      const v3 = [x + halfSize, y + halfSize, z - halfHeight];
      addFaces(v0, v1, v2, v3);
    }

    // Left face (-X)
    if (!hasVoxel(x - voxelSize, y, z)) {
      const v0 = [x - halfSize, y - halfSize, z - halfHeight];
      const v1 = [x - halfSize, y + halfSize, z - halfHeight];
      const v2 = [x - halfSize, y + halfSize, z + halfHeight];
      const v3 = [x - halfSize, y - halfSize, z + halfHeight];
      addFaces(v0, v1, v2, v3);
    }

    // Top face (+Z)
    if (!hasVoxel(x, y, z + layerHeight)) {
      const v0 = [x - halfSize, y - halfSize, z + halfHeight];
      const v1 = [x - halfSize, y + halfSize, z + halfHeight];
      const v2 = [x + halfSize, y + halfSize, z + halfHeight];
      const v3 = [x + halfSize, y - halfSize, z + halfHeight];
      addFaces(v0, v1, v2, v3);
    }

    // Bottom face (-Z)
    if (!hasVoxel(x, y, z - layerHeight)) {
      const v0 = [x - halfSize, y - halfSize, z - halfHeight];
      const v1 = [x + halfSize, y - halfSize, z - halfHeight];
      const v2 = [x + halfSize, y + halfSize, z - halfHeight];
      const v3 = [x - halfSize, y + halfSize, z - halfHeight];
      addFaces(v0, v1, v2, v3);
    }
  });

  // Final commit
  commitGeometry();

  return geometries;
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
  showTerritory = false,
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

    const { grid, islandLabelsPerLayer, territoryLabelsPerLayer, islands } = scanResults;

    // SOURCE SELECTION: Territory vs Island
    const activeLabels = (showTerritory && territoryLabelsPerLayer) ? territoryLabelsPerLayer : islandLabelsPerLayer;

    const meshData: Array<{
      id: number;
      geometries: THREE.BufferGeometry[];
      color: THREE.Color;
      opacity: number;
      isSelected: boolean;
    }> = [];

    // Create a map of island ID to island data for quick lookup
    // If showing Territory, we might not have 'islands' metadata for IDs.
    // We synthesize dummy islands.
    let visibleIslands: any[] = []; // Type 'any' to handle dummy objects

    if (showTerritory && territoryLabelsPerLayer) {
      // Collect all unique IDs from territory RLE
      const uniqueIds = new Set<number>();
      for (const layer of territoryLabelsPerLayer) {
        if (!layer) continue;
        for (let y = 0; y < layer.height; y++) {
          const row = layer.rows[y];
          for (let i = 0; i < row.length; i += 3) {
            if (row[i + 2] > 0) uniqueIds.add(row[i + 2]);
          }
        }
      }
      visibleIslands = Array.from(uniqueIds).map(id => ({ id, status: 'active' }));
    } else {
      // Standard Island Mode
      visibleIslands = islands.filter(island => {
        if (!showMerged && island.parentId !== undefined) {
          return false; // Hide merged islands
        }
        return true;
      });
    }

    const islandMap = new Map(islands.map(island => [island.id, island]));

    // Find max layer for height-based coloring
    const maxLayer = activeLabels.length - 1;

    // Pre-calculate grid constants to avoid repeated property access
    const { originX, originZ, px_mm, width, height } = grid;
    const negOriginZ = -originZ; // Pre-negate for Y calculation
    const layerSize = width * height;

    // Build a map of actual layer ranges for each island by scanning islandLabelsPerLayer
    // This is needed because placeholder island pixels get reassigned to parents,
    // but the parent's lastLayer doesn't get updated
    const islandLayerRanges = new Map<number, { first: number; last: number }>();

    // Iterate RLE layers to find ranges (USING SELECTED LABELS)
    for (let layer = 0; layer < activeLabels.length; layer++) {
      const layerLabels = activeLabels[layer];
      if (!layerLabels) continue; // Safety

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

      // Determine color for this island
      const isSelected = selectedIslandId !== null && island.id === selectedIslandId;
      const color = isSelected
        ? new THREE.Color(0xffff00) // Yellow for selected
        : getIslandColor(island.id, colorScheme, island, maxLayer);

      // Determine opacity
      const finalOpacity = isSelected ? 1.0 : opacity;

      // Generate mesh directly from RLE data (Greedy Meshing)
      // This skips the expensive position collection & map overhead
      const geometries = generateMeshFromRLE(
        island.id,
        activeLabels,
        grid,
        layerHeightMm,
        zOffset,
        startLayer,
        endLayer
      );

      meshData.push({
        id: island.id,
        geometries,
        color,
        opacity: finalOpacity,
        isSelected,
      });
    }

    return meshData;
  }, [enabled, scanResults, layerHeightMm, opacity, colorScheme, selectedIslandId, showMerged, showTerritory, centerOffset, zOffset]);

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
        <group key={data.id}> {/* Wrap chunks in a group (or fragment) */}
          {data.geometries.map((geom, idx) => (
            <IslandSmoothMesh
              key={`${data.id}-${idx}`}
              geometry={geom}
              color={data.color}
              opacity={data.opacity}
              isSelected={data.isSelected}
              clippingPlanes={clippingPlanes}
            />
          ))}
        </group>
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
        side={THREE.FrontSide}
        clippingPlanes={clippingPlanes}
        clipIntersection
      />
    </mesh>
  );
}
