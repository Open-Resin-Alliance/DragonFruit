import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
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
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  excludeModelIds?: string[];
  ghostOpacity?: number;
  ghostRenderOrder?: number;
  onModelPointerSelect?: (modelId: string) => void;
  enablePointerSelection?: boolean;
}

type CachedSolidRaftGeometry = {
  kind: 'solid';
  baseGeometry: THREE.BufferGeometry;
  wallGeometry: THREE.BufferGeometry | null;
};

type CachedLineRaftGeometry = {
  kind: 'line';
  beamGeometries: THREE.BufferGeometry[];
  borderGeometry: THREE.BufferGeometry | null;
  wallGeometry: THREE.BufferGeometry | null;
};

type CachedRaftGeometry = CachedSolidRaftGeometry | CachedLineRaftGeometry;

type RaftProxyCacheEntry = {
  supportStateRef: unknown;
  raftSignature: string;
  geometriesByModel: Map<string, CachedRaftGeometry>;
};

let raftProxyCache: RaftProxyCacheEntry | null = null;

const MODEL_NONE_KEY = '__none__';
const DEFAULT_RAFT_COLOR = '#a3a3a3';
const ACTIVE_RAFT_COLOR = '#c8752a';

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

function disposeGeneratedMaterials(meshes: THREE.Mesh[]) {
  const seen = new Set<THREE.Material>();
  for (const mesh of meshes) {
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const m of material) {
        if (seen.has(m)) continue;
        seen.add(m);
        m.dispose();
      }
      continue;
    }
    if (!material || seen.has(material)) continue;
    seen.add(material);
    material.dispose();
  }
}

function collectRootCirclesByModel(supportState: ReturnType<typeof getSnapshot>): Map<string, SupportBaseCircle[]> {
  const byModel = new Map<string, SupportBaseCircle[]>();

  for (const root of Object.values(supportState.roots)) {
    const modelKey = toModelKey(root.modelId);
    const circles = byModel.get(modelKey) ?? [];
    circles.push({
      x: root.transform.pos.x,
      y: root.transform.pos.y,
      r: root.diameter / 2,
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
  modelFilterId = null,
  excludeModelId = null,
  excludeModelIds = [],
  ghostOpacity = 1,
  ghostRenderOrder = 0,
  onModelPointerSelect,
  enablePointerSelection = true,
}: RaftProxyMeshLayerProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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

  const raftSignature = React.useMemo(() => buildRaftSignature(raft), [raft]);

  const geometriesByModel = React.useMemo(() => {
    if (
      raftProxyCache
      && raftProxyCache.supportStateRef === supportState
      && raftProxyCache.raftSignature === raftSignature
    ) {
      return raftProxyCache.geometriesByModel;
    }

    const rootCirclesByModel = collectRootCirclesByModel(supportState);
    const next = new Map<string, CachedRaftGeometry>();

    if (raft.bottomMode === 'solid') {
      for (const [modelKey, circles] of rootCirclesByModel.entries()) {
        const solid = buildSolidRaftPreviewMeshes({
          circles,
          raftSettings: raft,
          baseColor: DEFAULT_RAFT_COLOR,
          wallColor: DEFAULT_RAFT_COLOR,
        });
        if (!solid) continue;

        next.set(modelKey, {
          kind: 'solid',
          baseGeometry: solid.baseMesh.geometry as THREE.BufferGeometry,
          wallGeometry: solid.wallMesh ? (solid.wallMesh.geometry as THREE.BufferGeometry) : null,
        });

        disposeGeneratedMaterials([
          solid.baseMesh,
          ...(solid.wallMesh ? [solid.wallMesh] : []),
        ]);
      }
    } else if (raft.bottomMode === 'line') {
      for (const [modelKey, circles] of rootCirclesByModel.entries()) {
        const line = buildLineRaftPreviewMeshes({
          circles,
          raftSettings: raft,
          beamColor: DEFAULT_RAFT_COLOR,
          wallColor: DEFAULT_RAFT_COLOR,
        });
        if (!line) continue;

        next.set(modelKey, {
          kind: 'line',
          beamGeometries: line.beamMeshes.map((mesh) => mesh.geometry as THREE.BufferGeometry),
          borderGeometry: line.borderMesh ? (line.borderMesh.geometry as THREE.BufferGeometry) : null,
          wallGeometry: line.wallMesh ? (line.wallMesh.geometry as THREE.BufferGeometry) : null,
        });

        disposeGeneratedMaterials([
          ...line.beamMeshes,
          ...(line.borderMesh ? [line.borderMesh] : []),
          ...(line.wallMesh ? [line.wallMesh] : []),
        ]);
      }
    }

    raftProxyCache = {
      supportStateRef: supportState,
      raftSignature,
      geometriesByModel: next,
    };

    return next;
  }, [raft, raft.bottomMode, raftSignature, supportState]);

  const visibleEntries = React.useMemo(() => {
    const entries: Array<{ modelId?: string; modelKey: string; color: string; geometry: CachedRaftGeometry }> = [];

    const requestedFilterKey = modelFilterId ? toModelKey(modelFilterId) : null;

    for (const [modelKey, geometry] of geometriesByModel.entries()) {
      if (requestedFilterKey && modelKey !== requestedFilterKey) continue;

      const modelId = fromModelKey(modelKey);
      if (excludeModelId && modelId === excludeModelId) continue;
      if (modelId && excludedModelIdSet.has(modelId)) continue;

      const highlighted = !!modelId && (modelId === activeModelId || selectedModelIdSet.has(modelId));
      entries.push({
        modelId,
        modelKey,
        geometry,
        color: highlighted ? ACTIVE_RAFT_COLOR : DEFAULT_RAFT_COLOR,
      });
    }

    return entries;
  }, [activeModelId, excludeModelId, excludedModelIdSet, geometriesByModel, modelFilterId, selectedModelIdSet]);

  const raftOpacity = Math.max(0.05, Math.min(1, ghostOpacity));
  const raftTransparent = raftOpacity < 0.999;

  const handleClick = React.useCallback((modelId?: string) => {
    if (!enablePointerSelection) return;
    if (!modelId) return;
    onModelPointerSelect?.(modelId);
  }, [enablePointerSelection, onModelPointerSelect]);

  if (raft.bottomMode === 'off' || visibleEntries.length === 0) {
    return null;
  }

  return (
    <group>
      {visibleEntries.map((entry) => {
        if (entry.geometry.kind === 'solid') {
          return (
            <group key={`raft-solid:${entry.modelKey}`}>
              <mesh
                geometry={entry.geometry.baseGeometry}
                renderOrder={ghostRenderOrder}
                onClick={enablePointerSelection ? () => handleClick(entry.modelId) : undefined}
              >
                <meshStandardMaterial
                  color={entry.color}
                  roughness={0.9}
                  metalness={0.0}
                  transparent={raftTransparent}
                  opacity={raftOpacity}
                  depthWrite={!raftTransparent}
                  clippingPlanes={clippingPlanes ?? undefined}
                />
              </mesh>

              {entry.geometry.wallGeometry && (
                <mesh
                  geometry={entry.geometry.wallGeometry}
                  renderOrder={ghostRenderOrder}
                  onClick={enablePointerSelection ? () => handleClick(entry.modelId) : undefined}
                >
                  <meshStandardMaterial
                    color={entry.color}
                    roughness={0.9}
                    metalness={0.0}
                    transparent={raftTransparent}
                    opacity={raftOpacity}
                    depthWrite={!raftTransparent}
                    clippingPlanes={clippingPlanes ?? undefined}
                  />
                </mesh>
              )}
            </group>
          );
        }

        return (
          <group key={`raft-line:${entry.modelKey}`}>
            {entry.geometry.beamGeometries.map((geometry, index) => (
              <mesh
                key={`beam:${entry.modelKey}:${index}`}
                geometry={geometry}
                renderOrder={ghostRenderOrder}
                onClick={enablePointerSelection ? () => handleClick(entry.modelId) : undefined}
              >
                <meshStandardMaterial
                  color={entry.color}
                  roughness={0.9}
                  metalness={0.0}
                  transparent={raftTransparent}
                  opacity={raftOpacity}
                  depthWrite={!raftTransparent}
                  clippingPlanes={clippingPlanes ?? undefined}
                  side={THREE.DoubleSide}
                />
              </mesh>
            ))}

            {entry.geometry.borderGeometry && (
              <mesh
                geometry={entry.geometry.borderGeometry}
                renderOrder={ghostRenderOrder}
                onClick={enablePointerSelection ? () => handleClick(entry.modelId) : undefined}
              >
                <meshStandardMaterial
                  color={entry.color}
                  roughness={0.9}
                  metalness={0.0}
                  transparent={raftTransparent}
                  opacity={raftOpacity}
                  depthWrite={!raftTransparent}
                  clippingPlanes={clippingPlanes ?? undefined}
                  side={THREE.DoubleSide}
                />
              </mesh>
            )}

            {entry.geometry.wallGeometry && (
              <mesh
                geometry={entry.geometry.wallGeometry}
                renderOrder={ghostRenderOrder}
                onClick={enablePointerSelection ? () => handleClick(entry.modelId) : undefined}
              >
                <meshStandardMaterial
                  color={entry.color}
                  roughness={0.9}
                  metalness={0.0}
                  transparent={raftTransparent}
                  opacity={raftOpacity}
                  depthWrite={!raftTransparent}
                  clippingPlanes={clippingPlanes ?? undefined}
                />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}
