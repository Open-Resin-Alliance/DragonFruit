import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import { DEFAULT_FILTER_TOGGLES, annotateFilterFlags, applyFilter } from '@/volumeAnalysis/Islands/filtering';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import type { AutoPlaceResult } from '../autoSupport/types';
import { runAutoPlace } from '../autoSupport/autoPlace';
import { resetStore, resetKickstandsInState } from '../state';
import { clearHistory } from '../../history/historyStore';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';

/**
 * A part resting on the plate. Its domed underside touches the plate at the
 * lowest point of the patch and climbs from there, which is the case the island
 * grounding rule used to get wrong: the filter read the patch's contact (its
 * lowest footprint pixel, at the plate) and hid the whole patch, so the run saw
 * almost no islands and placed almost nothing. The same part lifted 5 mm got a
 * full forest.
 */

const LAYER_MM = 0.05;

/**
 * A 24 mm round patch whose surface climbs away from its lowest point, the way
 * the classifier's footprint mask carries a dome's surface Z. `contactZ` is the
 * height of that lowest point above the plate.
 */
function domedUnderside(contactZ: number): DetectedIsland {
  const voxels: Array<{ x: number; y: number; z: number }> = [];
  for (let x = -12; x <= 12; x += 0.5) {
    for (let y = -12; y <= 12; y += 0.5) {
      const rSq = x * x + y * y;
      if (rSq <= 144) voxels.push({ x, y, z: contactZ + rSq / 8 });
    }
  }
  return {
    id: 'o0',
    source: 'overhang',
    contact: new THREE.Vector3(0, 0, contactZ),
    baseZ: contactZ,
    maxZ: contactZ + 18,
    areaMm2: 450,
    overhangAngleDeg: 20,
    surfaceNormal: { x: 0, y: 0, z: -0.94 },
    contactVoxels: footprintFromPoints(voxels),
  };
}

/** The island list the Auto-Support panel hands the run. */
function islandsAsPanelSeesThem(islands: DetectedIsland[]): DetectedIsland[] {
  const annotated = annotateFilterFlags(islands.map((island) => ({ ...island })), {
    supportTips: [],
    plateZ: 0,
    layerHeightMm: LAYER_MM,
  });
  return applyFilter(annotated, DEFAULT_FILTER_TOGGLES);
}

function placedTotal(result: AutoPlaceResult): number {
  return Object.values(result.placed).reduce((sum, count) => sum + count, 0);
}

test('a domed underside on the plate reaches placement and gets supports', () => {
  resetStore();
  resetKickstandsInState();
  clearHistory();
  const disposeHandlers = registerSupportHistoryHandlers();

  const onPlate = islandsAsPanelSeesThem([domedUnderside(0.5)]);
  assert.equal(onPlate.length, 1, 'the patch is not hidden as plate contact');

  const result = runAutoPlace(onPlate, 'model-a');

  assert.ok(placedTotal(result) > 0, `the dome got ${placedTotal(result)} supports`);
  assert.equal(result.changed, true);

  disposeHandlers();
});

test('the same dome lifted clear of the plate also places supports', () => {
  resetStore();
  resetKickstandsInState();
  clearHistory();
  const disposeHandlers = registerSupportHistoryHandlers();

  const visible = islandsAsPanelSeesThem([domedUnderside(5)]);
  assert.equal(visible.length, 1);

  const result = runAutoPlace(visible, 'model-a');
  assert.ok(placedTotal(result) > 0, `the lifted dome got ${placedTotal(result)} supports`);

  disposeHandlers();
});
