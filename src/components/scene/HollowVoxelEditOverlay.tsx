import React from 'react';
import * as THREE from 'three';

type HollowVoxelEditOverlayProps = {
  voxelCenters: Float32Array;
  voxelRadiusMm: number;
  blockedVoxelIndexSet: Set<number>;
  meshOffset: THREE.Vector3;
  onToggleVoxel?: (voxelIndex: number) => void;
};

const ACTIVE_COLOR = new THREE.Color('#d0c81d');
const BLOCKED_COLOR = new THREE.Color('#4aa7ff');
const EMPTY_MATRIX = new THREE.Matrix4();
const INSTANCE_POSITION = new THREE.Vector3();
const INSTANCE_SCALE = new THREE.Vector3(1, 1, 1);
const INSTANCE_QUATERNION = new THREE.Quaternion();

export function HollowVoxelEditOverlay({
  voxelCenters,
  voxelRadiusMm,
  blockedVoxelIndexSet,
  meshOffset,
  onToggleVoxel,
}: HollowVoxelEditOverlayProps) {
  const instancedMeshRef = React.useRef<THREE.InstancedMesh>(null);
  const sphereGeometry = React.useMemo(
    () => new THREE.SphereGeometry(Math.max(voxelRadiusMm, 0.05), 10, 10),
    [voxelRadiusMm],
  );

  React.useEffect(() => () => {
    sphereGeometry.dispose();
  }, [sphereGeometry]);

  React.useLayoutEffect(() => {
    const mesh = instancedMeshRef.current;
    if (!mesh) return;

    const count = Math.floor(voxelCenters.length / 3);
    mesh.count = count;

    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      INSTANCE_POSITION.set(
        voxelCenters[offset] + meshOffset.x,
        voxelCenters[offset + 1] + meshOffset.y,
        voxelCenters[offset + 2] + meshOffset.z,
      );
      EMPTY_MATRIX.compose(INSTANCE_POSITION, INSTANCE_QUATERNION, INSTANCE_SCALE);
      mesh.setMatrixAt(index, EMPTY_MATRIX);
      mesh.setColorAt(index, blockedVoxelIndexSet.has(index) ? BLOCKED_COLOR : ACTIVE_COLOR);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
  }, [blockedVoxelIndexSet, meshOffset, voxelCenters]);

  return (
    <instancedMesh
      ref={instancedMeshRef}
      args={[sphereGeometry, undefined, Math.floor(voxelCenters.length / 3)]}
      renderOrder={90}
      onClick={(event) => {
        if (typeof event.instanceId !== 'number') return;
        event.stopPropagation();
        onToggleVoxel?.(event.instanceId);
      }}
    >
      <meshStandardMaterial
        vertexColors
        transparent
        opacity={0.96}
        emissive="#242424"
        emissiveIntensity={0.16}
        roughness={0.55}
        metalness={0.05}
        depthTest={false}
        depthWrite={false}
      />
    </instancedMesh>
  );
}
