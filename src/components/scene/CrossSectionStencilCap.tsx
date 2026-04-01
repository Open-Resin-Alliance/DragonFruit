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

type CrossSectionStencilCapProps = {
  entries: CrossSectionStencilCapEntry[];
  sourceObject?: THREE.Object3D | null;
  sourceObjectVersion?: number;
  y: number;
  color?: string;
  planeWidthMm: number;
  planeHeightMm: number;
  visible?: boolean;
};

type StaticStencilMeshEntry = {
  kind: 'single';
  key: string;
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  minZ: number;
  maxZ: number;
};

type StaticStencilInstancedEntry = {
  kind: 'instanced';
  key: string;
  geometry: THREE.BufferGeometry;
  matrices: THREE.Matrix4[];
  minZByInstance: number[];
  maxZByInstance: number[];
  minZ: number;
  maxZ: number;
};

type StaticStencilEntry = StaticStencilMeshEntry | StaticStencilInstancedEntry;

type VisibleStaticStencilInstancedEntry = {
  key: string;
  geometry: THREE.BufferGeometry;
  capacity: number;
  matrices: THREE.Matrix4[];
};

type StencilZBoundsEntry<T> = {
  item: T;
  minZ: number;
  maxZ: number;
};

type ModelStencilPassEntry = {
  id: string;
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  offset: THREE.Vector3;
  minZ: number;
  maxZ: number;
};

function StaticInstancedStencilPass({
  geometry,
  capacity,
  matrices,
  backMaterial,
  frontMaterial,
  backRenderOrder,
  frontRenderOrder,
}: {
  geometry: THREE.BufferGeometry;
  capacity: number;
  matrices: THREE.Matrix4[];
  backMaterial: THREE.Material;
  frontMaterial: THREE.Material;
  backRenderOrder: number;
  frontRenderOrder: number;
}) {
  const backRef = React.useRef<THREE.InstancedMesh>(null);
  const frontRef = React.useRef<THREE.InstancedMesh>(null);

  React.useLayoutEffect(() => {
    const back = backRef.current;
    const front = frontRef.current;
    if (!back || !front) return;

    for (let i = 0; i < matrices.length; i += 1) {
      const matrix = matrices[i];
      back.setMatrixAt(i, matrix);
      front.setMatrixAt(i, matrix);
    }

    back.count = matrices.length;
    front.count = matrices.length;
    back.instanceMatrix.needsUpdate = true;
    front.instanceMatrix.needsUpdate = true;
    (back as THREE.InstancedMesh & { computeBoundingSphere?: () => void }).computeBoundingSphere?.();
    (front as THREE.InstancedMesh & { computeBoundingSphere?: () => void }).computeBoundingSphere?.();
  }, [matrices]);

  if (matrices.length === 0) return null;

  return (
    <>
      <instancedMesh
        ref={backRef}
        args={[geometry, undefined, capacity]}
        material={backMaterial}
        renderOrder={backRenderOrder}
        frustumCulled
        raycast={() => null}
      />
      <instancedMesh
        ref={frontRef}
        args={[geometry, undefined, capacity]}
        material={frontMaterial}
        renderOrder={frontRenderOrder}
        frustumCulled
        raycast={() => null}
      />
    </>
  );
}

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

function intersectsMinMaxZ(minZ: number, maxZ: number, clipZ: number): boolean {
  return clipZ >= minZ - 1e-4 && clipZ <= maxZ + 1e-4;
}

function CrossSectionStencilCapInner({
  entries,
  sourceObject,
  sourceObjectVersion,
  y,
  color = '#ffffff',
  planeWidthMm,
  planeHeightMm,
  visible = true,
}: CrossSectionStencilCapProps) {
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

  const staticSourceEntries = React.useMemo<StaticStencilEntry[]>(() => {
    if (!sourceObject) return [];

    const results: StaticStencilEntry[] = [];
    const instanceMatrix = new THREE.Matrix4();
    const worldInstanceMatrix = new THREE.Matrix4();

    sourceObject.updateWorldMatrix(true, true);
    sourceObject.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh?.isMesh) return;
      if (!meshContributesToStencil(mesh)) return;
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geometry || !geometry.getAttribute('position')) return;

      const center = getGeometryCenter(geometry);

      const maybeInstancedMesh = mesh as THREE.InstancedMesh;
      if (maybeInstancedMesh.isInstancedMesh && maybeInstancedMesh.count > 0) {
        const matrices: THREE.Matrix4[] = [];
        const minZByInstance: number[] = [];
        const maxZByInstance: number[] = [];
        let minZ = Number.POSITIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;

        for (let i = 0; i < maybeInstancedMesh.count; i += 1) {
          maybeInstancedMesh.getMatrixAt(i, instanceMatrix);
          worldInstanceMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
          const centeredMatrix = composeCenteredGeometryMatrix(worldInstanceMatrix, center);
          const bounds = getGeometryWorldZBounds(geometry, centeredMatrix);
          if (!bounds) continue;

          matrices.push(centeredMatrix);
          minZByInstance.push(bounds.min);
          maxZByInstance.push(bounds.max);
          minZ = Math.min(minZ, bounds.min);
          maxZ = Math.max(maxZ, bounds.max);
        }

        if (matrices.length === 0) return;

        results.push({
          kind: 'instanced',
          key: `${mesh.uuid}:instanced`,
          geometry,
          matrices,
          minZByInstance,
          maxZByInstance,
          minZ,
          maxZ,
        });
        return;
      }

      const centeredMatrix = composeCenteredGeometryMatrix(mesh.matrixWorld, center);
      const bounds = getGeometryWorldZBounds(geometry, centeredMatrix);
      if (!bounds) return;

      results.push({
        kind: 'single',
        key: mesh.uuid,
        geometry,
        matrix: centeredMatrix,
        minZ: bounds.min,
        maxZ: bounds.max,
      });
    });

    return results;
  }, [sourceObject, sourceObjectVersion]);

  const modelStencilEntries = React.useMemo(() => {
    return entries.map<ModelStencilPassEntry | null>((entry) => {
      const matrix = composeTransformMatrix(entry.transform);
      const worldMatrix = composeCenteredGeometryMatrix(matrix, entry.center);
      const bounds = getGeometryWorldZBounds(entry.geometry, worldMatrix);
      if (!bounds) return null;
      return {
        id: entry.id,
        geometry: entry.geometry,
        matrix,
        offset: new THREE.Vector3(-entry.center.x, -entry.center.y, -entry.center.z),
        minZ: bounds.min,
        maxZ: bounds.max,
      };
    }).filter((entry): entry is ModelStencilPassEntry => entry !== null);
  }, [entries]);

  const visibleModelStencilEntries = React.useMemo(() => {
    return modelStencilEntries.filter((entry) => intersectsMinMaxZ(entry.minZ, entry.maxZ, y));
  }, [modelStencilEntries, y]);

  const visibleStaticSingleEntries = React.useMemo(() => {
    const visibleSingles: StaticStencilMeshEntry[] = [];
    for (const entry of staticSourceEntries) {
      if (entry.kind !== 'single') continue;
      if (!intersectsMinMaxZ(entry.minZ, entry.maxZ, y)) continue;
      visibleSingles.push(entry);
    }
    return visibleSingles;
  }, [staticSourceEntries, y]);

  const visibleStaticInstancedEntries = React.useMemo<VisibleStaticStencilInstancedEntry[]>(() => {
    const visibleInstanced: VisibleStaticStencilInstancedEntry[] = [];

    for (const entry of staticSourceEntries) {
      if (entry.kind !== 'instanced') continue;
      if (!intersectsMinMaxZ(entry.minZ, entry.maxZ, y)) continue;

      const matrices: THREE.Matrix4[] = [];
      for (let i = 0; i < entry.matrices.length; i += 1) {
        if (!intersectsMinMaxZ(entry.minZByInstance[i], entry.maxZByInstance[i], y)) continue;
        matrices.push(entry.matrices[i]);
      }

      if (matrices.length === 0) continue;

      visibleInstanced.push({
        key: entry.key,
        geometry: entry.geometry,
        capacity: entry.matrices.length,
        matrices,
      });
    }

    return visibleInstanced;
  }, [staticSourceEntries, y]);

  const hasVisibleStaticSource = visibleStaticSingleEntries.length > 0 || visibleStaticInstancedEntries.length > 0;

  React.useEffect(() => {
    return () => {
      stencilBase.dispose();
      stencilBack.dispose();
      stencilFront.dispose();
      capPlaneGeometry.dispose();
      capPlaneMaterial.dispose();
    };
  }, [capPlaneGeometry, capPlaneMaterial, stencilBack, stencilBase, stencilFront]);

  const modelStencilPassNodes = React.useMemo(() => {
    return visibleModelStencilEntries.map((entry) => (
      <group key={`stencil-cap-${entry.id}`}>
        <group matrix={entry.matrix} matrixAutoUpdate={false}>
          <mesh
            geometry={entry.geometry}
            position={entry.offset}
            material={stencilBack}
            renderOrder={990.1}
            frustumCulled
            raycast={() => null}
          />
          <mesh
            geometry={entry.geometry}
            position={entry.offset}
            material={stencilFront}
            renderOrder={990.2}
            frustumCulled
            raycast={() => null}
          />
        </group>
      </group>
    ));
  }, [stencilBack, stencilFront, visibleModelStencilEntries]);

  const staticSingleStencilPassNodes = React.useMemo(() => {
    return visibleStaticSingleEntries.map((entry) => (
      <group key={`stencil-source-pass-${entry.key}`}>
        <group matrix={entry.matrix} matrixAutoUpdate={false}>
          <mesh
            geometry={entry.geometry}
            material={stencilBack}
            renderOrder={990.3}
            frustumCulled
            raycast={() => null}
          />
          <mesh
            geometry={entry.geometry}
            material={stencilFront}
            renderOrder={990.4}
            frustumCulled
            raycast={() => null}
          />
        </group>
      </group>
    ));
  }, [stencilBack, stencilFront, visibleStaticSingleEntries]);

  const staticInstancedStencilPassNodes = React.useMemo(() => {
    return visibleStaticInstancedEntries.map((entry) => (
      <StaticInstancedStencilPass
        key={`stencil-source-instanced-pass-${entry.key}`}
        geometry={entry.geometry}
        capacity={entry.capacity}
        matrices={entry.matrices}
        backMaterial={stencilBack}
        frontMaterial={stencilFront}
        backRenderOrder={990.3}
        frontRenderOrder={990.4}
      />
    ));
  }, [stencilBack, stencilFront, visibleStaticInstancedEntries]);

  if (!visible || (visibleModelStencilEntries.length === 0 && !hasVisibleStaticSource)) return null;

  return (
    <group renderOrder={990}>
      {modelStencilPassNodes}

      {staticSingleStencilPassNodes}

      {staticInstancedStencilPassNodes}

      <mesh
        geometry={capPlaneGeometry}
        material={capPlaneMaterial}
        position={[0, 0, y + 1e-4]}
        renderOrder={990.45}
        frustumCulled
        raycast={() => null}
        onAfterRender={(renderer) => {
          (renderer as THREE.WebGLRenderer).clearStencil();
        }}
      />
    </group>
  );
}

const areCrossSectionStencilCapPropsEqual = (
  prev: Readonly<CrossSectionStencilCapProps>,
  next: Readonly<CrossSectionStencilCapProps>,
) => {
  return (
    prev.entries === next.entries
    && prev.sourceObject === next.sourceObject
    && prev.sourceObjectVersion === next.sourceObjectVersion
    && prev.y === next.y
    && prev.color === next.color
    && prev.planeWidthMm === next.planeWidthMm
    && prev.planeHeightMm === next.planeHeightMm
    && prev.visible === next.visible
  );
};

const CrossSectionStencilCapMemo = React.memo(CrossSectionStencilCapInner, areCrossSectionStencilCapPropsEqual);
CrossSectionStencilCapMemo.displayName = 'CrossSectionStencilCapMemo';

export function CrossSectionStencilCap(props: CrossSectionStencilCapProps) {
  return <CrossSectionStencilCapMemo {...props} />;
}
