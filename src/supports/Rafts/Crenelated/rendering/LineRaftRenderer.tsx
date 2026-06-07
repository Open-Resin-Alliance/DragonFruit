"use client";

import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from '@/supports/state';
import { getKickstandSnapshot, subscribeToKickstandStore } from '@/supports/SupportTypes/Kickstand/kickstandStore';
import { getRaftSettings, subscribeToRaftStore } from '../RaftState';
import { convexHull2d } from '../geometry/convexHull2d';
import { computeFootprint } from '../geometry/computeFootprint';
import { buildLineRaftEdgePairs } from '../geometry/buildLineRaftEdgePairs';
import { generateUnionedLineRaftMesh } from '../geometry/generateUnionedLineRaftMesh';
import { generateChamferedBeam } from '../geometry/generateChamferedBeam';
import { generatePerimeterWall } from '../geometry/generatePerimeterWall';
import { generateCrenelatedWallManual } from '../geometry/generateCrenelatedWallManual';
import { collectRaftBaseCirclesByModel, fromRaftModelKey } from '../raftFootprintCircles';

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
  clipLower?: number | null;
  clipUpper?: number | null;
  passive?: boolean;
  colorized?: boolean;
  hoverized?: boolean;
  ghostOpacity?: number;
  ghostRenderOrder?: number;
  activeModelId?: string | null;
  selectedModelIds?: string[];
  hoverModelId?: string | null;
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  excludeModelIds?: string[];
  navigationLodActive?: boolean;
  onModelPointerSelect?: (modelId: string, e: any) => void;
}

export default function LineRaftRenderer({
  clipLower = null,
  clipUpper = null,
  passive = false,
  colorized = true,
  hoverized = false,
  ghostOpacity = 1,
  ghostRenderOrder = 0,
  activeModelId = null,
  selectedModelIds = [],
  hoverModelId = null,
  modelFilterId = null,
  excludeModelId = null,
  excludeModelIds = [],
  navigationLodActive = false,
  onModelPointerSelect,
}: LineRaftRendererProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot);
  const kickstandState = useSyncExternalStore(subscribeToKickstandStore, getKickstandSnapshot, getKickstandSnapshot);
  const raft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
  const [immediateModelHoverId, setImmediateModelHoverId] = React.useState<string | null>(null);
  const [immediatePrepareActiveModelId, setImmediatePrepareActiveModelId] = React.useState<string | null>(null);
  const lastSyncedPrepareActiveModelIdRef = React.useRef<string | null>(activeModelId ?? null);

  React.useEffect(() => {
    if (passive) {
      setImmediateModelHoverId((prev) => (prev === null ? prev : null));
      return;
    }

    const handleImmediateModelHover = (event: Event) => {
      if (navigationLodActive) return;
      const customEvent = event as CustomEvent<{ modelId?: string | null }>;
      setImmediateModelHoverId(customEvent.detail?.modelId ?? null);
    };

    window.addEventListener('model-pointer-hover-immediate', handleImmediateModelHover as EventListener);
    return () => {
      window.removeEventListener('model-pointer-hover-immediate', handleImmediateModelHover as EventListener);
    };
  }, [navigationLodActive, passive]);

  const effectiveHoverModelId = passive ? null : (immediateModelHoverId ?? hoverModelId);
  const effectiveVisualActiveModelId = passive
    ? activeModelId
    : (immediatePrepareActiveModelId ?? activeModelId);

  React.useEffect(() => {
    if (passive) {
      setImmediatePrepareActiveModelId((prev) => (prev === null ? prev : null));
      return;
    }

    const handleModelClicked = (event: Event) => {
      const customEvent = event as CustomEvent<{ modelId?: string | null }>;
      const modelId = customEvent.detail?.modelId ?? null;
      setImmediatePrepareActiveModelId((prev) => (prev === modelId ? prev : modelId));
    };

    const handleModelDeselected = () => {
      setImmediatePrepareActiveModelId((prev) => (prev === null ? prev : null));
    };

    window.addEventListener('model-clicked', handleModelClicked as EventListener);
    window.addEventListener('model-deselected', handleModelDeselected);
    return () => {
      window.removeEventListener('model-clicked', handleModelClicked as EventListener);
      window.removeEventListener('model-deselected', handleModelDeselected);
    };
  }, [passive]);

  React.useEffect(() => {
    const next = passive ? null : (activeModelId ?? null);
    if (lastSyncedPrepareActiveModelIdRef.current === next) return;
    lastSyncedPrepareActiveModelIdRef.current = next;
    setImmediatePrepareActiveModelId((prev) => (prev === next ? prev : next));
  }, [activeModelId, passive]);

  React.useEffect(() => {
    if (passive) return;
    if (!immediatePrepareActiveModelId) return;
    if (selectedModelIds.includes(immediatePrepareActiveModelId)) return;
    setImmediatePrepareActiveModelId((prev) => (prev === null ? prev : null));
  }, [immediatePrepareActiveModelId, passive, selectedModelIds]);

  // Initialize clipping planes once (update in-place to avoid recreation)
  const clippingPlanesRef = React.useRef<THREE.Plane[]>([]);

  React.useEffect(() => {
    const planes: THREE.Plane[] = [];

    if (clipLower != null) {
      planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
    }

    if (clipUpper != null) {
      planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
    }

    clippingPlanesRef.current = planes;
  }, [clipLower, clipUpper]);

  const clippingPlanes = clippingPlanesRef.current;

  const selectedModelIdSet = React.useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
  const excludedModelIdSet = React.useMemo(() => new Set(excludeModelIds.filter((id): id is string => Boolean(id))), [excludeModelIds]);
  const hasSelectedModels = selectedModelIdSet.size > 0;
  const raftOpacity = Math.max(0.05, Math.min(1, ghostOpacity));
  const raftTransparent = raftOpacity < 0.999;

  const raftMeshes = React.useMemo(() => {
    if (raft.bottomMode !== 'line') return null;

    const rootsByModel = collectRaftBaseCirclesByModel({
      roots: Object.values(supportState.roots),
      anchors: Object.values(supportState.anchors),
      kickstandRoots: Object.values(kickstandState.roots),
    }, {
      modelFilterId,
      excludeModelId,
      excludedModelIds: excludedModelIdSet,
      fallbackModelKey: 'unknown',
    });

    const meshes: Array<{ beamMeshes: THREE.Mesh[]; wallMesh: THREE.Mesh | null }> = [];

    for (const [modelKey, circles] of rootsByModel) {
      if (circles.length === 0) continue;
      const modelId = fromRaftModelKey(modelKey, 'unknown') ?? modelKey;
      const nodes2d = circles.map((circle) => new THREE.Vector2(circle.x, circle.y));

    // Footprint polygon wraps around the *outer edge* of all supports.
    // Important: the border is chamfered (bottom inset). To ensure the *bottom* of the chamfer
    // still covers the support disks, we expand the footprint by the chamfer inset amount.
    const chamferInset = Math.max(0, raft.lineHeightMm) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, raft.chamferAngle))));
    const profile = computeFootprint(circles, { marginMm: 0.2 + chamferInset, samplesPerCircle: 24 });
    const hasBorderRing = !!profile && profile.length >= 3;

    const edgePairs = buildLineRaftEdgePairs(nodes2d, {
      hasBorderRing,
      keepFactor: 8,
      absMaxLen: 220,
      enforceConnected: true,
    });

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
    unionMesh.material = new THREE.MeshStandardMaterial({ color: '#a3a3a3', roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, opacity: raftOpacity, transparent: raftTransparent, depthWrite: true, clippingPlanes });
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
        mesh.material = new THREE.MeshStandardMaterial({ color: '#a3a3a3', roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, opacity: raftOpacity, transparent: raftTransparent, depthWrite: true, clippingPlanes });
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.userData.modelId = modelId;
        beamMeshes.push(mesh);
      }
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

        wallMesh.material = new THREE.MeshStandardMaterial({ color: '#a3a3a3', roughness: 0.9, metalness: 0.0, opacity: raftOpacity, transparent: raftTransparent, depthWrite: true, clippingPlanes });
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
  }, [excludeModelId, excludedModelIdSet, modelFilterId, raft, supportState, kickstandState.roots, raftOpacity, raftTransparent, ghostRenderOrder, clippingPlanes]);

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
      if (selectedModelIdSet.has(modelId)) return 1;
      if (effectiveHoverModelId) return modelId === effectiveHoverModelId ? 0.5 : 0;
      if (hasSelectedModels) return 0;
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

      if (material.clippingPlanes !== clippingPlanes) {
        material.clippingPlanes = clippingPlanes;
        material.needsUpdate = true;
      }

      if (!material.depthTest) {
        material.depthTest = true;
      }

      if (Math.abs(material.opacity - raftOpacity) > 1e-4) {
        material.opacity = raftOpacity;
      }

      const nextDepthWrite = true;
      if (material.depthWrite !== nextDepthWrite) {
        material.depthWrite = nextDepthWrite;
      }

      if (mesh.renderOrder !== ghostRenderOrder) {
        mesh.renderOrder = ghostRenderOrder;
      }
    }
  }, [colorized, effectiveHoverModelId, effectiveVisualActiveModelId, hasSelectedModels, hoverized, raft.lineHeightMm, raftOpacity, raftTransparent, ghostRenderOrder, raftMeshes, selectedModelIdSet, clippingPlanes]);

  if (raft.bottomMode !== 'line') return null;
  return <group ref={groupRef} position={[0, 0, 0]} onClick={navigationLodActive ? undefined : handleClick} onPointerMove={navigationLodActive ? undefined : handlePointerMove} onPointerOut={navigationLodActive ? undefined : handlePointerOut} />;
}
