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
  colorized?: boolean;
  hoverized?: boolean;
  activeModelId?: string | null;
  hoverModelId?: string | null;
  onModelPointerSelect?: (modelId: string, e: any) => void;
}

export default function RaftRenderer({
  colorized = true,
  hoverized = false,
  activeModelId = null,
  hoverModelId = null,
  onModelPointerSelect,
}: RaftRendererProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot);
  const raft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);

  const raftMeshes = React.useMemo(() => {
    if (raft.bottomMode !== 'solid') return null;

    const rootsByModel = new Map<string, typeof supportState.roots[string][]>();
    for (const root of Object.values(supportState.roots)) {
      const key = root.modelId || 'unknown';
      if (!rootsByModel.has(key)) rootsByModel.set(key, []);
      rootsByModel.get(key)!.push(root);
    }

    const blendColor = (baseHex: string, tintHex: string, strength: number) =>
      new THREE.Color(baseHex).lerp(new THREE.Color(tintHex), strength).getStyle();

    const resolveTintStrength = (modelId: string) => {
      if (!colorized) return 0;
      if (activeModelId) return modelId === activeModelId ? 1 : 0;
      if (hoverModelId) return modelId === hoverModelId ? 0.5 : 0;
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

      const tintStrength = resolveTintStrength(modelId);
      const baseColor = blendColor('#a3a3a3', '#3b82f6', tintStrength);
      const wallColor = blendColor('#a3a3a3', '#22c55e', tintStrength);

      const baseMesh = generateChamferedBase(profile, { thickness: raft.thickness, chamferAngle: raft.chamferAngle });
      baseMesh.userData.modelId = modelId;
      baseMesh.material = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.9, metalness: 0.0, opacity: 1.0, transparent: false });
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
          wallMesh.material = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.9, metalness: 0.0, opacity: 1.0, transparent: false });
          wallMesh.castShadow = false;
          wallMesh.receiveShadow = true;
        }
      }

      meshes.push({ baseMesh, wallMesh });
    }

    return meshes;
  }, [activeModelId, colorized, hoverModelId, hoverized, supportState, raft.bottomMode, raft.wallEnabled, raft.thickness, raft.chamferAngle, raft.wallHeight, raft.wallThickness, raft.crenulationGapWidth, raft.crenulationSpacing]);

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

  if (raft.bottomMode === 'off') return null;
  return <group ref={groupRef} position={[0, 0, 0]} onClick={handleClick} />;
}
