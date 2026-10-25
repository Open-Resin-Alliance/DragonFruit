import {
  buildJointDragSlotMap,
  dragKnotBallDiameter,
  fillConeBatchSlot,
  projectKnotT,
  segmentEndpointsForIndex,
  type BuildJointDragSlotMapOptions,
  type DragHostKnot,
  type JointDragSlotEntity,
  type JointDragSlotMap,
} from './dragSlots';
import { clearPrimitiveDragSuppression } from './dragSuppression';
import { calculateKnotPositionOnSegmentFromT } from '../SupportPrimitives/Knot/knotUtils';
import type { EndpointHosts, SegmentEndpoints } from '../SupportPrimitives/Knot/segmentEndpoints';
import { writeConeBodyMatrix, writeConeDiskMatrix, writeConeTipMatrix } from './coneSlotBatch';
import type { ConeBatchSlot } from './coneSlots';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import { writeJointSlotMatrix } from './jointSlotBatch';
import { writeShaftSlotMatrix } from './shaftSlotBatch';
import { SupportInstanceBatch } from './supportInstanceBatch';

export type { DragHostKnot, JointDragSlotEntity, JointDragSlotMap } from './dragSlots';

/**
 * The one gesture-scoped writer an instanced joint drag draws through.
 *
 * There is no React here on purpose. Today a joint drag publishes a preview
 * event that costs two synchronous React commits per 25 ms frame and rewrites
 * every producer and every instanced batch in the scene. The instanced path
 * replaces that with a begin/end transaction around per-frame attribute writes:
 *
 * ```
 * beginJointDrag(...)          // once: builds the stable slot map, notifies
 * writeJointDragFrame(entity)  // every frame: matrices only, one flush per batch
 * endJointDrag()               // at release: empties the private batches
 * clearJointDragSession()      // one frame later: after the commit render
 * ```
 *
 * The session survives `endJointDrag` until `clearJointDragSession` because both
 * commit sites read the last preview from it (the gizmo's commit would otherwise
 * write the pre-drag entity, now that publishing has stopped). Clearing it in
 * the same handler as the store write would be a frame early.
 *
 * Batches register themselves; the writer holds no scene references of its own.
 * Every per-frame write addresses exactly the instances the session's slot map
 * names, and the batches' own `assertLive` turns a mismatch into a loud
 * RangeError instead of a stale transform.
 */

/** The batches one mounted drag batch draws through. */
export type DragBatchHandles = {
  joint?: SupportInstanceBatch | null;
  /** Batch key to batch: `straight` or a taper ratio string. */
  shafts?: ReadonlyMap<string, SupportInstanceBatch> | null;
  /** Cone body bucket key to batch. */
  coneBodies?: ReadonlyMap<string, SupportInstanceBatch> | null;
  coneTips?: SupportInstanceBatch | null;
  coneDisks?: SupportInstanceBatch | null;
  /**
   * The scene's own joint batch, for the leaf host-knot balls on the dragged
   * support's segments. Scene-owned: the writer moves those instances and never
   * resizes or re-colours them.
   */
  sharedJoints?: SupportInstanceBatch | null;
  /** The nib depth the scene's cone batch would use, from the material profile. */
  resolvePenetration?: (slot: ConeBatchSlot) => number;
};

export type JointDragSession = {
  /**
   * Increments once per `beginJointDrag`. The batch component keys its resource
   * build on it, so a new gesture never reuses buffers sized for the old one.
   */
  readonly generation: number;
  readonly slotMap: JointDragSlotMap;
  readonly hosts: EndpointHosts;
  /** The dragged support's model drop offset, applied to every written position. */
  readonly dropOffsetZ: number;
  /** The newest preview entity; the gizmo commit reads it. */
  lastPreview: JointDragSlotEntity | null;
  /** True once the release handler has ended the gesture; frames are refused. */
  ended: boolean;
};

export type BeginJointDragOptions = BuildJointDragSlotMapOptions & {
  /** `SupportRenderer`'s drop offset for the dragged support's model. */
  dropOffsetZ?: number;
};

/**
 * The scene-owned values a gesture needs that the interaction layer cannot
 * derive from the entity: the knots a leaf may hang from, the scene joint
 * batch's instances for those knots' balls, and the model drop offset the
 * instanced batches draw in.
 *
 * `SupportRenderer` publishes this once per render into a ref the interaction
 * hook and the gizmo read at gesture start, so neither has to know the scene's
 * producers. All three are optional: a missing scene simply means no knot balls
 * follow and nothing is dropped.
 */
export type JointDragSceneContext = {
  hostKnots?: readonly DragHostKnot[];
  sharedJointSlotById?: ReadonlyMap<string, number> | null;
  dropOffsetZFor?: (modelId?: string) => number;
};

let session: JointDragSession | null = null;
let generation = 0;
const registrations = new Set<DragBatchHandles>();
const listeners = new Set<() => void>();

/** The current session, or null. A stable identity until begin/end/clear. */
export function getJointDragSession(): JointDragSession | null {
  return session;
}

/** The same value on the server: there is no gesture outside the client. */
export function getJointDragSessionServerSnapshot(): JointDragSession | null {
  return null;
}

export function subscribeJointDragSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Open a session for this gesture.
 *
 * Returns the slot map, or null when the gesture must stay on the detail path
 * (see `buildJointDragSlotMap`). Null is silent: the caller keeps publishing the
 * legacy preview and nothing is suppressed.
 *
 * No frame is written here: batches register themselves as they mount, and
 * `registerDragBatch` writes the session's current frame (the committed entity)
 * before that commit paints. A batch still registered from a previous gesture
 * belongs to a mount that is about to unmount, and writing a new slot map into
 * its instances would address the wrong sizes.
 */
export function beginJointDrag(options: BeginJointDragOptions): JointDragSlotMap | null {
  const slotMap = buildJointDragSlotMap(options);
  if (!slotMap) return null;

  generation += 1;
  session = {
    generation,
    slotMap,
    hosts: options.hosts ?? {},
    dropOffsetZ: options.dropOffsetZ ?? 0,
    lastPreview: options.entity,
    ended: false,
  };

  emit();
  return slotMap;
}

/**
 * Write one frame from a preview entity.
 *
 * The entity must carry the same ids as the committed one (`moveJoint` keeps
 * them); positions, the cone's aim and a segment's length are re-derived from it
 * with the same helpers the detail renderers use. The dragged joint's diameter
 * is the COMMITTED resolved one, never the scene blend, so the ball keeps the
 * size the selected detail joint has.
 *
 * Throws when there is no session or the gesture already ended: a frame after
 * release is a bug in the caller, not a frame to drop silently.
 */
export function writeJointDragFrame(entity: JointDragSlotEntity): void {
  const current = session;
  if (!current) throw new Error('writeJointDragFrame: no joint drag session');
  if (current.ended) throw new Error('writeJointDragFrame: the session has ended');

  current.lastPreview = entity;

  const touched = new Set<SupportInstanceBatch>();
  for (const handles of registrations) {
    collectJointDragWrites(current, handles, entity, touched);
  }
  flushBatches(touched);
}

/**
 * End the gesture: no further frames, and every private instance is emptied.
 *
 * Emptying the batches here (not at clear) is what makes the release frame
 * correct: the detail renderers are switched back on in the same React commit,
 * and an instance left behind would double-draw the support for a frame. The
 * scene-owned shared batch is never resized — only the balls the drag moved.
 *
 * The session itself survives so `getLastJointDragPreview` can answer the
 * commit; `clearJointDragSession` releases it one frame later.
 */
export function endJointDrag(): void {
  const current = session;
  if (!current || current.ended) return;
  // A new object, not a mutation: the batch component subscribes to the session
  // identity, and it has to re-render (and stop drawing) on this transition.
  session = { ...current, ended: true };

  const touched = new Set<SupportInstanceBatch>();
  for (const handles of registrations) {
    emptyPrivateBatch(handles.joint, touched);
    if (handles.shafts) for (const batch of handles.shafts.values()) emptyPrivateBatch(batch, touched);
    if (handles.coneBodies) for (const batch of handles.coneBodies.values()) emptyPrivateBatch(batch, touched);
    emptyPrivateBatch(handles.coneTips, touched);
    emptyPrivateBatch(handles.coneDisks, touched);
  }
  flushBatches(touched);

  // The detail renderers are switched back on in the same handler as the
  // committed store write, so the release paint shows the committed geometry
  // once — never both the drag batch and the detail primitives.
  clearPrimitiveDragSuppression();

  emit();
}

/**
 * Release the session, one frame after the commit render.
 *
 * Called from the next frame (or a `requestAnimationFrame` scheduled at
 * release): by then the committed store write and the suppression clear have
 * both painted, so the drag batch's component unmounts without a blank or a
 * double-drawn frame.
 */
export function clearJointDragSession(): void {
  // Unconditional: a dead gesture must never leave a primitive hidden, even if
  // its session was already released by an earlier frame.
  clearPrimitiveDragSuppression();
  if (!session) return;
  session = null;
  emit();
}

let scheduledClear = false;

/**
 * Schedule `clearJointDragSession` for the next frame — the release path's one
 * call. The release handler writes the store and clears suppression
 * synchronously, so that commit has rendered by the next frame; clearing in the
 * handler itself would release the session a frame early and leave the batch
 * nothing to read for the commit.
 */
export function clearJointDragSessionAfterFrame(): void {
  const scheduledGeneration = session?.generation ?? null;
  if (scheduledGeneration === null || scheduledClear) return;
  scheduledClear = true;
  const run = () => {
    scheduledClear = false;
    // A new gesture can begin inside the frame this was scheduled for (a
    // release and the next press in one tick). Clearing by generation keeps
    // that gesture's session — and its suppression — alive.
    if (session?.generation !== scheduledGeneration) return;
    clearJointDragSession();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

/** The last preview entity, for a commit that reads what the operator saw. */
export function getLastJointDragPreview<T = JointDragSlotEntity>(): T | null {
  return (session?.lastPreview as T | null | undefined) ?? null;
}

/**
 * Register a mounted batch set. Returns its disposer.
 *
 * Registration writes the session's current frame immediately: the batch mounts
 * a commit after the gesture began, so without it the first paint would show the
 * instances at identity (a unit sphere at the origin) until the next frame.
 */
export function registerDragBatch(handles: DragBatchHandles): () => void {
  registrations.add(handles);

  const current = session;
  if (current && !current.ended && current.lastPreview) {
    const touched = new Set<SupportInstanceBatch>();
    try {
      collectJointDragWrites(current, handles, current.lastPreview, touched);
      flushBatches(touched);
    } catch (error) {
      // A batch that cannot hold the session's instances must not stay in the
      // registry: every later frame would throw from inside the render loop.
      registrations.delete(handles);
      throw error;
    }
  }

  return () => {
    registrations.delete(handles);
  };
}

/** The number of mounted handle sets; exposed for the mount/unmount assertion. */
export function dragBatchRegistrationCount(): number {
  return registrations.size;
}

function emptyPrivateBatch(
  batch: SupportInstanceBatch | null | undefined,
  touched: Set<SupportInstanceBatch>,
): void {
  if (!batch) return;
  if (batch.count === 0) return;
  // Shrinking only: the data word and ratio are never appended here.
  batch.resizeTo(0, 0, 1);
  touched.add(batch);
}

function flushBatches(batches: Iterable<SupportInstanceBatch>): void {
  for (const batch of batches) batch.flush();
}

/** Two point scratches (a segment has two ends) and a cone slot: a frame is synchronous. */
const scratchStart = { x: 0, y: 0, z: 0 };
const scratchEnd = { x: 0, y: 0, z: 0 };
const scratchConeSlot: ConeBatchSlot = {
  id: '',
  supportId: '',
  pos: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
  surfaceNormal: { x: 0, y: 0, z: 0 },
  kind: 'legacy',
  lengthMm: 0,
  contactRadius: 0,
  diskThickness: 0,
  penetrationMm: 0,
};

function shiftInto(
  target: { x: number; y: number; z: number },
  point: { x: number; y: number; z: number },
  dropOffsetZ: number,
): { x: number; y: number; z: number } {
  target.x = point.x;
  target.y = point.y;
  target.z = point.z + dropOffsetZ;
  return target;
}

/**
 * Write every instance these handles own, from `entity`.
 *
 * Collected into `touched` rather than flushed here so a frame that is split
 * across handle sets (a StrictMode double registration, or a batch shared by two
 * sets) still uploads each batch exactly once.
 */
function collectJointDragWrites(
  current: JointDragSession,
  handles: DragBatchHandles,
  entity: JointDragSlotEntity,
  touched: Set<SupportInstanceBatch>,
): void {
  const slotMap = current.slotMap;
  const dropOffsetZ = current.dropOffsetZ;
  const hosts = current.hosts;

  const jointBatch = handles.joint;
  if (jointBatch) {
    for (const slot of slotMap.joints) {
      const joint = entity.segments[slot.segmentIndex]?.[slot.jointKey];
      if (!joint) continue;
      writeJointSlotMatrix(
        jointBatch,
        slot.instance,
        shiftInto(scratchStart, joint.pos, dropOffsetZ),
        slot.diameter,
      );
      touched.add(jointBatch);
    }
  }

  // Endpoints are resolved once per segment index and shared with the knot
  // balls: a knot on a segment the drag does not draw still needs its host span.
  const endpointCache = new Map<number, SegmentEndpoints | null>();
  const endpointsFor = (segmentIndex: number): SegmentEndpoints | null => {
    const cached = endpointCache.get(segmentIndex);
    if (cached !== undefined) return cached;
    const resolved = segmentEndpointsForIndex(entity, segmentIndex, hosts);
    endpointCache.set(segmentIndex, resolved);
    return resolved;
  };

  for (const slot of slotMap.segments) {
    const batch = handles.shafts?.get(slot.batchKey);
    if (!batch) continue;
    const endpoints = endpointsFor(slot.segmentIndex);
    if (!endpoints) continue;
    writeShaftSlotMatrix(batch, slot.instance, {
      start: shiftInto(scratchStart, endpoints.start, dropOffsetZ),
      end: shiftInto(scratchEnd, endpoints.end, dropOffsetZ),
      diameter: slot.diameter,
    });
    touched.add(batch);
  }

  const coneBodyBatches = handles.coneBodies;
  const coneTipBatch = handles.coneTips;
  const coneDiskBatch = handles.coneDisks;
  if (coneBodyBatches || coneTipBatch || coneDiskBatch) {
    const record = entity as unknown as Record<string, ContactCone | undefined>;
    for (const slot of slotMap.cones) {
      const cone = record[slot.field];
      if (!cone) continue;
      if (!fillConeBatchSlot(scratchConeSlot, cone, slotMap.supportId, entity.modelId)) continue;
      // The body ratio is geometry and cannot change during a joint drag: the
      // move re-aims the cone and re-measures its length, never its diameters.
      scratchConeSlot.pos.z += dropOffsetZ;

      const bodyBatch = coneBodyBatches?.get(slot.bodyKey);
      if (bodyBatch) {
        writeConeBodyMatrix(bodyBatch, slot.bodyInstance, scratchConeSlot);
        touched.add(bodyBatch);
      }
      if (coneTipBatch) {
        writeConeTipMatrix(coneTipBatch, slot.tipInstance, scratchConeSlot);
        touched.add(coneTipBatch);
      }
      if (slot.diskInstance !== undefined && coneDiskBatch) {
        const penetration = handles.resolvePenetration?.(scratchConeSlot)
          ?? scratchConeSlot.penetrationMm;
        writeConeDiskMatrix(coneDiskBatch, slot.diskInstance, scratchConeSlot, penetration);
        touched.add(coneDiskBatch);
      }
    }
  }

  const sharedJoints = handles.sharedJoints;
  if (sharedJoints) {
    for (const slot of slotMap.knotBalls) {
      if (slot.sharedInstance == null) continue;
      // A scene rebuild can renumber the shared batch's slots mid-gesture. The
      // ball then has no instance to write; freezing it for the rest of the
      // gesture is better than a RangeError inside a frame.
      if (slot.sharedInstance >= sharedJoints.count) continue;
      const endpoints = endpointsFor(slot.segmentIndex);
      const segment = entity.segments[slot.segmentIndex];
      if (!endpoints || !segment) continue;

      const t = slot.t ?? projectKnotT(slot.pos, endpoints.start, endpoints.end);
      const pos = calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, segment, t);
      writeJointSlotMatrix(
        sharedJoints,
        slot.sharedInstance,
        shiftInto(scratchStart, pos, dropOffsetZ),
        dragKnotBallDiameter(slot, segment.diameter),
      );
      touched.add(sharedJoints);
    }
  }
}
