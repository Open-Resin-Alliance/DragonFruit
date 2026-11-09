import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { DEFAULT_FILTER_TOGGLES, annotateFilterFlags, applyFilter } from '../filtering';
import type { DetectedIsland } from '../types';

const LAYER_MM = 0.05;

/** A mesh patch: `contact` is the lowest footprint pixel, `maxZ` its top. */
function patch(id: string, contactZ: number, maxZ: number): DetectedIsland {
  return {
    id,
    source: 'overhang',
    contact: new THREE.Vector3(0, 0, contactZ),
    baseZ: contactZ,
    maxZ,
    areaMm2: 500,
  };
}

/** A voxel section: starts at `baseZ` and spans `layers` layers. */
function section(id: string, baseZ: number, layers: number): DetectedIsland {
  return {
    id,
    source: 'voxel',
    contact: new THREE.Vector3(0, 0, baseZ),
    baseZ,
    layerSpan: [0, layers] as const,
    areaMm2: 40,
  };
}

const annotate = (islands: DetectedIsland[]) => annotateFilterFlags(islands, {
  supportTips: [],
  plateZ: 0,
  layerHeightMm: LAYER_MM,
});

test('a patch that only touches the plate is still unsupported, not grounded', () => {
  // The reported run: a domed underside resting on the plate. Its contact is the
  // lowest footprint pixel, at the plate, but the patch climbs 20 mm from there.
  // Reading the contact alone hid the whole patch and the part got no supports.
  const dome = patch('o0', 0, 20);
  const flatBottom = patch('o1', 0, 0);

  const annotated = annotate([dome, flatBottom]);

  assert.equal(annotated[0].grounded, false, 'a patch that rises off the plate needs support');
  assert.equal(annotated[1].grounded, true, 'a flat bottom resting on the plate is grounded');

  const visible = applyFilter(annotated, DEFAULT_FILTER_TOGGLES);
  assert.deepEqual(visible.map((island) => island.id), ['o0']);
});

test('a patch lifted clear of the plate is not grounded', () => {
  const lifted = patch('o0', 5, 25);
  assert.equal(annotate([lifted])[0].grounded, false);
});

test('a voxel section keeps the contact rule', () => {
  // A section has no `maxZ`: its contact *is* its base, so starting above the
  // plate is the whole answer.
  const section3 = section('v0', 3 * LAYER_MM, 10);
  const onPlate = section('v1', 0, 3);

  const annotated = annotate([section3, onPlate]);

  assert.equal(annotated[0].grounded, false);
  assert.equal(annotated[1].grounded, true);
});
