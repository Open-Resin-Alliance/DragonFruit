"use client";

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';

import { noteActivity } from '@/utils/debug/heartbeatContext';
import {
  buildProxyHoverIndex,
  createProxyHoverRaycast,
  type ProxyHoverTarget,
} from '../proxyHoverIndex';
import { ROOT_RENDER_LIFT_MM } from '../SupportPrimitives/Roots/InstancedRootsGroup';
import { createInstancedStandardMaterial, syncInstancedStandardMaterialState } from './instancedStandardMaterial';
import {
  applyRootSlotStateChanges,
  computeRootSlotStates,
  diffRootSlotStates,
  ROOT_DISK_BATCH_KEY,
  ROOT_SPHERE_BATCH_KEY,
  writeAllRootSlots,
  type InstancedRootVisualState,
} from './rootSlotBatch';
import type { RootBatchSlot, RootSlotIndex, RootSlotRecord } from './rootSlots';
import { SupportInstanceBatch } from './supportInstanceBatch';

/** Registry name for this program; keep it distinct from every other material. */
const INSTANCED_ROOT_PROGRAM_KEY = 'df-instanced-root';

/** The legacy templates, verbatim: `CylinderGeometry(…, 10)` and `SphereGeometry(1, 8, 6)`. */
const ROOT_RADIAL_SEGMENTS = 10;
const SPHERE_WIDTH_SEGMENTS = 8;
const SPHERE_HEIGHT_SEGMENTS = 6;

/** Stable empty marquee list, so an unset prop does not re-run the state diff. */
const NO_SUPPORT_IDS: readonly string[] = [];

export interface InstancedRootBatchProps {
  /** Unselected supports' plate roots, in the producer's draw order; `id` = slot. */
  index: RootSlotIndex;
  /** Support whose root draws in the hover state, or null. */
  hoveredSupportId?: string | null;
  /** Supports past the first marquee hover: the bulk colour, as the overlay did. */
  marqueeSupportIds?: readonly string[];
  /**
   * The cross-section planes, passed down rather than left to the parent's
   * traversal: a batch material mounted a commit after that traversal ran would
   * draw unclipped until the next dependency change.
   */
  clippingPlanes?: THREE.Plane[] | null;
  /** Ghost pass: translucent, no depth write, exactly as the parent sets it. */
  transparent?: boolean;
  opacity?: number;
  /** The render order the parent's ghost traversal applies to every mesh. */
  renderOrder?: number;
  onRootClick?: (root: RootBatchSlot, event: ThreeEvent<MouseEvent>) => void;
  onRootPointerMove?: (root: RootBatchSlot, event: ThreeEvent<PointerEvent>) => void;
  onRootPointerOut?: (root: RootBatchSlot | null, event: ThreeEvent<PointerEvent>) => void;
}

/** One capacity batch: the geometry it draws and the material it draws with. */
type RootBatchResource = {
  batch: SupportInstanceBatch;
  material: THREE.MeshStandardMaterial;
  /** The cone geometry's quantized ratio; 1 for the two fixed primitives. */
  ratio: number;
};

type RootBatchStructure = {
  disks: RootBatchResource;
  spheres: RootBatchResource;
  buckets: ReadonlyMap<string, RootBatchResource>;
};

function createRootBatchResource(
  geometry: THREE.BufferGeometry,
  capacity: number,
  ratio: number,
): RootBatchResource {
  // The batch copies the template's index, positions and normals, so the
  // template itself is disposable straight away.
  const batch = new SupportInstanceBatch(geometry, Math.max(1, capacity));
  geometry.dispose();
  return { batch, material: createInstancedStandardMaterial(INSTANCED_ROOT_PROGRAM_KEY), ratio };
}

function disposeRootBatchResource(resource: RootBatchResource): void {
  resource.batch.dispose();
  resource.material.dispose();
}

/**
 * One disk mesh: the only root mesh with a pointer index.
 *
 * The legacy group made exactly the disk pickable and left the base cone and the
 * top ball `raycast={() => null}`, so indexing the whole silhouette here would
 * let a root's cone and ball swallow pointer events the plate owns. Tolerance 0:
 * Support mode has never given roots a grab radius. The segment is the drawn
 * disk — lifted off the plate with the rest of the stack — as a capsule, so it
 * over-hits by about a radius past the plate contact where three tested the
 * cylinder's caps exactly.
 */
function RootDiskMesh({
  resource,
  records,
  renderOrder,
  onRootClick,
  onRootPointerMove,
  onRootPointerOut,
}: {
  resource: RootBatchResource;
  records: readonly RootSlotRecord[];
  renderOrder: number;
  onRootClick?: (root: RootBatchSlot, event: ThreeEvent<MouseEvent>) => void;
  onRootPointerMove?: (root: RootBatchSlot, event: ThreeEvent<PointerEvent>) => void;
  onRootPointerOut?: (root: RootBatchSlot | null, event: ThreeEvent<PointerEvent>) => void;
}) {
  const lastHoveredRootRef = useRef<RootBatchSlot | null>(null);

  const raycast = useMemo(() => {
    const targets: ProxyHoverTarget[] = records.map((record) => {
      const { slot } = record;
      const baseZ = slot.basePos.z + ROOT_RENDER_LIFT_MM;
      return {
        ...(slot.modelId !== undefined ? { modelId: slot.modelId } : {}),
        index: record.diskInstance,
        start: { x: slot.basePos.x, y: slot.basePos.y, z: baseZ },
        end: { x: slot.basePos.x, y: slot.basePos.y, z: baseZ + slot.diskHeight },
        radius: Math.max(0.001, slot.bottomRadius),
      };
    });

    const hoverIndex = buildProxyHoverIndex(targets);
    return hoverIndex ? createProxyHoverRaycast(hoverIndex, () => 0) : () => {};
  }, [records]);

  const resolveRoot = (instanceId: number | undefined | null): RootBatchSlot | null => (
    instanceId == null ? null : records[instanceId]?.slot ?? null
  );

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (!onRootClick) return;
    event.stopPropagation();
    const root = resolveRoot(event.instanceId);
    if (!root) return;
    onRootClick(root, event);
  };

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!onRootPointerMove) return;
    event.stopPropagation();
    const root = resolveRoot(event.instanceId);
    if (!root) return;
    lastHoveredRootRef.current = root;
    onRootPointerMove(root, event);
  };

  const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
    if (!onRootPointerOut) return;
    event.stopPropagation();
    onRootPointerOut(lastHoveredRootRef.current, event);
    lastHoveredRootRef.current = null;
  };

  return (
    <mesh
      geometry={resource.batch.geometry}
      material={resource.material}
      // Instances move without the unit cylinder's bounds changing, so the
      // geometry's own sphere cannot answer a frustum test.
      frustumCulled={false}
      renderOrder={renderOrder}
      visible={records.length > 0}
      raycast={raycast}
      onClick={onRootClick ? handleClick : undefined}
      onPointerMove={onRootPointerMove ? handlePointerMove : undefined}
      onPointerOut={onRootPointerOut ? handlePointerOut : undefined}
    />
  );
}

/**
 * One inert root primitive: the base cone or the top ball.
 *
 * Both are the legacy group's `raycast={() => null}` meshes — a root answers the
 * pointer from its disk alone — so this is a no-op rather than the shared
 * `INSTANCED_MESH_RAYCAST`, which reads an `InstancedMesh`-only field and throws
 * on a plain mesh.
 */
function RootPrimitiveMesh({
  resource,
  instanceCount,
  renderOrder,
}: {
  resource: RootBatchResource;
  instanceCount: number;
  renderOrder: number;
}) {
  return (
    <mesh
      geometry={resource.batch.geometry}
      material={resource.material}
      frustumCulled={false}
      renderOrder={renderOrder}
      visible={instanceCount > 0}
      raycast={() => null}
    />
  );
}

/**
 * Every unselected plate root in Support mode, as one draw per quantized cone
 * ratio plus one disk batch and one top-ball batch.
 *
 * The batches are capacity-managed and mounted once per shape: a support
 * appearing, a selection change or a hover only rewrites attributes, never the
 * mesh, so neither the GPU pick registration nor the material traversal has to
 * re-see it. A new *ratio* is the one structural change: it creates one cone
 * batch and disposes any bucket the slot list no longer names.
 *
 * The hover/marquee highlight is a per-instance colour and, unlike joints and
 * shafts, there is no matrix scale: the legacy overlay drew the same root at the
 * same transform.
 */
export function InstancedRootBatch({
  index,
  hoveredSupportId = null,
  marqueeSupportIds,
  clippingPlanes = null,
  transparent = false,
  opacity = 1,
  renderOrder = 100000,
  onRootClick,
  onRootPointerMove,
  onRootPointerOut,
}: InstancedRootBatchProps) {
  const [structure, setStructure] = useState<RootBatchStructure | null>(null);
  const structureRef = useRef<RootBatchStructure | null>(null);
  const appliedStatesRef = useRef<Map<number, InstancedRootVisualState>>(new Map());

  // The count this batch first saw is only a capacity hint: growth reallocates
  // the attributes in place, so the mesh never depends on it again.
  const initialDiskCapacityRef = useRef(index.disks.length);
  const initialSphereCapacityRef = useRef(index.spheres.length);

  /**
   * Create the batches the slot list needs and dispose the ones it no longer
   * names. The disk and ball templates never change, so only the cone ratios can
   * rebuild anything.
   */
  useLayoutEffect(() => {
    const previous = structureRef.current;

    if (!previous) {
      const buckets = new Map<string, RootBatchResource>();
      for (const bucket of index.buckets) {
        buckets.set(bucket.key, createRootBatchResource(
          new THREE.CylinderGeometry(bucket.ratio, 1, 1, ROOT_RADIAL_SEGMENTS),
          bucket.records.length,
          bucket.ratio,
        ));
      }
      const next: RootBatchStructure = {
        disks: createRootBatchResource(
          new THREE.CylinderGeometry(1, 1, 1, ROOT_RADIAL_SEGMENTS),
          initialDiskCapacityRef.current,
          1,
        ),
        spheres: createRootBatchResource(
          new THREE.SphereGeometry(1, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS),
          initialSphereCapacityRef.current,
          1,
        ),
        buckets,
      };
      structureRef.current = next;
      setStructure(next);
      return;
    }

    const buckets = new Map<string, RootBatchResource>();
    let changed = false;
    for (const bucket of index.buckets) {
      const existing = previous.buckets.get(bucket.key);
      // Root cone geometry carries the quantized ratio itself, so the key alone
      // identifies the shape; the ratio check keeps a future re-key honest.
      if (existing && existing.ratio === bucket.ratio) {
        buckets.set(bucket.key, existing);
        continue;
      }
      if (existing) disposeRootBatchResource(existing);
      buckets.set(bucket.key, createRootBatchResource(
        new THREE.CylinderGeometry(bucket.ratio, 1, 1, ROOT_RADIAL_SEGMENTS),
        bucket.records.length,
        bucket.ratio,
      ));
      changed = true;
    }
    for (const [key, resource] of previous.buckets) {
      if (buckets.has(key)) continue;
      disposeRootBatchResource(resource);
      changed = true;
    }
    if (!changed) return;

    const next: RootBatchStructure = { ...previous, buckets };
    structureRef.current = next;
    setStructure(next);
  }, [index]);

  // A real unmount frees every batch. Declared after the reconcile effect so a
  // StrictMode remount rebuilds from an empty ref rather than reusing buffers
  // the simulated unmount already released.
  useLayoutEffect(() => () => {
    const current = structureRef.current;
    if (!current) return;
    disposeRootBatchResource(current.disks);
    disposeRootBatchResource(current.spheres);
    for (const resource of current.buckets.values()) disposeRootBatchResource(resource);
    structureRef.current = null;
  }, []);

  // Same values the parent's traversal applies to every mesh under its group.
  // Repeated here so the batch is correct on the commit it mounts, which is one
  // commit after that traversal last ran.
  useLayoutEffect(() => {
    if (!structure) return;
    const state = {
      clippingPlanes: clippingPlanes && clippingPlanes.length > 0 ? clippingPlanes : null,
      transparent,
      opacity,
    };
    syncInstancedStandardMaterialState(structure.disks.material, state);
    syncInstancedStandardMaterialState(structure.spheres.material, state);
    for (const resource of structure.buckets.values()) {
      syncInstancedStandardMaterialState(resource.material, state);
    }
  }, [structure, clippingPlanes, transparent, opacity]);

  // The map every writer addresses: the keys are the ones the slot index names
  // its batches by, so a bucket the index holds cannot be written to a batch it
  // does not own (the writer fails loudly instead).
  const batches = useMemo(() => {
    if (!structure) return null;
    const map = new Map<string, SupportInstanceBatch>();
    map.set(ROOT_DISK_BATCH_KEY, structure.disks.batch);
    map.set(ROOT_SPHERE_BATCH_KEY, structure.spheres.batch);
    for (const [key, resource] of structure.buckets) map.set(key, resource.batch);
    return map;
  }, [structure]);

  // `structure` follows the slot list by one commit, because batches are built in
  // a layout effect. Until the map holds exactly the index's keys, neither writer
  // may run: a bucket the slot list just gained has no batch yet, and one it just
  // dropped has been disposed.
  const batchesReady = !!batches
    && batches.size === index.buckets.length + 2
    && index.buckets.every((bucket) => batches.has(bucket.key));

  // A new slot list is a full rewrite: the producer already applied the model
  // drop offset and resolved the colour, and the writer owns the render lift.
  useLayoutEffect(() => {
    if (!batches || !batchesReady) return;
    noteActivity('support-mode:instanced-root-batch');
    writeAllRootSlots(index, batches);
    for (const batch of batches.values()) batch.flush();
    // Every slot is base again, so the state diff below has to re-apply.
    appliedStatesRef.current.clear();
  }, [batches, batchesReady, index]);

  // Hover and marquee: only the slots whose state changed are rewritten.
  useLayoutEffect(() => {
    if (!batches || !batchesReady) return;

    const next = computeRootSlotStates(index, hoveredSupportId, marqueeSupportIds ?? NO_SUPPORT_IDS);
    const changes = diffRootSlotStates(appliedStatesRef.current, next);
    appliedStatesRef.current = next;
    if (changes.length === 0) return;

    applyRootSlotStateChanges(index, changes, batches);
    for (const batch of batches.values()) batch.flush();
  }, [batches, batchesReady, index, hoveredSupportId, marqueeSupportIds]);

  if (!structure) return null;

  return (
    <>
      <RootDiskMesh
        resource={structure.disks}
        records={index.disks}
        renderOrder={renderOrder}
        onRootClick={onRootClick}
        onRootPointerMove={onRootPointerMove}
        onRootPointerOut={onRootPointerOut}
      />
      <RootPrimitiveMesh
        resource={structure.spheres}
        instanceCount={index.spheres.length}
        renderOrder={renderOrder}
      />
      {index.buckets.map((bucket) => {
        const resource = structure.buckets.get(bucket.key);
        if (!resource) return null;
        return (
          <RootPrimitiveMesh
            key={bucket.key}
            resource={resource}
            instanceCount={bucket.records.length}
            renderOrder={renderOrder}
          />
        );
      })}
    </>
  );
}
