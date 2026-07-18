import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { rleEncode, rleEncodeLabels } from '@/volumeAnalysis/IslandScan/rle';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { collectSupportGeometry, evaluateCoverageScan } from '../verifyCoverage';
import { AUTO_SUPPORT_PRESETS } from '../presets';

function scanFromLayers(layers: number[][], width: number, height: number): ScanResults {
  return {
    grid: { originX: 0, originZ: 0, width, height, px_mm: 1 },
    layers: layers.map((values) => ({
      islandMaskRle: rleEncode(Uint8Array.from(values), width, height),
      islandCount: 0,
      islandLabels: rleEncodeLabels(Int32Array.from(values), width, height),
    })),
    firstHit: new Int16Array(width * height),
    lastHit: new Int16Array(width * height),
    baseFootprint: new Uint8Array(width * height),
    baseLabels: new Int32Array(width * height),
    compBase: new Int16Array(1),
    compTop: new Int16Array(1),
    islands: [],
    islandLabelsPerLayer: [],
  };
}

const SETTINGS = {
  ...AUTO_SUPPORT_PRESETS.normal,
  minBaseAreaMm2: 0,
  minVolumeMm3: 0,
  minHeightMm: 0,
};

test('reports remaining volumes when the verification scan still finds islands', () => {
  const scan = scanFromLayers([[1, 0, 0, 1]], 4, 1);
  const verification = evaluateCoverageScan({ scan, scanMinZ: 10, layerHeightMm: 1, settings: SETTINGS });
  assert.equal(verification.remainingVolumeCount, 2);
});

test('reports full coverage when the verification scan finds nothing significant', () => {
  const scan = scanFromLayers([[0, 0, 0, 0]], 4, 1);
  const verification = evaluateCoverageScan({ scan, scanMinZ: 10, layerHeightMm: 1, settings: SETTINGS });
  assert.equal(verification.remainingVolumeCount, 0);
});

test('flattens support groups into one world-space position-only geometry', () => {
  const group = new THREE.Group();
  const meshA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  meshA.position.set(5, 0, 0);
  const meshB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  group.add(meshA, meshB);

  const merged = collectSupportGeometry([group]);
  assert.ok(merged);
  assert.equal(merged.index, null);
  assert.deepEqual(Object.keys(merged.attributes), ['position']);
  merged.computeBoundingBox();
  assert.ok(Math.abs(merged.boundingBox!.max.x - 5.5) < 1e-6);
  assert.ok(Math.abs(merged.boundingBox!.min.x + 0.5) < 1e-6);
  merged.dispose();
});

test('returns null for groups with no meshes', () => {
  assert.equal(collectSupportGeometry([new THREE.Group()]), null);
});

test('planned stick geometry spans its cones and never anchors at the origin', async () => {
  const { routeStickFallback } = await import('../stickFallback');
  const { createIslandSupportMesh, disposeIslandSupportMesh } = await import('../islandSupportSurface');
  const { plannedSupportGroup } = await import('../verifyCoverage');
  const { mergeGeometries } = await import('three/examples/jsm/utils/BufferGeometryUtils.js');

  const body = new THREE.BoxGeometry(10, 10, 4);
  const overhang = new THREE.BoxGeometry(2, 2, 1).translate(0, 0, 8.5);
  const geometry = mergeGeometries([body, overhang], false)!;
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
  const bbox = geometry.boundingBox!.clone();
  const mesh = createIslandSupportMesh({
    geometry,
    bbox,
    center: bbox.getCenter(new THREE.Vector3()),
    size: bbox.getSize(new THREE.Vector3()),
    flatteningPlanes: [],
  }, {
    position: new THREE.Vector3(20, 20, 0),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
  }, 'model-vs');

  try {
    const routed = await routeStickFallback({
      contacts: [{ id: '1:0', volumeId: 1, position: { x: 20, y: 20, z: 4.5 } }],
      settings: AUTO_SUPPORT_PRESETS.normal,
      modelId: 'model-vs',
      mesh,
    });
    assert.equal(routed.supports.length, 1);

    const merged = collectSupportGeometry([plannedSupportGroup(routed.supports[0])]);
    assert.ok(merged);
    merged.computeBoundingBox();
    // The stick lives around (20, 20); geometry touching the origin means the
    // shaft was anchored at a default start instead of its joints.
    assert.ok(merged.boundingBox!.min.x > 15, `min.x ${merged.boundingBox!.min.x}`);
    assert.ok(merged.boundingBox!.min.y > 15, `min.y ${merged.boundingBox!.min.y}`);
    merged.dispose();
  } finally {
    disposeIslandSupportMesh(mesh);
    geometry.dispose();
  }
});
