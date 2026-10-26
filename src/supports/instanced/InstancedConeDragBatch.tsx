"use client";

import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';

import { CONE_DISK_PRIMITIVE_DATA, coneSlotData } from './coneSlotBatch';
import type { ConeDragSlotMap } from './coneDragSlots';
import { useContactPenetrationResolver } from './contactPenetration';
import {
  getConeDragSession,
  getConeDragSessionServerSnapshot,
  registerConeDragBatch,
  subscribeConeDragSession,
} from './coneDragWriter';
import {
  createInstancedStandardMaterial,
  syncInstancedStandardMaterialState,
} from './instancedStandardMaterial';
import { SupportInstanceBatch } from './supportInstanceBatch';

/** Registry name for this program; keep it distinct from every other material. */
const CONE_DRAG_PROGRAM_KEY = 'df-instanced-cone-drag';

/** The detail cone's templates: 24-segment body and nib, 24x18 tip ball. */
const CONE_RADIAL_SEGMENTS = 24;
const CONE_TIP_WIDTH_SEGMENTS = 24;
const CONE_TIP_HEIGHT_SEGMENTS = 18;

/** Where the batch mounts in the support group's render order. */
const CONE_DRAG_RENDER_ORDER = 100000;

/**
 * The colour the detail renderers give a selected contact disk:
 * `ContactConeRenderer`'s `isContactDiskSelected ? '#c11f61'` for the body, and
 * `ContactDiskRenderer`'s disk. A tip drag only exists while its cone is the
 * selected primitive, so the batch needs no per-gesture resolution — and it must
 * not copy the support's own palette, which is a different thing.
 */
export const CONE_DRAG_COLOR = '#c11f61';

/** A batch mesh must never answer a pointer: the detail cone still does. */
const NOOP_RAYCAST: THREE.Object3D['raycast'] = () => {};

/**
 * The GPU pick pass clones and renders every mesh under the support group; the
 * cone drag batch is a display-only mirror of a primitive that is still
 * registered, so it must not enter that clone. `noClipping` matches the detail
 * group of a selected support, which is clip-exempt.
 */
const CONE_DRAG_MESH_USER_DATA = { excludeFromPickingClone: true, noClipping: true };

export interface InstancedConeDragBatchProps {
  /** The cross-section planes, passed down rather than inherited from a traversal. */
  clippingPlanes?: THREE.Plane[] | null;
  /** Ghost pass: translucent, no depth write, exactly as the parent sets it. */
  transparent?: boolean;
  opacity?: number;
  /** The render order the parent's ghost traversal applies to every mesh. */
  renderOrder?: number;
}

/** One capacity batch: the geometry it draws and the material it draws with. */
type ConeDragResource = {
  batch: SupportInstanceBatch;
  material: THREE.MeshStandardMaterial;
};

type ConeDragResources = {
  slotMap: ConeDragSlotMap;
  bodies: ReadonlyMap<string, ConeDragResource>;
  tips: ConeDragResource | null;
  disks: ConeDragResource | null;
};

/**
 * The dragged contact cone, as private instances, while a tip drag runs.
 *
 * Capacity is exact, not grown: the slot map is fixed at gesture start, so every
 * batch is sized once and only its matrices change. Nothing here is pickable —
 * `raycast` is a no-op and the GPU pick clone skips it — because the detail cone
 * is hidden with `visible={false}`, not unmounted, and keeps answering the
 * pointer.
 *
 * Detail parity is the point: a 24-segment body frustum in the cone's ratio
 * bucket, a 24x18 tip ball and — for a `disk` profile — a polygon-offset nib.
 * The shaft, the joints and any sibling cone stay on their detail renderers, so
 * this batch never suppresses anything but the one cone it draws.
 */
export function InstancedConeDragBatch({
  clippingPlanes = null,
  transparent = false,
  opacity = 1,
  renderOrder = CONE_DRAG_RENDER_ORDER,
}: InstancedConeDragBatchProps) {
  const session = useSyncExternalStore(
    subscribeConeDragSession,
    getConeDragSession,
    getConeDragSessionServerSnapshot,
  );

  // One gesture, one mount: the generation is the key, so a gesture never
  // reuses buffers sized for the previous one, and the cleanup below frees the
  // set when the gesture ends (a batch left behind would draw the committed
  // cone a second time).
  if (!session || session.ended) return null;

  return (
    <ConeDragBatchSession
      key={session.generation}
      slotMap={session.slotMap}
      clippingPlanes={clippingPlanes}
      transparent={transparent}
      opacity={opacity}
      renderOrder={renderOrder}
    />
  );
}

function ConeDragBatchSession({
  slotMap,
  clippingPlanes,
  transparent,
  opacity,
  renderOrder,
}: {
  slotMap: ConeDragSlotMap;
  clippingPlanes: THREE.Plane[] | null;
  transparent: boolean;
  opacity: number;
  renderOrder: number;
}) {
  // Built in the state initializer, not an effect: the slot map is fixed for the
  // gesture, so there is nothing to synchronise afterwards.
  const [resources] = useState(() => buildConeDragResources(slotMap));
  const resolvePenetration = useContactPenetrationResolver();

  // The disposer is the only owner of the batch set's lifetime.
  useLayoutEffect(() => () => disposeConeDragResources(resources), [resources]);

  // The detail palette, written once per resource set — a drag does not change
  // what is selected, only where it is.
  useLayoutEffect(() => {
    writeConeDragColors(resources);
  }, [resources]);

  // Same values the parent's traversal applies to every mesh under its group.
  // Repeated here so the batch is correct on the commit it mounts, which is one
  // commit after that traversal last ran.
  useLayoutEffect(() => {
    const state = {
      clippingPlanes: clippingPlanes && clippingPlanes.length > 0 ? clippingPlanes : null,
      transparent,
      opacity,
    };
    for (const resource of everyConeDragResource(resources)) {
      syncInstancedStandardMaterialState(resource.material, state);
    }
  }, [resources, clippingPlanes, transparent, opacity]);

  // Registering writes the session's current frame, because the batch mounts a
  // commit after the gesture began: without it the first paint would be an
  // identity instance.
  useLayoutEffect(
    () => registerConeDragBatch({
      coneBodies: batchMap(resources.bodies),
      coneTips: resources.tips?.batch ?? null,
      coneDisks: resources.disks?.batch ?? null,
      resolvePenetration,
    }),
    [resources, resolvePenetration],
  );

  return (
    <>
      {[...resources.bodies.values()].map((resource) => (
        <ConeDragBatchMesh
          key={`cone-body:${resource.batch.geometry.uuid}`}
          resource={resource}
          instanceCount={resource.batch.count}
          renderOrder={renderOrder}
        />
      ))}
      {resources.tips && (
        <ConeDragBatchMesh
          resource={resources.tips}
          instanceCount={slotMap.counts.cones}
          renderOrder={renderOrder}
        />
      )}
      {resources.disks && slotMap.counts.coneNibs > 0 && (
        <ConeDragBatchMesh
          resource={resources.disks}
          instanceCount={slotMap.counts.coneNibs}
          renderOrder={renderOrder}
        />
      )}
    </>
  );
}

function ConeDragBatchMesh({
  resource,
  instanceCount,
  renderOrder,
}: {
  resource: ConeDragResource;
  instanceCount: number;
  renderOrder: number;
}) {
  return (
    <mesh
      geometry={resource.batch.geometry}
      material={resource.material}
      // The instance moves without the unit template's bounds changing, so the
      // geometry's own sphere cannot answer a frustum test.
      frustumCulled={false}
      renderOrder={renderOrder}
      visible={instanceCount > 0}
      raycast={NOOP_RAYCAST}
      userData={CONE_DRAG_MESH_USER_DATA}
    />
  );
}

function batchMap(
  resources: ReadonlyMap<string, ConeDragResource>,
): ReadonlyMap<string, SupportInstanceBatch> {
  const batches = new Map<string, SupportInstanceBatch>();
  for (const [key, resource] of resources) batches.set(key, resource.batch);
  return batches;
}

function everyConeDragResource(resources: ConeDragResources): ConeDragResource[] {
  const all: ConeDragResource[] = [...resources.bodies.values()];
  if (resources.tips) all.push(resources.tips);
  if (resources.disks) all.push(resources.disks);
  return all;
}

function disposeConeDragResources(resources: ConeDragResources): void {
  for (const resource of everyConeDragResource(resources)) {
    resource.batch.dispose();
    resource.material.dispose();
  }
}

function createConeDragResource(
  geometry: THREE.BufferGeometry,
  capacity: number,
  polygonOffset = false,
): ConeDragResource {
  // The batch copies the template's index, positions and normals, so the
  // template itself is disposable straight away.
  const batch = new SupportInstanceBatch(geometry, Math.max(1, capacity));
  geometry.dispose();
  const material = createInstancedStandardMaterial(CONE_DRAG_PROGRAM_KEY);
  if (polygonOffset) {
    // The legacy nib's material, verbatim: without the offset the nib z-fights
    // the model it is pressed into.
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
  }
  return { batch, material };
}

function buildConeDragResources(slotMap: ConeDragSlotMap): ConeDragResources {
  const bodies = new Map<string, ConeDragResource>();
  for (const bucket of slotMap.coneBodyBuckets) {
    // The legacy bucket geometry verbatim: a unit cylinder whose bottom radius
    // is the body/contact ratio.
    const resource = createConeDragResource(
      new THREE.CylinderGeometry(1, bucket.ratio, 1, CONE_RADIAL_SEGMENTS),
      bucket.instances,
    );
    resource.batch.resizeTo(bucket.instances, coneSlotData(slotMap.cones[0]?.kind ?? 'legacy'), bucket.ratio);
    bodies.set(bucket.key, resource);
  }

  let tips: ConeDragResource | null = null;
  if (slotMap.counts.cones > 0) {
    tips = createConeDragResource(
      new THREE.SphereGeometry(1, CONE_TIP_WIDTH_SEGMENTS, CONE_TIP_HEIGHT_SEGMENTS),
      slotMap.counts.cones,
    );
    tips.batch.resizeTo(slotMap.counts.cones, coneSlotData(slotMap.cones[0]?.kind ?? 'legacy'), 1);
  }

  let disks: ConeDragResource | null = null;
  if (slotMap.counts.coneNibs > 0) {
    disks = createConeDragResource(
      new THREE.CylinderGeometry(1, 1, 1, CONE_RADIAL_SEGMENTS),
      slotMap.counts.coneNibs,
      true,
    );
    disks.batch.resizeTo(slotMap.counts.coneNibs, CONE_DISK_PRIMITIVE_DATA, 1);
  }

  return { slotMap, bodies, tips, disks };
}

function writeConeDragColors(resources: ConeDragResources): void {
  const tint = new THREE.Color(CONE_DRAG_COLOR);
  for (const slot of resources.slotMap.cones) {
    const body = resources.bodies.get(slot.bodyKey);
    if (body) body.batch.setColor(slot.bodyInstance, tint.r, tint.g, tint.b);
    if (resources.tips) {
      resources.tips.batch.setColor(slot.tipInstance, tint.r, tint.g, tint.b);
    }
    if (slot.diskInstance !== undefined && resources.disks) {
      resources.disks.batch.setColor(slot.diskInstance, tint.r, tint.g, tint.b);
    }
  }
}
