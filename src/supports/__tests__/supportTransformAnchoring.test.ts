import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { getSnapshot, loadFromImportFormat, resetStore, transformAllSupportsForSingleModel, transformSupportsForModel } from '../state';
import {
  getSupportTypeDescriptor,
  SUPPORT_COLLECTION_KEYS,
  type SupportCollectionKey,
  type SupportTypeId,
} from '../supportTypeRegistry';
import { readKickstands } from './helpers/kickstandFixture';
import type { DragonfruitImportFormat, SupportCollectionByType } from '../types';

/**
 * A payload keys a support collection by its NAME, and that name is the
 * registry's to declare: spelling `twigs`/`sticks` here would make renaming a
 * type edit this fixture too. Laying the empty keys down from
 * `SUPPORT_COLLECTION_KEYS`, and filling the rest through the type that declares
 * them, keeps a rename a registry-only edit.
 *
 * `roots` and `knots` are primitives -- no type declares them and no rename
 * reaches them -- so the literal names those two keys directly.
 */
function emptyWireCollections(): Pick<DragonfruitImportFormat, SupportCollectionKey> {
  const collections = {} as Record<string, unknown[]>;
  for (const key of SUPPORT_COLLECTION_KEYS) collections[key] = [];
  return collections as unknown as Pick<DragonfruitImportFormat, SupportCollectionKey>;
}

/** What the wire format carries under a type's collection key. */
type WireEntities<K extends SupportTypeId> =
  DragonfruitImportFormat[SupportCollectionByType[K] & keyof DragonfruitImportFormat];

/**
 * Fill one collection, keyed by the TYPE that declares it. The key comes from
 * the registry, and the rows are still checked against what that key carries.
 */
function setCollection<K extends SupportTypeId>(
  payload: DragonfruitImportFormat,
  typeId: K,
  entities: WireEntities<K>,
): void {
  (payload as unknown as Record<string, unknown>)[getSupportTypeDescriptor(typeId).location.key] = entities;
}

function makeBaseData(): DragonfruitImportFormat {
  const payload: DragonfruitImportFormat = {
    ...emptyWireCollections(),
    version: 1,
    meta: {
      source: 'unit-test',
      objectCenter: { x: 0, y: 0, z: 0 },
    },
    roots: [
      {
        id: 'root-1',
        modelId: 'model-1',
        transform: {
          pos: { x: 1, y: 2, z: 0 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 4,
        diskHeight: 0.5,
        coneHeight: 1,
      },
    ],
    knots: [
      {
        id: 'knot-1',
        parentShaftId: 'seg-1',
        t: 0.8,
        pos: { x: 1, y: 2, z: 8 },
        diameter: 1.1,
      },
    ],
  };

  setCollection(payload, 'trunk', [
    {
      id: 'trunk-1',
      modelId: 'model-1',
      rootId: 'root-1',
      segments: [
        {
          id: 'seg-1',
          type: 'straight',
          diameter: 1,
          topJoint: {
            id: 'seg-1-top',
            pos: { x: 1, y: 2, z: 10 },
            diameter: 1,
          },
        },
      ],
    },
  ]);

  setCollection(payload, 'kickstand', [
    {
      root: {
        id: 'support-brace-root-1',
        modelId: 'model-1',
        transform: {
          pos: { x: 3, y: -2, z: 0 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 2,
        diskHeight: 0.4,
        coneHeight: 0.7,
      },
      hostKnot: {
        id: 'support-brace-host-knot-1',
        parentShaftId: 'seg-1',
        t: 0.9,
        pos: { x: 1, y: 2, z: 9 },
        diameter: 1,
      },
      kickstand: {
        id: 'support-brace-1',
        modelId: 'model-1',
        rootId: 'support-brace-root-1',
        hostKnotId: 'support-brace-host-knot-1',
        hostSegmentId: 'seg-1',
        hostMinT: 0,
        segments: [
          {
            id: 'support-brace-seg-1',
            type: 'straight',
            diameter: 0.7,
            bottomJoint: {
              id: 'support-brace-j0',
              pos: { x: 3, y: -2, z: 2 },
              diameter: 0.8,
            },
            topJoint: {
              id: 'support-brace-j1',
              pos: { x: 2, y: 0, z: 6 },
              diameter: 0.8,
            },
          },
        ],
        profile: {
          bodyDiameterMm: 0.7,
          terminalStartDiameterMm: 0.7,
          terminalEndDiameterMm: 0.9,
        },
      },
    },
  ]);

  return payload;
}

test('transformSupportsForModel keeps support roots grounded during pure Z translation', () => {
  resetStore();
  loadFromImportFormat(makeBaseData());

  const before = {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };
  const after = {
    position: new THREE.Vector3(0, 0, 5),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };

  transformSupportsForModel('model-1', before, after);

  const snapshot = getSnapshot();
  const kickstandSnapshot = readKickstands();

  assert.equal(snapshot.roots['root-1']?.transform.pos.z, 0, 'Main support root should remain grounded on Z translation');
  assert.equal(snapshot.trunks['trunk-1']?.segments[0]?.topJoint?.pos.z, 15, 'Trunk top should follow model Z translation');

  assert.equal(
    kickstandSnapshot.roots['support-brace-root-1']?.transform.pos.z,
    0,
    'Kickstand root should remain grounded on Z translation',
  );
  assert.equal(
    kickstandSnapshot.kickstands['support-brace-1']?.segments[0]?.topJoint?.pos.z,
    11,
    'Kickstand shaft should follow model Z translation',
  );
  assert.equal(
    kickstandSnapshot.knots['support-brace-host-knot-1']?.pos.z,
    14,
    'Kickstand host knot should follow model Z translation',
  );

  resetStore();
});

test('transformAllSupportsForSingleModel keeps roots grounded during pure Z translation', () => {
  resetStore();
  loadFromImportFormat(makeBaseData());

  const before = {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };
  const after = {
    position: new THREE.Vector3(4, -3, 2),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };

  transformAllSupportsForSingleModel(before, after);

  const snapshot = getSnapshot();
  assert.equal(snapshot.roots['root-1']?.transform.pos.x, 5, 'Root should follow X translation');
  assert.equal(snapshot.roots['root-1']?.transform.pos.y, -1, 'Root should follow Y translation');
  assert.equal(snapshot.roots['root-1']?.transform.pos.z, 0, 'Root should remain grounded in Z');

  resetStore();
});

test('transformSupportsForModel preserves full root transform behavior for rotation/scale changes', () => {
  resetStore();
  loadFromImportFormat(makeBaseData());

  const before = {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };
  const after = {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(Math.PI / 2, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };

  transformSupportsForModel('model-1', before, after);

  const snapshot = getSnapshot();
  const transformedRoot = snapshot.roots['root-1']?.transform.pos;

  assert.ok(transformedRoot, 'Expected transformed root to exist');
  assert.notEqual(transformedRoot?.z, 0, 'Root Z should be transformed when transform includes rotation');

  resetStore();
});
