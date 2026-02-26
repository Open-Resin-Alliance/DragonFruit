import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { getSnapshot, loadFromLychee, resetStore, transformAllSupportsForSingleModel, transformSupportsForModel } from '../state';
import { getSupportBraceSnapshot } from '../SupportTypes/SupportBrace/supportBraceStore';
import type { DragonfruitImportFormat } from '../types';

function makeBaseData(): DragonfruitImportFormat {
  return {
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
    trunks: [
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
    ],
    branches: [],
    leaves: [],
    twigs: [],
    sticks: [],
    braces: [],
    knots: [
      {
        id: 'knot-1',
        parentShaftId: 'seg-1',
        t: 0.8,
        pos: { x: 1, y: 2, z: 8 },
        diameter: 1.1,
      },
    ],
    supportBraces: [
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
        supportBrace: {
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
    ],
  };
}

test('transformSupportsForModel keeps support roots grounded during pure Z translation', () => {
  resetStore();
  loadFromLychee(makeBaseData());

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
  const supportBraceSnapshot = getSupportBraceSnapshot();

  assert.equal(snapshot.roots['root-1']?.transform.pos.z, 0, 'Main support root should remain grounded on Z translation');
  assert.equal(snapshot.trunks['trunk-1']?.segments[0]?.topJoint?.pos.z, 15, 'Trunk top should follow model Z translation');

  assert.equal(
    supportBraceSnapshot.roots['support-brace-root-1']?.transform.pos.z,
    0,
    'Support brace root should remain grounded on Z translation',
  );
  assert.equal(
    supportBraceSnapshot.supportBraces['support-brace-1']?.segments[0]?.topJoint?.pos.z,
    11,
    'Support brace shaft should follow model Z translation',
  );
  assert.equal(
    supportBraceSnapshot.knots['support-brace-host-knot-1']?.pos.z,
    14,
    'Support brace host knot should follow model Z translation',
  );

  resetStore();
});

test('transformAllSupportsForSingleModel keeps roots grounded during pure Z translation', () => {
  resetStore();
  loadFromLychee(makeBaseData());

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
  loadFromLychee(makeBaseData());

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
