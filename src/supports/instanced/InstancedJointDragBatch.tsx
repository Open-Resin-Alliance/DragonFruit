"use client";

import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';

import type { JointDragSlotMap } from './dragSlots';
import { CONE_DISK_PRIMITIVE_DATA, coneSlotData } from './coneSlotBatch';
import { useContactPenetrationResolver } from './contactPenetration';
import {
  getJointDragSession,
  getJointDragSessionServerSnapshot,
  registerDragBatch,
  subscribeJointDragSession,
} from './instanceDragWriter';
import {
  createInstancedStandardMaterial,
  syncInstancedStandardMaterialState,
} from './instancedStandardMaterial';
import { resizeJointBatch } from './jointSlotBatch';
import {
  SHAFT_STRAIGHT_BATCH_KEY,
  SHAFT_STRAIGHT_SLOT_DATA,
  SHAFT_TAPERED_SLOT_DATA,
} from './shaftSlotBatch';
import { SupportInstanceBatch } from './supportInstanceBatch';

/** Registry name for this program; keep it distinct from every other material. */
const DRAG_PROGRAM_KEY = 'df-instanced-joint-drag';

/** The detail joint's sphere: `JointRenderer` draws `sphereGeometry(radius, 16, 12)`. */
const JOINT_WIDTH_SEGMENTS = 16;
const JOINT_HEIGHT_SEGMENTS = 12;

/** The detail shaft's cylinder: `ShaftRenderer` defaults to 16 radial segments. */
const SHAFT_RADIAL_SEGMENTS = 16;

/** The detail cone's templates: 24-segment body and nib, 24x18 tip ball. */
const CONE_RADIAL_SEGMENTS = 24;
const CONE_TIP_WIDTH_SEGMENTS = 24;
const CONE_TIP_HEIGHT_SEGMENTS = 18;

/** Where the drag batch mounts in the support group's render order. */
const DRAG_RENDER_ORDER = 100000;

/**
 * The colours the detail renderers give a selected support's primitives.
 *
 * Anchors: `JointRenderer`'s `displayColor` (`isSelected ? '#1a75ff'` for the
 * dragged joint, `isParentSelected ? '#888888'` for its siblings) and its
 * `propColor`, which is also `ShaftRenderer`'s and `ContactConeRenderer`'s
 * default. `color` exists because the base colour is the scene's per-model
 * resolution, not a constant.
 */
export const DRAG_JOINT_COLOR = '#1a75ff';
export const DRAG_SIBLING_JOINT_COLOR = '#888888';
export const DRAG_PRIMITIVE_COLOR = '#c8752a';

/** A batch mesh must never answer a pointer: the detail primitive still does. */
const NOOP_RAYCAST: THREE.Object3D['raycast'] = () => {};

/**
 * The GPU pick pass clones and renders every mesh under the support group; the
 * drag batch is a display-only mirror of primitives that are still registered,
 * so it must not enter that clone.
 *
 * `noClipping` is the tag the detail groups of a selected support carry: every
 * draggable type's detail is clip-exempt (always for trunk/branch, on selection
 * for the rest), so the batch that stands in for it must be too. It also stops
 * the parent's ghost/clip traversal from adding planes to these materials when
 * that traversal happens to run mid-drag.
 */
const DRAG_MESH_USER_DATA = { excludeFromPickingClone: true, noClipping: true };

export interface InstancedJointDragBatchProps {
  /**
   * The scene's joint batch. The drag moves the leaf host-knot balls that ride
   * the dragged support's own segments through it — they are scene geometry, so
   * this only names their instances and never resizes them.
   */
  sharedJointBatch?: SupportInstanceBatch | null;
  /**
   * The selected support's base colour, exactly as its detail renderer resolved
   * it (`resolveDetailSupportColor`). Joints do not use it: a selected support's
   * joints are blue/grey by `JointRenderer`'s own rule.
   */
  color?: string;
  /**
   * The same colour, resolved from the gesture's slot map — the scene knows the
   * dragged support's model and debug tint, the batch only knows its ids. Takes
   * precedence over `color`.
   */
  resolveColor?: (slotMap: JointDragSlotMap) => string;
  /** The cross-section planes, passed down rather than inherited from a traversal. */
  clippingPlanes?: THREE.Plane[] | null;
  /** Ghost pass: translucent, no depth write, exactly as the parent sets it. */
  transparent?: boolean;
  opacity?: number;
  /** The render order the parent's ghost traversal applies to every mesh. */
  renderOrder?: number;
}

/** One capacity batch: the geometry it draws and the material it draws with. */
type DragBatchResource = {
  batch: SupportInstanceBatch;
  material: THREE.MeshStandardMaterial;
};

type DragBatchResources = {
  slotMap: JointDragSlotMap;
  joint: DragBatchResource | null;
  shafts: ReadonlyMap<string, DragBatchResource>;
  coneBodies: ReadonlyMap<string, DragBatchResource>;
  coneTips: DragBatchResource | null;
  coneDisks: DragBatchResource | null;
};

/**
 * The dragged support's live geometry for one joint gesture, as private
 * instances.
 *
 * Capacity is exact, not grown: the slot map is fixed at drag start, so every
 * batch is sized once and only its matrices change. Nothing here is pickable —
 * `raycast` is a no-op and the GPU pick clone skips it — because the detail
 * primitives are suppressed with `visible={false}`, not unmounted, and they keep
 * answering the pointer.
 *
 * Detail parity is the point: a 16x12 joint sphere at the entity's resolved
 * diameter, a 16-segment cylinder per taper bucket, and a 24-segment cone with
 * its 24x18 tip ball and a polygon-offset nib. The colours are the detail
 * renderers' selected-support palette, because that is what the gesture has to
 * look like.
 */
export function InstancedJointDragBatch({
  sharedJointBatch = null,
  color = DRAG_PRIMITIVE_COLOR,
  resolveColor,
  clippingPlanes = null,
  transparent = false,
  opacity = 1,
  renderOrder = DRAG_RENDER_ORDER,
}: InstancedJointDragBatchProps) {
  const session = useSyncExternalStore(
    subscribeJointDragSession,
    getJointDragSession,
    getJointDragSessionServerSnapshot,
  );

  // One gesture, one mount: the generation is the key, so a gesture never
  // reuses buffers sized for the previous one, and the cleanup below frees the
  // set when the gesture ends (a batch left behind would draw the committed
  // geometry a second time).
  if (!session || session.ended) return null;

  return (
    <DragBatchSession
      key={session.generation}
      slotMap={session.slotMap}
      sharedJointBatch={sharedJointBatch}
      color={resolveColor ? resolveColor(session.slotMap) : color}
      clippingPlanes={clippingPlanes}
      transparent={transparent}
      opacity={opacity}
      renderOrder={renderOrder}
    />
  );
}

function DragBatchSession({
  slotMap,
  sharedJointBatch,
  color,
  clippingPlanes,
  transparent,
  opacity,
  renderOrder,
}: {
  slotMap: JointDragSlotMap;
  sharedJointBatch: SupportInstanceBatch | null;
  color: string;
  clippingPlanes: THREE.Plane[] | null;
  transparent: boolean;
  opacity: number;
  renderOrder: number;
}) {
  // Built in the state initializer, not an effect: the slot map is fixed for the
  // gesture, so there is nothing to synchronise afterwards. A discarded
  // StrictMode initializer is plain JS memory — these buffers have not been
  // handed to the GPU yet — so the double render costs nothing to clean up.
  const [resources] = useState(() => buildDragBatchResources(slotMap));
  const resolvePenetration = useContactPenetrationResolver();

  // The disposer is the only owner of the batch set's lifetime.
  useLayoutEffect(() => () => disposeDragBatchResources(resources), [resources]);

  // The detail palette, written once per resource set — a drag does not change
  // what is selected, only where it is.
  useLayoutEffect(() => {
    writeDragBatchColors(resources, color);
  }, [resources, color]);

  // Same values the parent's traversal applies to every mesh under its group.
  // Repeated here so the batch is correct on the commit it mounts, which is one
  // commit after that traversal last ran.
  useLayoutEffect(() => {
    const state = {
      clippingPlanes: clippingPlanes && clippingPlanes.length > 0 ? clippingPlanes : null,
      transparent,
      opacity,
    };
    for (const resource of everyDragResource(resources)) {
      syncInstancedStandardMaterialState(resource.material, state);
    }
  }, [resources, clippingPlanes, transparent, opacity]);

  // Registering writes the session's current frame, because the batch mounts a
  // commit after the gesture began: without it the first paint would be identity
  // instances.
  useLayoutEffect(
    () => registerDragBatch({
      joint: resources.joint?.batch ?? null,
      shafts: batchMap(resources.shafts),
      coneBodies: batchMap(resources.coneBodies),
      coneTips: resources.coneTips?.batch ?? null,
      coneDisks: resources.coneDisks?.batch ?? null,
      sharedJoints: sharedJointBatch,
      resolvePenetration,
    }),
    [resources, sharedJointBatch, resolvePenetration],
  );

  return (
    <>
      {resources.joint && (
        <DragBatchMesh
          resource={resources.joint}
          instanceCount={slotMap.counts.joints}
          renderOrder={renderOrder}
        />
      )}
      {[...resources.shafts.values()].map((resource) => (
        <DragBatchMesh
          key={`shaft:${resource.batch.geometry.uuid}`}
          resource={resource}
          instanceCount={resource.batch.count}
          renderOrder={renderOrder}
        />
      ))}
      {[...resources.coneBodies.values()].map((resource) => (
        <DragBatchMesh
          key={`cone:${resource.batch.geometry.uuid}`}
          resource={resource}
          instanceCount={resource.batch.count}
          renderOrder={renderOrder}
        />
      ))}
      {resources.coneTips && (
        <DragBatchMesh
          resource={resources.coneTips}
          instanceCount={slotMap.counts.cones}
          renderOrder={renderOrder}
        />
      )}
      {resources.coneDisks && slotMap.counts.coneNibs > 0 && (
        <DragBatchMesh
          resource={resources.coneDisks}
          instanceCount={slotMap.counts.coneNibs}
          renderOrder={renderOrder}
        />
      )}
    </>
  );
}

function DragBatchMesh({
  resource,
  instanceCount,
  renderOrder,
}: {
  resource: DragBatchResource;
  instanceCount: number;
  renderOrder: number;
}) {
  return (
    <mesh
      geometry={resource.batch.geometry}
      material={resource.material}
      // The instances move without the unit template's bounds changing, so the
      // geometry's own sphere cannot answer a frustum test.
      frustumCulled={false}
      renderOrder={renderOrder}
      visible={instanceCount > 0}
      raycast={NOOP_RAYCAST}
      userData={DRAG_MESH_USER_DATA}
    />
  );
}

function batchMap(
  resources: ReadonlyMap<string, DragBatchResource>,
): ReadonlyMap<string, SupportInstanceBatch> {
  const batches = new Map<string, SupportInstanceBatch>();
  for (const [key, resource] of resources) batches.set(key, resource.batch);
  return batches;
}

function everyDragResource(resources: DragBatchResources): DragBatchResource[] {
  const all: DragBatchResource[] = [];
  if (resources.joint) all.push(resources.joint);
  all.push(...resources.shafts.values());
  all.push(...resources.coneBodies.values());
  if (resources.coneTips) all.push(resources.coneTips);
  if (resources.coneDisks) all.push(resources.coneDisks);
  return all;
}

function disposeDragBatchResources(resources: DragBatchResources): void {
  for (const resource of everyDragResource(resources)) {
    resource.batch.dispose();
    resource.material.dispose();
  }
}

function createDragBatchResource(
  geometry: THREE.BufferGeometry,
  capacity: number,
  polygonOffset = false,
): DragBatchResource {
  // The batch copies the template's index, positions and normals, so the
  // template itself is disposable straight away.
  const batch = new SupportInstanceBatch(geometry, Math.max(1, capacity));
  geometry.dispose();
  const material = createInstancedStandardMaterial(DRAG_PROGRAM_KEY);
  if (polygonOffset) {
    // The legacy nib's material, verbatim: without the offset the nib z-fights
    // the model it is pressed into.
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
  }
  return { batch, material };
}

function buildDragBatchResources(slotMap: JointDragSlotMap): DragBatchResources {
  let joint: DragBatchResource | null = null;
  if (slotMap.counts.joints > 0) {
    joint = createDragBatchResource(
      new THREE.SphereGeometry(1, JOINT_WIDTH_SEGMENTS, JOINT_HEIGHT_SEGMENTS),
      slotMap.counts.joints,
    );
    resizeJointBatch(joint.batch, slotMap.counts.joints);
  }

  const shafts = new Map<string, DragBatchResource>();
  for (const bucket of slotMap.shaftBuckets) {
    // The legacy bucket geometry verbatim: a unit cylinder whose top radius is
    // the taper ratio, so the writer's uniform `diameter` scale lands the two
    // ends where the detail `ShaftRenderer` puts them.
    const resource = createDragBatchResource(
      new THREE.CylinderGeometry(bucket.ratio / 2, 0.5, 1, SHAFT_RADIAL_SEGMENTS),
      bucket.instances,
    );
    resource.batch.resizeTo(
      bucket.instances,
      bucket.key === SHAFT_STRAIGHT_BATCH_KEY ? SHAFT_STRAIGHT_SLOT_DATA : SHAFT_TAPERED_SLOT_DATA,
      bucket.ratio,
    );
    shafts.set(bucket.key, resource);
  }

  const coneBodies = new Map<string, DragBatchResource>();
  for (const bucket of slotMap.coneBodyBuckets) {
    const resource = createDragBatchResource(
      new THREE.CylinderGeometry(1, bucket.ratio, 1, CONE_RADIAL_SEGMENTS),
      bucket.instances,
    );
    resource.batch.resizeTo(bucket.instances, coneSlotData('legacy'), bucket.ratio);
    coneBodies.set(bucket.key, resource);
  }

  let coneTips: DragBatchResource | null = null;
  if (slotMap.counts.cones > 0) {
    coneTips = createDragBatchResource(
      new THREE.SphereGeometry(1, CONE_TIP_WIDTH_SEGMENTS, CONE_TIP_HEIGHT_SEGMENTS),
      slotMap.counts.cones,
    );
    coneTips.batch.resizeTo(slotMap.counts.cones, coneSlotData('legacy'), 1);
  }

  let coneDisks: DragBatchResource | null = null;
  if (slotMap.counts.coneNibs > 0) {
    coneDisks = createDragBatchResource(
      new THREE.CylinderGeometry(1, 1, 1, CONE_RADIAL_SEGMENTS),
      slotMap.counts.coneNibs,
      true,
    );
    coneDisks.batch.resizeTo(slotMap.counts.coneNibs, CONE_DISK_PRIMITIVE_DATA, 1);
  }

  // The data word and ratio a bucket's instance carries are per-instance for a
  // cone, whose profile kind can differ inside one body bucket.
  for (const cone of slotMap.cones) {
    const body = coneBodies.get(cone.bodyKey);
    if (body) body.batch.setData(cone.bodyInstance, coneSlotData(cone.kind));
    if (coneTips) coneTips.batch.setData(cone.tipInstance, coneSlotData(cone.kind));
  }

  return { slotMap, joint, shafts, coneBodies, coneTips, coneDisks };
}

function writeDragBatchColors(resources: DragBatchResources, color: string): void {
  const slotMap = resources.slotMap;
  const tint = new THREE.Color();

  if (resources.joint) {
    for (const slot of slotMap.joints) {
      tint.set(slot.id === slotMap.jointId ? DRAG_JOINT_COLOR : DRAG_SIBLING_JOINT_COLOR);
      resources.joint.batch.setColor(slot.instance, tint.r, tint.g, tint.b);
    }
  }

  for (const slot of slotMap.segments) {
    const resource = resources.shafts.get(slot.batchKey);
    if (!resource) continue;
    tint.set(color);
    resource.batch.setColor(slot.instance, tint.r, tint.g, tint.b);
  }

  for (const slot of slotMap.cones) {
    tint.set(color);
    const body = resources.coneBodies.get(slot.bodyKey);
    if (body) body.batch.setColor(slot.bodyInstance, tint.r, tint.g, tint.b);
    if (resources.coneTips) {
      resources.coneTips.batch.setColor(slot.tipInstance, tint.r, tint.g, tint.b);
    }
    if (slot.diskInstance !== undefined && resources.coneDisks) {
      resources.coneDisks.batch.setColor(slot.diskInstance, tint.r, tint.g, tint.b);
    }
  }
}
