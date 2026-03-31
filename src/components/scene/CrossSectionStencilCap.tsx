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
  center: THREE.Vector3;
  matrixWorld: THREE.Matrix4;
};

type StencilZBoundsEntry<T> = {
  item: T;
  minZ: number;
  maxZ: number;
};

function materialContributesToStencil(material: THREE.Material): boolean {
  const mat = material as THREE.Material & {
    opacity?: number;
    transparent?: boolean;
    visible?: boolean;
  };

  if (mat.visible === false) return false;
  if (typeof mat.opacity === 'number' && mat.opacity <= 1e-3) return false;
  return true;
}

function meshContributesToStencil(mesh: THREE.Mesh): boolean {
  if (!mesh.visible) return false;

  const material = mesh.material;
  if (Array.isArray(material)) {
    return material.some((mat) => materialContributesToStencil(mat));
  }

  if (!material) return false;
  return materialContributesToStencil(material);
}

function composeTransformMatrix(transform: ModelTransform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    transform.position,
    quaternionFromGlobalEuler(transform.rotation),
    transform.scale,
  );
}

function getGeometryWorldZBounds(geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4): { min: number; max: number } | null {
  let boundingBox = geometry.boundingBox;
  if (!boundingBox) {
    geometry.computeBoundingBox();
    boundingBox = geometry.boundingBox;
  }

  if (!boundingBox) return null;

  const corners = [
    new THREE.Vector3(boundingBox.min.x, boundingBox.min.y, boundingBox.min.z),
    new THREE.Vector3(boundingBox.min.x, boundingBox.min.y, boundingBox.max.z),
    new THREE.Vector3(boundingBox.min.x, boundingBox.max.y, boundingBox.min.z),
    new THREE.Vector3(boundingBox.min.x, boundingBox.max.y, boundingBox.max.z),
    new THREE.Vector3(boundingBox.max.x, boundingBox.min.y, boundingBox.min.z),
    new THREE.Vector3(boundingBox.max.x, boundingBox.min.y, boundingBox.max.z),
    new THREE.Vector3(boundingBox.max.x, boundingBox.max.y, boundingBox.min.z),
    new THREE.Vector3(boundingBox.max.x, boundingBox.max.y, boundingBox.max.z),
  ];

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const corner of corners) {
    corner.applyMatrix4(matrixWorld);
    min = Math.min(min, corner.z);
    max = Math.max(max, corner.z);
  }

  return { min, max };
}

function composeCenteredGeometryMatrix(matrix: THREE.Matrix4, center: THREE.Vector3): THREE.Matrix4 {
  const centerOffset = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
  return new THREE.Matrix4().multiplyMatrices(matrix, centerOffset);
}

function getGeometryCenter(geometry: THREE.BufferGeometry): THREE.Vector3 {
  let boundingSphere = geometry.boundingSphere;
  if (!boundingSphere) {
    geometry.computeBoundingSphere();
    boundingSphere = geometry.boundingSphere;
  }

  if (boundingSphere) {
    return boundingSphere.center.clone();
  }

  let boundingBox = geometry.boundingBox;
  if (!boundingBox) {
    geometry.computeBoundingBox();
    boundingBox = geometry.boundingBox;
  }

  if (boundingBox) {
    return boundingBox.getCenter(new THREE.Vector3());
  }

  return new THREE.Vector3();
}

function intersectsClipPlaneAtZ(bounds: { min: number; max: number } | null, clipZ: number): boolean {
  if (!bounds) return false;
  return clipZ >= bounds.min - 1e-4 && clipZ <= bounds.max + 1e-4;
}

function intersectsMinMaxZ(minZ: number, maxZ: number, clipZ: number): boolean {
  return clipZ >= minZ - 1e-4 && clipZ <= maxZ + 1e-4;
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
      if (!meshContributesToStencil(mesh)) return;
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geometry || !geometry.getAttribute('position')) return;

      const maybeInstancedMesh = mesh as THREE.InstancedMesh;
      if (maybeInstancedMesh.isInstancedMesh && maybeInstancedMesh.count > 0) {
        const center = getGeometryCenter(geometry);
        for (let i = 0; i < maybeInstancedMesh.count; i += 1) {
          maybeInstancedMesh.getMatrixAt(i, instanceMatrix);
          worldInstanceMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
          results.push({
            key: `${mesh.uuid}:inst:${i}`,
            geometry,
            center,
            matrixWorld: worldInstanceMatrix.clone(),
          });
        }
        return;
      }

      results.push({
        key: mesh.uuid,
        geometry,
        center: getGeometryCenter(geometry),
        matrixWorld: mesh.matrixWorld.clone(),
      });
    });

    return results;
  }, [sourceObject, sourceObjectVersion]);

  const entryBounds = React.useMemo(() => {
    return entries.map<StencilZBoundsEntry<CrossSectionStencilCapEntry> | null>((entry) => {
      const worldMatrix = composeCenteredGeometryMatrix(composeTransformMatrix(entry.transform), entry.center);
      const bounds = getGeometryWorldZBounds(entry.geometry, worldMatrix);
      if (!bounds) return null;
      return {
        item: entry,
        minZ: bounds.min,
        maxZ: bounds.max,
      };
    }).filter((entry): entry is StencilZBoundsEntry<CrossSectionStencilCapEntry> => entry !== null);
  }, [entries]);

  const visibleEntries = React.useMemo(() => {
    return entryBounds
      .filter((entry) => intersectsMinMaxZ(entry.minZ, entry.maxZ, y))
      .map((entry) => entry.item);
  }, [entryBounds, y]);

  const staticSourceBounds = React.useMemo(() => {
    return staticSourceMeshes.map<StencilZBoundsEntry<StaticStencilMeshEntry> | null>((entry) => {
      const bounds = getGeometryWorldZBounds(
        entry.geometry,
        composeCenteredGeometryMatrix(entry.matrixWorld, entry.center),
      );
      if (!bounds) return null;
      return {
        item: entry,
        minZ: bounds.min,
        maxZ: bounds.max,
      };
    }).filter((entry): entry is StencilZBoundsEntry<StaticStencilMeshEntry> => entry !== null);
  }, [staticSourceMeshes]);

  const visibleStaticSourceMeshes = React.useMemo(() => {
    return staticSourceBounds
      .filter((entry) => intersectsMinMaxZ(entry.minZ, entry.maxZ, y))
      .map((entry) => entry.item);
  }, [staticSourceBounds, y]);

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

            <mesh
              geometry={capPlaneGeometry}
              material={capPlaneMaterial}
              position={[0, 0, y + 1e-4]}
              renderOrder={990.25}
              frustumCulled={false}
              raycast={() => null}
              onAfterRender={(renderer) => {
                (renderer as THREE.WebGLRenderer).clearStencil();
              }}
            />
          </group>
        );
      })}

      {visibleStaticSourceMeshes.map((entry) => (
        <group key={`stencil-source-pass-${entry.key}`}>
          <group matrix={composeCenteredGeometryMatrix(entry.matrixWorld, entry.center)} matrixAutoUpdate={false}>
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

          <mesh
            geometry={capPlaneGeometry}
            material={capPlaneMaterial}
            position={[0, 0, y + 1e-4]}
            renderOrder={990.45}
            frustumCulled={false}
            raycast={() => null}
            onAfterRender={(renderer) => {
              (renderer as THREE.WebGLRenderer).clearStencil();
            }}
          />
        </group>
      ))}
    </group>
  );
}
