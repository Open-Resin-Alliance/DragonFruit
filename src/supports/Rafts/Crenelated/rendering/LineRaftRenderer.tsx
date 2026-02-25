"use client";

import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from '@/supports/state';
import { getRaftSettings, subscribeToRaftStore } from '../RaftState';
import { convexHull2d } from '../geometry/convexHull2d';
import { computeFootprint } from '../geometry/computeFootprint';
import { delaunayTriangulate2d } from '../geometry/delaunayTriangulate2d';
import { generateUnionedLineRaftMesh } from '../geometry/generateUnionedLineRaftMesh';
import { generateChamferedBeam } from '../geometry/generateChamferedBeam';
import { generatePerimeterBorderBeam } from '../geometry/generatePerimeterBorderBeam';
import { generatePerimeterWall } from '../geometry/generatePerimeterWall';
import { generateCrenelatedWallManual } from '../geometry/generateCrenelatedWallManual';
import type { SupportBaseCircle } from '../RaftTypes';

type EdgeKey = string;

function edgeKey(a: number, b: number): EdgeKey {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function edgeLen(a: THREE.Vector2, b: THREE.Vector2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function orient(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: THREE.Vector2, b: THREE.Vector2, p: THREE.Vector2): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return p.x >= minX - 1e-6 && p.x <= maxX + 1e-6 && p.y >= minY - 1e-6 && p.y <= maxY + 1e-6;
}

function segmentsIntersect(a1: THREE.Vector2, a2: THREE.Vector2, b1: THREE.Vector2, b2: THREE.Vector2): boolean {
  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);

  // Proper intersection
  if ((o1 > 0 && o2 < 0 || o1 < 0 && o2 > 0) && (o3 > 0 && o4 < 0 || o3 < 0 && o4 > 0)) return true;

  // Colinear cases
  if (Math.abs(o1) < 1e-6 && onSegment(a1, a2, b1)) return true;
  if (Math.abs(o2) < 1e-6 && onSegment(a1, a2, b2)) return true;
  if (Math.abs(o3) < 1e-6 && onSegment(b1, b2, a1)) return true;
  if (Math.abs(o4) < 1e-6 && onSegment(b1, b2, a2)) return true;

  return false;
}

function buildNonCrossingEdges(points: THREE.Vector2[], maxDegree: number, maxLen: number, seedEdges: Array<[number, number]>): Array<[number, number]> {
  const chosen: Array<[number, number]> = [];
  const chosenKeys = new Set<EdgeKey>();
  const deg = new Array(points.length).fill(0);

  // Seed edges first (e.g., hull ring)
  for (const [a, b] of seedEdges) {
    if (a === b) continue;
    const key = edgeKey(a, b);
    if (chosenKeys.has(key)) continue;
    chosenKeys.add(key);
    chosen.push([a, b]);
    deg[a] += 1;
    deg[b] += 1;
  }

  const candidates: Array<{ a: number; b: number; len: number }> = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x;
      const dy = points[j].y - points[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len <= maxLen) candidates.push({ a: i, b: j, len });
    }
  }
  candidates.sort((x, y) => x.len - y.len);

  const intersectsChosen = (a: number, b: number): boolean => {
    const p1 = points[a];
    const p2 = points[b];
    for (const [c, d] of chosen) {
      // shared endpoints are allowed
      if (a === c || a === d || b === c || b === d) continue;
      if (segmentsIntersect(p1, p2, points[c], points[d])) return true;
    }
    return false;
  };

  for (const cand of candidates) {
    if (deg[cand.a] >= maxDegree || deg[cand.b] >= maxDegree) continue;
    const key = edgeKey(cand.a, cand.b);
    if (chosenKeys.has(key)) continue;
    if (intersectsChosen(cand.a, cand.b)) continue;
    chosenKeys.add(key);
    chosen.push([cand.a, cand.b]);
    deg[cand.a] += 1;
    deg[cand.b] += 1;
  }

  return chosen;
}

interface LineRaftRendererProps {
  colorized?: boolean;
  hoverized?: boolean;
  ghostOpacity?: number;
  ghostRenderOrder?: number;
  activeModelId?: string | null;
  hoverModelId?: string | null;
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  navigationLodActive?: boolean;
  onModelPointerSelect?: (modelId: string, e: any) => void;
}

export default function LineRaftRenderer({
  colorized = true,
  hoverized = false,
  ghostOpacity = 1,
  ghostRenderOrder = 0,
  activeModelId = null,
  hoverModelId = null,
  modelFilterId = null,
  excludeModelId = null,
  navigationLodActive = false,
  onModelPointerSelect,
}: LineRaftRendererProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot);
  const raft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
  const [immediateModelHoverId, setImmediateModelHoverId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const handleImmediateModelHover = (event: Event) => {
      if (navigationLodActive) return;
      const customEvent = event as CustomEvent<{ modelId?: string | null }>;
      setImmediateModelHoverId(customEvent.detail?.modelId ?? null);
    };

    window.addEventListener('model-pointer-hover-immediate', handleImmediateModelHover as EventListener);
    return () => {
      window.removeEventListener('model-pointer-hover-immediate', handleImmediateModelHover as EventListener);
    };
  }, []);

  const effectiveHoverModelId = immediateModelHoverId ?? hoverModelId;
  const raftOpacity = Math.max(0.05, Math.min(1, ghostOpacity));
  const raftTransparent = raftOpacity < 0.999;

  const raftMeshes = React.useMemo(() => {
    if (raft.bottomMode !== 'line') return null;

    const rootsByModel = new Map<string, typeof supportState.roots[string][]>();
    for (const root of Object.values(supportState.roots)) {
      if (excludeModelId && root.modelId === excludeModelId) continue;
      if (modelFilterId && root.modelId !== modelFilterId) continue;
      const key = root.modelId || 'unknown';
      if (!rootsByModel.has(key)) rootsByModel.set(key, []);
      rootsByModel.get(key)!.push(root);
    }

    const blendColor = (baseHex: string, tintHex: string, strength: number) =>
      new THREE.Color(baseHex).lerp(new THREE.Color(tintHex), strength).getStyle();

    const resolveTintStrength = (modelId: string) => {
      if (!colorized) return 0;
      if (activeModelId) return modelId === activeModelId ? 1 : 0;
      if (effectiveHoverModelId) return modelId === effectiveHoverModelId ? 0.5 : 0;
      return hoverized ? 0.5 : 1;
    };

    const meshes: Array<{ beamMeshes: THREE.Mesh[]; wallMesh: THREE.Mesh | null }> = [];

    for (const [modelId, roots] of rootsByModel) {
      if (roots.length === 0) continue;

      const nodes2d = roots.map((r) => new THREE.Vector2(r.transform.pos.x, r.transform.pos.y));

      const circles: SupportBaseCircle[] = roots.map((r) => ({
        x: r.transform.pos.x,
        y: r.transform.pos.y,
        r: r.diameter / 2,
      }));

    // Footprint polygon wraps around the *outer edge* of all supports.
    // Important: the border is chamfered (bottom inset). To ensure the *bottom* of the chamfer
    // still covers the support disks, we expand the footprint by the chamfer inset amount.
    const chamferInset = Math.max(0, raft.lineHeightMm) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, raft.chamferAngle))));
    const profile = computeFootprint(circles, { marginMm: 0.2 + chamferInset, samplesPerCircle: 24 });
    const hasBorderRing = !!profile && profile.length >= 3;

    // Outer ring (natural border)
    const hull = convexHull2d(nodes2d);

    // Build index mapping for hull points to nearest original node index
    const hullIndices: number[] = hull.map((hp) => {
      let best = 0;
      let bestD2 = Infinity;
      for (let i = 0; i < nodes2d.length; i++) {
        const p = nodes2d[i];
        const dx = p.x - hp.x;
        const dy = p.y - hp.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
        }
      }
      return best;
    });

    // Seed: hull ring edges
    const hullEdges: Array<[number, number]> = [];
    if (hullIndices.length >= 2) {
      for (let i = 0; i < hullIndices.length; i++) {
        const a = hullIndices[i];
        const b = hullIndices[(i + 1) % hullIndices.length];
        if (a !== b) hullEdges.push([a, b]);
      }
    }

    const hullEdgeSet = new Set<EdgeKey>();
    for (const [a, b] of hullEdges) hullEdgeSet.add(edgeKey(a, b));

    // Interior edges: Delaunay triangulation (planar / non-crossing) + pruning.
    const tris = delaunayTriangulate2d(nodes2d);

    const nn = new Array(nodes2d.length).fill(Infinity);
    for (let i = 0; i < nodes2d.length; i++) {
      for (let j = 0; j < nodes2d.length; j++) {
        if (i === j) continue;
        nn[i] = Math.min(nn[i], edgeLen(nodes2d[i], nodes2d[j]));
      }
      if (!Number.isFinite(nn[i])) nn[i] = 0;
    }

    const keepFactor = 3.2;
    const absMaxLen = 120;
    const edges = new Set<EdgeKey>();
    const edgePairs: Array<[number, number]> = [];

    // If we have a dedicated perimeter border ring mesh, do NOT also add hull beam edges.
    // Otherwise (fallback), keep hull edges so the network still has a boundary.
    if (!hasBorderRing) {
      for (const [a, b] of hullEdges) {
        const key = edgeKey(a, b);
        if (!edges.has(key)) {
          edges.add(key);
          edgePairs.push([a, b]);
        }
      }
    }

    // Add pruned Delaunay edges
    for (const [i, j, k] of tris) {
      const triEdges: Array<[number, number]> = [
        [i, j],
        [j, k],
        [k, i],
      ];
      for (const [a, b] of triEdges) {
        const key = edgeKey(a, b);
        if (edges.has(key)) continue;
        if (hasBorderRing && hullEdgeSet.has(key)) continue;
        const len = edgeLen(nodes2d[a], nodes2d[b]);
        const localMax = keepFactor * Math.min(nn[a], nn[b]);
        if (len > absMaxLen) continue;
        if (nn[a] > 0 && nn[b] > 0 && len > localMax) continue;
        edges.add(key);
        edgePairs.push([a, b]);
      }
    }

    // Beam height: explicit line height setting
    const beamHeight = Math.max(0.01, raft.lineHeightMm);

    const unionEdges: Array<[THREE.Vector2, THREE.Vector2]> = edgePairs.map(([a, b]) => [nodes2d[a], nodes2d[b]]);
    const unionMesh = generateUnionedLineRaftMesh(unionEdges, {
      widthMm: raft.lineWidthMm,
      heightMm: beamHeight,
      // Interior network only: keep this unioned mesh flat to avoid sloppy chamfer stitching.
      borderProfile: null,
    });
    unionMesh.renderOrder = ghostRenderOrder;
    unionMesh.material = new THREE.MeshStandardMaterial({ color: '#a3a3a3', roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, opacity: raftOpacity, transparent: raftTransparent, depthWrite: !raftTransparent });
    unionMesh.castShadow = false;
    unionMesh.receiveShadow = true;
    unionMesh.userData.modelId = modelId;

    const unionHasGeometry = (unionMesh.geometry as any)?.attributes?.position?.count > 0;
    const beamMeshes: THREE.Mesh[] = [];
    if (unionHasGeometry) {
      beamMeshes.push(unionMesh);
    } else {
      for (const [a, b] of edgePairs) {
        const start = new THREE.Vector3(nodes2d[a].x, nodes2d[a].y, 0);
        const end = new THREE.Vector3(nodes2d[b].x, nodes2d[b].y, 0);
        const mesh = generateChamferedBeam(start, end, {
          widthMm: raft.lineWidthMm,
          heightMm: beamHeight,
          chamferAngleDeg: 90,
        });
        mesh.renderOrder = ghostRenderOrder;
        mesh.material = new THREE.MeshStandardMaterial({ color: '#a3a3a3', roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, opacity: raftOpacity, transparent: raftTransparent, depthWrite: !raftTransparent });
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.userData.modelId = modelId;
        beamMeshes.push(mesh);
      }
    }

    // Perimeter border beam: single manifold ring mesh (chamfered outer edge).
    if (hasBorderRing) {
      const borderMesh = generatePerimeterBorderBeam(profile, { widthMm: raft.lineWidthMm, heightMm: beamHeight, chamferAngleDeg: raft.chamferAngle });
      borderMesh.renderOrder = ghostRenderOrder;
      borderMesh.material = new THREE.MeshStandardMaterial({ color: '#a3a3a3', roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, opacity: raftOpacity, transparent: raftTransparent, depthWrite: !raftTransparent });
      borderMesh.castShadow = false;
      borderMesh.receiveShadow = true;
      borderMesh.userData.modelId = modelId;
      beamMeshes.push(borderMesh);
    }

    // Wall: perimeter only (never along internal beams)
    let wallMesh: THREE.Mesh | null = null;
    if (raft.wallEnabled) {
      if (profile && profile.length >= 3) {
        const useCrenels = raft.crenulationSpacing > 0 && raft.crenulationGapWidth > 0;
        wallMesh = useCrenels
          ? generateCrenelatedWallManual(profile, {
              wallHeight: raft.wallHeight,
              wallThickness: raft.wallThickness,
              crenulationGapWidth: raft.crenulationGapWidth,
              crenulationSpacing: raft.crenulationSpacing,
              thickness: beamHeight,
              chamferAngle: raft.chamferAngle,
            })
          : generatePerimeterWall(profile, {
              wallHeight: raft.wallHeight,
              wallThickness: raft.wallThickness,
              thickness: beamHeight,
            });

        wallMesh.material = new THREE.MeshStandardMaterial({ color: '#a3a3a3', roughness: 0.9, metalness: 0.0, opacity: raftOpacity, transparent: raftTransparent, depthWrite: !raftTransparent });
  wallMesh.renderOrder = ghostRenderOrder;
        wallMesh.castShadow = false;
        wallMesh.receiveShadow = true;
        wallMesh.userData.modelId = modelId;
        wallMesh.userData.isWall = true;
      }
    }

      meshes.push({ beamMeshes, wallMesh });
    }

    return meshes;
  }, [excludeModelId, modelFilterId, raft, supportState, raftOpacity, raftTransparent, ghostRenderOrder]);

  const handleClick = React.useCallback((e: any) => {
    const modelId = e?.object?.userData?.modelId;
    if (!modelId || !onModelPointerSelect) return;

    e.stopPropagation();
    if (e.nativeEvent) {
      e.nativeEvent.stopPropagation();
      e.nativeEvent.stopImmediatePropagation?.();
    }

    onModelPointerSelect(modelId, e);
  }, [onModelPointerSelect]);

  const handlePointerMove = React.useCallback((e: any) => {
    const modelId = e?.object?.userData?.modelId ?? null;
    window.dispatchEvent(new CustomEvent('support-raft-model-pointer-hover', {
      detail: {
        modelId,
        category: 'raft',
      },
    }));
  }, []);

  const handlePointerOut = React.useCallback(() => {
    window.dispatchEvent(new CustomEvent('support-raft-model-pointer-hover', {
      detail: {
        modelId: null,
        category: 'raft',
      },
    }));
  }, []);

  const groupRef = React.useRef<THREE.Group>(null);
  React.useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    while (group.children.length) group.remove(group.children[0]);

    if (raftMeshes) {
      for (const meshes of raftMeshes) {
        for (const m of meshes.beamMeshes) group.add(m);
        if (meshes.wallMesh) group.add(meshes.wallMesh);
      }
    }
  }, [raftMeshes]);

  React.useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const blendColor = (baseHex: string, tintHex: string, strength: number) =>
      new THREE.Color(baseHex).lerp(new THREE.Color(tintHex), strength);

    const resolveTintStrength = (modelId: string | null) => {
      if (!modelId) return colorized ? (hoverized ? 0.5 : 1) : 0;
      if (!colorized) return 0;
      if (activeModelId) return modelId === activeModelId ? 1 : 0;
      if (effectiveHoverModelId) return modelId === effectiveHoverModelId ? 0.5 : 0;
      return hoverized ? 0.5 : 1;
    };

    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      const material = mesh.material;
      if (!material || Array.isArray(material) || !(material instanceof THREE.MeshStandardMaterial)) continue;

      const modelId = (mesh.userData?.modelId as string | undefined) ?? null;
      const tintStrength = resolveTintStrength(modelId);
      const isWall = mesh.userData?.isWall === true
        || (!!mesh.geometry && ((mesh.geometry as THREE.BufferGeometry).boundingBox?.max?.z ?? 0) > (raft.lineHeightMm + 0.001));
      const tintHex = isWall ? '#22c55e' : '#f97316';
      const nextColor = blendColor('#a3a3a3', tintHex, tintStrength);
      if (!material.color.equals(nextColor)) {
        material.color.copy(nextColor);
      }

      if (material.transparent !== raftTransparent) {
        material.transparent = raftTransparent;
      }

      if (Math.abs(material.opacity - raftOpacity) > 1e-4) {
        material.opacity = raftOpacity;
      }

      const nextDepthWrite = !raftTransparent;
      if (material.depthWrite !== nextDepthWrite) {
        material.depthWrite = nextDepthWrite;
      }

      if (mesh.renderOrder !== ghostRenderOrder) {
        mesh.renderOrder = ghostRenderOrder;
      }
    }
  }, [activeModelId, colorized, effectiveHoverModelId, hoverized, raft.lineHeightMm, raftOpacity, raftTransparent, ghostRenderOrder]);

  if (raft.bottomMode !== 'line') return null;
  return <group ref={groupRef} position={[0, 0, 0]} onClick={navigationLodActive ? undefined : handleClick} onPointerMove={navigationLodActive ? undefined : handlePointerMove} onPointerOut={navigationLodActive ? undefined : handlePointerOut} />;
}
