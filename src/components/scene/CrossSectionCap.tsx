"use client";

import * as THREE from 'three';
import React from 'react';
import ClipperLib from 'clipper-lib';
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

type IntPoint = { X: number; Y: number };

const CLIPPER_SCALE = 1000;
const CONTEXT_CACHE_LIMIT = 8;
const LOOPS_CACHE_LIMIT = 48;
const LOOP_GROUPS_CACHE_LIMIT = 48;
const SHAPE_GEOMETRY_CACHE_LIMIT = 32;

function polygonSignedArea(loop: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    area += (a.x * b.y) - (b.x * a.y);
  }
  return area * 0.5;
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

function toIntPoint(point: THREE.Vector2): IntPoint {
  return {
    X: Math.round(point.x * CLIPPER_SCALE),
    Y: Math.round(point.y * CLIPPER_SCALE),
  };
}

function toVector2Loop(path: IntPoint[]): THREE.Vector2[] {
  return path.map((point) => new THREE.Vector2(point.X / CLIPPER_SCALE, point.Y / CLIPPER_SCALE));
}

function getPolyTreeChildren(node: any): any[] {
  if (!node) return [];
  if (Array.isArray(node.Childs)) return node.Childs;
  if (typeof node.Childs === 'function') {
    const value = node.Childs();
    return Array.isArray(value) ? value : [];
  }
  if (Array.isArray(node.m_Childs)) return node.m_Childs;
  return [];
}

function getPolyTreeContour(node: any): IntPoint[] {
  if (!node) return [];
  if (Array.isArray(node.Contour)) return node.Contour;
  if (Array.isArray(node.m_polygon)) return node.m_polygon;
  if (Array.isArray(node.m_Contour)) return node.m_Contour;
  return [];
}

function isPolyTreeHoleNode(node: any): boolean {
  if (!node) return false;
  if (typeof node.IsHole === 'function') return !!node.IsHole();
  if (typeof node.IsHole === 'boolean') return node.IsHole;
  if (typeof node.m_IsHole === 'boolean') return node.m_IsHole;
  return false;
}

function polyTreeToLoopGroups(polyTree: any): LoopGroup[] {
  const result: LoopGroup[] = [];

  const addOuterNode = (node: any) => {
    const outerContour = getPolyTreeContour(node);
    if (!outerContour || outerContour.length < 3) return;

    const outer = orientLoop(toVector2Loop(outerContour), false);
    const holes: THREE.Vector2[][] = [];

    for (const child of getPolyTreeChildren(node)) {
      if (!isPolyTreeHoleNode(child)) continue;
      const holeContour = getPolyTreeContour(child);
      if (!holeContour || holeContour.length < 3) continue;
      holes.push(orientLoop(toVector2Loop(holeContour), true));
    }

    result.push({ outer, holes });
  };

  if (polyTree && typeof polyTree.GetFirst === 'function') {
    let node = polyTree.GetFirst();
    while (node) {
      if (!isPolyTreeHoleNode(node)) {
        addOuterNode(node);
      }
      node = typeof node.GetNext === 'function' ? node.GetNext() : null;
    }
    return result;
  }

  for (const child of getPolyTreeChildren(polyTree)) {
    if (!isPolyTreeHoleNode(child)) {
      addOuterNode(child);
    }
  }

  return result;
}

function buildLoopGroups(loops: THREE.Vector2[][]): LoopGroup[] {
  const normalizedLoops = loops
    .map(normalizeLoop)
    .filter((loop) => loop.length >= 3 && Math.abs(polygonSignedArea(loop)) > 1e-8);

  if (normalizedLoops.length === 0) return [];

  const subject = normalizedLoops.map((loop) => loop.map(toIntPoint));
  const clipper = new ClipperLib.Clipper();
  clipper.StrictlySimple = true;
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);

  const polyTree = new ClipperLib.PolyTree();
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );

  return polyTreeToLoopGroups(polyTree);
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

type CrossSectionCapProps = {
  geometry?: THREE.BufferGeometry;
  sourceObject?: THREE.Object3D | null;
  projectedModels?: LoadedModel[];
  projectedContextVersion?: unknown;
  y: number;
  color?: string;
  side?: THREE.Side;
  offsetMm?: number;
  depthTest?: boolean;
  transformMatrix?: THREE.Matrix4;
  mode?: 'smooth' | 'rasterized';
  pxMm?: number;
  interactive?: boolean;
  interactiveZStepMm?: number;
  preferProjectedOnlyDuringInteractive?: boolean;
  visible?: boolean;
};

function quantizeInteractiveY(y: number, interactive?: boolean, interactiveZStepMm?: number): number {
  if (!interactive) return y;
  const step = Math.max(0.001, interactiveZStepMm ?? 0.2);
  return Math.round(y / step) * step;
}

function CrossSectionCapInner({
  geometry,
  sourceObject,
  projectedModels,
  projectedContextVersion,
  y,
  color = '#ffffff',
  side = THREE.FrontSide,
  offsetMm = 1e-4,
  depthTest = true,
  transformMatrix,
  mode = 'smooth',
  pxMm = 0.1,
  interactive = false,
  interactiveZStepMm = 0.2,
  preferProjectedOnlyDuringInteractive = true,
  visible = true
}: CrossSectionCapProps) {
  const projectedContextVersionObjectIdsRef = React.useRef<WeakMap<object, number>>(new WeakMap());
  const projectedContextVersionCounterRef = React.useRef(1);

  const projectedContextVersionKey = React.useMemo(() => {
    if (projectedContextVersion == null) return 'ctx:none';

    const valueType = typeof projectedContextVersion;
    if (
      valueType === 'string'
      || valueType === 'number'
      || valueType === 'boolean'
      || valueType === 'bigint'
      || valueType === 'symbol'
    ) {
      return `ctx:${valueType}:${String(projectedContextVersion)}`;
    }

    if (valueType === 'object' || valueType === 'function') {
      const valueObject = projectedContextVersion as object;
      const existingId = projectedContextVersionObjectIdsRef.current.get(valueObject);
      if (existingId != null) return `ctx:obj:${existingId}`;

      const nextId = projectedContextVersionCounterRef.current;
      projectedContextVersionCounterRef.current += 1;
      projectedContextVersionObjectIdsRef.current.set(valueObject, nextId);
      return `ctx:obj:${nextId}`;
    }

    return `ctx:other:${String(projectedContextVersion)}`;
  }, [projectedContextVersion]);

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
  const projectedLoopGroupsCacheRef = React.useRef<Map<string, LoopGroup[]>>(new Map());
  const projectedShapeGeometryCacheRef = React.useRef<Map<string, THREE.ShapeGeometry>>(new Map());

  React.useEffect(() => {
    return () => {
      for (const geometry of projectedShapeGeometryCacheRef.current.values()) {
        geometry.dispose();
      }
      projectedShapeGeometryCacheRef.current.clear();
    };
  }, []);

  const mesh = React.useMemo(() => {
    if (!visible) return null;

    const effectiveY = interactive
      ? Math.round(y / Math.max(0.001, interactiveZStepMm)) * Math.max(0.001, interactiveZStepMm)
      : y;
    const quantizedStepMm = interactive ? Math.max(0.001, interactiveZStepMm) : undefined;

    const loops: THREE.Vector2[][] = [];
    let projectedCacheKey: string | null = null;
    const canUseProjectedCaches = Boolean(
      projectedModels
      && (!sourceObject || (interactive && preferProjectedOnlyDuringInteractive))
      && !geometry,
    );

    if (projectedModels && projectedModels.length > 0) {
      const cacheKey = `${projectedContextVersionKey}|${projectedModelSignature}|${effectiveY.toFixed(3)}|off:${offsetMm.toFixed(4)}`;
      if (canUseProjectedCaches) {
        projectedCacheKey = cacheKey;
      }
      const cached = projectedLoopsCacheRef.current.get(cacheKey);
      if (cached) {
        loops.push(...cached);
      } else {
        let computed: THREE.Vector2[][] = [];

        if (projectedModelSignature) {
          const contextCacheKey = `${projectedContextVersionKey}|${projectedModelSignature}`;
          let context = projectedContextCacheRef.current.get(contextCacheKey);
          if (!context) {
            context = buildProjectedCrossSectionContext(projectedModels) ?? undefined;
            if (context) {
              projectedContextCacheRef.current.set(contextCacheKey, context);
              if (projectedContextCacheRef.current.size > CONTEXT_CACHE_LIMIT) {
                const oldestContextKey = projectedContextCacheRef.current.keys().next().value;
                if (oldestContextKey) projectedContextCacheRef.current.delete(oldestContextKey);
              }
            }
          }

          if (context) {
            computed = buildProjectedCrossSectionLoopsAtZFromContext({
              context,
              zMm: effectiveY,
              quantizedStepMm,
            });
          } else {
            // Fallback only when context construction failed.
            // If context exists and returns zero loops, that is a valid empty
            // intersection and should not trigger a second full context build.
            computed = buildProjectedCrossSectionLoopsAtZ({ models: projectedModels, zMm: effectiveY });
          }
        }

        loops.push(...computed);

        projectedLoopsCacheRef.current.set(cacheKey, computed);
        if (projectedLoopsCacheRef.current.size > LOOPS_CACHE_LIMIT) {
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

    let loopGroups: LoopGroup[] | undefined;
    if (projectedCacheKey) {
      loopGroups = projectedLoopGroupsCacheRef.current.get(projectedCacheKey);
      if (!loopGroups) {
        loopGroups = buildLoopGroups(loops);
        projectedLoopGroupsCacheRef.current.set(projectedCacheKey, loopGroups);
        if (projectedLoopGroupsCacheRef.current.size > LOOP_GROUPS_CACHE_LIMIT) {
          const oldestKey = projectedLoopGroupsCacheRef.current.keys().next().value;
          if (oldestKey) projectedLoopGroupsCacheRef.current.delete(oldestKey);
        }
      }
    } else {
      loopGroups = buildLoopGroups(loops);
    }

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
          const rgba = new Uint8Array(width * height * 4);
          const tint = new THREE.Color(color);
          const r = Math.round(THREE.MathUtils.clamp(tint.r, 0, 1) * 255);
          const g = Math.round(THREE.MathUtils.clamp(tint.g, 0, 1) * 255);
          const b = Math.round(THREE.MathUtils.clamp(tint.b, 0, 1) * 255);

          for (let row = 0; row < height; row += 1) {
            for (let col = 0; col < width; col += 1) {
              const srcIndex = row * width + col;
              const flippedRow = height - 1 - row;
              const dstIndex = (flippedRow * width + col) * 4;
              if (grid[srcIndex] === 1) {
                rgba[dstIndex] = r;
                rgba[dstIndex + 1] = g;
                rgba[dstIndex + 2] = b;
                rgba[dstIndex + 3] = 255;
              }
            }
          }

          const texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
          texture.needsUpdate = true;
          texture.flipY = false;
          texture.magFilter = THREE.NearestFilter;
          texture.minFilter = THREE.NearestFilter;
          texture.generateMipmaps = false;

          const planeWidth = width * pxMm;
          const planeHeight = height * pxMm;
          const planeGeom = new THREE.PlaneGeometry(planeWidth, planeHeight);
          const mat = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            alphaTest: 0.5,
            depthWrite: true,
            depthTest,
            opacity: 1.0,
            side,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          });

          const plane = new THREE.Mesh(planeGeom, mat);
          plane.position.set(originX + ((width - 1) * pxMm * 0.5), originY + ((height - 1) * pxMm * 0.5), effectiveY + offsetMm);
          group.add(plane);
        }
      }
    } else {
      let shapeGeom: THREE.ShapeGeometry;
      if (projectedCacheKey) {
        const cachedGeometry = projectedShapeGeometryCacheRef.current.get(projectedCacheKey);
        if (cachedGeometry) {
          shapeGeom = cachedGeometry;
        } else {
          const shapes = loopGroups.map((loopGroup) => {
            const shape = new THREE.Shape(loopGroup.outer);
            for (const hole of loopGroup.holes) {
              shape.holes.push(new THREE.Path(hole));
            }
            return shape;
          });

          shapeGeom = new THREE.ShapeGeometry(shapes);
          shapeGeom.translate(0, 0, effectiveY + offsetMm);
          projectedShapeGeometryCacheRef.current.set(projectedCacheKey, shapeGeom);
          if (projectedShapeGeometryCacheRef.current.size > SHAPE_GEOMETRY_CACHE_LIMIT) {
            const oldestKey = projectedShapeGeometryCacheRef.current.keys().next().value;
            if (oldestKey) {
              const oldestGeometry = projectedShapeGeometryCacheRef.current.get(oldestKey);
              projectedShapeGeometryCacheRef.current.delete(oldestKey);
              oldestGeometry?.dispose();
            }
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

        shapeGeom = new THREE.ShapeGeometry(shapes);
        shapeGeom.translate(0, 0, effectiveY + offsetMm);
      }

      const mat = new THREE.MeshBasicMaterial({
        color,
        depthWrite: true,
        depthTest,
        transparent: false,
        opacity: 1.0,
        side,
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
    depthTest,
    geometry,
    interactive,
    interactiveZStepMm,
    mode,
    offsetMm,
    preferProjectedOnlyDuringInteractive,
    projectedModelSignature,
    projectedContextVersionKey,
    pxMm,
    side,
    sourceObject,
    transformMatrix,
    visible,
    y,
  ]);

  if (!mesh) return null;
  return <primitive object={mesh} />;
}

const areCrossSectionCapPropsEqual = (
  prev: Readonly<CrossSectionCapProps>,
  next: Readonly<CrossSectionCapProps>,
) => {
  const prevY = quantizeInteractiveY(prev.y, prev.interactive, prev.interactiveZStepMm);
  const nextY = quantizeInteractiveY(next.y, next.interactive, next.interactiveZStepMm);

  return (
    prev.geometry === next.geometry
    && prev.sourceObject === next.sourceObject
    && prev.projectedModels === next.projectedModels
    && prev.projectedContextVersion === next.projectedContextVersion
    && prev.color === next.color
    && prev.side === next.side
    && prev.offsetMm === next.offsetMm
    && prev.depthTest === next.depthTest
    && prev.transformMatrix === next.transformMatrix
    && prev.mode === next.mode
    && prev.pxMm === next.pxMm
    && prev.interactive === next.interactive
    && prev.interactiveZStepMm === next.interactiveZStepMm
    && prev.preferProjectedOnlyDuringInteractive === next.preferProjectedOnlyDuringInteractive
    && prev.visible === next.visible
    && Math.abs(prevY - nextY) <= 1e-9
  );
};

const CrossSectionCapMemo = React.memo(CrossSectionCapInner, areCrossSectionCapPropsEqual);
CrossSectionCapMemo.displayName = 'CrossSectionCapMemo';

export function CrossSectionCap(props: CrossSectionCapProps) {
  return <CrossSectionCapMemo {...props} />;
}
