"use client";

import React from 'react';
import * as THREE from 'three';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

export type CrossSectionStencilCapEntry = {
  id: string;
  geometry: THREE.BufferGeometry;
  center: THREE.Vector3;
  transform: ModelTransform;
};

type StaticStencilMeshEntry = {
  key: string;
  geometry: THREE.BufferGeometry;
  matrixWorld: THREE.Matrix4;
};

function composeTransformMatrix(transform: ModelTransform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    transform.position,
    quaternionFromGlobalEuler(transform.rotation),
    transform.scale,
  );
}

function geometryIntersectsClipPlaneAtZ(geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4, clipZ: number): boolean {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!position || position.count < 3) return false;

  const zSlice = clipZ + 1e-5;
  const EPS = 1e-9;

  for (let i = 0; i < position.count; i += 3) {
    const v0 = new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(matrixWorld);
    const v1 = new THREE.Vector3(position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1)).applyMatrix4(matrixWorld);
    const v2 = new THREE.Vector3(position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2)).applyMatrix4(matrixWorld);

    const above = [v0.z >= zSlice + 10 * EPS, v1.z >= zSlice + 10 * EPS, v2.z >= zSlice + 10 * EPS];
    const below = [v0.z <= zSlice - 10 * EPS, v1.z <= zSlice - 10 * EPS, v2.z <= zSlice - 10 * EPS];

    if (!((above[0] && above[1] && above[2]) || (below[0] && below[1] && below[2]))) {
      return true;
    }
  }

  return false;
}

export function CrossSectionStencilCap({
  entries,
  sourceObject,
  sourceObjectVersion,
  y,
  color = '#ffffff',
  planeWidthMm,
  planeHeightMm,
  visible = true,
}: {
  entries: CrossSectionStencilCapEntry[];
  sourceObject?: THREE.Object3D | null;
  sourceObjectVersion?: number;
  y: number;
  color?: string;
  planeWidthMm: number;
  planeHeightMm: number;
  visible?: boolean;
}) {
  const clipPlaneRef = React.useRef(new THREE.Plane(new THREE.Vector3(0, 0, -1), y));
  
  React.useEffect(() => {
    clipPlaneRef.current.constant = y;
  }, [y]);

  const stencilBase = React.useMemo(() => {
    const material = new THREE.MeshBasicMaterial();
    material.depthWrite = false;
    material.depthTest = false;
    material.colorWrite = false;
    material.stencilWrite = true;
    material.stencilFunc = THREE.AlwaysStencilFunc;
    return material;
  }, []);

  const stencilBack = React.useMemo(() => {
    const material = stencilBase.clone();
    material.side = THREE.BackSide;
    material.clippingPlanes = [clipPlaneRef.current];
    material.stencilFail = THREE.IncrementWrapStencilOp;
    material.stencilZFail = THREE.IncrementWrapStencilOp;
    material.stencilZPass = THREE.IncrementWrapStencilOp;
    return material;
  }, [stencilBase]);

  const stencilFront = React.useMemo(() => {
    const material = stencilBase.clone();
    material.side = THREE.FrontSide;
    material.clippingPlanes = [clipPlaneRef.current];
    material.stencilFail = THREE.DecrementWrapStencilOp;
    material.stencilZFail = THREE.DecrementWrapStencilOp;
    material.stencilZPass = THREE.DecrementWrapStencilOp;
    return material;
  }, [stencilBase]);

  const capPlaneGeometry = React.useMemo(() => {
    return new THREE.PlaneGeometry(
      Math.max(1, planeWidthMm),
      Math.max(1, planeHeightMm),
    );
  }, [planeHeightMm, planeWidthMm]);

  const capPlaneMaterial = React.useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    return material;
  }, [color]);

  const staticSourceMeshes = React.useMemo<StaticStencilMeshEntry[]>(() => {
    if (!sourceObject) return [];

    const results: StaticStencilMeshEntry[] = [];
    const instanceMatrix = new THREE.Matrix4();
    const worldInstanceMatrix = new THREE.Matrix4();

    sourceObject.updateWorldMatrix(true, true);
    sourceObject.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh?.isMesh) return;
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geometry || !geometry.getAttribute('position')) return;

      const maybeInstancedMesh = mesh as THREE.InstancedMesh;
      if (maybeInstancedMesh.isInstancedMesh && maybeInstancedMesh.count > 0) {
        for (let i = 0; i < maybeInstancedMesh.count; i += 1) {
          maybeInstancedMesh.getMatrixAt(i, instanceMatrix);
          worldInstanceMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
          results.push({
            key: `${mesh.uuid}:inst:${i}`,
            geometry,
            matrixWorld: worldInstanceMatrix.clone(),
          });
        }
        return;
      }

      results.push({
        key: mesh.uuid,
        geometry,
        matrixWorld: mesh.matrixWorld.clone(),
      });
    });

    return results;
  }, [sourceObject, sourceObjectVersion]);

  const visibleEntries = React.useMemo(() => {
    return entries.filter((entry) => {
      return geometryIntersectsClipPlaneAtZ(entry.geometry, composeTransformMatrix(entry.transform), y);
    });
  }, [entries, y]);

  const visibleStaticSourceMeshes = React.useMemo(() => {
    return staticSourceMeshes.filter((entry) => {
      return geometryIntersectsClipPlaneAtZ(entry.geometry, entry.matrixWorld, y);
    });
  }, [staticSourceMeshes, y]);

  React.useEffect(() => {
    return () => {
      stencilBase.dispose();
      stencilBack.dispose();
      stencilFront.dispose();
      capPlaneGeometry.dispose();
      capPlaneMaterial.dispose();
    };
  }, [capPlaneGeometry, capPlaneMaterial, stencilBack, stencilBase, stencilFront]);

  if (!visible || (visibleEntries.length === 0 && visibleStaticSourceMeshes.length === 0)) return null;

  return (
    <group renderOrder={990}>
      {visibleEntries.map((entry) => {
        const matrix = composeTransformMatrix(entry.transform);
        const offset = new THREE.Vector3(-entry.center.x, -entry.center.y, -entry.center.z);

        return (
          <group key={`stencil-cap-${entry.id}`}>
            <group matrix={matrix} matrixAutoUpdate={false}>
              <mesh
                geometry={entry.geometry}
                position={offset}
                material={stencilBack}
                renderOrder={990.1}
                frustumCulled={false}
                raycast={() => null}
              />
              <mesh
                geometry={entry.geometry}
                position={offset}
                material={stencilFront}
                renderOrder={990.2}
                frustumCulled={false}
                raycast={() => null}
              />
            </group>
          </group>
        );
      })}

      {visibleStaticSourceMeshes.map((entry) => (
        <group key={`stencil-source-pass-${entry.key}`}>
          <group matrix={entry.matrixWorld} matrixAutoUpdate={false}>
            <mesh
              geometry={entry.geometry}
              material={stencilBack}
              renderOrder={990.3}
              frustumCulled={false}
              raycast={() => null}
            />
            <mesh
              geometry={entry.geometry}
              material={stencilFront}
              renderOrder={990.4}
              frustumCulled={false}
              raycast={() => null}
            />
          </group>
        </group>
      ))}

      <mesh
        geometry={capPlaneGeometry}
        material={capPlaneMaterial}
        position={[0, 0, y + 1e-4]}
        renderOrder={990.9}
        frustumCulled={false}
        raycast={() => null}
        onAfterRender={(renderer) => {
          (renderer as THREE.WebGLRenderer).clearStencil();
        }}
      />
    </group>
  );
}
