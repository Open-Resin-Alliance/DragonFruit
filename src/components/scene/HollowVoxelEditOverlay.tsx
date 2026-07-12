import React from 'react';
import * as THREE from 'three';
import { getVoxelPreviewBudget, tryAllocateFloat32Array, warnOnce } from './hollowVoxelPreviewLimits';
import { INSTANCED_EDGE_FRAGMENT_SHADER, INSTANCED_EDGE_VERTEX_SHADER } from './instancedEdgeShader';

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
const EDGE_OPACITY = 0.45;
// Stable reference so the shaderMaterial's `uniforms` prop doesn't get a
// fresh object (and re-upload to the GPU) on every render.
const EDGE_UNIFORMS = {
  uColor: { value: new THREE.Color(EDGE_COLOR) },
  uOpacity: { value: EDGE_OPACITY },
};

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

/**
 * Builds the GPU-instanced edge-wireframe geometry: a shared, non-instanced
 * 24-vertex cube-edge template plus a per-instance transform attribute that
 * reuses the exact same matrix buffer already built for the cube
 * InstancedMesh (`instanceData.matrices` from `buildInstanceData`) -- zero
 * additional per-voxel memory, unlike the previous fully-expanded
 * world-space buffer.
 */
function buildInstancedEdgeGeometry(matrices: Float32Array): THREE.InstancedBufferGeometry {
  const geom = new THREE.InstancedBufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(CUBE_EDGE_VERTICES, 3));
  geom.setAttribute('instanceTransform', new THREE.InstancedBufferAttribute(matrices, 16));
  geom.instanceCount = Math.floor(matrices.length / 16);
  return geom;
}

function buildInstanceData(
  voxelCenters: Float32Array,
  blockedVoxelCenters: Float32Array | undefined,
  voxelSizeMm: number,
  offsetX: number,
  offsetY: number,
  offsetZ: number,
  blockedVoxelIndexSet: Set<number>,
): { matrices: Float32Array; colors: Float32Array } | null {
  const removedCount = Math.floor(voxelCenters.length / 3);
  const blockedCount = blockedVoxelCenters
    ? Math.floor(blockedVoxelCenters.length / 3)
    : 0;
  const total = removedCount + blockedCount;
  const matrices = tryAllocateFloat32Array(total * 16);
  const colors = matrices ? tryAllocateFloat32Array(total * 3) : null;
  if (!matrices || !colors) return null;
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

  const budget = getVoxelPreviewBudget();
  // Edges degrade gracefully (skipped above budget, cheap to re-enable once
  // the voxel count drops back down). The cube InstancedMesh itself has a
  // much higher ceiling (64 bytes/voxel), and truncating it isn't safe here
  // without also renumbering blockedVoxelIndexSet (computed by the caller
  // against the *full*, untruncated removed/blocked counts) -- so on the
  // rare chance even that generous ceiling is exceeded, skip rendering this
  // overlay entirely rather than risk misaligned voxel-toggle indices.
  const showEdges = totalCount <= budget.maxEdgeInstances;
  const overCubeBudget = totalCount > budget.maxCubeInstances;

  React.useEffect(() => {
    if (overCubeBudget) {
      warnOnce(
        'hollow-voxel-edit-overlay-cube-cap',
        `[HollowVoxelEditOverlay] voxel count ${totalCount} exceeds render budget (${budget.maxCubeInstances}); hiding the edit overlay to avoid an out-of-memory crash.`,
      );
    } else if (!showEdges) {
      warnOnce(
        'hollow-voxel-edit-overlay-edge-cap',
        `[HollowVoxelEditOverlay] voxel count ${totalCount} exceeds edge-render budget (${budget.maxEdgeInstances}); showing cubes without edge outlines.`,
      );
    }
  }, [totalCount, overCubeBudget, showEdges, budget.maxCubeInstances, budget.maxEdgeInstances]);

  const instanceData = React.useMemo(() => {
    if (overCubeBudget) return null;
    return buildInstanceData(
      voxelCenters,
      blockedVoxelCenters,
      voxelRadiusMm,
      meshOffset.x,
      meshOffset.y,
      meshOffset.z,
      blockedVoxelIndexSet,
    );
  }, [voxelCenters, blockedVoxelCenters, voxelRadiusMm, meshOffset.x, meshOffset.y, meshOffset.z, blockedVoxelIndexSet, overCubeBudget]);

  // Edge geometry: GPU-instanced, reusing the same per-voxel matrices
  // already built for the cube InstancedMesh above (instanceData.matrices).
  const edgeGeometry = React.useMemo(() => {
    if (!showEdges || !instanceData) return null;
    return buildInstancedEdgeGeometry(instanceData.matrices);
  }, [instanceData, showEdges]);

  React.useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !instanceData) return;
    const { matrices, colors } = instanceData;
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
  }, [instanceData, totalCount]);

  if (totalCount === 0 || !instanceData) return null;

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
      {edgeGeometry && (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={30002}
          frustumCulled={false}
          raycast={() => null}
        >
          <shaderMaterial
            transparent
            depthTest
            depthWrite={false}
            uniforms={EDGE_UNIFORMS}
            vertexShader={INSTANCED_EDGE_VERTEX_SHADER}
            fragmentShader={INSTANCED_EDGE_FRAGMENT_SHADER}
          />
        </lineSegments>
      )}
    </group>
  );
}
