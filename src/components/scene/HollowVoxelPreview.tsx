import React from 'react';
import * as THREE from 'three';

type HollowVoxelPreviewProps = {
  voxelCenters: Float32Array;
  voxelSizeMm: number;
  meshOffset: THREE.Vector3;
};

const CAVITY_COLOR = '#66ecff';
const EDGE_COLOR = '#000000';

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
  const matrices = new Float32Array(count * 16);
  const scale = voxelSizeMm;
  for (let i = 0; i < count; i += 1) {
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

function buildEdgePositions(
  voxelCenters: Float32Array,
  voxelSizeMm: number,
  offsetX: number,
  offsetY: number,
  offsetZ: number,
): Float32Array {
  const count = Math.floor(voxelCenters.length / 3);
  const half = voxelSizeMm * 0.5;
  const out = new Float32Array(count * 24 * 3); // 24 vertices per cube
  for (let i = 0; i < count; i += 1) {
    const base = i * 3;
    const cx = voxelCenters[base] + offsetX;
    const cy = voxelCenters[base + 1] + offsetY;
    const cz = voxelCenters[base + 2] + offsetZ;
    const vo = i * 72;
    for (let v = 0; v < 72; v += 3) {
      out[vo + v]     = cx + CUBE_EDGE_VERTICES[v]     * voxelSizeMm;
      out[vo + v + 1] = cy + CUBE_EDGE_VERTICES[v + 1] * voxelSizeMm;
      out[vo + v + 2] = cz + CUBE_EDGE_VERTICES[v + 2] * voxelSizeMm;
    }
  }
  return out;
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
  const count = Math.floor(voxelCenters.length / 3);

  const matrices = React.useMemo(() => {
    return buildInstanceMatrices(
      voxelCenters,
      voxelSizeMm,
      meshOffset.x,
      meshOffset.y,
      meshOffset.z,
    );
  }, [voxelCenters, voxelSizeMm, meshOffset.x, meshOffset.y, meshOffset.z]);

  // Edge geometry: single LineSegments with all cube edges baked in world space.
  const edgeGeometry = React.useMemo(() => {
    const edgePos = buildEdgePositions(
      voxelCenters,
      voxelSizeMm,
      meshOffset.x,
      meshOffset.y,
      meshOffset.z,
    );
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(edgePos, 3));
    return geom;
  }, [voxelCenters, voxelSizeMm, meshOffset.x, meshOffset.y, meshOffset.z]);

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
      <lineSegments
        ref={edgeRef}
        geometry={edgeGeometry}
        renderOrder={8}
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
