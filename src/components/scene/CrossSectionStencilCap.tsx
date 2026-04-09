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
  minZ?: number;
  maxZ?: number;
};

type CrossSectionStencilCapProps = {
  entries: CrossSectionStencilCapEntry[];
  sourceObject?: THREE.Object3D | null;
  sourceObjectVersion?: unknown;
  skipSourceZBounds?: boolean;
  y: number;
  color?: string;
  planeWidthMm: number;
  planeHeightMm: number;
  visible?: boolean;
  capOpacity?: number;
  capDepthTest?: boolean;
  glowThicknessMm?: number;
  glowOpacity?: number;
  glowColor?: string;
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
  count: number;
  matrixElements: Float32Array;
  minZ: number;
  maxZ: number;
};

type StaticStencilEntry = StaticStencilMeshEntry | StaticStencilInstancedEntry;

type VisibleStaticStencilInstancedEntry = {
  key: string;
  geometry: THREE.BufferGeometry;
  capacity: number;
  matrixElements: Float32Array;
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
  matrixElements,
  backMaterial,
  frontMaterial,
  backRenderOrder,
  frontRenderOrder,
}: {
  geometry: THREE.BufferGeometry;
  capacity: number;
  matrixElements: Float32Array;
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

    const tempMatrix = new THREE.Matrix4();
    for (let i = 0; i < capacity; i += 1) {
      tempMatrix.fromArray(matrixElements, i * 16);
      back.setMatrixAt(i, tempMatrix);
      front.setMatrixAt(i, tempMatrix);
    }

    back.count = capacity;
    front.count = capacity;
    back.instanceMatrix.needsUpdate = true;
    front.instanceMatrix.needsUpdate = true;
  }, [capacity, matrixElements]);

  return (
    <>
      <instancedMesh
        ref={backRef}
        args={[geometry, undefined, capacity]}
        material={backMaterial}
        renderOrder={backRenderOrder}
        frustumCulled={false}
        raycast={() => null}
      />
      <instancedMesh
        ref={frontRef}
        args={[geometry, undefined, capacity]}
        material={frontMaterial}
        renderOrder={frontRenderOrder}
        frustumCulled={false}
        raycast={() => null}
      />
    </>
  );
}

const StaticInstancedStencilPassMemo = React.memo(
  StaticInstancedStencilPass,
  (prev, next) => (
    prev.geometry === next.geometry
    && prev.capacity === next.capacity
    && prev.matrixElements === next.matrixElements
    && prev.backMaterial === next.backMaterial
    && prev.frontMaterial === next.frontMaterial
    && prev.backRenderOrder === next.backRenderOrder
    && prev.frontRenderOrder === next.frontRenderOrder
  ),
);
StaticInstancedStencilPassMemo.displayName = 'StaticInstancedStencilPassMemo';

function ModelStencilPass({
  entry,
  backMaterial,
  frontMaterial,
}: {
  entry: ModelStencilPassEntry;
  backMaterial: THREE.Material;
  frontMaterial: THREE.Material;
}) {
  return (
    <group key={`stencil-cap-${entry.id}`}>
      <group matrix={entry.matrix} matrixAutoUpdate={false}>
        <mesh
          geometry={entry.geometry}
          position={entry.offset}
          material={backMaterial}
          renderOrder={STENCIL_MODEL_BACK_ORDER}
          frustumCulled
          raycast={() => null}
        />
        <mesh
          geometry={entry.geometry}
          position={entry.offset}
          material={frontMaterial}
          renderOrder={STENCIL_MODEL_FRONT_ORDER}
          frustumCulled
          raycast={() => null}
        />
      </group>
    </group>
  );
}

const ModelStencilPassMemo = React.memo(
  ModelStencilPass,
  (prev, next) => (
    prev.entry === next.entry
    && prev.backMaterial === next.backMaterial
    && prev.frontMaterial === next.frontMaterial
  ),
);
ModelStencilPassMemo.displayName = 'ModelStencilPassMemo';

function StaticSingleStencilPass({
  entry,
  backMaterial,
  frontMaterial,
}: {
  entry: StaticStencilMeshEntry;
  backMaterial: THREE.Material;
  frontMaterial: THREE.Material;
}) {
  return (
    <group key={`stencil-source-pass-${entry.key}`}>
      <group matrix={entry.matrix} matrixAutoUpdate={false}>
        <mesh
          geometry={entry.geometry}
          material={backMaterial}
          renderOrder={STENCIL_SOURCE_BACK_ORDER}
          frustumCulled
          raycast={() => null}
        />
        <mesh
          geometry={entry.geometry}
          material={frontMaterial}
          renderOrder={STENCIL_SOURCE_FRONT_ORDER}
          frustumCulled
          raycast={() => null}
        />
      </group>
    </group>
  );
}

const StaticSingleStencilPassMemo = React.memo(
  StaticSingleStencilPass,
  (prev, next) => (
    prev.entry === next.entry
    && prev.backMaterial === next.backMaterial
    && prev.frontMaterial === next.frontMaterial
  ),
);
StaticSingleStencilPassMemo.displayName = 'StaticSingleStencilPassMemo';

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

const worldBoundsScratch = new THREE.Box3();

function getGeometryWorldZBounds(geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4): { min: number; max: number } | null {
  let boundingBox = geometry.boundingBox;
  if (!boundingBox) {
    geometry.computeBoundingBox();
    boundingBox = geometry.boundingBox;
  }

  if (!boundingBox) return null;

  worldBoundsScratch.copy(boundingBox);
  worldBoundsScratch.applyMatrix4(matrixWorld);
  return { min: worldBoundsScratch.min.z, max: worldBoundsScratch.max.z };
}

function composeCenteredGeometryMatrix(matrix: THREE.Matrix4, center: THREE.Vector3): THREE.Matrix4 {
  const centerOffset = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
  return new THREE.Matrix4().multiplyMatrices(matrix, centerOffset);
}

function intersectsMinMaxZ(minZ: number, maxZ: number, clipZ: number): boolean {
  return clipZ >= minZ - 1e-4 && clipZ <= maxZ + 1e-4;
}

const INSTANCED_STENCIL_Z_BUCKET_MM = 6;
const STENCIL_RENDER_ORDER_BASE = 9800;
const STENCIL_MODEL_BACK_ORDER = STENCIL_RENDER_ORDER_BASE + 0.1;
const STENCIL_MODEL_FRONT_ORDER = STENCIL_RENDER_ORDER_BASE + 0.2;
const STENCIL_SOURCE_BACK_ORDER = STENCIL_RENDER_ORDER_BASE + 0.3;
const STENCIL_SOURCE_FRONT_ORDER = STENCIL_RENDER_ORDER_BASE + 0.4;
const STENCIL_GLOW_BACK_ORDER = STENCIL_RENDER_ORDER_BASE + 0.44;
const STENCIL_GLOW_FRONT_ORDER = STENCIL_RENDER_ORDER_BASE + 0.445;
const STENCIL_CAP_ORDER = STENCIL_RENDER_ORDER_BASE + 0.45;

function CrossSectionStencilCapInner({
  entries,
  sourceObject,
  sourceObjectVersion,
  skipSourceZBounds = false,
  y,
  color = '#ffffff',
  planeWidthMm,
  planeHeightMm,
  visible = true,
  capOpacity = 1,
  capDepthTest = true,
  glowThicknessMm = 0,
  glowOpacity = 0,
  glowColor,
}: CrossSectionStencilCapProps) {
  const clipPlaneRef = React.useRef(new THREE.Plane(new THREE.Vector3(0, 0, -1), y));
  
  React.useLayoutEffect(() => {
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
    const resolvedOpacity = Math.max(0, Math.min(1, capOpacity));
    const isOpaqueCap = resolvedOpacity >= 0.999;
    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: !isOpaqueCap,
      opacity: resolvedOpacity,
      // Opaque caps must contribute depth so later transparent passes
      // (e.g. build plate helpers) don't overdraw and make the cap look
      // like it's rendering behind the plate.
      depthWrite: isOpaqueCap,
      depthTest: capDepthTest,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });
    return material;
  }, [capDepthTest, capOpacity, color]);

  const glowPlaneMaterial = React.useMemo(() => {
    if (glowThicknessMm <= 0 || glowOpacity <= 0) return null;

    const material = new THREE.MeshBasicMaterial({
      color: glowColor ?? color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: Math.max(0, Math.min(1, glowOpacity)),
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });

    return material;
  }, [color, glowColor, glowOpacity, glowThicknessMm]);

  // R3F adds/removes meshes from the support group during the commit phase,
  // AFTER React's render phase (where useMemo runs). To avoid traversing a
  // stale group, we gate the traversal on a post-commit counter that is
  // incremented by a useLayoutEffect after each version change. This ensures
  // staticSourceEntries is recomputed on the render that follows the commit
  // in which the scene graph was actually updated.
  const [postCommitTraversalKey, setPostCommitTraversalKey] = React.useState(0);
  React.useLayoutEffect(() => {
    setPostCommitTraversalKey((k) => k + 1);
  }, [sourceObjectVersion]);

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

      const maybeInstancedMesh = mesh as THREE.InstancedMesh;
      if (maybeInstancedMesh.isInstancedMesh && maybeInstancedMesh.count > 0) {
        const initialCount = maybeInstancedMesh.count;
        const matrixElements = new Float32Array(initialCount * 16);
        const minBounds = skipSourceZBounds ? null : new Float32Array(initialCount);
        const maxBounds = skipSourceZBounds ? null : new Float32Array(initialCount);
        let acceptedCount = 0;

        for (let i = 0; i < initialCount; i += 1) {
          maybeInstancedMesh.getMatrixAt(i, instanceMatrix);
          worldInstanceMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
          if (!skipSourceZBounds) {
            const bounds = getGeometryWorldZBounds(geometry, worldInstanceMatrix);
            if (!bounds) continue;
            minBounds![acceptedCount] = bounds.min;
            maxBounds![acceptedCount] = bounds.max;
          }

          worldInstanceMatrix.toArray(matrixElements, acceptedCount * 16);
          acceptedCount += 1;
        }

        if (acceptedCount === 0) return;

        const compactMatrixElements = acceptedCount === initialCount
          ? matrixElements
          : matrixElements.slice(0, acceptedCount * 16);

        const compactMinBounds = minBounds
          ? (acceptedCount === initialCount ? minBounds : minBounds.slice(0, acceptedCount))
          : null;
        const compactMaxBounds = maxBounds
          ? (acceptedCount === initialCount ? maxBounds : maxBounds.slice(0, acceptedCount))
          : null;

        if (skipSourceZBounds) {
          results.push({
            kind: 'instanced',
            key: `${mesh.uuid}:instanced`,
            geometry,
            count: acceptedCount,
            matrixElements: compactMatrixElements,
            minZ: Number.NEGATIVE_INFINITY,
            maxZ: Number.POSITIVE_INFINITY,
          });
          return;
        }

        if (!compactMinBounds || !compactMaxBounds) return;
        const compactMinBoundsSafe = compactMinBounds as Float32Array;
        const compactMaxBoundsSafe = compactMaxBounds as Float32Array;

        const bucketSize = Math.max(0.1, INSTANCED_STENCIL_Z_BUCKET_MM);
        const buckets = new Map<number, {
          matrixValues: number[];
          minZ: number;
          maxZ: number;
          count: number;
        }>();

        for (let instanceIndex = 0; instanceIndex < acceptedCount; instanceIndex += 1) {
          const minZ = compactMinBoundsSafe[instanceIndex];
          const maxZ = compactMaxBoundsSafe[instanceIndex];
          const centerZ = (minZ + maxZ) * 0.5;
          const bucketKey = Math.floor(centerZ / bucketSize);

          let bucket = buckets.get(bucketKey);
          if (!bucket) {
            bucket = {
              matrixValues: [],
              minZ,
              maxZ,
              count: 0,
            };
            buckets.set(bucketKey, bucket);
          }

          bucket.minZ = Math.min(bucket.minZ, minZ);
          bucket.maxZ = Math.max(bucket.maxZ, maxZ);
          bucket.count += 1;

          const matrixOffset = instanceIndex * 16;
          for (let elementIndex = 0; elementIndex < 16; elementIndex += 1) {
            bucket.matrixValues.push(compactMatrixElements[matrixOffset + elementIndex]);
          }
        }

        if (buckets.size <= 1) {
          let minZ = Number.POSITIVE_INFINITY;
          let maxZ = Number.NEGATIVE_INFINITY;
          for (let i = 0; i < acceptedCount; i += 1) {
            minZ = Math.min(minZ, compactMinBoundsSafe[i]);
            maxZ = Math.max(maxZ, compactMaxBoundsSafe[i]);
          }

          results.push({
            kind: 'instanced',
            key: `${mesh.uuid}:instanced`,
            geometry,
            count: acceptedCount,
            matrixElements: compactMatrixElements,
            minZ,
            maxZ,
          });
          return;
        }

        for (const [bucketKey, bucket] of buckets) {
          results.push({
            kind: 'instanced',
            key: `${mesh.uuid}:instanced:zbucket:${bucketKey}`,
            geometry,
            count: bucket.count,
            matrixElements: new Float32Array(bucket.matrixValues),
            minZ: bucket.minZ,
            maxZ: bucket.maxZ,
          });
        }
        return;
      }

      const worldMatrix = mesh.matrixWorld.clone();
      if (skipSourceZBounds) {
        results.push({
          kind: 'single',
          key: mesh.uuid,
          geometry,
          matrix: worldMatrix,
          minZ: Number.NEGATIVE_INFINITY,
          maxZ: Number.POSITIVE_INFINITY,
        });
        return;
      }

      const bounds = getGeometryWorldZBounds(geometry, worldMatrix);
      if (!bounds) return;

      results.push({
        kind: 'single',
        key: mesh.uuid,
        geometry,
        matrix: worldMatrix,
        minZ: bounds.min,
        maxZ: bounds.max,
      });
    });

    return results;
  }, [skipSourceZBounds, sourceObject, postCommitTraversalKey]);

  const modelStencilEntryCacheRef = React.useRef<Map<string, {
    signature: string;
    item: ModelStencilPassEntry;
  }>>(new Map());

  const modelStencilEntries = React.useMemo<ModelStencilPassEntry[]>(() => {
    const cache = modelStencilEntryCacheRef.current;
    const liveIds = new Set<string>();
    const next: ModelStencilPassEntry[] = [];

    for (const entry of entries) {
      liveIds.add(entry.id);
      const { transform, center, geometry, minZ: providedMinZ, maxZ: providedMaxZ } = entry;
      const signature = [
        geometry.uuid,
        center.x.toFixed(5),
        center.y.toFixed(5),
        center.z.toFixed(5),
        transform.position.x.toFixed(5),
        transform.position.y.toFixed(5),
        transform.position.z.toFixed(5),
        transform.rotation.x.toFixed(5),
        transform.rotation.y.toFixed(5),
        transform.rotation.z.toFixed(5),
        transform.scale.x.toFixed(5),
        transform.scale.y.toFixed(5),
        transform.scale.z.toFixed(5),
      ].join('|');

      const cached = cache.get(entry.id);
      if (cached && cached.signature === signature) {
        next.push(cached.item);
        continue;
      }

      const matrix = composeTransformMatrix(transform);
      const worldMatrix = composeCenteredGeometryMatrix(matrix, center);
      const hasProvidedBounds = Number.isFinite(providedMinZ) && Number.isFinite(providedMaxZ);
      const resolvedMinZ = hasProvidedBounds ? Number(providedMinZ) : null;
      const resolvedMaxZ = hasProvidedBounds ? Number(providedMaxZ) : null;

      let minZ = resolvedMinZ;
      let maxZ = resolvedMaxZ;

      if (minZ == null || maxZ == null) {
        const bounds = getGeometryWorldZBounds(geometry, worldMatrix);
        if (!bounds) continue;
        minZ = bounds.min;
        maxZ = bounds.max;
      }

      const rebuilt: ModelStencilPassEntry = {
        id: entry.id,
        geometry,
        matrix,
        offset: new THREE.Vector3(-center.x, -center.y, -center.z),
        minZ,
        maxZ,
      };

      cache.set(entry.id, {
        signature,
        item: rebuilt,
      });
      next.push(rebuilt);
    }

    for (const cachedId of cache.keys()) {
      if (!liveIds.has(cachedId)) {
        cache.delete(cachedId);
      }
    }

    return next;
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

      visibleInstanced.push({
        key: entry.key,
        geometry: entry.geometry,
        capacity: entry.count,
        matrixElements: entry.matrixElements,
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
      glowPlaneMaterial?.dispose();
    };
  }, [capPlaneGeometry, capPlaneMaterial, glowPlaneMaterial, stencilBack, stencilBase, stencilFront]);

  const modelStencilPassNodes = React.useMemo(() => {
    return visibleModelStencilEntries.map((entry) => (
      <ModelStencilPassMemo
        key={`stencil-cap-${entry.id}`}
        entry={entry}
        backMaterial={stencilBack}
        frontMaterial={stencilFront}
      />
    ));
  }, [stencilBack, stencilFront, visibleModelStencilEntries]);

  const staticSingleStencilPassNodes = React.useMemo(() => {
    return visibleStaticSingleEntries.map((entry) => (
      <StaticSingleStencilPassMemo
        key={`stencil-source-pass-${entry.key}`}
        entry={entry}
        backMaterial={stencilBack}
        frontMaterial={stencilFront}
      />
    ));
  }, [stencilBack, stencilFront, visibleStaticSingleEntries]);

  const staticInstancedStencilPassNodes = React.useMemo(() => {
    return visibleStaticInstancedEntries.map((entry) => (
      <StaticInstancedStencilPassMemo
        key={`stencil-source-instanced-pass-${entry.key}`}
        geometry={entry.geometry}
        capacity={entry.capacity}
        matrixElements={entry.matrixElements}
        backMaterial={stencilBack}
        frontMaterial={stencilFront}
        backRenderOrder={STENCIL_SOURCE_BACK_ORDER}
        frontRenderOrder={STENCIL_SOURCE_FRONT_ORDER}
      />
    ));
  }, [stencilBack, stencilFront, visibleStaticInstancedEntries]);

  if (!visible || (visibleModelStencilEntries.length === 0 && !hasVisibleStaticSource)) return null;

  return (
    <group renderOrder={STENCIL_RENDER_ORDER_BASE}>
      {modelStencilPassNodes}

      {staticSingleStencilPassNodes}

      {staticInstancedStencilPassNodes}

      {glowPlaneMaterial && glowThicknessMm > 0 && (
        <>
          <mesh
            geometry={capPlaneGeometry}
            material={glowPlaneMaterial}
            position={[0, 0, y + Math.max(1e-4, glowThicknessMm)]}
            renderOrder={STENCIL_GLOW_BACK_ORDER}
            frustumCulled
            raycast={() => null}
          />
          <mesh
            geometry={capPlaneGeometry}
            material={glowPlaneMaterial}
            position={[0, 0, y - Math.max(1e-4, glowThicknessMm)]}
            renderOrder={STENCIL_GLOW_FRONT_ORDER}
            frustumCulled
            raycast={() => null}
          />
        </>
      )}

      <mesh
        geometry={capPlaneGeometry}
        material={capPlaneMaterial}
        position={[0, 0, y + 1e-4]}
        renderOrder={STENCIL_CAP_ORDER}
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
    && prev.skipSourceZBounds === next.skipSourceZBounds
    && prev.y === next.y
    && prev.color === next.color
    && prev.planeWidthMm === next.planeWidthMm
    && prev.planeHeightMm === next.planeHeightMm
    && prev.visible === next.visible
    && prev.capOpacity === next.capOpacity
    && prev.capDepthTest === next.capDepthTest
    && prev.glowThicknessMm === next.glowThicknessMm
    && prev.glowOpacity === next.glowOpacity
    && prev.glowColor === next.glowColor
  );
};

const CrossSectionStencilCapMemo = React.memo(CrossSectionStencilCapInner, areCrossSectionStencilCapPropsEqual);
CrossSectionStencilCapMemo.displayName = 'CrossSectionStencilCapMemo';

export function CrossSectionStencilCap(props: CrossSectionStencilCapProps) {
  return <CrossSectionStencilCapMemo {...props} />;
}
