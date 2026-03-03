"use client";

import * as THREE from 'three';
import React from 'react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import {
  buildProjectedCrossSectionContext,
  buildProjectedCrossSectionLoopsAtZ,
  buildProjectedCrossSectionLoopsAtZFromContext,
  type ProjectedCrossSectionContext,
} from '@/features/slicing/rasterLayerZipExport';

// Slice geometry at Z height and return loops in XY plane
// Applies transform matrix to vertices before slicing for world-space slicing
function computeLoopsAtZ(geometry: THREE.BufferGeometry, z: number, transformMatrix?: THREE.Matrix4): THREE.Vector2[][] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const segments: Array<[THREE.Vector2, THREE.Vector2]> = [];
  const zSlice = z + 1e-5;
  const EPS = 1e-9;

  for (let i = 0; i < pos.count; i += 3) {
    const v0 = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const v1 = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
    const v2 = new THREE.Vector3(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));

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

function computeLoopsAtZFromObject(sourceObject: THREE.Object3D, z: number): THREE.Vector2[][] {
  const loops: THREE.Vector2[][] = [];
  const instanceMatrix = new THREE.Matrix4();
  const worldInstanceMatrix = new THREE.Matrix4();

  sourceObject.updateWorldMatrix(true, true);
  sourceObject.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;

    const bufferGeometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!bufferGeometry) return;
    const position = bufferGeometry.getAttribute('position');
    if (!position) return;

    const maybeInstancedMesh = mesh as THREE.InstancedMesh;
    if (maybeInstancedMesh.isInstancedMesh && maybeInstancedMesh.count > 0) {
      for (let i = 0; i < maybeInstancedMesh.count; i++) {
        maybeInstancedMesh.getMatrixAt(i, instanceMatrix);
        worldInstanceMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        loops.push(...computeLoopsAtZ(bufferGeometry, z, worldInstanceMatrix));
      }
      return;
    }

    loops.push(...computeLoopsAtZ(bufferGeometry, z, mesh.matrixWorld));
  });

  return loops;
}

type LoopGroup = {
  outer: THREE.Vector2[];
  holes: THREE.Vector2[][];
};

function polygonSignedArea(loop: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    area += (a.x * b.y) - (b.x * a.y);
  }
  return area * 0.5;
}

function isPointOnSegment2D(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2, eps = 1e-7): boolean {
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const apX = p.x - a.x;
  const apY = p.y - a.y;
  const cross = (abX * apY) - (abY * apX);
  if (Math.abs(cross) > eps) return false;

  const dot = (apX * abX) + (apY * abY);
  if (dot < -eps) return false;
  const lenSq = (abX * abX) + (abY * abY);
  if (dot - lenSq > eps) return false;
  return true;
}

function isPointOnPolygonBoundary2D(p: THREE.Vector2, loop: THREE.Vector2[], eps = 1e-7): boolean {
  for (let i = 0; i < loop.length; i += 1) {
    if (isPointOnSegment2D(p, loop[i], loop[(i + 1) % loop.length], eps)) {
      return true;
    }
  }
  return false;
}

function isPointInPolygon2D(point: THREE.Vector2, loop: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
    const xi = loop[i].x;
    const yi = loop[i].y;
    const xj = loop[j].x;
    const yj = loop[j].y;
    const intersects = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-20) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function normalizeLoop(loop: THREE.Vector2[]): THREE.Vector2[] {
  if (loop.length < 3) return [];
  const normalized = loop.map((p) => new THREE.Vector2(p.x, p.y));
  if (normalized.length >= 3 && normalized[0].distanceTo(normalized[normalized.length - 1]) < 1e-6) {
    normalized.pop();
  }
  return normalized;
}

function orientLoop(loop: THREE.Vector2[], clockwise: boolean): THREE.Vector2[] {
  const oriented = loop.map((p) => new THREE.Vector2(p.x, p.y));
  const isClockwise = THREE.ShapeUtils.isClockWise(oriented);
  if (isClockwise !== clockwise) {
    oriented.reverse();
  }
  return oriented;
}

function buildLoopGroups(loops: THREE.Vector2[][]): LoopGroup[] {
  const normalizedLoops = loops
    .map(normalizeLoop)
    .filter((loop) => loop.length >= 3 && Math.abs(polygonSignedArea(loop)) > 1e-8);

  if (normalizedLoops.length === 0) return [];

  const absAreas = normalizedLoops.map((loop) => Math.abs(polygonSignedArea(loop)));
  const parent = new Array<number>(normalizedLoops.length).fill(-1);

  for (let i = 0; i < normalizedLoops.length; i += 1) {
    let bestParent = -1;
    let bestParentArea = Infinity;

    for (let j = 0; j < normalizedLoops.length; j += 1) {
      if (i === j) continue;
      if (absAreas[j] <= absAreas[i]) continue;

      const candidatePoint = normalizedLoops[i].find((p) => !isPointOnPolygonBoundary2D(p, normalizedLoops[j]));
      if (!candidatePoint) continue;
      if (!isPointInPolygon2D(candidatePoint, normalizedLoops[j])) continue;

      if (absAreas[j] < bestParentArea) {
        bestParentArea = absAreas[j];
        bestParent = j;
      }
    }

    parent[i] = bestParent;
  }

  const depthMemo = new Array<number>(normalizedLoops.length).fill(-1);
  const getDepth = (index: number): number => {
    if (depthMemo[index] >= 0) return depthMemo[index];
    const p = parent[index];
    const depth = p < 0 ? 0 : getDepth(p) + 1;
    depthMemo[index] = depth;
    return depth;
  };

  const groupsByOuterIndex = new Map<number, LoopGroup>();

  for (let i = 0; i < normalizedLoops.length; i += 1) {
    const depth = getDepth(i);
    if (depth % 2 === 0) {
      groupsByOuterIndex.set(i, {
        outer: orientLoop(normalizedLoops[i], false),
        holes: [],
      });
    }
  }

  for (let i = 0; i < normalizedLoops.length; i += 1) {
    const depth = getDepth(i);
    if (depth % 2 !== 1) continue;
    const p = parent[i];
    if (p < 0) continue;
    const owner = groupsByOuterIndex.get(p);
    if (!owner) continue;
    owner.holes.push(orientLoop(normalizedLoops[i], true));
  }

  return Array.from(groupsByOuterIndex.values());
}

// Rasterize loops into a pixel grid
function rasterizeLoops(groups: LoopGroup[], pxMm: number, bbox: { minX: number; maxX: number; minY: number; maxY: number }): { grid: Uint8Array; width: number; height: number; originX: number; originY: number } {
  const width = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) / pxMm));
  const height = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) / pxMm));
  const winding = new Int16Array(width * height);
  const originX = bbox.minX + pxMm * 0.5;
  const originY = bbox.minY + pxMm * 0.5;

  const rasterizeLoopWithDelta = (loop: THREE.Vector2[], delta: number) => {
    if (loop.length < 3) return;

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
          winding[row * width + col] += delta;
        }
      }
    }
  };

  for (const group of groups) {
    rasterizeLoopWithDelta(group.outer, 1);
    for (const hole of group.holes) {
      rasterizeLoopWithDelta(hole, -1);
    }
  }

  const grid = new Uint8Array(width * height);
  for (let i = 0; i < winding.length; i += 1) {
    grid[i] = winding[i] !== 0 ? 1 : 0;
  }

  return { grid, width, height, originX, originY };
}

export function CrossSectionCap({
  geometry,
  sourceObject,
  projectedModels,
  y,
  color = '#ffffff',
  transformMatrix,
  mode = 'smooth',
  pxMm = 0.1,
  interactive = false,
  interactiveZStepMm = 0.2,
  preferProjectedOnlyDuringInteractive = true,
  visible = true
}: {
  geometry?: THREE.BufferGeometry;
  sourceObject?: THREE.Object3D | null;
  projectedModels?: LoadedModel[];
  y: number;
  color?: string;
  transformMatrix?: THREE.Matrix4;
  mode?: 'smooth' | 'rasterized';
  pxMm?: number;
  interactive?: boolean;
  interactiveZStepMm?: number;
  preferProjectedOnlyDuringInteractive?: boolean;
  visible?: boolean;
}) {
  const projectedModelSignature = React.useMemo(() => {
    if (!projectedModels || projectedModels.length === 0) return '';
    return projectedModels
      .filter((model) => model.visible)
      .map((model) => {
        const t = model.transform;
        return [
          model.id,
          model.geometry.geometry.uuid,
          t.position.x.toFixed(3),
          t.position.y.toFixed(3),
          t.position.z.toFixed(3),
          t.rotation.x.toFixed(3),
          t.rotation.y.toFixed(3),
          t.rotation.z.toFixed(3),
          t.scale.x.toFixed(3),
          t.scale.y.toFixed(3),
          t.scale.z.toFixed(3),
        ].join('|');
      })
      .join(';');
  }, [projectedModels]);

  const projectedLoopsCacheRef = React.useRef<Map<string, THREE.Vector2[][]>>(new Map());
  const projectedContextCacheRef = React.useRef<Map<string, ProjectedCrossSectionContext>>(new Map());

  const mesh = React.useMemo(() => {
    if (!visible) return null;

    const effectiveY = interactive
      ? Math.round(y / Math.max(0.001, interactiveZStepMm)) * Math.max(0.001, interactiveZStepMm)
      : y;

    const loops: THREE.Vector2[][] = [];

    if (projectedModels) {
      const cacheKey = `${projectedModelSignature}|${effectiveY.toFixed(3)}`;
      const cached = projectedLoopsCacheRef.current.get(cacheKey);
      if (cached) {
        loops.push(...cached);
      } else {
        let computed: THREE.Vector2[][] = [];

        if (projectedModelSignature) {
          let context = projectedContextCacheRef.current.get(projectedModelSignature);
          if (!context) {
            context = buildProjectedCrossSectionContext(projectedModels) ?? undefined;
            if (context) {
              projectedContextCacheRef.current.set(projectedModelSignature, context);
              if (projectedContextCacheRef.current.size > 8) {
                const oldestContextKey = projectedContextCacheRef.current.keys().next().value;
                if (oldestContextKey) projectedContextCacheRef.current.delete(oldestContextKey);
              }
            }
          }

          if (context) {
            computed = buildProjectedCrossSectionLoopsAtZFromContext({
              context,
              zMm: effectiveY,
            });
          }
        }

        if (computed.length === 0) {
          computed = buildProjectedCrossSectionLoopsAtZ({ models: projectedModels, zMm: effectiveY });
        }

        loops.push(...computed);

        projectedLoopsCacheRef.current.set(cacheKey, computed);
        if (projectedLoopsCacheRef.current.size > 48) {
          const oldestKey = projectedLoopsCacheRef.current.keys().next().value;
          if (oldestKey) projectedLoopsCacheRef.current.delete(oldestKey);
        }
      }
    }

    if (sourceObject && !(interactive && preferProjectedOnlyDuringInteractive)) {
      loops.push(...computeLoopsAtZFromObject(sourceObject, effectiveY));
    }

    if (!projectedModels && !sourceObject && geometry) {
      loops.push(...computeLoopsAtZ(geometry, effectiveY, transformMatrix));
    }

    if (loops.length === 0) return null;

    const loopGroups = buildLoopGroups(loops);
    if (loopGroups.length === 0) return null;

    const group = new THREE.Group();
    group.renderOrder = 990;

    if (mode === 'rasterized') {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      for (const loopGroup of loopGroups) {
        const allLoops = [loopGroup.outer, ...loopGroup.holes];
        for (const loop of allLoops) {
          for (const pt of loop) {
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
          }
        }
      }

      if (isFinite(minX) && isFinite(maxX) && isFinite(minY) && isFinite(maxY)) {
        const { grid, width, height, originX, originY } = rasterizeLoops(loopGroups, pxMm, { minX, maxX, minY, maxY });

        let pixelCount = 0;
        for (let i = 0; i < grid.length; i += 1) {
          if (grid[i] === 1) pixelCount += 1;
        }

        if (pixelCount > 0) {
          const pixelSize = pxMm * 0.95;
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
            polygonOffsetUnits: -1,
          });

          const instancedMesh = new THREE.InstancedMesh(pixelGeom, mat, pixelCount);
          const matrix = new THREE.Matrix4();
          let instanceIndex = 0;

          for (let row = 0; row < height; row += 1) {
            for (let col = 0; col < width; col += 1) {
              if (grid[row * width + col] === 1) {
                const worldX = originX + col * pxMm;
                const worldY = originY + row * pxMm;
                matrix.setPosition(worldX, worldY, effectiveY + 1e-4);
                instancedMesh.setMatrixAt(instanceIndex, matrix);
                instanceIndex += 1;
              }
            }
          }

          instancedMesh.instanceMatrix.needsUpdate = true;
          group.add(instancedMesh);
        }
      }
    } else {
      const shapes = loopGroups.map((loopGroup) => {
        const shape = new THREE.Shape(loopGroup.outer);
        for (const hole of loopGroup.holes) {
          shape.holes.push(new THREE.Path(hole));
        }
        return shape;
      });

      const shapeGeom = new THREE.ShapeGeometry(shapes);
      shapeGeom.translate(0, 0, effectiveY + 1e-4);

      const mat = new THREE.MeshBasicMaterial({
        color,
        depthWrite: true,
        depthTest: true,
        transparent: false,
        opacity: 1.0,
        side: THREE.FrontSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const m = new THREE.Mesh(shapeGeom, mat);
      group.add(m);
    }

    return group;
  }, [
    color,
    geometry,
    interactive,
    interactiveZStepMm,
    mode,
    preferProjectedOnlyDuringInteractive,
    projectedModelSignature,
    projectedModels,
    pxMm,
    sourceObject,
    transformMatrix,
    visible,
    y,
  ]);

  if (!mesh) return null;
  return <primitive object={mesh} />;
}
