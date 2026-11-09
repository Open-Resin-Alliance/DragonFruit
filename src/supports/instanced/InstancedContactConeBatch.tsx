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
import {
  applyConeSlotStateChanges,
  computeConeSlotStates,
  CONE_DISK_BATCH_KEY,
  CONE_TIP_BATCH_KEY,
  coneStartPoint,
  diffConeSlotStates,
  writeAllConeSlots,
  type InstancedConeVisualState,
} from './coneSlotBatch';
import { useContactPenetrationResolver } from './contactPenetration';
import type { ConeBatchSlot, ConeSlotIndex, ConeSlotRecord } from './coneSlots';
import { getDiskCenter } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import { createInstancedStandardMaterial, syncInstancedStandardMaterialState } from './instancedStandardMaterial';
import { SupportInstanceBatch } from './supportInstanceBatch';

/** Registry name for this program; keep it distinct from every other material. */
const INSTANCED_CONTACT_CONE_PROGRAM_KEY = 'df-instanced-contact-cone';

/** The legacy primitive templates, verbatim: `CylinderGeometry(…, 10)` and `SphereGeometry(1, 8, 6)`. */
const CONE_RADIAL_SEGMENTS = 10;
const TIP_WIDTH_SEGMENTS = 8;
const TIP_HEIGHT_SEGMENTS = 6;

/**
 * Half-length of the segment a tip ball is indexed as. Same trick as the joint
 * batch: three's ray-segment maths divides by the segment length, so a truly
 * degenerate segment is unusable while a 0.001 mm stub is a sphere to that
 * precision.
 */
const TIP_SEGMENT_EPSILON = 0.001;

/** Stable empty marquee list, so an unset prop does not re-run the state diff. */
const NO_SUPPORT_IDS: readonly string[] = [];

/** A callback that resolves the cone a pointer event names. */
export type ConeBatchPointerHandler = (cone: ConeBatchSlot, event: ThreeEvent<PointerEvent>) => void;

export interface InstancedContactConeBatchProps {
  /** Unselected supports' contact cones, in the producer's draw order; `id` = slot. */
  index: ConeSlotIndex;
  /** Support whose cones draw in the hover state, or null. */
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
  onConeClick?: (cone: ConeBatchSlot, event: ThreeEvent<MouseEvent>) => void;
  onConePointerMove?: ConeBatchPointerHandler;
  onConePointerOut?: (cone: ConeBatchSlot | null, event: ThreeEvent<PointerEvent>) => void;
}

/** One capacity batch: the geometry it draws and the material it draws with. */
type ConeBatchResource = {
  batch: SupportInstanceBatch;
  material: THREE.MeshStandardMaterial;
  /** The geometry's body/contact ratio; 1 for the two fixed primitives. */
  ratio: number;
};

type ConeBatchStructure = {
  tips: ConeBatchResource;
  disks: ConeBatchResource;
  bodies: ReadonlyMap<string, ConeBatchResource>;
};

function createConeBatchResource(
  geometry: THREE.BufferGeometry,
  capacity: number,
  ratio: number,
  polygonOffset = false,
): ConeBatchResource {
  // The batch copies the template's index, positions and normals, so the
  // template itself is disposable straight away.
  const batch = new SupportInstanceBatch(geometry, Math.max(1, capacity));
  geometry.dispose();
  const material = createInstancedStandardMaterial(INSTANCED_CONTACT_CONE_PROGRAM_KEY);
  if (polygonOffset) {
    // The legacy nib's material, verbatim: without the offset the nib z-fights
    // the model and plate it is pressed into (`InstancedContactConeGroup`).
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
  }
  return { batch, material, ratio };
}

function disposeConeBatchResource(resource: ConeBatchResource): void {
  resource.batch.dispose();
  resource.material.dispose();
}

/**
 * One body mesh: the only cone mesh with a pointer index.
 *
 * The index covers the slot's whole silhouette rather than just the frustum
 * the mesh draws, because the legacy group let all three of its meshes answer
 * the pointer: two half-segments along the body (contact end at the contact
 * radius, socket end at the bucket's drawn socket radius), a stub for the tip
 * ball at the start, and — for a disk profile — the nib's own span. All four
 * share the record's body instance id, so whichever one the ray reaches
 * resolves to the same slot the handler expects.
 *
 * Tolerance 0: Support mode has never given cones a grab radius, so a non-zero
 * tolerance would quietly enlarge every cone hitbox. One consequence is
 * documented rather than hidden — the test is a capsule, so it over-hits by
 * about a radius past each end where three tested the caps exactly.
 */
function ConeBodyMesh({
  resource,
  records,
  renderOrder,
  resolvePenetration,
  onConeClick,
  onConePointerMove,
  onConePointerOut,
}: {
  resource: ConeBatchResource;
  records: readonly ConeSlotRecord[];
  renderOrder: number;
  resolvePenetration: (slot: ConeBatchSlot) => number;
  onConeClick?: (cone: ConeBatchSlot, event: ThreeEvent<MouseEvent>) => void;
  onConePointerMove?: ConeBatchPointerHandler;
  onConePointerOut?: (cone: ConeBatchSlot | null, event: ThreeEvent<PointerEvent>) => void;
}) {
  const lastHoveredConeRef = useRef<ConeBatchSlot | null>(null);

  const raycast = useMemo(() => {
    const targets: ProxyHoverTarget[] = [];

    for (const record of records) {
      const { slot } = record;
      const start = coneStartPoint(slot);
      // The drawn body height, so a degenerate profile cannot make the index's
      // segment zero-length (three's ray-segment maths divides by its length).
      const length = Math.max(0.001, slot.lengthMm);
      const halfLength = length / 2;
      const mid = {
        x: start.x + slot.normal.x * halfLength,
        y: start.y + slot.normal.y * halfLength,
        z: start.z + slot.normal.z * halfLength,
      };
      const socket = {
        x: start.x + slot.normal.x * length,
        y: start.y + slot.normal.y * length,
        z: start.z + slot.normal.z * length,
      };
      const index = record.bodyInstance;

      targets.push({ index, start, end: mid, radius: slot.contactRadius });
      targets.push({
        index,
        start: mid,
        end: socket,
        // The drawn socket radius, not the nominal body radius: the bucket's
        // geometry ratio is the first-seen raw ratio, so the two can differ by
        // up to half a quantization step.
        radius: Math.max(0.001, record.bodyRatio * slot.contactRadius),
      });
      targets.push({
        index,
        start: {
          x: start.x - slot.normal.x * TIP_SEGMENT_EPSILON,
          y: start.y - slot.normal.y * TIP_SEGMENT_EPSILON,
          z: start.z - slot.normal.z * TIP_SEGMENT_EPSILON,
        },
        end: {
          x: start.x + slot.normal.x * TIP_SEGMENT_EPSILON,
          y: start.y + slot.normal.y * TIP_SEGMENT_EPSILON,
          z: start.z + slot.normal.z * TIP_SEGMENT_EPSILON,
        },
        radius: slot.contactRadius,
      });

      if (record.kind === 'disk') {
        const penetration = Math.max(0, resolvePenetration(slot));
        const half = (slot.diskThickness + penetration) / 2;
        const centre = getDiskCenter(slot.pos, slot.surfaceNormal, slot.diskThickness);
        // The drawn nib is pulled back by half the penetration, so its span is
        // centred there rather than on the authored disk centre.
        const nibCentre = {
          x: centre.x - slot.surfaceNormal.x * (penetration / 2),
          y: centre.y - slot.surfaceNormal.y * (penetration / 2),
          z: centre.z - slot.surfaceNormal.z * (penetration / 2),
        };
        targets.push({
          index,
          start: {
            x: nibCentre.x - slot.surfaceNormal.x * half,
            y: nibCentre.y - slot.surfaceNormal.y * half,
            z: nibCentre.z - slot.surfaceNormal.z * half,
          },
          end: {
            x: nibCentre.x + slot.surfaceNormal.x * half,
            y: nibCentre.y + slot.surfaceNormal.y * half,
            z: nibCentre.z + slot.surfaceNormal.z * half,
          },
          radius: slot.contactRadius,
        });
      }
    }

    const hoverIndex = buildProxyHoverIndex(targets);
    return hoverIndex ? createProxyHoverRaycast(hoverIndex, () => 0) : () => {};
  }, [records, resolvePenetration]);

  const resolveCone = (instanceId: number | undefined | null): ConeBatchSlot | null => (
    instanceId == null ? null : records[instanceId]?.slot ?? null
  );

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (!onConeClick) return;
    event.stopPropagation();
    const cone = resolveCone(event.instanceId);
    if (!cone) return;
    onConeClick(cone, event);
  };

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!onConePointerMove) return;
    event.stopPropagation();
    const cone = resolveCone(event.instanceId);
    if (!cone) return;
    lastHoveredConeRef.current = cone;
    onConePointerMove(cone, event);
  };

  const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
    if (!onConePointerOut) return;
    event.stopPropagation();
    onConePointerOut(lastHoveredConeRef.current, event);
    lastHoveredConeRef.current = null;
  };

  return (
    <mesh
      geometry={resource.batch.geometry}
      material={resource.material}
      // Instances move without the unit frustum's bounds changing, so the
      // geometry's own sphere cannot answer a frustum test.
      frustumCulled={false}
      renderOrder={renderOrder}
      visible={records.length > 0}
      raycast={raycast}
      onClick={onConeClick ? handleClick : undefined}
      onPointerMove={onConePointerMove ? handlePointerMove : undefined}
      onPointerOut={onConePointerOut ? handlePointerOut : undefined}
    />
  );
}

/**
 * One inert cone primitive: the tip ball or the nib.
 *
 * Both are drawn from the same records as the body and covered by the body
 * mesh's index, so a second pick target would only double-answer. `raycast` is a
 * no-op rather than the shared `INSTANCED_MESH_RAYCAST`: that one is
 * `InstancedMesh.prototype.raycast`, which reads `this.boundingSphere` — a field
 * only an `InstancedMesh` has, so calling it on this plain mesh throws.
 */
function ConePrimitiveMesh({
  resource,
  instanceCount,
  renderOrder,
}: {
  resource: ConeBatchResource;
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
 * Every unselected support's contact cones in Support mode, as one draw per
 * quantized body/contact ratio plus one tip ball and one nib batch.
 *
 * The batches are capacity-managed and mounted once per shape: a support
 * appearing, a selection change or a hover only rewrites attributes, never the
 * mesh, so neither the GPU pick registration nor the material traversal has to
 * re-see it. A new *ratio* is the one structural change: it creates one body
 * batch and disposes any bucket the slot list no longer names.
 *
 * The profile split is per-instance, not per-batch: `sphere` and `legacy` cones
 * draw body and tip, `disk` cones add the nib. The hover/marquee highlight is a
 * per-instance colour, and unlike joints and shafts there is no matrix scale —
 * the legacy overlays drew the same cone at the same transform.
 *
 * The nib's depth is a subscription to the active material profile, not scene
 * state, so the writer takes the resolver from `useContactPenetrationResolver`
 * and the resolver's identity is a write dependency.
 */
export function InstancedContactConeBatch({
  index,
  hoveredSupportId = null,
  marqueeSupportIds,
  clippingPlanes = null,
  transparent = false,
  opacity = 1,
  renderOrder = 100000,
  onConeClick,
  onConePointerMove,
  onConePointerOut,
}: InstancedContactConeBatchProps) {
  const [structure, setStructure] = useState<ConeBatchStructure | null>(null);
  const structureRef = useRef<ConeBatchStructure | null>(null);
  const appliedStatesRef = useRef<Map<number, InstancedConeVisualState>>(new Map());
  const resolvePenetration = useContactPenetrationResolver();

  // The count this batch first saw is only a capacity hint: growth reallocates
  // the attributes in place, so the mesh never depends on it again.
  const initialTipCapacityRef = useRef(index.tips.length);
  const initialDiskCapacityRef = useRef(index.disks.length);

  /**
   * Create the batches the slot list needs and dispose the ones it no longer
   * names. The tip and nib templates never change, so only the body ratios can
   * rebuild anything.
   */
  useLayoutEffect(() => {
    const previous = structureRef.current;

    if (!previous) {
      const bodies = new Map<string, ConeBatchResource>();
      for (const bucket of index.bodies) {
        bodies.set(bucket.key, createConeBatchResource(
          new THREE.CylinderGeometry(1, bucket.ratio, 1, CONE_RADIAL_SEGMENTS),
          bucket.records.length,
          bucket.ratio,
        ));
      }
      const next: ConeBatchStructure = {
        tips: createConeBatchResource(
          new THREE.SphereGeometry(1, TIP_WIDTH_SEGMENTS, TIP_HEIGHT_SEGMENTS),
          initialTipCapacityRef.current,
          1,
        ),
        disks: createConeBatchResource(
          new THREE.CylinderGeometry(1, 1, 1, CONE_RADIAL_SEGMENTS),
          initialDiskCapacityRef.current,
          1,
          true,
        ),
        bodies,
      };
      structureRef.current = next;
      setStructure(next);
      return;
    }

    const bodies = new Map<string, ConeBatchResource>();
    let changed = false;
    for (const bucket of index.bodies) {
      const existing = previous.bodies.get(bucket.key);
      // A bucket's geometry ratio is the first-seen raw ratio, so it can move
      // when that cone leaves even though the quantized key stayed. The mesh is
      // wrong the moment they disagree, so it is rebuilt.
      if (existing && existing.ratio === bucket.ratio) {
        bodies.set(bucket.key, existing);
        continue;
      }
      if (existing) disposeConeBatchResource(existing);
      bodies.set(bucket.key, createConeBatchResource(
        new THREE.CylinderGeometry(1, bucket.ratio, 1, CONE_RADIAL_SEGMENTS),
        bucket.records.length,
        bucket.ratio,
      ));
      changed = true;
    }
    for (const [key, resource] of previous.bodies) {
      if (bodies.has(key)) continue;
      disposeConeBatchResource(resource);
      changed = true;
    }
    if (!changed) return;

    const next: ConeBatchStructure = { ...previous, bodies };
    structureRef.current = next;
    setStructure(next);
  }, [index]);

  // A real unmount frees every batch. Declared after the reconcile effect so a
  // StrictMode remount rebuilds from an empty ref rather than reusing buffers
  // the simulated unmount already released.
  useLayoutEffect(() => () => {
    const current = structureRef.current;
    if (!current) return;
    disposeConeBatchResource(current.tips);
    disposeConeBatchResource(current.disks);
    for (const resource of current.bodies.values()) disposeConeBatchResource(resource);
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
    syncInstancedStandardMaterialState(structure.tips.material, state);
    syncInstancedStandardMaterialState(structure.disks.material, state);
    for (const resource of structure.bodies.values()) {
      syncInstancedStandardMaterialState(resource.material, state);
    }
  }, [structure, clippingPlanes, transparent, opacity]);

  // The map every writer addresses: the keys are the ones the slot index names
  // its batches by, so a bucket the index holds cannot be written to a batch it
  // does not own (the writer fails loudly instead).
  const batches = useMemo(() => {
    if (!structure) return null;
    const map = new Map<string, SupportInstanceBatch>();
    map.set(CONE_TIP_BATCH_KEY, structure.tips.batch);
    map.set(CONE_DISK_BATCH_KEY, structure.disks.batch);
    for (const [key, resource] of structure.bodies) map.set(key, resource.batch);
    return map;
  }, [structure]);

  // `structure` follows the slot list by one commit, because batches are built in
  // a layout effect. Until the map holds exactly the index's keys, neither writer
  // may run: a bucket the slot list just gained has no batch yet, and one it just
  // dropped has been disposed.
  const batchesReady = !!batches
    && batches.size === index.bodies.length + 2
    && index.bodies.every((bucket) => batches.has(bucket.key));

  // A new slot list — or a changed material profile, which moves every nib — is
  // a full rewrite: the producer already applied the model drop offset and
  // resolved the colour, so the batch must not adjust either.
  useLayoutEffect(() => {
    if (!batches || !batchesReady) return;
    noteActivity('support-mode:instanced-cone-batch');
    writeAllConeSlots(index, batches, resolvePenetration);
    for (const batch of batches.values()) batch.flush();
    // Every slot is base again, so the state diff below has to re-apply.
    appliedStatesRef.current.clear();
  }, [batches, batchesReady, index, resolvePenetration]);

  // Hover and marquee: only the slots whose state changed are rewritten.
  useLayoutEffect(() => {
    if (!batches || !batchesReady) return;

    const next = computeConeSlotStates(index, hoveredSupportId, marqueeSupportIds ?? NO_SUPPORT_IDS);
    const changes = diffConeSlotStates(appliedStatesRef.current, next);
    appliedStatesRef.current = next;
    if (changes.length === 0) return;

    applyConeSlotStateChanges(index, changes, batches, resolvePenetration);
    for (const batch of batches.values()) batch.flush();
  }, [batches, batchesReady, index, hoveredSupportId, marqueeSupportIds, resolvePenetration]);

  if (!structure) return null;

  return (
    <>
      {index.bodies.map((bucket) => {
        const resource = structure.bodies.get(bucket.key);
        if (!resource) return null;
        return (
          <ConeBodyMesh
            key={bucket.key}
            resource={resource}
            records={bucket.records}
            renderOrder={renderOrder}
            resolvePenetration={resolvePenetration}
            onConeClick={onConeClick}
            onConePointerMove={onConePointerMove}
            onConePointerOut={onConePointerOut}
          />
        );
      })}
      <ConePrimitiveMesh
        resource={structure.tips}
        instanceCount={index.tips.length}
        renderOrder={renderOrder}
      />
      <ConePrimitiveMesh
        resource={structure.disks}
        instanceCount={index.disks.length}
        renderOrder={renderOrder}
      />
    </>
  );
}
