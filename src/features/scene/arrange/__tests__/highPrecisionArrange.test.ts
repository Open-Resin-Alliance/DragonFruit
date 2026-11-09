import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  computeHighPrecisionArrangeResult,
  type ArrangeModel,
  type ArrangeTransform,
  type HullCacheEntry,
} from '../highPrecisionArrange';

function buildRectGeometry(width: number, depth: number) {
  const hw = width * 0.5;
  const hd = depth * 0.5;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -hw, -hd, 0,
    hw, -hd, 0,
    hw, hd, 0,
    -hw, -hd, 0,
    hw, hd, 0,
    -hw, hd, 0,
  ], 3));
  return geometry;
}

function buildTransform(x: number, y: number, zRotation = 0): ArrangeTransform {
  return {
    position: new THREE.Vector3(x, y, 0),
    rotation: new THREE.Euler(0, 0, zRotation, 'XYZ'),
    scale: new THREE.Vector3(1, 1, 1),
  };
}

function buildModel(id: string, width: number, depth: number, transform: ArrangeTransform): ArrangeModel {
  return {
    id,
    visible: true,
    transform,
    geometry: {
      center: new THREE.Vector3(0, 0, 0),
      geometry: buildRectGeometry(width, depth),
    },
  };
}

function serializeResult(result: ReturnType<typeof computeHighPrecisionArrangeResult>) {
  return {
    packedIds: [...result.packedIds],
    spilledIds: [...result.spilledIds],
    updates: result.updates.map((update) => ({
      id: update.id,
      position: [
        Number(update.transform.position.x.toFixed(4)),
        Number(update.transform.position.y.toFixed(4)),
        Number(update.transform.position.z.toFixed(4)),
      ],
      rotation: [
        Number(update.transform.rotation.x.toFixed(4)),
        Number(update.transform.rotation.y.toFixed(4)),
        Number(update.transform.rotation.z.toFixed(4)),
      ],
      scale: [
        Number(update.transform.scale.x.toFixed(4)),
        Number(update.transform.scale.y.toFixed(4)),
        Number(update.transform.scale.z.toFixed(4)),
      ],
    })),
  };
}

test('high-precision arrange reuses cached hull SAT data without changing packed result', () => {
  const sharedGeometry = buildRectGeometry(7.5, 5);
  const models: ArrangeModel[] = [
    {
      id: 'a',
      visible: true,
      transform: buildTransform(0, 0, 0),
      geometry: { center: new THREE.Vector3(0, 0, 0), geometry: sharedGeometry },
    },
    {
      id: 'b',
      visible: true,
      transform: buildTransform(0, 0, 0),
      geometry: { center: new THREE.Vector3(0, 0, 0), geometry: sharedGeometry },
    },
    {
      id: 'c',
      visible: true,
      transform: buildTransform(0, 0, 0),
      geometry: { center: new THREE.Vector3(0, 0, 0), geometry: sharedGeometry },
    },
    buildModel('blocker', 4, 4, buildTransform(14, 2, 0)),
  ];

  const hullCache = new Map<string, HullCacheEntry>();
  const input = {
    visibleModels: models.slice(0, 3),
    sceneModels: models,
    widthMm: 28,
    depthMm: 18,
    originMode: 'front_left' as const,
    arrangeSpacingMm: 0.5,
    arrangeAllowRotateOnZ: true,
    arrangeAnchorMode: 'center' as const,
    getArrangeTransform: (model: ArrangeModel) => model.transform,
    hullCache,
    safetyMarginMm: { front: 0, back: 0, left: 0, right: 0 },
  };

  const first = computeHighPrecisionArrangeResult(input);
  const firstSerialized = serializeResult(first);

  assert.equal(first.packedIds.length, 3, 'expected all target models to pack on the plate');
  assert.equal(first.spilledIds.length, 0, 'expected no packed models to spill');
  assert.ok(hullCache.size > 0, 'expected hull cache to be populated after first arrange pass');
  for (const entry of hullCache.values()) {
    assert.ok(entry.axes.length > 0, 'expected cached hull entry to include SAT axes');
  }

  const second = computeHighPrecisionArrangeResult(input);
  assert.deepEqual(
    serializeResult(second),
    firstSerialized,
    'expected reused cached hull SAT data to preserve packed output exactly',
  );
});

test('high-precision arrange packs an offset plate inside that plate, and leaves the first plate empty', () => {
  // Plate 2 sits one footprint + gap to the right of plate 1: 60mm wide, 20mm gap.
  const plateOffsetMm = { dxMm: 80, dyMm: 0 };
  const buildTargets = (x: number): ArrangeModel[] => [
    buildModel('a', 10, 10, buildTransform(x, -20, 0)),
    buildModel('b', 10, 10, buildTransform(x, 0, 0)),
    buildModel('c', 10, 10, buildTransform(x, 20, 0)),
  ];
  const plateTwoModels = buildTargets(110);

  const run = (plateOffset?: { dxMm: number; dyMm: number }) => computeHighPrecisionArrangeResult({
    visibleModels: plateTwoModels,
    sceneModels: plateTwoModels,
    widthMm: 60,
    depthMm: 60,
    originMode: 'center' as const,
    ...(plateOffset ? { plateOffsetMm: plateOffset } : {}),
    arrangeSpacingMm: 1,
    arrangeAllowRotateOnZ: false,
    arrangeAnchorMode: 'center' as const,
    getArrangeTransform: (model: ArrangeModel) => model.transform,
    hullCache: new Map(),
    safetyMarginMm: { front: 0, back: 0, left: 0, right: 0 },
  });

  const onSecondPlate = run(plateOffsetMm);
  assert.equal(onSecondPlate.updates.length, 3, 'expected all three models to be placed');
  for (const update of onSecondPlate.updates) {
    const { x, y } = update.transform.position;
    // Plate 2's own frame: plate 1's [-30, 30] shifted by the cascade offset.
    assert.ok(x >= 50 && x <= 110, `expected ${update.id}.x on plate 2, got ${x}`);
    assert.ok(y >= -30 && y <= 30, `expected ${update.id}.y on plate 2, got ${y}`);
  }

  // Without the offset the same models pack into plate 1's frame — the frame is the
  // only thing that moved, which is what made a plate-2 arrange drop its models on plate 1.
  const onFirstPlate = run();
  assert.equal(onFirstPlate.updates.length, 3, 'expected all three models to be placed');
  for (const update of onFirstPlate.updates) {
    const { x } = update.transform.position;
    assert.ok(x >= -30 && x <= 30, `expected ${update.id}.x on plate 1, got ${x}`);
  }
});