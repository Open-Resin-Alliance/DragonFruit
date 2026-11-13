"use client";

import React from 'react';
import * as THREE from 'three';
import { getSceneClipPlanes } from '@/features/slicing/sceneClipStore';
import { supportAnswersPointer, SCENERY_DIM } from '@/features/scene/plates/plateInteractivity';
import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from '@/supports/state';
import { getRaftSettingsForModel, getRaftStoreRevision, subscribeToRaftStore } from '../RaftState';
import { buildRaftFootprintMeshes } from '../geometry/generateRaftFromFootprint';
import { collectModelPlateFootprint, type PlateFootprintSource } from '../geometry/modelPlateFootprint';
import { raftBandTopMm } from '../geometry/computeRaftFootprint';
import type { PolygonWithHoles } from '../geometry/polygonSet2d';
import { collectRaftBaseCirclesByModel, fromRaftModelKey, type RaftFootprintSource } from '../raftFootprintCircles';
import { noteActivity } from '@/utils/debug/heartbeatContext';

/**
 * RaftRenderer
 * - Subscribes to supports and raft settings
 * - Builds a convex footprint around support base circles, minus the plate
 *   footprint of any model standing on the plate
 * - Generates chamfered base mesh and renders it at Z=0 when enabled
 */
interface RaftRendererProps {
  passive?: boolean;
  colorized?: boolean;
  /** Models on another bed: their raft dims and answers no pointer, like the model itself. */
  pointerSceneryModelIds?: ReadonlySet<string>;
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
  /** Models whose plate footprint the raft has to clear. */
  plateClearanceTargets?: readonly PlateFootprintSource[];
}

const EMPTY_PLATE_CLEARANCE_TARGETS: readonly PlateFootprintSource[] = Object.freeze([]);

export interface SolidViewportRaftMeshesOptions {
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  excludedModelIds?: ReadonlySet<string> | Iterable<string>;
  plateClearanceTargets?: readonly PlateFootprintSource[];
  raftOpacity?: number;
  raftTransparent?: boolean;
  ghostRenderOrder?: number;
  clippingPlanes?: THREE.Plane[];
}

export function buildSolidViewportRaftMeshes(
  supportState: RaftFootprintSource,
  options: SolidViewportRaftMeshesOptions = {},
): Array<{ baseMesh: THREE.Mesh; wallMesh: THREE.Mesh | null }> {
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

  const clearanceByBandTop = new Map<number, PolygonWithHoles[]>();
  const getClearance = (bandTop: number) => {
    let clearance = clearanceByBandTop.get(bandTop);
    if (!clearance) {
      clearance = collectModelPlateFootprint(plateClearanceTargets, bandTop);
      clearanceByBandTop.set(bandTop, clearance);
    }
    return clearance;
  };

  const meshes: Array<{ baseMesh: THREE.Mesh; wallMesh: THREE.Mesh | null }> = [];
  let notedActivity = false;

  for (const [modelKey, circles] of rootsByModel) {
    if (circles.length === 0) continue;
    const resolvedModelId = fromRaftModelKey(modelKey, 'unknown');
    const modelRaft = getRaftSettingsForModel(resolvedModelId);
    if (modelRaft.bottomMode !== 'solid') continue;

    if (!notedActivity) {
      noteActivity('support-mode:raft-meshes');
      notedActivity = true;
    }

    const modelId = resolvedModelId ?? modelKey;
    const clearance = getClearance(raftBandTopMm(modelRaft));

    const parts = buildRaftFootprintMeshes({ circles, raft: modelRaft, clearance });
    if (!parts.baseMesh) continue;

    const baseMesh = parts.baseMesh;
    baseMesh.userData.modelId = modelId;
    baseMesh.renderOrder = ghostRenderOrder;
    baseMesh.material = new THREE.MeshStandardMaterial({ color: '#a3a3a3', roughness: 0.9, metalness: 0.0, opacity: raftOpacity, transparent: raftTransparent, depthWrite: !raftTransparent, clippingPlanes });
    baseMesh.castShadow = false;
    baseMesh.receiveShadow = true;

    let wallMesh: THREE.Mesh | null = parts.wallMesh;
    if (wallMesh && (wallMesh.geometry as THREE.BufferGeometry).attributes?.position?.count > 0) {
      wallMesh.userData.modelId = modelId;
      wallMesh.userData.isWall = true;
      wallMesh.renderOrder = ghostRenderOrder;
      wallMesh.material = new THREE.MeshStandardMaterial({ color: '#a3a3a3', roughness: 0.9, metalness: 0.0, opacity: raftOpacity, transparent: raftTransparent, depthWrite: !raftTransparent, clippingPlanes });
      wallMesh.castShadow = false;
      wallMesh.receiveShadow = true;
    } else {
      wallMesh = null;
    }

    meshes.push({ baseMesh, wallMesh });
  }

  return meshes;
}

export default function RaftRenderer({
  passive = false,
  colorized = true,
  pointerSceneryModelIds,
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
  plateClearanceTargets = EMPTY_PLATE_CLEARANCE_TARGETS,
}: RaftRendererProps) {
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
    () => buildSolidViewportRaftMeshes(supportState, {
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
    if (passive) return;
    const modelId = e?.object?.userData?.modelId;
    if (!supportAnswersPointer(modelId, pointerSceneryModelIds)) return;
    if (!modelId || !onModelPointerSelect) return;

    e.stopPropagation();
    if (e.nativeEvent) {
      e.nativeEvent.stopPropagation();
      e.nativeEvent.stopImmediatePropagation?.();
    }

    onModelPointerSelect(modelId, e);
  }, [onModelPointerSelect, passive, pointerSceneryModelIds]);

  const handlePointerMove = React.useCallback((e: any) => {
    if (passive) return;
    const modelId = e?.object?.userData?.modelId ?? null;
    window.dispatchEvent(new CustomEvent('support-raft-model-pointer-hover', {
      detail: {
        modelId,
        category: 'raft',
      },
    }));
  }, [passive]);

  const handlePointerOut = React.useCallback(() => {
    if (passive) return;
    window.dispatchEvent(new CustomEvent('support-raft-model-pointer-hover', {
      detail: {
        modelId: null,
        category: 'raft',
      },
    }));
  }, [passive]);

  // Attach/detach mesh to a group node
  const groupRef = React.useRef<THREE.Group>(null);
  React.useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    // Clear existing
    while (group.children.length) group.remove(group.children[0]);
    if (raftMeshes) {
      for (const meshes of raftMeshes) {
        group.add(meshes.baseMesh);
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
        || (
          !!mesh.geometry
          && ((mesh.geometry as THREE.BufferGeometry).attributes?.position?.count ?? 0) > 0
          && mesh.geometry.boundingBox?.max?.z !== undefined
          && ((mesh.geometry.boundingBox?.max.z ?? 0) > (modelRaft.thickness + 0.001))
        );
      const tintHex = isWall ? '#22c55e' : '#3b82f6';
      const nextColor = blendColor('#a3a3a3', tintHex, tintStrength);
      if (!supportAnswersPointer(modelId ?? undefined, pointerSceneryModelIds)) {
        nextColor.multiplyScalar(SCENERY_DIM);
      }
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
  }, [colorized, effectiveHoverModelId, effectiveVisualActiveModelId, hasSelectedModels, hoverized, raftRevision, raftOpacity, raftTransparent, ghostRenderOrder, raftMeshes, selectedModelIdSet, clippingPlanes, pointerSceneryModelIds]);

  if (!raftMeshes || raftMeshes.length === 0) return null;
  return <group ref={groupRef} position={[0, 0, 0]} onClick={navigationLodActive ? undefined : handleClick} onPointerMove={navigationLodActive ? undefined : handlePointerMove} onPointerOut={navigationLodActive ? undefined : handlePointerOut} />;
}
