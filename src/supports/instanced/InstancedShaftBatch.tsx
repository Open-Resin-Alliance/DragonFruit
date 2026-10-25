"use client";

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';

import { noteActivity } from '@/utils/debug/heartbeatContext';
import { buildProxyHoverIndex, createProxyHoverRaycast } from '../proxyHoverIndex';
import { InstancedShaftGroup, type InstancedShaft } from '../SupportPrimitives/Shaft/InstancedShaftGroup';
import { createInstancedStandardMaterial, syncInstancedStandardMaterialState } from './instancedStandardMaterial';
import type { InstancedShaftVisualState } from './shaftSlotBatch';
import {
  applyShaftSlotStateChanges,
  computeShaftSlotStates,
  diffShaftSlotStates,
  SHAFT_STRAIGHT_BATCH_KEY,
  writeAllShaftSlots,
} from './shaftSlotBatch';
import type { ShaftSlotIndex, ShaftSlotRecord } from './shaftSlots';
import { SupportInstanceBatch } from './supportInstanceBatch';

/** Registry name for this program; keep it distinct from every other material. */
const INSTANCED_SHAFT_PROGRAM_KEY = 'df-instanced-shaft';

/** Same order the legacy shaft batches mount at; the parent traversal re-applies it. */
const SHAFT_RENDER_ORDER = 100000;

/** The straight cylinder's end-over-start ratio: one template for every uniform shaft. */
const STRAIGHT_RATIO = 1;

/**
 * Half the radius of the narrowest shaft a pointer may hit, in millimetres.
 *
 * The legacy batch's index used the same floor (`InstancedShaftGroup`'s
 * `Math.max(0.2, diameter / 2)`), so a hair-thin shaft keeps the hitbox it had.
 */
const MIN_SHAFT_HIT_RADIUS = 0.2;

/** Stable empty marquee list, so an unset prop does not re-run the state diff. */
const NO_SUPPORT_IDS: readonly string[] = [];

export interface InstancedShaftBatchProps {
  /** Unselected supports' shafts, in the producer's draw order; `instance` = batch id. */
  index: ShaftSlotIndex;
  /** Support whose shafts draw in the hover state, or null. */
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
  /** The template's radial segments; a change rebuilds the batch templates once. */
  radialSegments: number;
  onShaftClick?: (shaft: InstancedShaft, event: ThreeEvent<MouseEvent>) => void;
  onShaftPointerMove?: (shaft: InstancedShaft, event: ThreeEvent<PointerEvent>) => void;
  onShaftPointerOut?: (shaft: InstancedShaft | null, event: ThreeEvent<PointerEvent>) => void;
}

/** One capacity batch: the geometry it draws and the material it draws with. */
type ShaftBatchResource = {
  batch: SupportInstanceBatch;
  material: THREE.MeshStandardMaterial;
};

type ShaftBatchStructure = {
  radialSegments: number;
  straight: ShaftBatchResource;
  buckets: ReadonlyMap<string, ShaftBatchResource>;
};

function createShaftBatchResource(
  ratio: number,
  radialSegments: number,
  capacity: number,
): ShaftBatchResource {
  // The legacy bucket geometries verbatim: a 1 x 1 cylinder with the taper on
  // the top radius (`InstancedShaftGroup`'s straight mesh and `TaperedShaftBucket`),
  // so an instance matrix that lands a straight shaft on its diameter lands a
  // tapered one on `diameter` at the start and `diameter * ratio` at the end.
  const base = new THREE.CylinderGeometry(ratio / 2, 0.5, 1, radialSegments, 1, false);
  const batch = new SupportInstanceBatch(base, Math.max(1, capacity));
  // The batch copied the template's index, positions and normals.
  base.dispose();
  return {
    batch,
    material: createInstancedStandardMaterial(INSTANCED_SHAFT_PROGRAM_KEY),
  };
}

function disposeShaftBatchResource(resource: ShaftBatchResource): void {
  resource.batch.dispose();
  resource.material.dispose();
}

/**
 * One batch mesh: a plain `<mesh>` over the batch geometry, answered by the
 * slot list rather than by three's per-instance walk.
 *
 * The mesh is deliberately *not* an `<instancedMesh>`: that object applies its
 * own matrix and count, which would draw the batch a second way. The material
 * applies `instanceMatrix` itself (see `instancedStandardMaterial`).
 */
function ShaftBatchMesh({
  resource,
  records,
  onShaftClick,
  onShaftPointerMove,
  onShaftPointerOut,
}: {
  resource: ShaftBatchResource;
  records: readonly ShaftSlotRecord[];
  onShaftClick?: (shaft: InstancedShaft, event: ThreeEvent<MouseEvent>) => void;
  onShaftPointerMove?: (shaft: InstancedShaft, event: ThreeEvent<PointerEvent>) => void;
  onShaftPointerOut?: (shaft: InstancedShaft | null, event: ThreeEvent<PointerEvent>) => void;
}) {
  const lastHoveredShaftRef = useRef<InstancedShaft | null>(null);

  /**
   * One grid cell index over this batch's own instances, replacing three's
   * per-instance walk: a support batch spans the plate, so walking it on every
   * pointer move is O(instances) per event.
   *
   * A target is the slot's segment with the radius the legacy batch indexed it
   * at. Tolerance 0: Support mode has never given shafts a grab radius, so a
   * non-zero tolerance would quietly enlarge every shaft hitbox. One consequence
   * is documented rather than hidden — the test is a capsule, so it over-hits by
   * about a radius past each end where three's cylinder tested the caps exactly.
   *
   * An empty slot list returns a no-op rather than the shared
   * `INSTANCED_MESH_RAYCAST` fallback: that one is
   * `InstancedMesh.prototype.raycast`, which reads `this.boundingSphere` — a
   * field only an `InstancedMesh` has, so calling it on this plain mesh throws.
   */
  const raycast = useMemo(() => {
    const targets = records.map((record) => {
      const { slot } = record;
      return {
        ...(slot.modelId !== undefined ? { modelId: slot.modelId } : {}),
        index: record.instance,
        start: slot.start,
        end: slot.end,
        radius: Math.max(MIN_SHAFT_HIT_RADIUS, slot.diameter / 2),
      };
    });

    const hoverIndex = buildProxyHoverIndex(targets);
    return hoverIndex ? createProxyHoverRaycast(hoverIndex, () => 0) : () => {};
  }, [records]);

  // Click/move/out keep the legacy callbacks; only the argument changes from
  // "the shaft in this batch array" to "the slot this instance id names".
  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (!onShaftClick) return;
    event.stopPropagation();
    const shaft = event.instanceId == null ? null : records[event.instanceId]?.slot ?? null;
    if (!shaft) return;
    onShaftClick(shaft, event);
  };

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!onShaftPointerMove) return;
    event.stopPropagation();
    const shaft = event.instanceId == null ? null : records[event.instanceId]?.slot ?? null;
    if (!shaft) return;
    lastHoveredShaftRef.current = shaft;
    onShaftPointerMove(shaft, event);
  };

  const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
    if (!onShaftPointerOut) return;
    event.stopPropagation();
    onShaftPointerOut(lastHoveredShaftRef.current, event);
    lastHoveredShaftRef.current = null;
  };

  return (
    <mesh
      geometry={resource.batch.geometry}
      material={resource.material}
      // Instances move without the unit cylinder's bounds changing, so the
      // geometry's own sphere cannot answer a frustum test.
      frustumCulled={false}
      renderOrder={SHAFT_RENDER_ORDER}
      visible={records.length > 0}
      raycast={raycast}
      onClick={onShaftClick ? handleClick : undefined}
      onPointerMove={onShaftPointerMove ? handlePointerMove : undefined}
      onPointerOut={onShaftPointerOut ? handlePointerOut : undefined}
    />
  );
}

/**
 * Every unselected support's straight and tapered shafts in Support mode, as one
 * draw for the straight ones plus one per quantized taper ratio.
 *
 * The batches are capacity-managed and mounted once per shape: a support
 * appearing, a selection change or a hover only rewrites attributes, never the
 * mesh, so neither the GPU pick registration nor the material traversal has to
 * re-see it. A new *shape* (a taper ratio that no shaft in the scene used
 * before) is the one structural change: it creates one batch and disposes any
 * bucket the slot list no longer names.
 *
 * The hover/marquee highlight is two per-instance values, not a second mesh: the
 * tint comes from the colour attribute and the x1.02 lift from the instance
 * matrix, and only the slots whose state changed are rewritten.
 *
 * Curved shafts cannot be instances — a merged bezier tube has one radius and is
 * hit-resolved by `faceIndex` — so they mount here as one legacy
 * `InstancedShaftGroup` per colour, from the curved-only lists the slot index
 * carries. That is also why the hover/marquee overlays still exist for curves.
 */
export function InstancedShaftBatch({
  index,
  hoveredSupportId = null,
  marqueeSupportIds,
  clippingPlanes = null,
  transparent = false,
  opacity = 1,
  radialSegments,
  onShaftClick,
  onShaftPointerMove,
  onShaftPointerOut,
}: InstancedShaftBatchProps) {
  const [structure, setStructure] = useState<ShaftBatchStructure | null>(null);
  const structureRef = useRef<ShaftBatchStructure | null>(null);
  const appliedStatesRef = useRef<Map<number, InstancedShaftVisualState>>(new Map());

  // The count this batch first saw is only a capacity hint: growth reallocates
  // the attributes in place, so the mesh never depends on it again.
  const initialStraightCapacityRef = useRef(index.counts.straight);

  /**
   * Create the batches the slot list needs and dispose the ones it no longer
   * names.
   *
   * Growth is not this effect's business: a count change keeps the mesh, the
   * geometry object and the material, and `SupportInstanceBatch` reallocates the
   * attributes. Only the ratio set (a shape) and the radial segment count (a
   * template) rebuild anything, and both are rare.
   */
  useLayoutEffect(() => {
    const previous = structureRef.current;

    if (!previous || previous.radialSegments !== radialSegments) {
      if (previous) {
        disposeShaftBatchResource(previous.straight);
        for (const resource of previous.buckets.values()) disposeShaftBatchResource(resource);
      }

      const buckets = new Map<string, ShaftBatchResource>();
      for (const bucket of index.tapered) {
        buckets.set(bucket.key, createShaftBatchResource(
          bucket.ratio,
          radialSegments,
          bucket.slots.length,
        ));
      }
      const next: ShaftBatchStructure = {
        radialSegments,
        straight: createShaftBatchResource(
          STRAIGHT_RATIO,
          radialSegments,
          initialStraightCapacityRef.current,
        ),
        buckets,
      };
      structureRef.current = next;
      setStructure(next);
      return;
    }

    const buckets = new Map<string, ShaftBatchResource>();
    let changed = false;
    for (const bucket of index.tapered) {
      const existing = previous.buckets.get(bucket.key);
      if (existing) {
        buckets.set(bucket.key, existing);
        continue;
      }
      buckets.set(bucket.key, createShaftBatchResource(
        bucket.ratio,
        radialSegments,
        bucket.slots.length,
      ));
      changed = true;
    }
    for (const [key, resource] of previous.buckets) {
      if (buckets.has(key)) continue;
      disposeShaftBatchResource(resource);
      changed = true;
    }
    if (!changed) return;

    const next: ShaftBatchStructure = { ...previous, buckets };
    structureRef.current = next;
    setStructure(next);
  }, [index, radialSegments]);

  // A real unmount frees every batch. Declared after the reconcile effect so a
  // StrictMode remount rebuilds from an empty ref rather than reusing buffers the
  // simulated unmount already released.
  useLayoutEffect(() => () => {
    const current = structureRef.current;
    if (!current) return;
    disposeShaftBatchResource(current.straight);
    for (const resource of current.buckets.values()) disposeShaftBatchResource(resource);
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
    syncInstancedStandardMaterialState(structure.straight.material, state);
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
    map.set(SHAFT_STRAIGHT_BATCH_KEY, structure.straight.batch);
    for (const [key, resource] of structure.buckets) map.set(key, resource.batch);
    return map;
  }, [structure]);

  // `structure` follows the slot list by one commit, because batches are built in
  // a layout effect. Until the map holds exactly the index's keys, neither writer
  // may run: a bucket the slot list just gained has no batch yet, and one it just
  // dropped has been disposed. The reconcile effect schedules the re-render whose
  // map matches.
  const batchesReady = !!batches
    && batches.size === index.tapered.length + 1
    && index.tapered.every((bucket) => batches.has(bucket.key));

  // A new slot list is a full rewrite: the producer already applied the model
  // drop offset and resolved the colour, so the batch must not adjust either.
  useLayoutEffect(() => {
    if (!batches || !batchesReady) return;
    noteActivity('support-mode:instanced-shaft-batch');
    writeAllShaftSlots(index, batches);
    for (const batch of batches.values()) batch.flush();
    // Every slot is base again, so the state diff below has to re-apply.
    appliedStatesRef.current.clear();
  }, [batches, batchesReady, index]);

  // Hover and marquee: only the slots whose state changed are rewritten.
  useLayoutEffect(() => {
    if (!batches || !batchesReady) return;

    const next = computeShaftSlotStates(index, hoveredSupportId, marqueeSupportIds ?? NO_SUPPORT_IDS);
    const changes = diffShaftSlotStates(appliedStatesRef.current, next);
    appliedStatesRef.current = next;
    if (changes.length === 0) return;

    applyShaftSlotStateChanges(index, changes, batches);
    for (const batch of batches.values()) batch.flush();
  }, [batches, batchesReady, index, hoveredSupportId, marqueeSupportIds]);

  const curvedGroups = useMemo(() => [...index.curvedByColor.entries()], [index]);

  return (
    <>
      {structure && (
        <>
          <ShaftBatchMesh
            resource={structure.straight}
            records={index.straight}
            onShaftClick={onShaftClick}
            onShaftPointerMove={onShaftPointerMove}
            onShaftPointerOut={onShaftPointerOut}
          />
          {index.tapered.map((bucket) => {
            const resource = structure.buckets.get(bucket.key);
            return resource ? (
              <ShaftBatchMesh
                key={bucket.key}
                resource={resource}
                records={bucket.slots}
                onShaftClick={onShaftClick}
                onShaftPointerMove={onShaftPointerMove}
                onShaftPointerOut={onShaftPointerOut}
              />
            ) : null;
          })}
        </>
      )}
      {curvedGroups.map(([color, shafts]) => (
        <InstancedShaftGroup
          key={`curved:${color}`}
          shafts={shafts}
          color={color}
          transparent={transparent}
          opacity={opacity}
          radialSegments={radialSegments}
          onShaftClick={onShaftClick}
          onShaftPointerMove={onShaftPointerMove}
          onShaftPointerOut={onShaftPointerOut}
        />
      ))}
    </>
  );
}
