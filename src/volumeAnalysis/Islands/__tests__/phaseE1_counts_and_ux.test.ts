import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { annotateAndCountSupports, buildIslandContactGrid } from '../contactGrid';
import {
  DEFAULT_FILTER_TOGGLES,
  MULTI_SUPPORT_AREA_THRESHOLD_MM2,
  applyFilter,
  isIslandEffectivelySupported,
  isIslandHiddenBySupport,
  type IslandFilterOptions,
} from '../filtering';
import type { DetectedIsland, TipInfo } from '../types';
import { selectSpacedSubApexes, sortIslandsByBaseZ } from '../useIslands';
import { footprintFromPoints } from '../voxelFootprint';

function makeIsland(overrides: Partial<DetectedIsland> & { id: string }): DetectedIsland {
  return {
    source: 'voxel',
    contact: new THREE.Vector3(0, 0, 5),
    baseZ: 5,
    areaMm2: 0.2,
    ...overrides,
  };
}

test('contactGrid: tip landing on snapped mj.contact outside contactVoxels counts toward supportCount', () => {
  // Voxel footprint sits at X = 0..0.2, while matched minima snapped contact to X = 0.7 (0.5 mm outside footprint).
  // Tip at X = 0.7 with diameter 0.4 mm (actualRadius = 0.35 mm) misses all footprint voxels,
  // so it only matches if island.contact itself is indexed in the contact grid.
  const snappedIntersection = makeIsland({
    id: 'v0',
    class: 'intersection',
    matchedWith: 'm0',
    contact: new THREE.Vector3(0.7, 0, 5),
    baseZ: 5,
    areaMm2: 0.2,
    contactVoxels: footprintFromPoints([
      { x: 0, y: 0, z: 5 },
      { x: 0.05, y: 0, z: 5 },
    ]),
  });

  const grid = buildIslandContactGrid([snappedIntersection]);
  const tips: TipInfo[] = [{ pos: new THREE.Vector3(0.7, 0, 5), diameterMm: 0.4 }];
  const [annotated] = annotateAndCountSupports([snappedIntersection], grid, tips, 0, 4.0, 0.05);

  assert.equal(annotated.supportCount, 1);
  assert.equal(annotated.supported, true);
  assert.equal(annotated.fullySupported, true);
});

test('contactGrid: tips landing on subApexes count in both footprint and non-footprint branches and deduplicate per tip', () => {
  const withFootprint = makeIsland({
    id: 'v1',
    class: 'intersection',
    matchedWith: 'm1',
    contact: new THREE.Vector3(0, 0, 5),
    baseZ: 5,
    areaMm2: 8.0, // requiredSupports = 2 when areaPerSupport = 4.0
    contactVoxels: footprintFromPoints([{ x: 0, y: 0, z: 5 }]),
    subApexes: [
      { x: 3, y: 0, z: 5 },
      { x: 3.1, y: 0, z: 5 }, // same tip covers both sub-apexes -> must deduplicate to 1 for that tip
      { x: Number.NaN, y: 0, z: 5 },
    ],
  });

  const withoutFootprint = makeIsland({
    id: 'v2',
    class: 'intersection',
    matchedWith: 'm2',
    contact: new THREE.Vector3(10, 0, 5),
    baseZ: 5,
    areaMm2: 6.0, // requiredSupports = 2 when areaPerSupport = 4.0
    subApexes: [{ x: 14, y: 0, z: 5 }],
  });

  const grid = buildIslandContactGrid([withFootprint, withoutFootprint]);
  const singleSubApexTips: TipInfo[] = [
    { pos: new THREE.Vector3(3.05, 0, 5), diameterMm: 0.4 },
    { pos: new THREE.Vector3(14, 0, 5), diameterMm: 0.4 },
  ];

  const firstPass = annotateAndCountSupports([withFootprint, withoutFootprint], grid, singleSubApexTips, 0, 4.0, 0.05);
  assert.equal(firstPass[0].supportCount, 1, 'one tip hitting two nearby subApexes deduplicates per islandIndex');
  assert.equal(firstPass[0].supported, true);
  assert.equal(firstPass[0].fullySupported, false);
  assert.equal(firstPass[1].supportCount, 1, 'non-footprint branch indexes finite subApexes');
  assert.equal(firstPass[1].supported, true);
  assert.equal(firstPass[1].fullySupported, false);

  const secondPass = annotateAndCountSupports(
    [withFootprint, withoutFootprint],
    grid,
    [
      ...singleSubApexTips,
      { pos: new THREE.Vector3(0, 0, 5), diameterMm: 0.4 },
      { pos: new THREE.Vector3(10, 0, 5), diameterMm: 0.4 },
    ],
    0,
    4.0,
    0.05,
  );
  assert.equal(secondPass[0].supportCount, 2);
  assert.equal(secondPass[0].fullySupported, true);
  assert.equal(secondPass[1].supportCount, 2);
  assert.equal(secondPass[1].fullySupported, true);
});

test('filtering: multi-support threshold 0.5 mm² and consolidateVoxel/removeSupportedAreaClusters gating', () => {
  assert.equal(MULTI_SUPPORT_AREA_THRESHOLD_MM2, 0.5);

  const smallSupported = makeIsland({
    id: 'v-small',
    areaMm2: 0.5,
    supported: true,
    fullySupported: false,
    grounded: false,
  });
  const largePartial = makeIsland({
    id: 'v-large-partial',
    areaMm2: 0.51,
    supported: true,
    fullySupported: false,
    grounded: false,
  });
  const largeFull = makeIsland({
    id: 'v-large-full',
    areaMm2: 4.5,
    supported: true,
    fullySupported: true,
    grounded: false,
  });
  const legacyNoFullyField = makeIsland({
    id: 'v-legacy',
    areaMm2: 5.0,
    supported: true,
    grounded: false,
  });
  const missingAreaSupported = makeIsland({
    id: 'v-undef-area',
    areaMm2: undefined,
    supported: true,
    fullySupported: false,
    grounded: false,
  });
  const groundedUnsupported = makeIsland({
    id: 'v-grounded',
    areaMm2: 0.2,
    supported: false,
    grounded: true,
  });

  assert.equal(isIslandEffectivelySupported(smallSupported), true, '<= 0.5 mm² hides on supported');
  assert.equal(isIslandEffectivelySupported(largePartial), false, '> 0.5 mm² requires fullySupported');
  assert.equal(isIslandEffectivelySupported(largeFull), true);
  assert.equal(isIslandEffectivelySupported(legacyNoFullyField), true, 'falls back to Boolean(supported) when fullySupported omitted');
  assert.equal(isIslandEffectivelySupported(missingAreaSupported), true, 'undefined areaMm2 falls back to <= 0.5 mm² rule and uses supported');

  // Default 2-arg caller keeps largePartial, hides smallSupported, largeFull, groundedUnsupported
  const defaultVisible = applyFilter(
    [smallSupported, largePartial, largeFull, groundedUnsupported],
    DEFAULT_FILTER_TOGGLES,
  );
  assert.deepEqual(defaultVisible.map((i) => i.id), ['v-large-partial']);

  // showAlreadySupported overrides both <= 0.5 and > 0.5
  const showSupportedVisible = applyFilter(
    [smallSupported, largePartial, largeFull],
    { showAlreadySupported: true, showPlateContact: false },
  );
  assert.deepEqual(showSupportedVisible.map((i) => i.id), ['v-small', 'v-large-partial', 'v-large-full']);

  const contouredIds = new Set(['v-large-full', 'v-large-partial']);
  // Unconsolidated contouredIds MUST NOT retain supported clusters forever
  const unconsolidatedOpts: IslandFilterOptions = {
    contouredIds,
    consolidateVoxel: false,
    removeSupportedAreaClusters: false,
  };
  assert.equal(isIslandHiddenBySupport(largeFull, DEFAULT_FILTER_TOGGLES, unconsolidatedOpts), true);
  assert.equal(isIslandHiddenBySupport(largePartial, DEFAULT_FILTER_TOGGLES, unconsolidatedOpts), false);

  // Consolidated + contoured retains supported clusters unless removeSupportedAreaClusters is true
  const consolidatedKeepOpts: IslandFilterOptions = {
    contouredIds,
    consolidateVoxel: true,
    removeSupportedAreaClusters: false,
  };
  assert.equal(isIslandHiddenBySupport(largeFull, DEFAULT_FILTER_TOGGLES, consolidatedKeepOpts), false);

  const consolidatedRemoveOpts: IslandFilterOptions = {
    contouredIds,
    consolidateVoxel: true,
    removeSupportedAreaClusters: true,
  };
  assert.equal(isIslandHiddenBySupport(largeFull, DEFAULT_FILTER_TOGGLES, consolidatedRemoveOpts), true);
  assert.equal(isIslandHiddenBySupport(largePartial, DEFAULT_FILTER_TOGGLES, consolidatedRemoveOpts), false);
});

test('selectSpacedSubApexes: enforces >= 0.8 mm 3D spacing and rejects non-finite points', () => {
  const primary = { x: 0, y: 0, z: 5 };
  assert.deepEqual(selectSpacedSubApexes(primary, undefined), []);
  assert.deepEqual(selectSpacedSubApexes(primary, []), []);

  const candidates = [
    { x: Number.NaN, y: 0, z: 5 },
    { x: 0.79, y: 0, z: 5 }, // < 0.8 from primary -> reject
    { x: 0, y: 0, z: 5.85 }, // >= 0.8 in 3D via Z -> accept
    { x: 1.0, y: 0, z: 5 }, // 1.0 from primary, sqrt(1 + 0.85^2) > 0.8 from (0,0,5.85) -> accept
    { x: 1.5, y: 0, z: 5 }, // 0.5 from (1,0,5) -> reject
    { x: 1.8, y: 0, z: 5 }, // 0.8 from (1,0,5) -> accept
    { x: 2.0, y: Number.POSITIVE_INFINITY, z: 5 },
  ];

  const selected = selectSpacedSubApexes(primary, candidates, 0.8);
  assert.deepEqual(selected, [
    { x: 0, y: 0, z: 5.85 },
    { x: 1.0, y: 0, z: 5 },
    { x: 1.8, y: 0, z: 5 },
  ]);
  assert.deepEqual(
    selectSpacedSubApexes(primary, candidates, Number.NaN),
    selected,
    'NaN minSpacingMm falls back cleanly to 0.8 mm default spacing',
  );
});

test('contactGrid: buildIslandContactGrid skips non-finite footprint voxels and NaN Z tip is rejected', () => {
  const island = makeIsland({
    id: 'v-nonfinite',
    contact: new THREE.Vector3(10, 0, Number.NaN),
    baseZ: 5,
    areaMm2: 0.4,
    contactVoxels: footprintFromPoints([
      { x: Number.NaN, y: 0, z: 5 },
      { x: 0, y: Number.POSITIVE_INFINITY, z: 5 },
      { x: 0, y: 0, z: Number.NaN },
      { x: 2, y: 3, z: 5 },
    ]),
  });

  const grid = buildIslandContactGrid([island]);
  assert.equal(grid.query(0, 0, 0.5).length, 0, 'non-finite voxel Z with non-finite contact.z is skipped');
  assert.equal(grid.query(2, 3, 0.5).length, 1, 'finite voxel at (2, 3, 5) is indexed');

  const internalMap = (grid as unknown as { grid: Map<number, unknown[]> }).grid;
  for (const key of internalMap.keys()) {
    assert.equal(Number.isFinite(key), true, 'grid must never store NaN or Infinity bucket keys');
  }

  const [afterNanTip] = annotateAndCountSupports(
    [island],
    grid,
    [{ pos: new THREE.Vector3(2, 3, Number.NaN), diameterMm: 0.4 }],
    0,
    4.0,
    0.05,
  );
  assert.equal(afterNanTip.supportCount, 0, 'NaN tip.pos.z must not match via NaN > zTolerance false');
  assert.equal(afterNanTip.supported, false);
});

test('sortIslandsByBaseZ: sorts by ascending baseZ regardless of numeric ID and breaks ties deterministically', () => {
  const input: DetectedIsland[] = [
    makeIsland({ id: 'o0', source: 'overhang', contact: new THREE.Vector3(0, 0, 2), baseZ: 2 }),
    makeIsland({ id: 'v47', source: 'voxel', contact: new THREE.Vector3(0, 0, 1), baseZ: 1 }),
    makeIsland({ id: 'm10', source: 'minima', contact: new THREE.Vector3(0, 0, 2), baseZ: 2 }),
    makeIsland({ id: 'v2', source: 'voxel', contact: new THREE.Vector3(0, 0, 2), baseZ: 2 }),
    makeIsland({ id: 'v10', source: 'voxel', contact: new THREE.Vector3(0, 0, 2), baseZ: 2 }),
    makeIsland({ id: 'v0', source: 'voxel', contact: new THREE.Vector3(0, 0, 9), baseZ: 9 }),
    makeIsland({ id: 'v3', source: 'voxel', contact: new THREE.Vector3(0, 0, 0.5), baseZ: Number.NaN }),
  ];
  const originalOrder = input.map((i) => i.id);

  const sorted = sortIslandsByBaseZ(input);
  assert.deepEqual(input.map((i) => i.id), originalOrder, 'must return a shallow copy without mutating input');
  assert.deepEqual(
    sorted.map((i) => i.id),
    ['v3', 'v47', 'v2', 'v10', 'm10', 'o0', 'v0'],
  );
});
