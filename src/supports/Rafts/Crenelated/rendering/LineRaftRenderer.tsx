"use client";

import React from 'react';
import * as THREE from 'three';
import { getSceneClipPlanes } from '@/features/slicing/sceneClipStore';
import { supportAnswersPointer } from '@/features/scene/plates/plateInteractivity';
import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from '@/supports/state';
import { getRaftSettings, getRaftSettingsForModel, getRaftStoreRevision, subscribeToRaftStore } from '../RaftState';
import { convexHull2d } from '../geometry/convexHull2d';
import { computeRaftFootprintPolygons, inflateModelPlateClearance, raftBandTopMm, raftWallBaseHeightMm } from '../geometry/computeRaftFootprint';
import { collectModelPlateFootprint, type PlateFootprintSource } from '../geometry/modelPlateFootprint';
import type { PolygonWithHoles } from '../geometry/polygonSet2d';
import { generateWallFromPolygons, isUntrimmedFootprint } from '../geometry/generateRaftFromFootprint';
import { buildLineRaftEdgePairs } from '../geometry/buildLineRaftEdgePairs';
import { filterLineRaftEdges, generateUnionedLineRaftMesh } from '../geometry/generateUnionedLineRaftMesh';
import { generateChamferedBeam } from '../geometry/generateChamferedBeam';
import { generatePerimeterWall } from '../geometry/generatePerimeterWall';
import { generateCrenelatedWallManual } from '../geometry/generateCrenelatedWallManual';
import { collectRaftBaseCirclesByModel, fromRaftModelKey, type RaftFootprintSource } from '../raftFootprintCircles';

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
  /** Models on another bed: their raft answers no pointer. */
  pointerSceneryModelIds?: ReadonlySet<string>;
  /** Models whose plate footprint the raft has to clear. */
  plateClearanceTargets?: readonly PlateFootprintSource[];
}

const EMPTY_PLATE_CLEARANCE_TARGETS: readonly PlateFootprintSource[] = Object.freeze([]);

export interface LineViewportRaftMeshesOptions {
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  excludedModelIds?: Iterable<string>;
  plateClearanceTargets?: readonly PlateFootprintSource[];
  raftOpacity?: number;
  raftTransparent?: boolean;
  ghostRenderOrder?: number;
  clippingPlanes?: THREE.Plane[];
}

export function buildLineViewportRaftMeshes(
  supportState: RaftFootprintSource,
  options: LineViewportRaftMeshesOptions = {},
): Array<{ beamMeshes: THREE.Mesh[]; wallMesh: THREE.Mesh | null }> {
  const {
    modelFilterId = null,
    excludeModelId = null,
    excludedModelIds,
    plateClearanceTargets = EMPTY_PLATE_CLEARANCE_TARGETS,
    raftOpacity = 1,
    raftTransparent = false,
    ghostRenderOrder = 0,
    clippingPlanes = getSceneClipPlanes(),
  } = options;

  const rootsByModel = collectRaftBaseCirclesByModel(supportState, {
    modelFilterId,
    excludeModelId,
    excludedModelIds,
    fallbackModelKey: 'unknown',
  });
  if (rootsByModel.size === 0) return [];

  const clearanceByBandTop = new Map<
    number,
    { clearance: PolygonWithHoles[]; clearanceCut: PolygonWithHoles[] }
  >();
  const getClearanceEntry = (bandTop: number) => {
    let entry = clearanceByBandTop.get(bandTop);
    if (!entry) {
      const clearance = collectModelPlateFootprint(plateClearanceTargets, bandTop);
      const clearanceCut = inflateModelPlateClearance(clearance);
      entry = { clearance, clearanceCut };
      clearanceByBandTop.set(bandTop, entry);
    }
    return entry;
  };

  const meshes: Array<{ beamMeshes: THREE.Mesh[]; wallMesh: THREE.Mesh | null }> = [];

  for (const [modelKey, circles] of rootsByModel) {
    if (circles.length === 0) continue;
    const resolvedModelId = fromRaftModelKey(modelKey, 'unknown');
    const modelRaft = resolvedModelId ? getRaftSettingsForModel(resolvedModelId) : getRaftSettings();
    if (modelRaft.bottomMode !== 'line') continue;

    const modelId = resolvedModelId ?? modelKey;
    const { clearance, clearanceCut } = getClearanceEntry(raftBandTopMm(modelRaft));
    const nodes2d = circles.map((circle) => new THREE.Vector2(circle.x, circle.y));

    const footprint = computeRaftFootprintPolygons({ circles, raft: modelRaft, clearance });
    if (footprint.length === 0) continue;
    const hasBorderRing = true;

    const edgePairs = buildLineRaftEdgePairs(nodes2d, {
      hasBorderRing,
      keepFactor: 8,
      absMaxLen: 220,
      enforceConnected: true,
    });

    const beamHeight = Math.max(0.01, modelRaft.lineHeightMm);

    const unionEdges: Array<[THREE.Vector2, THREE.Vector2]> = filterLineRaftEdges(
      edgePairs.map(([a, b]) => [nodes2d[a], nodes2d[b]]),
      clearanceCut,
      modelRaft.lineWidthMm,
    );
    const unionMesh = generateUnionedLineRaftMesh(unionEdges, {
      widthMm: modelRaft.lineWidthMm,
      heightMm: beamHeight,
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
      unionMesh.geometry.dispose();
      if (Array.isArray(unionMesh.material)) {
        unionMesh.material.forEach((m) => m.dispose());
      } else {
        unionMesh.material?.dispose();
      }
      for (const [a, b] of unionEdges) {
        const start = new THREE.Vector3(a.x, a.y, 0);
        const end = new THREE.Vector3(b.x, b.y, 0);
        const mesh = generateChamferedBeam(start, end, {
          widthMm: modelRaft.lineWidthMm,
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

    let wallMesh: THREE.Mesh | null = null;
    if (modelRaft.wallEnabled) {
      const wallBaseHeight = raftWallBaseHeightMm(modelRaft);
      if (isUntrimmedFootprint(footprint)) {
        const useCrenels = modelRaft.crenulationSpacing > 0 && modelRaft.crenulationGapWidth > 0;
        wallMesh = useCrenels
          ? generateCrenelatedWallManual(footprint[0].outer, {
              wallHeight: modelRaft.wallHeight,
              wallThickness: modelRaft.wallThickness,
              crenulationGapWidth: modelRaft.crenulationGapWidth,
              crenulationSpacing: modelRaft.crenulationSpacing,
              thickness: wallBaseHeight,
              chamferAngle: modelRaft.chamferAngle,
            })
          : generatePerimeterWall(footprint[0].outer, {
              wallHeight: modelRaft.wallHeight,
              wallThickness: modelRaft.wallThickness,
              thickness: wallBaseHeight,
            });
      } else {
        wallMesh = generateWallFromPolygons(footprint, {
          thickness: wallBaseHeight,
          chamferAngle: modelRaft.chamferAngle,
          wallHeight: modelRaft.wallHeight,
          wallThickness: modelRaft.wallThickness,
          crenulationGapWidth: modelRaft.crenulationGapWidth,
          crenulationSpacing: modelRaft.crenulationSpacing,
        });
      }

      if (wallMesh) {
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
}

export default function LineRaftRenderer({
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
  pointerSceneryModelIds,
  plateClearanceTargets = EMPTY_PLATE_CLEARANCE_TARGETS,
}: LineRaftRendererProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot);
  const raftRevision = useSyncExternalStore(subscribeToRaftStore, getRaftStoreRevision, getRaftStoreRevision);
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

  // The scene's two shared planes: stable identity and length, so a scrub moves
  // their constants without recompiling a material.
  const clippingPlanes = getSceneClipPlanes();

  const selectedModelIdSet = React.useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
  const excludedModelIdSet = React.useMemo(() => new Set(excludeModelIds.filter((id): id is string => Boolean(id))), [excludeModelIds]);
  const hasSelectedModels = selectedModelIdSet.size > 0;
  const raftOpacity = Math.max(0.05, Math.min(1, ghostOpacity));
  const raftTransparent = raftOpacity < 0.999;

  const raftMeshes = React.useMemo(
    () => buildLineViewportRaftMeshes(supportState, {
      modelFilterId,
      excludeModelId,
      excludedModelIds: excludedModelIdSet,
      plateClearanceTargets,
      raftOpacity,
      raftTransparent,
      ghostRenderOrder,
      clippingPlanes,
    }),
    [excludeModelId, excludedModelIdSet, modelFilterId, plateClearanceTargets, supportState, raftRevision, raftOpacity, raftTransparent, ghostRenderOrder, clippingPlanes],
  );

  const handleClick = React.useCallback((e: any) => {
    const modelId = e?.object?.userData?.modelId;
    if (!supportAnswersPointer(modelId, pointerSceneryModelIds)) return;
    if (!modelId || !onModelPointerSelect) return;

    e.stopPropagation();
    if (e.nativeEvent) {
      e.nativeEvent.stopPropagation();
      e.nativeEvent.stopImmediatePropagation?.();
    }

    onModelPointerSelect(modelId, e);
  }, [onModelPointerSelect, pointerSceneryModelIds]);

  const handlePointerMove = React.useCallback((e: any) => {
    const modelId = e?.object?.userData?.modelId ?? null;
    if (!supportAnswersPointer(modelId ?? undefined, pointerSceneryModelIds)) return;
    window.dispatchEvent(new CustomEvent('support-raft-model-pointer-hover', {
      detail: {
        modelId,
        category: 'raft',
      },
    }));
  }, [pointerSceneryModelIds]);

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
      const modelRaft = getRaftSettingsForModel(modelId === 'unknown' ? null : modelId);
      const tintStrength = resolveTintStrength(modelId);
      const isWall = mesh.userData?.isWall === true
        || (!!mesh.geometry && ((mesh.geometry as THREE.BufferGeometry).boundingBox?.max?.z ?? 0) > (modelRaft.lineHeightMm + 0.001));
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
  }, [colorized, effectiveHoverModelId, effectiveVisualActiveModelId, hasSelectedModels, hoverized, raftRevision, raftOpacity, raftTransparent, ghostRenderOrder, raftMeshes, selectedModelIdSet, clippingPlanes]);

  if (!raftMeshes || raftMeshes.length === 0) return null;
  return <group ref={groupRef} position={[0, 0, 0]} onClick={navigationLodActive ? undefined : handleClick} onPointerMove={navigationLodActive ? undefined : handlePointerMove} onPointerOut={navigationLodActive ? undefined : handlePointerOut} />;
}
