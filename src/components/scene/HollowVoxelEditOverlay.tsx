import React from 'react';
import * as THREE from 'three';

type HollowVoxelEditOverlayProps = {
  voxelCenters: Float32Array;
  blockedVoxelCenters?: Float32Array;
  voxelRadiusMm: number;
  blockedVoxelIndexSet: Set<number>;
  meshOffset: THREE.Vector3;
  onToggleVoxel?: (voxelIndex: number) => void;
};

const UNBLOCKED = new THREE.Color('#66ecff');
const BLOCKED = new THREE.Color('#ffd928');
const EDGE_COLOR = '#1a3340';

/** 12 edges of a unit cube centred at origin, as 24 vertex positions. */
const CUBE_EDGE_VERTICES = new Float32Array([
  -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,
   0.5, -0.5, -0.5,  0.5,  0.5, -0.5,
   0.5,  0.5, -0.5, -0.5,  0.5, -0.5,
  -0.5,  0.5, -0.5, -0.5, -0.5, -0.5,
  -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,
   0.5, -0.5,  0.5,  0.5,  0.5,  0.5,
   0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
  -0.5,  0.5,  0.5, -0.5, -0.5,  0.5,
  -0.5, -0.5, -0.5, -0.5, -0.5,  0.5,
   0.5, -0.5, -0.5,  0.5, -0.5,  0.5,
   0.5,  0.5, -0.5,  0.5,  0.5,  0.5,
  -0.5,  0.5, -0.5, -0.5,  0.5,  0.5,
]);

function buildEdgePositions(
  voxelCenters: Float32Array,
  blockedVoxelCenters: Float32Array | undefined,
  voxelSizeMm: number,
  offsetX: number,
  offsetY: number,
  offsetZ: number,
): Float32Array {
  const removedCount = Math.floor(voxelCenters.length / 3);
  const blockedCount = blockedVoxelCenters
    ? Math.floor(blockedVoxelCenters.length / 3)
    : 0;
  const total = removedCount + blockedCount;
  const out = new Float32Array(total * 72);

  const writeEdges = (i: number, cx: number, cy: number, cz: number) => {
    const vo = i * 72;
    for (let v = 0; v < 72; v += 3) {
      out[vo + v]     = cx + CUBE_EDGE_VERTICES[v]     * voxelSizeMm;
      out[vo + v + 1] = cy + CUBE_EDGE_VERTICES[v + 1] * voxelSizeMm;
      out[vo + v + 2] = cz + CUBE_EDGE_VERTICES[v + 2] * voxelSizeMm;
    }
  };

  for (let i = 0; i < removedCount; i += 1) {
    const base = i * 3;
    writeEdges(i, voxelCenters[base] + offsetX, voxelCenters[base + 1] + offsetY, voxelCenters[base + 2] + offsetZ);
  }
  if (blockedVoxelCenters) {
    for (let i = 0; i < blockedCount; i += 1) {
      const base = i * 3;
      writeEdges(removedCount + i, blockedVoxelCenters[base] + offsetX, blockedVoxelCenters[base + 1] + offsetY, blockedVoxelCenters[base + 2] + offsetZ);
    }
  }
  return out;
}

function buildInstanceData(
  voxelCenters: Float32Array,
  blockedVoxelCenters: Float32Array | undefined,
  voxelSizeMm: number,
  offsetX: number,
  offsetY: number,
  offsetZ: number,
  blockedVoxelIndexSet: Set<number>,
): { matrices: Float32Array; colors: Float32Array } {
  const removedCount = Math.floor(voxelCenters.length / 3);
  const blockedCount = blockedVoxelCenters
    ? Math.floor(blockedVoxelCenters.length / 3)
    : 0;
  const total = removedCount + blockedCount;
  const matrices = new Float32Array(total * 16);
  const colors = new Float32Array(total * 3);
  const scale = voxelSizeMm;

  const writeInstance = (i: number, cx: number, cy: number, cz: number, isBlocked: boolean) => {
    const m = i * 16;
    matrices[m] = scale;
    matrices[m + 1] = 0;
    matrices[m + 2] = 0;
    matrices[m + 3] = 0;
    matrices[m + 4] = 0;
    matrices[m + 5] = scale;
    matrices[m + 6] = 0;
    matrices[m + 7] = 0;
    matrices[m + 8] = 0;
    matrices[m + 9] = 0;
    matrices[m + 10] = scale;
    matrices[m + 11] = 0;
    matrices[m + 12] = cx;
    matrices[m + 13] = cy;
    matrices[m + 14] = cz;
    matrices[m + 15] = 1;
    const c = isBlocked ? BLOCKED : UNBLOCKED;
    const cb = i * 3;
    colors[cb] = c.r;
    colors[cb + 1] = c.g;
    colors[cb + 2] = c.b;
  };

  for (let i = 0; i < removedCount; i += 1) {
    const base = i * 3;
    writeInstance(
      i,
      voxelCenters[base] + offsetX,
      voxelCenters[base + 1] + offsetY,
      voxelCenters[base + 2] + offsetZ,
      blockedVoxelIndexSet.has(i),
    );
  }
  if (blockedVoxelCenters) {
    for (let i = 0; i < blockedCount; i += 1) {
      const base = i * 3;
      const idx = removedCount + i;
      writeInstance(
        idx,
        blockedVoxelCenters[base] + offsetX,
        blockedVoxelCenters[base + 1] + offsetY,
        blockedVoxelCenters[base + 2] + offsetZ,
        blockedVoxelIndexSet.has(idx),
      );
    }
  }
  return { matrices, colors };
}

export function HollowVoxelEditOverlay({
  voxelCenters,
  blockedVoxelCenters,
  voxelRadiusMm,
  blockedVoxelIndexSet,
  meshOffset,
  onToggleVoxel,
}: HollowVoxelEditOverlayProps) {
  const meshRef = React.useRef<THREE.InstancedMesh>(null);
  const removedCount = Math.floor(voxelCenters.length / 3);
  const blockedCount = blockedVoxelCenters
    ? Math.floor(blockedVoxelCenters.length / 3)
    : 0;
  const totalCount = removedCount + blockedCount;

  const { matrices, colors } = React.useMemo(
    () => buildInstanceData(
      voxelCenters,
      blockedVoxelCenters,
      voxelRadiusMm,
      meshOffset.x,
      meshOffset.y,
      meshOffset.z,
      blockedVoxelIndexSet,
    ),
    [voxelCenters, blockedVoxelCenters, voxelRadiusMm, meshOffset.x, meshOffset.y, meshOffset.z, blockedVoxelIndexSet],
  );

  const edgeGeometry = React.useMemo(() => {
    const edgePos = buildEdgePositions(
      voxelCenters,
      blockedVoxelCenters,
      voxelRadiusMm,
      meshOffset.x,
      meshOffset.y,
      meshOffset.z,
    );
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(edgePos, 3));
    return geom;
  }, [voxelCenters, blockedVoxelCenters, voxelRadiusMm, meshOffset.x, meshOffset.y, meshOffset.z]);

  React.useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < totalCount; i += 1) {
      const base = i * 16;
      dummy.position.set(matrices[base + 12], matrices[base + 13], matrices[base + 14]);
      dummy.scale.set(matrices[base], matrices[base + 5], matrices[base + 10]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const cb = i * 3;
      mesh.setColorAt(i, new THREE.Color(colors[cb], colors[cb + 1], colors[cb + 2]));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [matrices, colors, totalCount]);

  if (totalCount === 0) return null;

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, totalCount]}
        renderOrder={30001}
        frustumCulled={false}
        onClick={onToggleVoxel ? (event) => {
          if (event.instanceId == null) return;
          event.stopPropagation();
          onToggleVoxel(event.instanceId);
        } : undefined}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial
          transparent
          opacity={0.99}
          depthTest
          depthWrite={true}
        />
      </instancedMesh>
      <lineSegments
        geometry={edgeGeometry}
        renderOrder={30002}
        raycast={() => null}
      >
        <lineBasicMaterial
          color={EDGE_COLOR}
          transparent
          opacity={0.45}
          depthTest
          depthWrite={false}
        />
      </lineSegments>
    </group>
  );
}
