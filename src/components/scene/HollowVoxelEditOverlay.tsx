import React from 'react';
import * as THREE from 'three';

type HollowVoxelEditOverlayProps = {
  voxelCenters: Float32Array;
  voxelRadiusMm: number;
  blockedVoxelIndexSet: Set<number>;
  meshOffset: THREE.Vector3;
  onToggleVoxel?: (voxelIndex: number) => void;
};

const YELLOW = '#ffd928';
const BLUE = '#3f8fff';
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
  const interactionMeshRef = React.useRef<THREE.InstancedMesh>(null);
  const yellowMeshRef = React.useRef<THREE.InstancedMesh>(null);
  const blueMeshRef = React.useRef<THREE.InstancedMesh>(null);
  const count = Math.floor(voxelCenters.length / 3);

  const sphereGeometry = React.useMemo(
    () => new THREE.SphereGeometry(Math.max(voxelRadiusMm, 0.05), 10, 10),
    [voxelRadiusMm],
  );

  React.useEffect(() => () => {
    sphereGeometry.dispose();
  }, [sphereGeometry]);

  React.useLayoutEffect(() => {
    const interactionMesh = interactionMeshRef.current;
    const yellowMesh = yellowMeshRef.current;
    const blueMesh = blueMeshRef.current;
    if (!interactionMesh || !yellowMesh || !blueMesh) return;

    let yellowCount = 0;
    let blueCount = 0;
    interactionMesh.count = count;

    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      INSTANCE_POSITION.set(
        voxelCenters[offset] + meshOffset.x,
        voxelCenters[offset + 1] + meshOffset.y,
        voxelCenters[offset + 2] + meshOffset.z,
      );
      EMPTY_MATRIX.compose(INSTANCE_POSITION, INSTANCE_QUATERNION, INSTANCE_SCALE);
      interactionMesh.setMatrixAt(index, EMPTY_MATRIX);

      if (blockedVoxelIndexSet.has(index)) {
        blueMesh.setMatrixAt(blueCount, EMPTY_MATRIX);
        blueCount += 1;
      } else {
        yellowMesh.setMatrixAt(yellowCount, EMPTY_MATRIX);
        yellowCount += 1;
      }
    }

    yellowMesh.count = yellowCount;
    blueMesh.count = blueCount;
    interactionMesh.instanceMatrix.needsUpdate = true;
    yellowMesh.instanceMatrix.needsUpdate = true;
    blueMesh.instanceMatrix.needsUpdate = true;
  }, [blockedVoxelIndexSet, count, meshOffset, voxelCenters]);

  return (
    <>
      <instancedMesh
        ref={interactionMeshRef}
        args={[sphereGeometry, undefined, count]}
        renderOrder={30000}
        frustumCulled={false}
        onClick={(event) => {
          if (typeof event.instanceId !== 'number') return;
          event.stopPropagation();
          onToggleVoxel?.(event.instanceId);
        }}
      >
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </instancedMesh>

      <instancedMesh
        ref={yellowMeshRef}
        args={[sphereGeometry, undefined, count]}
        renderOrder={30001}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial
          color={YELLOW}
          transparent
          opacity={0.999}
          emissive="#4a3b00"
          emissiveIntensity={0.18}
          roughness={0.38}
          metalness={0.04}
          depthTest
          depthWrite
          toneMapped={false}
        />
      </instancedMesh>

      <instancedMesh
        ref={blueMeshRef}
        args={[sphereGeometry, undefined, count]}
        renderOrder={30002}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial
          color={BLUE}
          transparent
          opacity={0.999}
          emissive="#0b2348"
          emissiveIntensity={0.16}
          roughness={0.34}
          metalness={0.05}
          depthTest
          depthWrite
          toneMapped={false}
        />
      </instancedMesh>
    </>
  );
}
