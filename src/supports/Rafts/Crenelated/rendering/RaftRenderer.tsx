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
export default function RaftRenderer() {
  const supportState = useSyncExternalStore(subscribe, getSnapshot);
  const raft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);

  const meshes = React.useMemo(() => {
    if (raft.bottomMode !== 'solid') return null;

    const circles: SupportBaseCircle[] = Object.values(supportState.roots).map(root => ({
      x: root.transform.pos.x,
      y: root.transform.pos.y,
      r: root.diameter / 2,
    }));

    if (circles.length === 0) return null;

    // Compute footprint (allow a small margin so bases are fully inside)
    const profile = computeFootprint(circles, { marginMm: 0.2, samplesPerCircle: 24 });
    if (!profile || profile.length < 3) return null;

    // Generate chamfered base mesh
    const baseMesh = generateChamferedBase(profile, { thickness: raft.thickness, chamferAngle: raft.chamferAngle });
    baseMesh.material = new THREE.MeshStandardMaterial({ color: '#3b82f6', roughness: 0.9, metalness: 0.0, opacity: 1.0, transparent: false });
    baseMesh.castShadow = false;
    baseMesh.receiveShadow = true;

    const shouldRenderWall = raft.wallEnabled;
    let wallMesh: THREE.Mesh | null = null;
    if (shouldRenderWall) {
      // Perimeter wall: use manual geometry builder for crenelations on straight runs
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
        wallMesh.material = new THREE.MeshStandardMaterial({ color: '#22c55e', roughness: 0.9, metalness: 0.0, opacity: 1.0, transparent: false });
        wallMesh.castShadow = false;
        wallMesh.receiveShadow = true;
      }
    }

    return { baseMesh, wallMesh } as const;
  }, [supportState, raft.bottomMode, raft.wallEnabled, raft.thickness, raft.chamferAngle, raft.wallHeight, raft.wallThickness, raft.crenulationGapWidth, raft.crenulationSpacing]);

  // Attach/detach mesh to a group node
  const groupRef = React.useRef<THREE.Group>(null);
  React.useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    // Clear existing
    while (group.children.length) group.remove(group.children[0]);
    if (meshes) {
      group.add(meshes.baseMesh);
      if (meshes.wallMesh) group.add(meshes.wallMesh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meshes]);

  if (raft.bottomMode === 'off') return null;
  return <group ref={groupRef} position={[0, 0, 0]} />;
}
