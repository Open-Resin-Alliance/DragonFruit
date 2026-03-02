"use client";

import * as THREE from 'three';
import React from 'react';

// Slice geometry at Z height and return loops in XY plane
// Applies transform matrix to vertices before slicing for world-space slicing
function computeLoopsAtZ(geometry: THREE.BufferGeometry, z: number, transformMatrix?: THREE.Matrix4): THREE.Vector2[][] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const segments: Array<[THREE.Vector2, THREE.Vector2]> = [];
  const zSlice = z + 1e-5;
  const EPS = 1e-9;

  for (let i = 0; i < pos.count; i += 3) {
    let v0 = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    let v1 = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
    let v2 = new THREE.Vector3(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));

    // Apply transform to get world-space coordinates
    if (transformMatrix) {
      v0.applyMatrix4(transformMatrix);
      v1.applyMatrix4(transformMatrix);
      v2.applyMatrix4(transformMatrix);
    }

    const above = [v0.z >= zSlice + 10 * EPS, v1.z >= zSlice + 10 * EPS, v2.z >= zSlice + 10 * EPS];
    const below = [v0.z <= zSlice - 10 * EPS, v1.z <= zSlice - 10 * EPS, v2.z <= zSlice - 10 * EPS];
    if ((above[0] && above[1] && above[2]) || (below[0] && below[1] && below[2])) continue;

    const intersectEdge = (a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 | null => {
      const dz = b.z - a.z;
      if (Math.abs(dz) < EPS) return null;
      const t = (zSlice - a.z) / dz;
      if (t < -EPS || t > 1 + EPS) return null;
      return new THREE.Vector3(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), zSlice);
    };

    const points: THREE.Vector3[] = [];
    const e01 = intersectEdge(v0, v1); if (e01) points.push(e01);
    const e12 = intersectEdge(v1, v2); if (e12) points.push(e12);
    const e20 = intersectEdge(v2, v0); if (e20) points.push(e20);

    if (points.length === 2) {
      segments.push([new THREE.Vector2(points[0].x, points[0].y), new THREE.Vector2(points[1].x, points[1].y)]);
    }
  }

  // Build loops
  const loops: THREE.Vector2[][] = [];
  while (segments.length > 0) {
    const loop: THREE.Vector2[] = [];
    const [start, end] = segments.shift()!;
    loop.push(start, end);

    let searching = true;
    while (searching && segments.length > 0) {
      searching = false;
      for (let i = 0; i < segments.length; i++) {
        const [a, b] = segments[i];
        if (loop[loop.length - 1].distanceTo(a) < 1e-6) {
          loop.push(b);
          segments.splice(i, 1);
          searching = true;
          break;
        } else if (loop[loop.length - 1].distanceTo(b) < 1e-6) {
          loop.push(a);
          segments.splice(i, 1);
          searching = true;
          break;
        }
      }
    }
    loops.push(loop);
  }

  return loops;
}

// Rasterize loops into a pixel grid
function rasterizeLoops(loops: THREE.Vector2[][], pxMm: number, bbox: { minX: number; maxX: number; minY: number; maxY: number }): { grid: Uint8Array; width: number; height: number; originX: number; originY: number } {
  const width = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) / pxMm));
  const height = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) / pxMm));
  const grid = new Uint8Array(width * height);
  const originX = bbox.minX + pxMm * 0.5;
  const originY = bbox.minY + pxMm * 0.5;

  // Rasterize each loop
  for (const loop of loops) {
    if (loop.length < 3) continue;

    // Scanline rasterization
    for (let row = 0; row < height; row++) {
      const worldY = originY + row * pxMm;
      const intersections: number[] = [];

      // Find intersections with this scanline
      for (let i = 0; i < loop.length; i++) {
        const p1 = loop[i];
        const p2 = loop[(i + 1) % loop.length];

        if ((p1.y <= worldY && p2.y > worldY) || (p2.y <= worldY && p1.y > worldY)) {
          const t = (worldY - p1.y) / (p2.y - p1.y);
          const x = p1.x + t * (p2.x - p1.x);
          intersections.push(x);
        }
      }

      // Sort intersections and fill between pairs
      intersections.sort((a, b) => a - b);
      for (let i = 0; i < intersections.length; i += 2) {
        if (i + 1 >= intersections.length) break;
        const startX = intersections[i];
        const endX = intersections[i + 1];
        const startCol = Math.floor((startX - bbox.minX) / pxMm);
        const endCol = Math.floor((endX - bbox.minX) / pxMm);

        for (let col = Math.max(0, startCol); col <= Math.min(width - 1, endCol); col++) {
          grid[row * width + col] = 1;
        }
      }
    }
  }

  return { grid, width, height, originX, originY };
}

export function CrossSectionCap({
  geometry,
  y,
  color = '#ffffff',
  transformMatrix,
  mode = 'smooth',
  pxMm = 0.1,
  visible = true
}: {
  geometry: THREE.BufferGeometry;
  y: number;
  color?: string;
  transformMatrix?: THREE.Matrix4;
  mode?: 'smooth' | 'rasterized';
  pxMm?: number;
  visible?: boolean;
}) {
  const mesh = React.useMemo(() => {
    if (!visible) return null;

    // Slice at world-space Z height using transformed geometry
    const loops = computeLoopsAtZ(geometry, y, transformMatrix);

    const group = new THREE.Group();
    group.renderOrder = 990;

    if (mode === 'rasterized') {
      // Calculate bounding box of all loops
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const loop of loops) {
        for (const pt of loop) {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.y > maxY) maxY = pt.y;
        }
      }

      if (isFinite(minX) && isFinite(maxX) && isFinite(minY) && isFinite(maxY)) {
        const { grid, width, height, originX, originY } = rasterizeLoops(loops, pxMm, { minX, maxX, minY, maxY });

        // Count active pixels
        let pixelCount = 0;
        for (let i = 0; i < grid.length; i++) {
          if (grid[i] === 1) pixelCount++;
        }

        if (pixelCount > 0) {
          // Use InstancedMesh for massive performance improvement
          const pixelSize = pxMm * 0.95; // Slightly smaller to show grid lines
          const pixelGeom = new THREE.PlaneGeometry(pixelSize, pixelSize);
          const mat = new THREE.MeshBasicMaterial({
            color,
            depthWrite: true,
            depthTest: true,
            transparent: false,
            opacity: 1.0,
            side: THREE.FrontSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1
          });

          const instancedMesh = new THREE.InstancedMesh(pixelGeom, mat, pixelCount);
          const matrix = new THREE.Matrix4();
          let instanceIndex = 0;

          for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
              if (grid[row * width + col] === 1) {
                const worldX = originX + col * pxMm;
                const worldY = originY + row * pxMm;
                matrix.setPosition(worldX, worldY, y + 1e-4);
                instancedMesh.setMatrixAt(instanceIndex++, matrix);
              }
            }
          }

          instancedMesh.instanceMatrix.needsUpdate = true;
          group.add(instancedMesh);
        }
      }
    } else {
      // Smooth mode - original behavior
      for (const loop of loops) {
        const shape = new THREE.Shape(loop);
        const shapeGeom = new THREE.ShapeGeometry(shape);
        shapeGeom.translate(0, 0, y + 1e-4);

        const mat = new THREE.MeshBasicMaterial({
          color,
          depthWrite: true,
          depthTest: true,
          transparent: false,
          opacity: 1.0,
          side: THREE.FrontSide,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1
        });
        const m = new THREE.Mesh(shapeGeom, mat);
        group.add(m);
      }
    }

    return group;
  }, [geometry, y, color, transformMatrix, mode, pxMm]);

  if (!mesh) return null;
  return <primitive object={mesh} />;
}
