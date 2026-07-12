import React from 'react';
import * as THREE from 'three';
import { getVoxelPreviewBudget, tryAllocateFloat32Array, warnOnce } from './hollowVoxelPreviewLimits';
import { INSTANCED_EDGE_FRAGMENT_SHADER, INSTANCED_EDGE_VERTEX_SHADER } from './instancedEdgeShader';

type HollowVoxelPreviewProps = {
  voxelCenters: Float32Array;
  voxelSizeMm: number;
  meshOffset: THREE.Vector3;
};

const CAVITY_COLOR = '#66ecff';
const EDGE_COLOR = '#000000';
const EDGE_OPACITY = 0.45;
// Stable references so the shaderMaterial's `uniforms` prop doesn't get a
// fresh object (and re-upload to the GPU) on every render.
const EDGE_UNIFORMS = {
  uColor: { value: new THREE.Color(EDGE_COLOR) },
  uOpacity: { value: EDGE_OPACITY },
};

/** 12 edges of a unit cube centred at origin, as 24 vertex positions. */
const CUBE_EDGE_VERTICES = new Float32Array([
  // Bottom face (z = -0.5)
  -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,
   0.5, -0.5, -0.5,  0.5,  0.5, -0.5,
   0.5,  0.5, -0.5, -0.5,  0.5, -0.5,
  -0.5,  0.5, -0.5, -0.5, -0.5, -0.5,
  // Top face (z = 0.5)
  -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,
   0.5, -0.5,  0.5,  0.5,  0.5,  0.5,
   0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
  -0.5,  0.5,  0.5, -0.5, -0.5,  0.5,
  // Vertical edges
  -0.5, -0.5, -0.5, -0.5, -0.5,  0.5,
   0.5, -0.5, -0.5,  0.5, -0.5,  0.5,
   0.5,  0.5, -0.5,  0.5,  0.5,  0.5,
  -0.5,  0.5, -0.5, -0.5,  0.5,  0.5,
]);

function buildInstanceMatrices(
  voxelCenters: Float32Array,
  voxelSizeMm: number,
  offsetX: number,
  offsetY: number,
  offsetZ: number,
): Float32Array {
  const count = Math.floor(voxelCenters.length / 3);
  const matrices = tryAllocateFloat32Array(count * 16) ?? new Float32Array(0);
  const usableCount = Math.floor(matrices.length / 16);
  const scale = voxelSizeMm;
  for (let i = 0; i < usableCount; i += 1) {
    const base = i * 3;
    const cx = voxelCenters[base] + offsetX;
    const cy = voxelCenters[base + 1] + offsetY;
    const cz = voxelCenters[base + 2] + offsetZ;
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
  }
  return matrices;
}

/**
 * Builds the GPU-instanced edge-wireframe geometry: a shared, non-instanced
 * 24-vertex cube-edge template plus a per-instance transform attribute that
 * reuses the exact same matrix buffer already built for the cube
 * InstancedMesh (`matrices` from `buildInstanceMatrices`) -- zero additional
 * per-voxel memory, unlike the previous fully-expanded world-space buffer.
 */
function buildInstancedEdgeGeometry(matrices: Float32Array): THREE.InstancedBufferGeometry {
  const geom = new THREE.InstancedBufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(CUBE_EDGE_VERTICES, 3));
  geom.setAttribute('instanceTransform', new THREE.InstancedBufferAttribute(matrices, 16));
  geom.instanceCount = Math.floor(matrices.length / 16);
  return geom;
}

/**
 * Renders the cavity as instanced cubes at removed-voxel positions,
 * with coloured edge lines for visual contrast.
 */
export function HollowVoxelPreview({
  voxelCenters,
  voxelSizeMm,
  meshOffset,
}: HollowVoxelPreviewProps) {
  const meshRef = React.useRef<THREE.InstancedMesh>(null);
  const edgeRef = React.useRef<THREE.LineSegments>(null);
  const fullCount = Math.floor(voxelCenters.length / 3);

  const budget = getVoxelPreviewBudget();
  const clampedCount = Math.min(fullCount, budget.maxCubeInstances);
  const showEdges = fullCount <= budget.maxEdgeInstances;

  // Cheap: subarray is a view over the same buffer, not a copy.
  const clampedVoxelCenters = React.useMemo(
    () => (clampedCount === fullCount ? voxelCenters : voxelCenters.subarray(0, clampedCount * 3)),
    [voxelCenters, clampedCount, fullCount],
  );

  React.useEffect(() => {
    if (fullCount > clampedCount) {
      warnOnce(
        'hollow-voxel-preview-cube-cap',
        `[HollowVoxelPreview] voxel count ${fullCount} exceeds render budget (${budget.maxCubeInstances}); showing first ${clampedCount} voxels only.`,
      );
    } else if (!showEdges) {
      warnOnce(
        'hollow-voxel-preview-edge-cap',
        `[HollowVoxelPreview] voxel count ${fullCount} exceeds edge-render budget (${budget.maxEdgeInstances}); showing cubes without edge outlines.`,
      );
    }
  }, [fullCount, clampedCount, showEdges, budget.maxCubeInstances, budget.maxEdgeInstances]);

  const matrices = React.useMemo(() => {
    return buildInstanceMatrices(
      clampedVoxelCenters,
      voxelSizeMm,
      meshOffset.x,
      meshOffset.y,
      meshOffset.z,
    );
  }, [clampedVoxelCenters, voxelSizeMm, meshOffset.x, meshOffset.y, meshOffset.z]);

  // Actual usable instance count -- derived from the built buffer itself
  // rather than trusting clampedCount blindly, in case the (already
  // budget-limited) allocation still failed for some other reason.
  const count = Math.floor(matrices.length / 16);

  // Edge geometry: GPU-instanced, reusing the same per-voxel matrices
  // already built for the cube InstancedMesh above -- see
  // buildInstancedEdgeGeometry. Skipped only if there are no cubes to draw.
  const edgeGeometry = React.useMemo(() => {
    if (!showEdges || count === 0) return null;
    return buildInstancedEdgeGeometry(matrices);
  }, [matrices, count, showEdges]);

  // R3F only auto-disposes attached geometry on unmount. When the memo swaps
  // in a fresh edge geometry mid-life (every preview update), the previous
  // one's GL buffers would otherwise leak (~64 bytes per voxel per swap).
  React.useEffect(() => {
    if (!edgeGeometry) return;
    return () => edgeGeometry.dispose();
  }, [edgeGeometry]);

  // Push instance matrices into the InstancedMesh on every change.
  React.useEffect(() => {
    if (!meshRef.current) return;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i += 1) {
      const base = i * 16;
      dummy.position.set(matrices[base + 12], matrices[base + 13], matrices[base + 14]);
      dummy.scale.set(matrices[base], matrices[base + 5], matrices[base + 10]);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [matrices, count]);

  if (count === 0) return null;

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, count]}
        renderOrder={7}
        frustumCulled={false}
        raycast={() => null}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial
          color={CAVITY_COLOR}
          emissive={CAVITY_COLOR}
          emissiveIntensity={0.15}
          transparent
          opacity={1.0}
          depthTest
          depthWrite={true}
        />
      </instancedMesh>
      {edgeGeometry && (
      <lineSegments
        ref={edgeRef}
        geometry={edgeGeometry}
        renderOrder={8}
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
