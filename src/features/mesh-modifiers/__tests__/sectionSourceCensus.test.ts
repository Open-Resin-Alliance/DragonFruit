import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { resolveFullResSourceForModel, resolveOutputGeometrySource } from '../prepareModelGeometry';
import { planMutatorFullResStaging } from '@/utils/fullResMutatorStaging';
import { planModelRustAnalysisStaging } from '@/utils/rustAnalysisStaging';
import { resolveIslandScanFrame } from '@/volumeAnalysis/Islands/islandScanSource';

/**
 * Ph3d — THE CENSUS. Every Rust-bound consumer must learn that a model is only
 * ONE SECTION of its source file.
 *
 * This is the single silent failure mode of the phase. A Split-to-Bodies half
 * keeps its parent's `sourcePath`, because it genuinely IS part of that file.
 * A consumer that asks only "is there a path?" and re-reads the whole thing
 * gets the OTHER half too — the supports reappear inside a hollow, an export
 * ships the whole plate, a slice stages triangles twice. None of that throws;
 * it produces a plausible mesh that is wrong.
 *
 * The defence is that the section rides on the resolved SOURCE, so a consumer
 * receives it by asking the question it already asks. These tests assert that
 * property at each consumer rather than trusting the comment on the type.
 *
 * RED: compile-only. `FullResSourceSection` did not exist.
 */

function makeModel(input: {
  isSection?: 'model' | 'support';
  runs?: Uint32Array | null;
  /** Simulates an over-cap map: runs present but empty, totalRunCount > 0. */
  overCapRunMap?: boolean;
}): LoadedModel {
  const positions = new Float32Array(30 * 9);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();
  const runs = input.overCapRunMap
    ? new Uint32Array(0)
    : input.runs === undefined ? new Uint32Array([0, 12]) : input.runs;

  return {
    id: 'half',
    name: 'plate.stl (Model)',
    visible: true,
    polygonCount: 30,
    sourcePath: 'C:/models/plate.stl',
    geometry: {
      geometry,
      bbox,
      center: bbox.getCenter(new THREE.Vector3()),
      size: bbox.getSize(new THREE.Vector3()),
      flatteningPlanes: [],
      cPre: [1, 2, 3] as [number, number, number],
      ...(runs
        ? {
          importRunMap: {
            runs,
            sourceTriangleCount: 40,
            modelTriangleCount: 12,
            droppedNonFiniteTriangles: 0,
            totalRunCount: input.overCapRunMap ? 9_000 : runs.length / 2,
          },
        }
        : {}),
      nativePreview: {
        originalTriangleCount: 12,
        previewTriangleCount: 30,
        cPre: [1, 2, 3] as [number, number, number],
        sourceFingerprint: { sizeBytes: 100, mtimeMs: 5 },
        ...(input.isSection
          ? { sourceSection: { section: input.isSection, recomputeReason: null } }
          : {}),
      },
      meshDefects: {
        hasDefects: false,
        repairedFloats: 0,
        totalVertices: 90,
        nativeRepairReport: { model_triangle_count: null, likely_support_geometry: false },
      },
    },
    transform: {
      position: new THREE.Vector3(),
      rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1),
    },
  } as unknown as LoadedModel;
}

test('an ordinary import resolves as the WHOLE file, byte-identically to before', () => {
  const model = makeModel({});
  const source = resolveFullResSourceForModel(model);
  assert.ok(source);
  assert.deepEqual(source.section, { kind: 'whole' });
  model.geometry.geometry.dispose();
});

test('a half resolves as its own section, with the runs that define it', () => {
  const model = makeModel({ isSection: 'model' });
  const source = resolveFullResSourceForModel(model);
  assert.ok(source);
  // `assert.equal` from node:assert/strict carries an `asserts` signature, so
  // it narrows the discriminant for us — no redundant guard needed below.
  assert.equal(source.section.kind, 'model');
  assert.deepEqual(Array.from(source.section.runs ?? []), [0, 12]);
  model.geometry.geometry.dispose();
});

test('the support half is the complement, not a second model section', () => {
  const model = makeModel({ isSection: 'support' });
  const source = resolveFullResSourceForModel(model);
  assert.ok(source);
  assert.equal(source.section.kind, 'support');
  model.geometry.geometry.dispose();
});

test('an OVER-CAP run map resolves to a recompute, never to an empty section', () => {
  // The trap this guards: `importRunMap.runs` is an EMPTY array when the
  // classifier's map exceeded the transport cap. Read raw, that says "this
  // section contains no triangles" and the half would slice to an empty plate.
  // `resolveImportRunMap` is what tells the two apart.
  const model = makeModel({ isSection: 'model', overCapRunMap: true });
  const source = resolveFullResSourceForModel(model);
  assert.ok(source);
  assert.equal(source.section.kind, 'model');
  assert.equal(source.section.runs, null, 'an over-cap map must resolve to null (recompute)');
  assert.ok(source.section.recomputeReason, 'and must say why');
  model.geometry.geometry.dispose();
});

test('every Rust-bound consumer receives the section', () => {
  const half = makeModel({ isSection: 'support' });
  const whole = makeModel({});

  // 1. The output chokepoint (slicing + mesh export).
  const output = resolveOutputGeometrySource(half);
  assert.equal(output.kind, 'fullres-source-file');
  assert.equal(output.section.kind, 'support');

  // 2. The permanent mutators (hollow, repair-in-place, hole punch). This is
  //    the one where forgetting costs the most: a whole-file stage would hand
  //    hollowing the supports it was just split away from.
  const mutator = planMutatorFullResStaging(half);
  assert.ok(mutator);
  assert.equal(mutator.section.kind, 'support');
  assert.deepEqual(planMutatorFullResStaging(whole)?.section, { kind: 'whole' });

  // 3. Rust analysis staging (SDF), which is built on the mutator plan.
  const analysis = planModelRustAnalysisStaging(half);
  assert.equal(analysis.kind, 'fullres-source-file');

  // 4. The islands sideload DECLINES for a half — `scan_islands_from_path` has
  //    no section filter, so it would scan the whole plate. Declining routes the
  //    caller to its client-side scan of the half's own geometry, which is
  //    frame-correct by construction.
  assert.equal(
    resolveIslandScanFrame({ sourcePath: half.sourcePath, geometry: half.geometry }),
    null,
    'a half must not authorize a whole-file islands sideload',
  );
  assert.ok(
    resolveIslandScanFrame({ sourcePath: whole.sourcePath, geometry: whole.geometry }),
    'a whole-file preview still sideloads, unchanged',
  );

  half.geometry.geometry.dispose();
  whole.geometry.geometry.dispose();
});
