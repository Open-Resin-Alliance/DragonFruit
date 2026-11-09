/**
 * Whatever the packer says it placed is on the bed, and no two share ground.
 * Rectangles, so a footprint is its bounding box and an overlap is an overlap.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  computeHighPrecisionArrangeResult,
  type ArrangeModel,
  type HullCacheEntry,
} from '../highPrecisionArrange';

const BED_W = 143.36;
const BED_D = 89.6;
const SPACING = 5;

function rectGeometry(width: number, depth: number) {
  const hw = width * 0.5;
  const hd = depth * 0.5;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -hw, -hd, 0, hw, -hd, 0, hw, hd, 0,
    -hw, -hd, 0, hw, hd, 0, -hw, hd, 0,
  ], 3));
  return geometry;
}

function model(id: string, width: number, depth: number, x = 0, y = 0): ArrangeModel {
  return {
    id,
    visible: true,
    transform: {
      position: new THREE.Vector3(x, y, 0),
      rotation: new THREE.Euler(0, 0, 0, 'XYZ'),
      scale: new THREE.Vector3(1, 1, 1),
    },
    geometry: { center: new THREE.Vector3(0, 0, 0), geometry: rectGeometry(width, depth) },
  };
}

type Rect = { minX: number; maxX: number; minY: number; maxY: number };

/** Where a packed model ends up, as a world rect. */
function placedRect(source: ArrangeModel, update: { transform: { position: THREE.Vector3; rotation: THREE.Euler } }): Rect {
  const geometry = source.geometry.geometry.clone();
  geometry.applyQuaternion(new THREE.Quaternion().setFromEuler(update.transform.rotation));
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  geometry.dispose();
  return {
    minX: update.transform.position.x + box.min.x,
    maxX: update.transform.position.x + box.max.x,
    minY: update.transform.position.y + box.min.y,
    maxY: update.transform.position.y + box.max.y,
  };
}

function arrange(models: ArrangeModel[]) {
  return computeHighPrecisionArrangeResult({
    visibleModels: models,
    sceneModels: models,
    widthMm: BED_W,
    depthMm: BED_D,
    originMode: 'front_left',
    arrangeSpacingMm: SPACING,
    arrangeAllowRotateOnZ: true,
    arrangeAnchorMode: 'center',
    getArrangeTransform: (m) => m.transform,
    hullCache: new Map<string, HullCacheEntry>(),
  });
}

/** Every packed model, on the bed and clear of the others. */
function assertPackedCleanly(models: ArrangeModel[], result: ReturnType<typeof arrange>) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const packed = new Set(result.packedIds);
  const rects = new Map<string, Rect>();

  for (const update of result.updates) {
    if (!packed.has(update.id)) continue;
    const source = byId.get(update.id);
    assert.ok(source, `update for unknown model ${update.id}`);
    rects.set(update.id, placedRect(source, update));
  }

  assert.equal(rects.size, packed.size, 'every packed model reports a placement');

  for (const [id, rect] of rects) {
    assert.ok(
      rect.minX >= -1e-6 && rect.maxX <= BED_W + 1e-6
      && rect.minY >= -1e-6 && rect.maxY <= BED_D + 1e-6,
      `${id} was packed off the bed: x ${rect.minX.toFixed(2)}..${rect.maxX.toFixed(2)}, `
      + `y ${rect.minY.toFixed(2)}..${rect.maxY.toFixed(2)}`,
    );
  }

  const ids = [...rects.keys()];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = rects.get(ids[i])!;
      const b = rects.get(ids[j])!;
      const overlaps = a.minX < b.maxX - 1e-6 && a.maxX > b.minX + 1e-6
        && a.minY < b.maxY - 1e-6 && a.maxY > b.minY + 1e-6;
      assert.ok(
        !overlaps,
        `${ids[i]} and ${ids[j]} were packed onto the same ground: `
        + `${ids[i]} x ${a.minX.toFixed(2)}..${a.maxX.toFixed(2)} y ${a.minY.toFixed(2)}..${a.maxY.toFixed(2)}, `
        + `${ids[j]} x ${b.minX.toFixed(2)}..${b.maxX.toFixed(2)} y ${b.minY.toFixed(2)}..${b.maxY.toFixed(2)}`,
      );
    }
  }
}

test('arrange packs small models onto one bed without overlapping them', () => {
  const models = [
    model('a', 30, 30), model('b', 30, 30), model('c', 30, 30),
    model('d', 25, 20), model('e', 20, 25), model('f', 15, 15),
  ];
  const result = arrange(models);
  assert.equal(result.spilledIds.length, 0, 'six small models fit one bed');
  assertPackedCleanly(models, result);
});

test('arrange spills what the bed cannot take rather than stacking it', () => {
  // Four models at 70x70: two fit side by side, the rest cannot.
  const models = [
    model('a', 70, 70), model('b', 70, 70), model('c', 70, 70), model('d', 70, 70),
  ];
  const result = arrange(models);
  assert.ok(result.spilledIds.length > 0, 'a bed this size cannot take all four');
  assertPackedCleanly(models, result);
});

test('arrange keeps models clear when they arrive stacked on one another', () => {
  // An imported scene can author every model at the same spot; the pack has to
  // separate them rather than leave them where they came in.
  const models = [
    model('a', 40, 40, 0, 0), model('b', 40, 40, 0, 0),
    model('c', 40, 40, 0, 0), model('d', 30, 30, 0, 0),
  ];
  const result = arrange(models);
  assertPackedCleanly(models, result);
});

test('arrange keeps models clear when one is far larger than the rest', () => {
  // The case an imported plate hits: one model most of the bed, several small.
  const models = [
    model('big', 120, 70),
    model('s1', 15, 15), model('s2', 15, 15), model('s3', 15, 15),
  ];
  const result = arrange(models);
  assertPackedCleanly(models, result);
});

test('arrange respects a model already standing on the bed', () => {
  const blocker = model('blocker', 100, 70, BED_W * 0.5, BED_D * 0.5);
  const incoming = [model('x', 30, 30), model('y', 30, 30)];
  const result = computeHighPrecisionArrangeResult({
    visibleModels: incoming,
    sceneModels: [blocker, ...incoming],
    widthMm: BED_W,
    depthMm: BED_D,
    originMode: 'front_left',
    arrangeSpacingMm: SPACING,
    arrangeAllowRotateOnZ: true,
    arrangeAnchorMode: 'center',
    getArrangeTransform: (m) => m.transform,
    hullCache: new Map<string, HullCacheEntry>(),
  });

  // The blocker holds its ground, so whatever packs has to miss it.
  const blockerRect: Rect = {
    minX: BED_W * 0.5 - 50, maxX: BED_W * 0.5 + 50,
    minY: BED_D * 0.5 - 35, maxY: BED_D * 0.5 + 35,
  };
  const byId = new Map(incoming.map((m) => [m.id, m]));
  const packed = new Set(result.packedIds);
  for (const update of result.updates) {
    if (!packed.has(update.id)) continue;
    const rect = placedRect(byId.get(update.id)!, update);
    const hits = rect.minX < blockerRect.maxX - 1e-6 && rect.maxX > blockerRect.minX + 1e-6
      && rect.minY < blockerRect.maxY - 1e-6 && rect.maxY > blockerRect.minY + 1e-6;
    assert.ok(!hits, `${update.id} was packed onto the model already standing there`);
  }
});

test('a pack that ignores the raft leaves the rafts overlapping', () => {
  // A raft reaches past its model, so models packed to touch put their rafts
  // through each other. This is why an import packs the raft, not the mesh.
  const RAFT_REACH = 8;
  const models = [
    model('a', 30, 30), model('b', 30, 30), model('c', 30, 30),
    model('d', 30, 30), model('e', 30, 30), model('f', 30, 30),
  ];
  const result = arrange(models);
  assertPackedCleanly(models, result);

  const byId = new Map(models.map((m) => [m.id, m]));
  const packed = new Set(result.packedIds);
  const rafts = new Map<string, Rect>();
  for (const update of result.updates) {
    if (!packed.has(update.id)) continue;
    const rect = placedRect(byId.get(update.id)!, update);
    rafts.set(update.id, {
      minX: rect.minX - RAFT_REACH, maxX: rect.maxX + RAFT_REACH,
      minY: rect.minY - RAFT_REACH, maxY: rect.maxY + RAFT_REACH,
    });
  }

  const ids = [...rafts.keys()];
  let clashes = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = rafts.get(ids[i])!;
      const b = rafts.get(ids[j])!;
      if (a.minX < b.maxX - 1e-6 && a.maxX > b.minX + 1e-6
        && a.minY < b.maxY - 1e-6 && a.maxY > b.minY + 1e-6) clashes += 1;
    }
  }

  // Spacing is 5mm and the raft reaches 8mm, so touching models clash.
  assert.ok(clashes > 0, 'expected mesh-packed models to clash once rafts are drawn');
});

test('giving the engine the raft reach keeps the rafts clear', () => {
  // The same six, each declaring the ground its raft takes: the engine reads
  // supports as local-space points, so the raft box corners stand in for it.
  const RAFT_REACH = 8;
  const models = [
    model('a', 30, 30), model('b', 30, 30), model('c', 30, 30),
    model('d', 30, 30), model('e', 30, 30), model('f', 30, 30),
  ].map((m) => ({
    ...m,
    geometry: {
      ...m.geometry,
      supportLocalPoints: [
        new THREE.Vector3(-15 - RAFT_REACH, -15 - RAFT_REACH, 0),
        new THREE.Vector3(15 + RAFT_REACH, -15 - RAFT_REACH, 0),
        new THREE.Vector3(-15 - RAFT_REACH, 15 + RAFT_REACH, 0),
        new THREE.Vector3(15 + RAFT_REACH, 15 + RAFT_REACH, 0),
      ],
      supportHullKey: `${m.id}-raft-${RAFT_REACH}`,
    },
  }));

  const result = arrange(models);

  const byId = new Map(models.map((m) => [m.id, m]));
  const packed = new Set(result.packedIds);
  const rafts = new Map<string, Rect>();
  for (const update of result.updates) {
    if (!packed.has(update.id)) continue;
    const rect = placedRect(byId.get(update.id)!, update);
    rafts.set(update.id, {
      minX: rect.minX - RAFT_REACH, maxX: rect.maxX + RAFT_REACH,
      minY: rect.minY - RAFT_REACH, maxY: rect.maxY + RAFT_REACH,
    });
  }

  const ids = [...rafts.keys()];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = rafts.get(ids[i])!;
      const b = rafts.get(ids[j])!;
      const overlaps = a.minX < b.maxX - 1e-6 && a.maxX > b.minX + 1e-6
        && a.minY < b.maxY - 1e-6 && a.maxY > b.minY + 1e-6;
      assert.ok(!overlaps, `rafts of ${ids[i]} and ${ids[j]} overlap`);
    }
  }
});
