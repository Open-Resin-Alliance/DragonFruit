import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { getSnapshot, resetStore } from '../state';
import {
  captureModelSupportsToClipboard,
  pasteModelSupports,
  pasteModelSupportsFromClipboard,
  type SupportClipboardPayload,
} from '../PlacementLogic/supportClipboard';
import { collectionEntries, emptyPayload, entitiesIn, keyOf, owningTypeId, setCollection } from './helpers/typeCollections';
import {
  SUPPORT_COLLECTION_KEYS,
  SUPPORT_TYPES,
  contactEndpointsFor,
  defaultPlacementToolTypeId,
  getSupportTypeDescriptor,
  type SupportCollectionKey,
  type SupportEdge,
  type SupportTypeDescriptor,
} from '../supportTypeRegistry';
import type { Knot, Roots } from '../types';

const SOURCE_MODEL_ID = 'model-source';
const TARGET_MODEL_ID = 'model-target';

/**
 * The payload is built from what each type declares, so every declared type is
 * covered rather than a hand-picked one.
 */

function makeVec3(x: number, y: number, z: number) {
  return { x, y, z };
}

function makeDiskProfile() {
  return {
    type: 'disk' as const,
    contactDiameterMm: 0.4,
    bodyDiameterMm: 1.2,
    lengthMm: 3,
    penetrationMm: 0.05,
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.25,
    standoffAngleThreshold: Math.PI / 4,
  };
}

/** The parts of a pasted entity the assertions below read. */
interface PastedSegment {
  id: string;
  bottomJoint?: { id?: string };
  topJoint?: { id?: string };
}

/** A shaft as the geometry assertions read it: its joints' positions. */
interface PositionedSegment {
  bottomJoint?: { pos?: { x: number; y: number; z: number } };
  topJoint?: { pos?: { x: number; y: number; z: number } };
}

/** The id a type's own entity carries in the payload. */
const sourceIdFor = (descriptor: SupportTypeDescriptor) => `${descriptor.id}-source`;

/** The id of the one segment a shafted type's entity carries. */
const sourceSegmentIdFor = (descriptor: SupportTypeDescriptor) => `${sourceIdFor(descriptor)}-s`;

/** The root a type's edge into `roots` claims. */
const sourceRootIdFor = (descriptor: SupportTypeDescriptor) => `${descriptor.id}-root-source`;

/** The knot a type's edge into `knots` hangs from. */
const sourceKnotIdFor = (descriptor: SupportTypeDescriptor, edge: SupportEdge) =>
  `${descriptor.id}-${edge.field}-knot-source`;

/** The shaft every knot rides: the default placement tool's own segment. */
const HOST_DESCRIPTOR = getSupportTypeDescriptor(defaultPlacementToolTypeId());
const HOST_SEGMENT_ID = sourceSegmentIdFor(HOST_DESCRIPTOR);

/** Which id a knot's `parentShaftId` names, past whatever prefix declares it. */
function knotHostOwnerId(parentShaftId: string): string {
  for (const descriptor of SUPPORT_TYPES) {
    if (descriptor.knotHostPrefix && parentShaftId.startsWith(descriptor.knotHostPrefix)) {
      return parentShaftId.slice(descriptor.knotHostPrefix.length);
    }
  }
  return parentShaftId;
}

const sourceSegment = (id: string) => ({
  id,
  type: 'straight' as const,
  diameter: 1,
  bottomJoint: { id: `${id}-bottom-joint`, pos: makeVec3(0, 0, 1), diameter: 1.1 },
  topJoint: { id: `${id}-top-joint`, pos: makeVec3(0, 0, 6), diameter: 1.1 },
});

/** A contact of the kind the type declares: a cone sits on a joint, a disk does not. */
const sourceContact = (ownerId: string, field: string, isDisk: boolean) => (isDisk
  ? {
    id: `${ownerId}-${field}`,
    pos: makeVec3(0, 0, 8),
    surfaceNormal: makeVec3(0, 0, 1),
    coneAxis: makeVec3(0, 0, 1),
    contactDiameterMm: 0.4,
    profile: makeDiskProfile(),
  }
  : {
    id: `${ownerId}-${field}`,
    pos: makeVec3(0, 0, 8),
    normal: makeVec3(0, 0, 1),
    surfaceNormal: makeVec3(0, 0, 1),
    socketJointId: `${ownerId}-${field}-joint`,
    profile: {
      type: 'cone' as const,
      contactDiameterMm: 0.4,
      bodyDiameterMm: 0.8,
      lengthMm: 3,
      penetrationMm: 0.05,
    },
  });

const sourceRoot = (id: string, x: number): Roots => ({
  id,
  modelId: SOURCE_MODEL_ID,
  transform: {
    pos: makeVec3(x, 0, 0),
    rot: { x: 0, y: 0, z: 0, w: 1 },
  },
  diameter: 3,
  diskHeight: 0.8,
  coneHeight: 1.2,
});

const sourceKnot = (id: string, parentShaftId: string, t: number): Knot => ({
  id,
  parentShaftId,
  t,
  pos: makeVec3(0, 0, t * 8),
  diameter: 0.9,
});

/** One type's source entity: its shaft, declared contacts, and one id per edge. */
function sourceEntityFor(descriptor: SupportTypeDescriptor): Record<string, unknown> {
  const id = sourceIdFor(descriptor);
  const entity: Record<string, unknown> = { id, modelId: SOURCE_MODEL_ID };

  if (descriptor.hasSegments) entity.segments = [sourceSegment(sourceSegmentIdFor(descriptor))];

  const kindByField = new Map(contactEndpointsFor(descriptor.id).map(({ field, kind }) => [field, kind]));
  for (const field of descriptor.contactFields) {
    entity[field] = sourceContact(id, field, kindByField.get(field) === 'disk');
  }

  for (const edge of descriptor.edges) {
    entity[edge.field] = edge.to === 'roots'
      ? sourceRootIdFor(descriptor)
      : edge.to === 'knots'
        ? sourceKnotIdFor(descriptor, edge)
        : HOST_SEGMENT_ID;
  }

  return entity;
}

function makePayload(): SupportClipboardPayload {
  const payload = emptyPayload();
  const roots: Roots[] = [];
  const knots: Knot[] = [];
  const kickstandRoots: Roots[] = [];
  const kickstandKnots: Knot[] = [];

  let rootX = 0;

  for (const descriptor of SUPPORT_TYPES) {
    setCollection(payload, descriptor.id, [sourceEntityFor(descriptor) as never]);

    // A type riding another's shaft brings its root and host knot through the
    // payload's dedicated channels as well as the shared ones.
    const ridesHostShaft = descriptor.edges.some((edge) => edge.to === 'segment');

    for (const edge of descriptor.edges) {
      if (edge.to === 'roots') {
        const root = sourceRoot(sourceRootIdFor(descriptor), (rootX += 3));
        roots.push(root);
        if (ridesHostShaft) kickstandRoots.push(root);
      } else if (edge.to === 'knots') {
        const knot = sourceKnot(sourceKnotIdFor(descriptor, edge), HOST_SEGMENT_ID, 0.2);
        knots.push(knot);
        if (ridesHostShaft) kickstandKnots.push(knot);
      }
    }

    // A type that addresses its own contact by a prefix puts a knot on that
    // pseudo-shaft rather than on a real segment.
    if (descriptor.knotHostPrefix) {
      const prefix = descriptor.knotHostPrefix;
      knots.push(sourceKnot(
        `${descriptor.id}-pseudo-knot-source`,
        `${prefix}${sourceIdFor(descriptor)}`,
        0.8,
      ));
    }
  }

  payload.roots = roots;
  payload.knots = knots;
  payload.kickstandRoots = kickstandRoots;
  payload.kickstandKnots = kickstandKnots;

  return payload;
}

describe('support clipboard remap isolation', () => {
  beforeEach(() => {
    resetStore();
  });

  it('never keeps source graph IDs in pasted references', () => {
    const payload = makePayload();

    const sourceTransform = {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };

    const targetTransform = {
      position: new THREE.Vector3(10, 10, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };

    const pastedCount = pasteModelSupportsFromClipboard(payload, TARGET_MODEL_ID, sourceTransform, targetTransform);
    assert.ok(pastedCount > 0);

    const state = getSnapshot();

    // Walked, not listed, so every declared collection's ids are compared and a
    // source id cannot collide with a pasted one unnoticed.
    const sourceIds = new Set<string>();
    const sourceJointIds = new Set<string>();
    for (const [key, entities] of collectionEntries(payload)) {
      for (const item of entities) {
        sourceIds.add(item.id);
        for (const segment of item.segments ?? []) {
          sourceIds.add(segment.id);
          if (segment.bottomJoint?.id) sourceJointIds.add(segment.bottomJoint.id);
          if (segment.topJoint?.id) sourceJointIds.add(segment.topJoint.id);
        }
      }
      // A type's contact endpoints are what it declares. Only the cone contacts
      // carry a joint, and the registry says which fields those are.
      const typeId = owningTypeId(key);
      if (!typeId) continue;
      for (const { kind, field } of contactEndpointsFor(typeId)) {
        if (kind !== 'cone') continue;
        for (const item of entities) {
          const contact = item[field] as { socketJointId?: string } | undefined;
          if (contact?.socketJointId) sourceJointIds.add(contact.socketJointId);
        }
      }
    }
    for (const item of payload.kickstandRoots) sourceIds.add(item.id);
    for (const item of payload.kickstandKnots) sourceIds.add(item.id);

    /** A pasted id must be one the paste minted, never one the source handed over. */
    const freshId = (id: unknown, what: string) => {
      assert.equal(typeof id, 'string', `${what}: expected an id, found ${String(id)}`);
      assert.ok(!sourceIds.has(id as string), `${what}: kept the source id ${String(id)}`);
    };

    /** A pasted joint must be one the paste minted, never one the source handed over. */
    const freshJoint = (id: string, what: string) => {
      assert.ok(!sourceJointIds.has(id), `${what}: kept the source joint ${id}`);
    };

    // What a pasted reference may legally point at, read back out of the state:
    // one member set per collection, plus every stored segment id.
    const storedIds = new Map<SupportCollectionKey | 'segment', Set<string>>();
    for (const key of SUPPORT_COLLECTION_KEYS) {
      const members = (state as unknown as Record<string, Record<string, unknown>>)[key] ?? {};
      storedIds.set(key, new Set(Object.keys(members)));
    }

    const storedSegmentIds = new Set<string>();
    for (const descriptor of SUPPORT_TYPES) {
      if (!descriptor.hasSegments) continue;
      for (const entity of entitiesIn<{ segments?: PastedSegment[] }>(state, descriptor.location.key)) {
        for (const segment of entity.segments ?? []) storedSegmentIds.add(segment.id);
      }
    }
    storedIds.set('segment', storedSegmentIds);

    // Every declared type, not the ones a hand-written fixture happened to
    // fill: a collection nobody checks is a collection whose source ids can
    // survive a paste unnoticed.
    let checked = 0;
    for (const descriptor of SUPPORT_TYPES) {
      const kindByField = new Map(contactEndpointsFor(descriptor.id).map(({ field, kind }) => [field, kind]));
      const pasted = entitiesIn<Record<string, unknown>>(state, descriptor.location.key)
        .filter((entity) => entity.modelId === TARGET_MODEL_ID);
      assert.ok(pasted.length > 0, `${descriptor.id}: the paste wrote nothing to ${descriptor.location.key}`);

      for (const entity of pasted) {
        checked += 1;
        freshId(entity.id, `${descriptor.id} id`);

        for (const segment of (entity.segments ?? []) as PastedSegment[]) {
          freshId(segment.id, `${descriptor.id} segment`);
          if (segment.bottomJoint?.id) freshJoint(segment.bottomJoint.id, `${descriptor.id} bottom joint`);
          if (segment.topJoint?.id) freshJoint(segment.topJoint.id, `${descriptor.id} top joint`);
        }

        for (const field of descriptor.contactFields) {
          // Only a cone names a joint it sits on; a disk's contact IS its
          // surface.
          const contact = entity[field] as { socketJointId?: string } | undefined;
          if (kindByField.get(field) === 'cone' && contact?.socketJointId) {
            freshJoint(contact.socketJointId, `${descriptor.id}.${field}`);
          }
        }

        // Every id-bearing field the type declares, and the collection it points
        // into: a fresh id that lands outside the collection it names is still a
        // broken graph.
        for (const edge of descriptor.edges) {
          const value = entity[edge.field];
          freshId(value, `${descriptor.id}.${edge.field}`);
          assert.ok(
            storedIds.get(edge.to)?.has(value as string),
            `${descriptor.id}.${edge.field}: points at nothing pasted`,
          );
        }
      }
    }
    assert.ok(checked >= SUPPORT_TYPES.length, `only ${checked} pasted entities were checked`);

    for (const root of Object.values(state.roots)) {
      assert.ok(!sourceIds.has(root.id), `root ${root.id} kept a source id`);
    }

    // A knot rides a real segment, or a pseudo-shaft its owner addresses by a
    // declared prefix. Both prefixes come from the registry.
    for (const knot of Object.values(state.knots)) {
      assert.ok(!sourceIds.has(knot.id), `knot ${knot.id} kept a source id`);
      freshId(knotHostOwnerId(knot.parentShaftId), `host of knot ${knot.id}`);
    }
  });

  it('captures clipboard payload for source model', () => {
    const payload = makePayload();

    const sourceTransform = {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };

    const targetTransform = {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };

    pasteModelSupportsFromClipboard(payload, SOURCE_MODEL_ID, sourceTransform, targetTransform);
    const captured = captureModelSupportsToClipboard(SOURCE_MODEL_ID);

    assert.ok(captured);
    // Every declared type, not just the two a hand-written assertion named: a
    // type the capture drops is a type that vanishes on a copy.
    for (const descriptor of SUPPORT_TYPES) {
      assert.ok(
        entitiesIn(captured!, keyOf(descriptor.id)).length > 0,
        `${descriptor.id}: nothing captured for ${descriptor.location.key}`,
      );
    }
    assert.ok((captured?.roots.length ?? 0) > 0);
    assert.ok((captured?.knots.length ?? 0) > 0);
  });

  it('lands a pasted copy at the target transform', () => {
    const payload = makePayload();

    const sourceTransform = {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };
    const targetTransform = {
      position: new THREE.Vector3(10, 10, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };

    pasteModelSupportsFromClipboard(payload, TARGET_MODEL_ID, sourceTransform, targetTransform);

    const state = getSnapshot();
    const moved = (pos: { x: number; y: number; z: number }) => `${pos.x + 10}|${pos.y + 10}|${pos.z}`;
    const at = (pos: { x: number; y: number; z: number }) => `${pos.x}|${pos.y}|${pos.z}`;
    const sorted = (values: string[]) => [...values].sort();

    // Every declared type, walked the way the payload was built: a move has to
    // carry its shaft joints and its declared contacts, or a copy is detached
    // geometry sitting at the source's transform.
    for (const descriptor of SUPPORT_TYPES) {
      const source = sourceEntityFor(descriptor);
      const pasted = entitiesIn<Record<string, unknown>>(state, descriptor.location.key)
        .filter((entity) => entity.modelId === TARGET_MODEL_ID);
      assert.equal(pasted.length, 1, `${descriptor.id}: expected one pasted entity`);
      const entity = pasted[0];

      const sourceSegments = (source.segments ?? []) as PositionedSegment[];
      const pastedSegments = (entity.segments ?? []) as PositionedSegment[];
      assert.equal(pastedSegments.length, sourceSegments.length, `${descriptor.id}: shaft length`);

      pastedSegments.forEach((segment, index) => {
        const sourceSegment = sourceSegments[index];
        for (const joint of ['bottomJoint', 'topJoint'] as const) {
          const pastedJoint = segment[joint];
          const sourceJoint = sourceSegment[joint];
          assert.ok(pastedJoint?.pos && sourceJoint?.pos, `${descriptor.id}.${joint}: no position`);
          assert.equal(at(pastedJoint.pos), moved(sourceJoint.pos), `${descriptor.id}.${joint} position`);
        }
      });

      for (const { field } of contactEndpointsFor(descriptor.id)) {
        const pastedContact = entity[field] as { pos?: { x: number; y: number; z: number } } | undefined;
        const sourceContact = source[field] as { pos?: { x: number; y: number; z: number } } | undefined;
        assert.ok(pastedContact?.pos && sourceContact?.pos, `${descriptor.id}.${field}: no position`);
        assert.equal(at(pastedContact.pos), moved(sourceContact.pos), `${descriptor.id}.${field} position`);
      }
    }

    // Roots and knots are compared as multisets: a payload carries the same
    // root through both its own channel and its kickstand's.
    assert.deepEqual(
      sorted(Object.values(state.roots).map((root) => at(root.transform.pos))),
      sorted([...payload.roots, ...payload.kickstandRoots].map((root) => moved(root.transform.pos))),
      'root positions',
    );
    assert.deepEqual(
      sorted(Object.values(state.knots).map((knot) => at(knot.pos))),
      sorted([...payload.knots, ...payload.kickstandKnots].map((knot) => moved(knot.pos))),
      'knot positions',
    );
  });

  it('pastes every target of one call at its own transform', () => {
    const payload = makePayload();
    const sourceTransform = {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };
    const targetTransformAt = (x: number, y: number) => ({
      position: new THREE.Vector3(x, y, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    });

    const pastedCount = pasteModelSupports([
      { payload, targetModelId: 'batch-x', sourceTransform, targetTransform: targetTransformAt(10, 0) },
      { payload, targetModelId: 'batch-y', sourceTransform, targetTransform: targetTransformAt(0, 20) },
    ]);
    assert.ok(pastedCount > 0);

    const state = getSnapshot();
    const hostDescriptor = getSupportTypeDescriptor(defaultPlacementToolTypeId());
    const sourceJointPos = ((sourceEntityFor(hostDescriptor).segments ?? []) as PositionedSegment[])[0].topJoint?.pos;
    assert.ok(sourceJointPos, 'the payload has no host shaft to compare against');

    for (const [modelId, dx, dy] of [['batch-x', 10, 0], ['batch-y', 0, 20]] as const) {
      const pasted = entitiesIn<Record<string, unknown>>(state, hostDescriptor.location.key)
        .filter((entity) => entity.modelId === modelId);
      assert.ok(pasted.length > 0, `${modelId}: nothing pasted`);

      for (const entity of pasted) {
        for (const segment of (entity.segments ?? []) as PositionedSegment[]) {
          assert.deepEqual(
            segment.topJoint?.pos,
            { x: sourceJointPos.x + dx, y: sourceJointPos.y + dy, z: sourceJointPos.z },
            `${modelId}: shaft joint`,
          );
        }
      }
    }
  });
});
