"use client";

import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from '@/supports/state';
import { getRaftSettings, subscribeToRaftStore } from '../RaftState';
import { SupportBaseCircle } from '../RaftTypes';
import { computeFootprint } from '../geometry/computeFootprint';
import { generateChamferedBase } from '../geometry/generateChamferedBase';
import { generatePerimeterWall } from '../geometry/generatePerimeterWall';
import { generateCrenelatedWallManual } from '../geometry/generateCrenelatedWallManual';

/**
 * RaftRenderer
 * - Subscribes to supports and raft settings
 * - Builds a convex footprint around support base circles
 * - Generates chamfered base mesh and renders it at Z=0 when enabled
 */
interface RaftRendererProps {
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

export default function RaftRenderer({
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
}: RaftRendererProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot);
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
    if (raft.bottomMode !== 'solid') return null;

    const rootsByModel = new Map<string, typeof supportState.roots[string][]>();
    for (const root of Object.values(supportState.roots)) {
      if (excludeModelId && root.modelId === excludeModelId) continue;
      if (root.modelId && excludedModelIdSet.has(root.modelId)) continue;
      if (modelFilterId && root.modelId !== modelFilterId) continue;
      const key = root.modelId || 'unknown';
      if (!rootsByModel.has(key)) rootsByModel.set(key, []);
      rootsByModel.get(key)!.push(root);
    }

    // Include anchor roots as synthetic Roots entries for raft footprint
    for (const anchor of Object.values(supportState.anchors)) {
      if (excludeModelId && anchor.modelId === excludeModelId) continue;
      if (anchor.modelId && excludedModelIdSet.has(anchor.modelId)) continue;
      if (modelFilterId && anchor.modelId !== modelFilterId) continue;
      const key = anchor.modelId || 'unknown';
      if (!rootsByModel.has(key)) rootsByModel.set(key, []);
      rootsByModel.get(key)!.push({
        id: anchor.id,
        modelId: anchor.modelId,
        transform: { pos: anchor.rootPos, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: anchor.rootBaseDiameter,
        diskHeight: anchor.rootHeight,
        coneHeight: 0,
      });
    }

    const blendColor = (baseHex: string, tintHex: string, strength: number) =>
      new THREE.Color(baseHex).lerp(new THREE.Color(tintHex), strength).getStyle();

    const resolveTintStrength = (modelId: string) => {
      if (!colorized) return 0;
      if (selectedModelIdSet.has(modelId)) return 1;
      if (effectiveHoverModelId) return modelId === effectiveHoverModelId ? 0.5 : 0;
      if (hasSelectedModels) return 0;
      return hoverized ? 0.5 : 1;
    };

    const meshes: Array<{ baseMesh: THREE.Mesh; wallMesh: THREE.Mesh | null }> = [];

    for (const [modelId, roots] of rootsByModel) {
      const circles: SupportBaseCircle[] = roots.map(root => ({
        x: root.transform.pos.x,
        y: root.transform.pos.y,
        r: root.diameter / 2,
      }));
      if (circles.length === 0) continue;

      const profile = computeFootprint(circles, { marginMm: 0.2, samplesPerCircle: 24 });
      if (!profile || profile.length < 3) continue;

      const baseMesh = generateChamferedBase(profile, { thickness: raft.thickness, chamferAngle: raft.chamferAngle });
      baseMesh.userData.modelId = modelId;
      baseMesh.renderOrder = ghostRenderOrder;
      baseMesh.material = new THREE.MeshStandardMaterial({ color: '#a3a3a3', roughness: 0.9, metalness: 0.0, opacity: raftOpacity, transparent: raftTransparent, depthWrite: !raftTransparent, clippingPlanes });
      baseMesh.castShadow = false;
      baseMesh.receiveShadow = true;

      let wallMesh: THREE.Mesh | null = null;
      if (raft.wallEnabled) {
        const useCrenels = raft.crenulationSpacing > 0 && raft.crenulationGapWidth > 0;
        wallMesh = useCrenels
          ? generateCrenelatedWallManual(profile, {
            wallHeight: raft.wallHeight,
            wallThickness: raft.wallThickness,
            crenulationGapWidth: raft.crenulationGapWidth,
            crenulationSpacing: raft.crenulationSpacing,
            thickness: raft.thickness,
            chamferAngle: raft.chamferAngle,
          })
          : generatePerimeterWall(profile, { wallHeight: raft.wallHeight, wallThickness: raft.wallThickness, thickness: raft.thickness });

        if (wallMesh.geometry && (wallMesh.geometry as any).attributes?.position?.count > 0) {
          wallMesh.userData.modelId = modelId;
          wallMesh.userData.isWall = true;
          wallMesh.renderOrder = ghostRenderOrder;
          wallMesh.material = new THREE.MeshStandardMaterial({ color: '#a3a3a3', roughness: 0.9, metalness: 0.0, opacity: raftOpacity, transparent: raftTransparent, depthWrite: !raftTransparent, clippingPlanes });
          wallMesh.castShadow = false;
          wallMesh.receiveShadow = true;
        }
      }

      meshes.push({ baseMesh, wallMesh });
    }

    return meshes;
  }, [excludeModelId, excludedModelIdSet, modelFilterId, supportState, raft.bottomMode, raft.wallEnabled, raft.thickness, raft.chamferAngle, raft.wallHeight, raft.wallThickness, raft.crenulationGapWidth, raft.crenulationSpacing, raftOpacity, raftTransparent, ghostRenderOrder, clippingPlanes]);

  const handleClick = React.useCallback((e: any) => {
    if (passive) return;
    const modelId = e?.object?.userData?.modelId;
    if (!modelId || !onModelPointerSelect) return;

    e.stopPropagation();
    if (e.nativeEvent) {
      e.nativeEvent.stopPropagation();
      e.nativeEvent.stopImmediatePropagation?.();
    }

    onModelPointerSelect(modelId, e);
  }, [onModelPointerSelect, passive]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        || (
          !!mesh.geometry
          && ((mesh.geometry as THREE.BufferGeometry).attributes?.position?.count ?? 0) > 0
          && mesh.geometry.boundingBox?.max?.z !== undefined
          && ((mesh.geometry.boundingBox?.max.z ?? 0) > (raft.thickness + 0.001))
        );
      const tintHex = isWall ? '#22c55e' : '#3b82f6';
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
  }, [colorized, effectiveHoverModelId, effectiveVisualActiveModelId, hasSelectedModels, hoverized, raft.thickness, raftOpacity, raftTransparent, ghostRenderOrder, raftMeshes, selectedModelIdSet, clippingPlanes]);

  if (raft.bottomMode === 'off') return null;
  return <group ref={groupRef} position={[0, 0, 0]} onClick={navigationLodActive ? undefined : handleClick} onPointerMove={navigationLodActive ? undefined : handlePointerMove} onPointerOut={navigationLodActive ? undefined : handlePointerOut} />;
}
