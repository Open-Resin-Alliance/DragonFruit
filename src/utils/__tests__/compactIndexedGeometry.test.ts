import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import {
  buildWorldTriangleSoup,
  compactGeometryToIndexed,
  mergeGeometriesPreservingIndex,
} from '../compactIndexedGeometry';
import { geometryFromSnapshot, snapshotGeometryPositions } from '../geometrySnapshot';
import { expandGeometryToTriangleSoup } from '../tauriMeshBridge';
import { computeLoopsAtY, computeLoopsAtZ } from '@/components/analysis/Slice2D';
import { applyTintAll } from '@/components/analysis/MeshPainter';
import { processGeometry } from '@/hooks/useStlGeometry';
import { buildSolidSliceMeshForWasm } from '@/features/slicing/rasterLayerZipExport';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';

test('compactGeometryToIndexed deduplicates shared vertices bit-exactly', () => {
  const box = new THREE.BoxGeometry(10, 20, 30);
  const soup = box.toNonIndexed();
  box.dispose();
  soup.deleteAttribute('uv');
  const originalSoup = expandGeometryToTriangleSoup(soup).slice();

  // 12 triangles * 3 corners = 36 non-indexed vertices, only 8 unique corners.
  assert.equal(soup.getAttribute('position').count, 36);
  compactGeometryToIndexed(soup);

  assert.equal(soup.getAttribute('position').count, 8);
  assert.equal(soup.getAttribute('normal'), undefined);
  assert.ok(soup.getIndex()?.array instanceof Uint16Array);
  assert.equal(soup.getIndex()!.count, 36);

  const reexpanded = expandGeometryToTriangleSoup(soup);
  assert.deepEqual(
    new Uint32Array(reexpanded.buffer, reexpanded.byteOffset, reexpanded.length),
    new Uint32Array(originalSoup.buffer, originalSoup.byteOffset, originalSoup.length),
    're-expanded coordinates must be bit-for-bit identical to the input soup',
  );
});

test('compactGeometryToIndexed leaves geometries with extra per-corner attributes untouched', () => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 0, 1, 0, 1, 0, 0,
  ], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 0, 1,
    0.5, 0.5, 0, 1, 1, 0,
  ], 2));

  compactGeometryToIndexed(geo);
  assert.equal(geo.getIndex(), null);
  assert.equal(geo.getAttribute('position').count, 6);
});

test('compactGeometryToIndexed uses Uint32Array when unique vertices exceed 65535', () => {
  const uniqueVerts = 65540;
  // 2 triangles sharing vertex 0 and vertex (uniqueVerts - 1), plus filler unique triangles.
  const cornerCount = uniqueVerts + 3;
  const positions = new Float32Array(cornerCount * 3);
  for (let i = 0; i < uniqueVerts; i += 1) {
    positions[i * 3] = i;
    positions[i * 3 + 1] = i % 7;
    positions[i * 3 + 2] = 0;
  }
  // Duplicate the last three vertices so deduplication triggers.
  positions[uniqueVerts * 3] = 0;
  positions[(uniqueVerts + 1) * 3] = 1;
  positions[(uniqueVerts + 1) * 3 + 1] = 1;
  positions[(uniqueVerts + 2) * 3] = uniqueVerts - 1;
  positions[(uniqueVerts + 2) * 3 + 1] = (uniqueVerts - 1) % 7;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const before = positions.slice();

  compactGeometryToIndexed(geo);
  assert.equal(geo.getAttribute('position').count, uniqueVerts);
  assert.ok(geo.getIndex()?.array instanceof Uint32Array);
  assert.deepEqual(expandGeometryToTriangleSoup(geo), before);
});

test('buildWorldTriangleSoup matches clone + translate + applyMatrix4 + toNonIndexed bit-for-bit', () => {
  for (const indexed of [true, false]) {
    const base = new THREE.BoxGeometry(7.5, 11.25, 19.75);
    const source = indexed ? base : base.toNonIndexed();
    if (!indexed) base.dispose();
    source.translate(3.2, -5.7, 8.1);
    source.computeBoundingBox();

    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(12.5, -4.25, 9.75),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.37, -0.82, 1.15, 'XYZ')),
      new THREE.Vector3(-1.2, 0.85, 1.4),
    );

    // Reference: legacy clone + translate + applyMatrix4 + toNonIndexed path.
    const refClone = source.clone();
    const refCenter = refClone.boundingBox!.getCenter(new THREE.Vector3());
    refClone.translate(-refCenter.x, -refCenter.y, -refCenter.z);
    refClone.applyMatrix4(matrix);
    const refSoup = refClone.index ? refClone.toNonIndexed() : refClone;
    refSoup.computeBoundingBox();
    const expectedPositions = (refSoup.getAttribute('position').array as Float32Array).slice();
    const expectedBbox = refSoup.boundingBox!.clone();
    if (refSoup !== refClone) refSoup.dispose();
    refClone.dispose();

    const actual = buildWorldTriangleSoup(source, matrix);
    assert.deepEqual(actual.positions, expectedPositions, `positions parity (indexed=${indexed})`);
    assert.deepEqual(actual.bbox.min.toArray(), expectedBbox.min.toArray(), `bbox.min parity (indexed=${indexed})`);
    assert.deepEqual(actual.bbox.max.toArray(), expectedBbox.max.toArray(), `bbox.max parity (indexed=${indexed})`);

    source.dispose();
  }
});

test('mergeGeometriesPreservingIndex matches toNonIndexed merge on mixed indexed/non-indexed parts while staying indexed', () => {
  const indexedPart = new THREE.CylinderGeometry(3, 3, 5, 12);
  const nonIndexedPart = new THREE.BoxGeometry(4, 2, 1).toNonIndexed();
  // Remove UV from one part to mimic mixed attribute layouts (e.g. crenelated wall + extrude).
  indexedPart.deleteAttribute('uv');

  // Reference: legacy toNonIndexed + mergeGeometries.
  const refParts = [indexedPart, nonIndexedPart].map((g) => {
    const c = g.clone();
    const ni = c.index ? c.toNonIndexed() : c;
    if (ni !== c) c.dispose();
    ni.deleteAttribute('uv');
    if (!ni.getAttribute('normal')) ni.computeVertexNormals();
    return ni;
  });
  const refMerged = mergeGeometries(refParts, false)!;
  refParts.forEach((g) => g.dispose());

  const merged = mergeGeometriesPreservingIndex([indexedPart, nonIndexedPart], {
    ensureNormals: true,
    keepAttributes: ['position', 'normal'],
  })!;

  assert.ok(merged.getIndex(), 'merged geometry must remain indexed');
  assert.ok(
    merged.getAttribute('position').count < refMerged.getAttribute('position').count,
    'indexed merge must store fewer vertices than the non-indexed expansion',
  );
  assert.equal(merged.getIndex()!.count, refMerged.getAttribute('position').count);

  // Expanding the indexed merge reproduces exact positions and normals per corner.
  const expandedMerged = merged.toNonIndexed();
  assert.deepEqual(
    expandedMerged.getAttribute('position').array,
    refMerged.getAttribute('position').array,
  );
  assert.deepEqual(
    expandedMerged.getAttribute('normal').array,
    refMerged.getAttribute('normal').array,
  );

  indexedPart.dispose();
  nonIndexedPart.dispose();
  refMerged.dispose();
  merged.dispose();
  expandedMerged.dispose();
});

test('snapshotGeometryPositions and geometryFromSnapshot round-trip an indexed geometry', () => {
  const box = new THREE.BoxGeometry(6, 8, 10);
  const expectedSoup = expandGeometryToTriangleSoup(box);
  const snap = snapshotGeometryPositions(box);
  assert.equal(snap.sourcePositionCount, 36);

  const restored = geometryFromSnapshot(snap);
  assert.ok(restored);
  assert.equal(restored.getAttribute('position').count, 8, 'restored snapshot is compacted');
  assert.deepEqual(expandGeometryToTriangleSoup(restored), expectedSoup);

  box.dispose();
  restored.dispose();
});

test('Slice2D and MeshPainter produce matching results on indexed and non-indexed geometries', () => {
  const indexed = new THREE.BoxGeometry(10, 10, 10);
  const nonIndexed = indexed.toNonIndexed();

  assert.equal(computeLoopsAtY(indexed, 0).length, computeLoopsAtY(nonIndexed, 0).length);
  assert.equal(computeLoopsAtZ(indexed, 0).length, computeLoopsAtZ(nonIndexed, 0).length);

  const base = new THREE.Color('#808080');
  const tint = new THREE.Color('#ff0000');
  const paintedIndexed = applyTintAll(indexed, base, tint, 0.5);
  const paintedNonIndexed = applyTintAll(nonIndexed, base, tint, 0.5);
  assert.equal(paintedIndexed, paintedNonIndexed);

  // Every vertex color on the indexed mesh should match every vertex color on the non-indexed mesh.
  const colIdx = indexed.getAttribute('color') as THREE.BufferAttribute;
  const colNon = nonIndexed.getAttribute('color') as THREE.BufferAttribute;
  assert.equal(colIdx.getX(0), colNon.getX(0));
  assert.equal(colIdx.getY(0), colNon.getY(0));
  assert.equal(colIdx.getZ(0), colNon.getZ(0));

  indexed.dispose();
  nonIndexed.dispose();
});

test('processGeometry splits an indexed geometry into compact indexed model and support sections', async () => {
  // 2 triangles (6 corners, 4 shared vertices): first triangle is model, second is support.
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    2, 0, 0,
    2, 2, 0,
    0, 2, 0,
  ], 3));
  geom.setIndex([0, 1, 2, 0, 2, 3]);

  const analysis = {
    triangle_count: 2,
    vertex_count: 4,
    non_manifold_edges: 0,
    non_manifold_vertices: 0,
    boundary_edges: 4,
    boundary_loops: 1,
    inconsistent_edges: 0,
    degenerate_triangles: 0,
    duplicate_triangles: 0,
    component_count: 1,
    self_intersections: 0,
    signed_volume: 0,
    is_watertight: false,
    timings_ms: {
      topology_ms: 0,
      self_intersections_ms: 0,
      components_ms: 0,
      total_ms: 0,
    },
  };
  const result = await processGeometry(geom, {
    bakedClassification: {
      version: 1,
      source_path: null,
      pre: analysis,
      post: analysis,
      steps: [],
      fully_repaired: true,
      residual_issues: [],
      total_ms: 0,
      model_triangle_count: 1,
      likely_support_geometry: false,
      rebuilt: false,
      cancelled: false,
    },
    _isTauriRuntime: () => false,
  });

  const modelSec = result.meshDefects?.modelSectionGeometry;
  const supportSec = result.meshDefects?.supportSectionGeometry;
  assert.ok(modelSec?.getIndex(), 'model section stays indexed');
  assert.ok(supportSec?.getIndex(), 'support section stays indexed');
  assert.equal(modelSec!.getIndex()!.count, 3);
  assert.equal(supportSec!.getIndex()!.count, 3);
  assert.equal(modelSec!.getAttribute('position').count, 3);
  assert.equal(supportSec!.getAttribute('position').count, 3);
});

test('buildSolidSliceMeshForWasm produces bit-identical world triangles for indexed and non-indexed models', async () => {
  const makeModel = (indexed: boolean, scaleX: number): LoadedModel => {
    const base = new THREE.BoxGeometry(8, 6, 10);
    const geometry = indexed ? base : base.toNonIndexed();
    if (!indexed) base.dispose();
    geometry.deleteAttribute('uv');
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    return {
      id: 'm1',
      name: 'm1',
      fileUrl: '',
      color: '#a3a3a3',
      visible: true,
      polygonCount: 12,
      geometry: {
        geometry,
        bbox,
        center: bbox.getCenter(new THREE.Vector3()),
        size: bbox.getSize(new THREE.Vector3()),
        flatteningPlanes: [],
      },
      transform: {
        position: new THREE.Vector3(3.5, -2.25, 7.0),
        rotation: new THREE.Euler(0.25, -0.4, 0.7),
        scale: new THREE.Vector3(scaleX, 1.15, 0.9),
      },
    } as unknown as LoadedModel;
  };

  const printerProfile = {
    id: 'p1',
    name: 'Test',
    buildVolumeMm: { width: 100, depth: 100, height: 100 },
    display: { resolutionX: 256, resolutionY: 256, outputFormat: '.ctb' },
  } as PrinterProfile;
  const materialProfile = { id: 'mat1', name: 'Test', layerHeightMm: 0.05 } as MaterialProfile;

  for (const scaleX of [1.25, -1.25]) {
    const indexedModel = makeModel(true, scaleX);
    const soupModel = makeModel(false, scaleX);
    const indexedOut = await buildSolidSliceMeshForWasm({
      models: [indexedModel],
      printerProfile,
      materialProfile,
      filenameBase: 'test',
    });
    const soupOut = await buildSolidSliceMeshForWasm({
      models: [soupModel],
      printerProfile,
      materialProfile,
      filenameBase: 'test',
    });
    assert.deepEqual(
      indexedOut.trianglesXYZ,
      soupOut.trianglesXYZ,
      `slicing triangles must match bit-for-bit (scaleX=${scaleX})`,
    );
    indexedModel.geometry.geometry.dispose();
    soupModel.geometry.geometry.dispose();
  }
});
