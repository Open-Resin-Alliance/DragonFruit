"use client";

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';

import { buildProxyHoverIndex, createProxyHoverRaycast } from '../proxyHoverIndex';
import type { InstancedJoint } from '../SupportPrimitives/Joint/InstancedJointGroup';
import {
  computeJointSlotStates,
  diffJointSlotStates,
  jointSlotRadius,
  writeAllJointSlots,
  writeJointSlot,
} from './jointSlotBatch';
import { createInstancedJointMaterial } from './instancedJointMaterial';
import { syncInstancedStandardMaterialState } from './instancedStandardMaterial';
import type { InstancedJointVisualState } from './instancedPalette';
import type { JointSlotIndex } from './jointSlots';
import { SupportInstanceBatch } from './supportInstanceBatch';

/** The sphere the whole batch draws, matching `BATCHED_JOINT_*` in SupportRenderer. */
const JOINT_WIDTH_SEGMENTS = 12;
const JOINT_HEIGHT_SEGMENTS = 10;

/** Same order the legacy joint batches mount at; the parent traversal re-applies it. */
const JOINT_RENDER_ORDER = 100000;

/**
 * Half-length of the segment a spherical joint is indexed as. Small enough to
 * be a sphere for picking, non-zero so the ray-segment division stays finite.
 */
const SPHERE_SEGMENT_EPSILON = 0.001;

export interface InstancedJointBatchProps {
  /** Unselected supports' joints, in the producer's draw order; slot = instance. */
  index: JointSlotIndex;
  /** Support whose joints draw in the hover state, or null. */
  hoveredSupportId?: string | null;
  /** Supports past the first marquee hover: the bulk colour, as the overlay did. */
  marqueeSupportIds?: readonly string[];
  /**
   * The cross-section planes, passed down rather than left to the parent's
   * traversal: a mesh mounted a commit after that traversal ran would draw
   * unclipped until the next dependency change.
   */
  clippingPlanes?: THREE.Plane[] | null;
  /** Ghost pass: translucent, no depth write, exactly as the parent sets it. */
  transparent?: boolean;
  opacity?: number;
  onJointClick?: (joint: InstancedJoint, event: ThreeEvent<MouseEvent>) => void;
  onJointPointerMove?: (joint: InstancedJoint, event: ThreeEvent<PointerEvent>) => void;
  onJointPointerOut?: (joint: InstancedJoint | null, event: ThreeEvent<PointerEvent>) => void;
  /**
   * The mounted batch, or null when it unmounts.
   *
   * The joint-drag writer moves the leaf host-knot balls that ride the dragged
   * support's own segments through THIS batch — they are scene geometry, so it
   * must not own or resize them. Nobody else needs the handle.
   */
  onBatchReady?: (batch: SupportInstanceBatch | null) => void;
}

type JointBatchResources = {
  batch: SupportInstanceBatch;
  material: THREE.MeshStandardMaterial;
};

/**
 * Every unselected joint in Support mode as one draw.
 *
 * The batch is capacity-managed and mounted once: a support appearing, a
 * selection change or a hover only rewrites attributes, never the mesh, so
 * neither the GPU pick registration nor the material traversal has to re-see it.
 * Joints of selected supports are not here at all — they are `JointRenderer`s,
 * which also keeps drag targets out of the batch.
 *
 * The hover/marquee highlight is two per-instance values, not a second mesh: the
 * tint comes from the colour attribute and the ×1.06 lift from the instance
 * matrix, and only the slots whose state changed are rewritten.
 */
export function InstancedJointBatch({
  index,
  hoveredSupportId = null,
  marqueeSupportIds,
  clippingPlanes = null,
  transparent = false,
  opacity = 1,
  onJointClick,
  onJointPointerMove,
  onJointPointerOut,
  onBatchReady,
}: InstancedJointBatchProps) {
  const [resources, setResources] = useState<JointBatchResources | null>(null);
  const appliedStatesRef = useRef<Map<number, InstancedJointVisualState>>(new Map());
  const lastHoveredJointRef = useRef<InstancedJoint | null>(null);

  // The count this batch first saw is only a capacity hint: growth reallocates
  // the attributes in place, so the mesh never depends on it again.
  const initialCapacityRef = useRef(index.slots.length);

  // Built in an effect rather than a memo because it owns a geometry and a
  // material to dispose: a StrictMode remount must build a fresh batch, not
  // reuse one whose buffers the cleanup already freed.
  useLayoutEffect(() => {
    const base = new THREE.SphereGeometry(1, JOINT_WIDTH_SEGMENTS, JOINT_HEIGHT_SEGMENTS);
    const batch = new SupportInstanceBatch(base, Math.max(1, initialCapacityRef.current));
    // The batch cloned the template's index, positions and normals.
    base.dispose();
    const material = createInstancedJointMaterial();
    setResources({ batch, material });

    return () => {
      batch.dispose();
      material.dispose();
    };
  }, []);

  // Hand the batch to whoever draws rider geometry through it (the joint-drag
  // writer moves leaf host-knot balls on the dragged support's segments). Null
  // on unmount so a released handle is never written into.
  useLayoutEffect(() => {
    if (!resources) return;
    onBatchReady?.(resources.batch);
    return () => onBatchReady?.(null);
  }, [resources, onBatchReady]);

  // Same values the parent's traversal applies to every mesh under its group.
  // Repeated here so the batch is correct on the commit it mounts, which is one
  // commit after that traversal last ran.
  useLayoutEffect(() => {
    if (!resources) return;
    syncInstancedStandardMaterialState(resources.material, {
      clippingPlanes: clippingPlanes && clippingPlanes.length > 0 ? clippingPlanes : null,
      transparent,
      opacity,
    });
  }, [resources, clippingPlanes, transparent, opacity]);

  // A new slot list is a full rewrite: the producer already applied the model
  // drop offset, the scene diameter blend and the leaf-knot pre-compensation, so
  // the batch must not adjust any of them again.
  useLayoutEffect(() => {
    if (!resources) return;
    writeAllJointSlots(resources.batch, index);
    resources.batch.flush();
    // Every slot is base again, so the state diff below has to re-apply.
    appliedStatesRef.current.clear();
  }, [resources, index]);

  // Hover and marquee: only the slots whose state changed are rewritten.
  useLayoutEffect(() => {
    if (!resources) return;

    const next = computeJointSlotStates(index, hoveredSupportId, marqueeSupportIds ?? []);
    const changes = diffJointSlotStates(appliedStatesRef.current, next);
    appliedStatesRef.current = next;
    if (changes.length === 0) return;

    for (const change of changes) {
      writeJointSlot(resources.batch, index, change.index, change.state);
    }
    resources.batch.flush();
  }, [resources, index, hoveredSupportId, marqueeSupportIds]);

  /**
   * One grid cell index over the slots, replacing three's per-instance walk.
   *
   * A joint is a ball, tested as a near-zero-length vertical segment: three's
   * ray-segment maths divides by the segment length, so a truly degenerate one
   * is unusable, while a 0.001 mm stub makes the capsule a sphere to that
   * precision. The ±radius segment other batches use would make the hitbox a
   * capsule 50% taller than the drawn ball. Tolerance 0: Support mode has never
   * given joints a grab radius, so a non-zero tolerance would quietly enlarge
   * every joint hitbox.
   *
   * An empty slot list returns a no-op rather than the shared
   * `INSTANCED_MESH_RAYCAST` fallback: that one is
   * `InstancedMesh.prototype.raycast`, which reads `this.boundingSphere` — a
   * field only an `InstancedMesh` has, so calling it on this plain mesh throws.
   */
  const raycast = useMemo(() => {
    const targets = index.slots.map((slot, slotIndex) => {
      const radius = jointSlotRadius(slot.diameter);
      return {
        ...(slot.modelId !== undefined ? { modelId: slot.modelId } : {}),
        index: slotIndex,
        start: { x: slot.pos.x, y: slot.pos.y, z: slot.pos.z - SPHERE_SEGMENT_EPSILON },
        end: { x: slot.pos.x, y: slot.pos.y, z: slot.pos.z + SPHERE_SEGMENT_EPSILON },
        radius,
      };
    });

    const hoverIndex = buildProxyHoverIndex(targets);
    return hoverIndex ? createProxyHoverRaycast(hoverIndex, () => 0) : () => {};
  }, [index]);

  // Click/move/out keep the legacy callbacks; only the argument changes from
  // "the joint in this batch array" to "the slot this instance id names".
  const resolveSlot = (instanceId: number | undefined | null): InstancedJoint | null => (
    instanceId == null ? null : index.slots[instanceId] ?? null
  );

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (!onJointClick) return;
    event.stopPropagation();
    const joint = resolveSlot(event.instanceId);
    if (!joint) return;
    onJointClick(joint, event);
  };

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!onJointPointerMove) return;
    event.stopPropagation();
    const joint = resolveSlot(event.instanceId);
    if (!joint) return;
    lastHoveredJointRef.current = joint;
    onJointPointerMove(joint, event);
  };

  const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
    if (!onJointPointerOut) return;
    event.stopPropagation();
    onJointPointerOut(lastHoveredJointRef.current, event);
    lastHoveredJointRef.current = null;
  };

  if (!resources) return null;

  return (
    <mesh
      geometry={resources.batch.geometry}
      material={resources.material}
      // Instances move without the unit sphere's bounds changing, so the
      // geometry's own sphere cannot answer a frustum test.
      frustumCulled={false}
      renderOrder={JOINT_RENDER_ORDER}
      visible={index.slots.length > 0}
      raycast={raycast}
      onClick={onJointClick ? handleClick : undefined}
      onPointerMove={onJointPointerMove ? handlePointerMove : undefined}
      onPointerOut={onJointPointerOut ? handlePointerOut : undefined}
    />
  );
}
