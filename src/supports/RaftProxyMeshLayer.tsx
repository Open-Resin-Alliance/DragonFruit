import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { subscribe, getSnapshot } from './state';
import { getRaftSettings, subscribeToRaftStore } from './Rafts/Crenelated/RaftState';
import type { RaftSettings, SupportBaseCircle } from './Rafts/Crenelated/RaftTypes';
import { buildSolidRaftPreviewMeshes } from './Settings/AnatomyPreview/PreviewTypes/Raft/buildSolidRaftPreviewMeshes';
import { buildLineRaftPreviewMeshes } from './Settings/AnatomyPreview/PreviewTypes/Raft/buildLineRaftPreviewMeshes';

interface RaftProxyMeshLayerProps {
  clipLower?: number | null;
  clipUpper?: number | null;
  activeModelId?: string | null;
  selectedModelIds?: string[];
  hoverModelId?: string | null;
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  excludeModelIds?: string[];
  ghostOpacity?: number;
  ghostRenderOrder?: number;
  onModelPointerSelect?: (modelId: string) => void;
  enablePointerSelection?: boolean;
  colorized?: boolean;
  hoverized?: boolean;
  navigationLodActive?: boolean;
  passive?: boolean;
}

type CachedRaftGeometry = {
  kind: 'solid' | 'line';
  bottomGeometry: THREE.BufferGeometry | null;
  wallGeometry: THREE.BufferGeometry | null;
};

type VisibleRaftEntry = {
  modelKey: string;
  modelId?: string;
  kind: 'solid' | 'line';
  bottomGeometry: THREE.BufferGeometry | null;
  wallGeometry: THREE.BufferGeometry | null;
  bottomColor: string;
  wallColor: string;
};

type RaftProxyCacheEntry = {
  supportRootsRef: ReturnType<typeof getSnapshot>['roots'];
  supportAnchorsRef: ReturnType<typeof getSnapshot>['anchors'];
  raftSignature: string;
  geometriesByModel: Map<string, CachedRaftGeometry>;
};

let raftProxyCache: RaftProxyCacheEntry | null = null;

const MODEL_NONE_KEY = '__none__';
const RAFT_BASE_COLOR = '#a3a3a3';
const SOLID_BOTTOM_TINT_COLOR = '#3b82f6';
const LINE_BOTTOM_TINT_COLOR = '#f97316';
const WALL_TINT_COLOR = '#22c55e';

function toModelKey(modelId?: string): string {
  return modelId ?? MODEL_NONE_KEY;
}

function fromModelKey(modelKey: string): string | undefined {
  return modelKey === MODEL_NONE_KEY ? undefined : modelKey;
}

function buildRaftSignature(raft: RaftSettings): string {
  return [
    raft.bottomMode,
    raft.wallEnabled ? 1 : 0,
    raft.thickness,
    raft.chamferAngle,
    raft.wallHeight,
    raft.wallThickness,
    raft.crenulationGapWidth,
    raft.crenulationSpacing,
    raft.lineWidthMm,
    raft.lineHeightMm,
  ].join('|');
}

function blendColor(baseHex: string, tintHex: string, strength: number): string {
  return new THREE.Color(baseHex).lerp(new THREE.Color(tintHex), strength).getStyle();
}

function mergeGeometryParts(parts: Array<THREE.BufferGeometry | null | undefined>): THREE.BufferGeometry | null {
  const valid = parts.filter((geometry): geometry is THREE.BufferGeometry => !!geometry);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0].clone();

  const clones = valid.map((geometry) => {
    const cloned = geometry.clone();
    const nonIndexed = cloned.index ? (cloned.toNonIndexed() ?? cloned) : cloned;
    if (nonIndexed !== cloned) cloned.dispose();

    if (!nonIndexed.getAttribute('normal')) {
      nonIndexed.computeVertexNormals();
    }

    // Keep only the attributes shared by every geometry so mergeGeometries
    // does not fail on mixed attribute layouts (e.g., uv present on some parts only).
    return nonIndexed;
  });

  const sharedAttributeNames = new Set<string>(Object.keys(clones[0].attributes));
  for (let i = 1; i < clones.length; i += 1) {
    const names = new Set<string>(Object.keys(clones[i].attributes));
    for (const name of Array.from(sharedAttributeNames)) {
      if (!names.has(name)) sharedAttributeNames.delete(name);
    }
  }

  if (!sharedAttributeNames.has('position')) {
    const fallback = clones[0];
    for (let i = 1; i < clones.length; i += 1) clones[i].dispose();
    return fallback;
  }

  for (const clone of clones) {
    const names = Object.keys(clone.attributes);
    for (const name of names) {
      if (!sharedAttributeNames.has(name)) {
        clone.deleteAttribute(name);
      }
    }
  }

  const merged = mergeGeometries(clones, false);

  if (merged) {
    for (const clone of clones) clone.dispose();
    return merged;
  }

  const fallback = clones[0];
  for (let i = 1; i < clones.length; i += 1) clones[i].dispose();
  return fallback;
}

function disposeGeneratedMeshes(meshes: Array<THREE.Mesh | null | undefined>) {
  const seenMaterials = new Set<THREE.Material>();

  for (const mesh of meshes) {
    if (!mesh) continue;
    mesh.geometry?.dispose?.();

    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const item of material) {
        if (seenMaterials.has(item)) continue;
        seenMaterials.add(item);
        item.dispose();
      }
      continue;
    }

    if (!material || seenMaterials.has(material)) continue;
    seenMaterials.add(material);
    material.dispose();
  }
}

function collectRootCirclesByModel(
  roots: ReturnType<typeof getSnapshot>['roots'],
  anchors: ReturnType<typeof getSnapshot>['anchors'],
): Map<string, SupportBaseCircle[]> {
  const byModel = new Map<string, SupportBaseCircle[]>();

  for (const root of Object.values(roots)) {
    const modelKey = toModelKey(root.modelId);
    const circles = byModel.get(modelKey) ?? [];
    circles.push({
      x: root.transform.pos.x,
      y: root.transform.pos.y,
      r: root.diameter / 2,
    });
    if (!byModel.has(modelKey)) byModel.set(modelKey, circles);
  }

  for (const anchor of Object.values(anchors)) {
    const modelKey = toModelKey(anchor.modelId);
    const circles = byModel.get(modelKey) ?? [];
    circles.push({
      x: anchor.rootPos.x,
      y: anchor.rootPos.y,
      r: anchor.rootBaseDiameter / 2,
    });
    if (!byModel.has(modelKey)) byModel.set(modelKey, circles);
  }

  return byModel;
}

export function RaftProxyMeshLayer({
  clipLower,
  clipUpper,
  activeModelId = null,
  selectedModelIds = [],
  hoverModelId = null,
  modelFilterId = null,
  excludeModelId = null,
  excludeModelIds = [],
  ghostOpacity = 1,
  ghostRenderOrder = 0,
  onModelPointerSelect,
  enablePointerSelection = true,
  colorized = true,
  hoverized = false,
  navigationLodActive = false,
  passive = false,
}: RaftProxyMeshLayerProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const supportRoots = supportState.roots;
  const supportAnchors = supportState.anchors;
  const raft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);

  const selectedModelIdSet = React.useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
  const excludedModelIdSet = React.useMemo(
    () => new Set(excludeModelIds.filter((id): id is string => Boolean(id))),
    [excludeModelIds],
  );

  const clippingPlanes = React.useMemo(() => {
    const planes: THREE.Plane[] = [];
    if (clipLower != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
    if (clipUpper != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
    return planes.length > 0 ? planes : null;
  }, [clipLower, clipUpper]);

  const effectiveHoverModelId = passive ? null : hoverModelId;

  const hasSelectedModels = selectedModelIdSet.size > 0;
  const raftSignature = React.useMemo(() => buildRaftSignature(raft), [raft]);

  const geometriesByModel = React.useMemo(() => {
    if (
      raftProxyCache
      && raftProxyCache.supportRootsRef === supportRoots
      && raftProxyCache.supportAnchorsRef === supportAnchors
      && raftProxyCache.raftSignature === raftSignature
    ) {
      return raftProxyCache.geometriesByModel;
    }

    const rootCirclesByModel = collectRootCirclesByModel(supportRoots, supportAnchors);
    const next = new Map<string, CachedRaftGeometry>();

    if (raft.bottomMode === 'solid') {
      for (const [modelKey, circles] of rootCirclesByModel.entries()) {
        const solid = buildSolidRaftPreviewMeshes({
          circles,
          raftSettings: raft,
          baseColor: RAFT_BASE_COLOR,
          wallColor: RAFT_BASE_COLOR,
        });
        if (!solid) continue;

        next.set(modelKey, {
          kind: 'solid',
          bottomGeometry: (solid.baseMesh.geometry as THREE.BufferGeometry).clone(),
          wallGeometry: solid.wallMesh ? (solid.wallMesh.geometry as THREE.BufferGeometry).clone() : null,
        });

        disposeGeneratedMeshes([
          solid.baseMesh,
          ...(solid.wallMesh ? [solid.wallMesh] : []),
        ]);
      }
    } else if (raft.bottomMode === 'line') {
      for (const [modelKey, circles] of rootCirclesByModel.entries()) {
        const line = buildLineRaftPreviewMeshes({
          circles,
          raftSettings: raft,
          beamColor: RAFT_BASE_COLOR,
          wallColor: RAFT_BASE_COLOR,
        });
        if (!line) continue;

        const bottomGeometry = mergeGeometryParts([
          ...line.beamMeshes.map((mesh) => mesh.geometry as THREE.BufferGeometry),
          line.borderMesh ? (line.borderMesh.geometry as THREE.BufferGeometry) : null,
        ]);

        const wallGeometry = line.wallMesh
          ? (line.wallMesh.geometry as THREE.BufferGeometry).clone()
          : null;

        next.set(modelKey, {
          kind: 'line',
          bottomGeometry,
          wallGeometry,
        });

        disposeGeneratedMeshes([
          ...line.beamMeshes,
          line.borderMesh,
          line.wallMesh,
        ]);
      }
    }

    raftProxyCache = {
      supportRootsRef: supportRoots,
      supportAnchorsRef: supportAnchors,
      raftSignature,
      geometriesByModel: next,
    };

    return next;
  }, [raft, raftSignature, supportRoots, supportAnchors]);

  const visibleEntries = React.useMemo<VisibleRaftEntry[]>(() => {
    const entries: VisibleRaftEntry[] = [];

    const resolveTintStrength = (modelId: string | null) => {
      if (!modelId) return colorized ? (hoverized ? 0.5 : 1) : 0;
      if (!colorized) return 0;
      if (selectedModelIdSet.has(modelId)) return 1;
      if (effectiveHoverModelId) return modelId === effectiveHoverModelId ? 0.5 : 0;
      if (hasSelectedModels) return 0;
      return hoverized ? 0.5 : 1;
    };

    const pushIfVisible = (modelKey: string, geometry: CachedRaftGeometry | undefined) => {
      if (!geometry) return;
      const modelId = fromModelKey(modelKey);
      if (excludeModelId && modelId === excludeModelId) return;
      if (modelId && excludedModelIdSet.has(modelId)) return;

      const tintStrength = resolveTintStrength(modelId ?? null);
      const bottomTintColor = geometry.kind === 'line' ? LINE_BOTTOM_TINT_COLOR : SOLID_BOTTOM_TINT_COLOR;

      entries.push({
        modelKey,
        modelId,
        kind: geometry.kind,
        bottomGeometry: geometry.bottomGeometry,
        wallGeometry: geometry.wallGeometry,
        bottomColor: blendColor(RAFT_BASE_COLOR, bottomTintColor, tintStrength),
        wallColor: blendColor(RAFT_BASE_COLOR, WALL_TINT_COLOR, tintStrength),
      });
    };

    if (modelFilterId) {
      const modelKey = toModelKey(modelFilterId);
      pushIfVisible(modelKey, geometriesByModel.get(modelKey));
      return entries;
    }

    for (const [modelKey, geometry] of geometriesByModel.entries()) {
      pushIfVisible(modelKey, geometry);
    }

    return entries;
  }, [
    colorized,
    effectiveHoverModelId,
    excludeModelId,
    excludedModelIdSet,
    geometriesByModel,
    hasSelectedModels,
    hoverized,
    modelFilterId,
    selectedModelIdSet,
  ]);

  const raftOpacity = Math.max(0.05, Math.min(1, ghostOpacity));
  const raftTransparent = raftOpacity < 0.999;
  const pointerEnabled = enablePointerSelection && !passive && !navigationLodActive;

  const lastHoverModelRef = React.useRef<string | null>(null);
  const hoverClearRafRef = React.useRef<number | null>(null);

  const dispatchRaftHover = React.useCallback((modelId: string | null) => {
    if (typeof window === 'undefined') return;
    if (lastHoverModelRef.current === modelId) return;
    lastHoverModelRef.current = modelId;
    window.dispatchEvent(new CustomEvent('support-raft-model-pointer-hover', {
      detail: {
        modelId,
        category: 'raft',
      },
    }));
  }, []);

  const scheduleHoverClear = React.useCallback(() => {
    if (hoverClearRafRef.current !== null) return;

    hoverClearRafRef.current = requestAnimationFrame(() => {
      hoverClearRafRef.current = null;
      dispatchRaftHover(null);
    });
  }, [dispatchRaftHover]);

  React.useEffect(() => {
    return () => {
      if (hoverClearRafRef.current !== null) {
        cancelAnimationFrame(hoverClearRafRef.current);
        hoverClearRafRef.current = null;
      }
      if (lastHoverModelRef.current !== null) {
        lastHoverModelRef.current = null;
        dispatchRaftHover(null);
      }
    };
  }, [dispatchRaftHover]);

  React.useEffect(() => {
    if (pointerEnabled) return;
    if (hoverClearRafRef.current !== null) {
      cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }
    if (lastHoverModelRef.current !== null) {
      lastHoverModelRef.current = null;
      dispatchRaftHover(null);
    }
  }, [dispatchRaftHover, pointerEnabled]);

  const handleClick = React.useCallback((event: any, modelId?: string) => {
    if (!pointerEnabled) return;
    if (!modelId || !onModelPointerSelect) return;

    event.stopPropagation();
    if (event.nativeEvent) {
      event.nativeEvent.stopPropagation();
      event.nativeEvent.stopImmediatePropagation?.();
    }

    onModelPointerSelect(modelId);
  }, [onModelPointerSelect, pointerEnabled]);

  const handlePointerMove = React.useCallback((event: any, modelId?: string) => {
    if (!pointerEnabled) return;
    event.stopPropagation();

    if (hoverClearRafRef.current !== null) {
      cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }
    dispatchRaftHover(modelId ?? null);
  }, [dispatchRaftHover, pointerEnabled]);

  const handlePointerOut = React.useCallback((event: any) => {
    if (!pointerEnabled) return;
    event.stopPropagation();
    scheduleHoverClear();
  }, [pointerEnabled, scheduleHoverClear]);

  if (raft.bottomMode === 'off' || visibleEntries.length === 0) {
    return null;
  }

  return (
    <group>
      {visibleEntries.map((entry) => (
        <group key={`raft-proxy:${entry.modelKey}`}>
          {entry.bottomGeometry && (
            <mesh
              geometry={entry.bottomGeometry}
              renderOrder={ghostRenderOrder}
              onClick={pointerEnabled ? (event) => handleClick(event, entry.modelId) : undefined}
              onPointerMove={pointerEnabled ? (event) => handlePointerMove(event, entry.modelId) : undefined}
              onPointerOut={pointerEnabled ? handlePointerOut : undefined}
            >
              <meshStandardMaterial
                color={entry.bottomColor}
                roughness={0.9}
                metalness={0.0}
                side={entry.kind === 'line' ? THREE.DoubleSide : THREE.FrontSide}
                transparent={raftTransparent}
                opacity={raftOpacity}
                depthWrite
                depthTest
                clippingPlanes={clippingPlanes ?? undefined}
              />
            </mesh>
          )}

          {entry.wallGeometry && (
            <mesh
              geometry={entry.wallGeometry}
              renderOrder={ghostRenderOrder}
              onClick={pointerEnabled ? (event) => handleClick(event, entry.modelId) : undefined}
              onPointerMove={pointerEnabled ? (event) => handlePointerMove(event, entry.modelId) : undefined}
              onPointerOut={pointerEnabled ? handlePointerOut : undefined}
            >
              <meshStandardMaterial
                color={entry.wallColor}
                roughness={0.9}
                metalness={0.0}
                transparent={raftTransparent}
                opacity={raftOpacity}
                depthWrite
                depthTest
                clippingPlanes={clippingPlanes ?? undefined}
              />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}
