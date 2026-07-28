import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { FullResMutatorSource } from '@/utils/fullResMutatorStaging';
import {
  checkSupportSectionPartition,
  concatHollowOutputWithSupportSection,
  hollowSectionStagingKeySuffix,
  planHollowSectionSplice,
} from '../hollowSectionAwareness';
import {
  makeFileFrameRunMap,
  makeGeometryFrameReport,
} from '@/utils/__tests__/triangleCountFrameFixtures';

/**
 * Ph3b — HOLLOW SECTION-AWARENESS.
 *
 * Before this phase hollowing voxelised whatever was staged, and for a
 * pre-supported >budget import that was the whole file — model body AND
 * supports. The supports came back as a smoothed, shelled approximation of
 * themselves. Ph3 built the machinery that makes the partition available at full
 * resolution and deliberately did not consume it, because half-wiring it trades
 * an honest suboptimality for a silent geometry error.
 *
 * This module is the seam that consumption needs.
 * `useHollowingManager.ts` is a 1 700-line React hook with no exported
 * surface, so the two decisions that can be wrong in a way the user only
 * discovers on a printed part — WHETHER to section, and whether the support
 * block that came back is the one the model pass skipped — live here as pure
 * functions instead of inside the hook.
 *
 * RED BEFORE THE FIX: this module did not exist, so the file did not compile.
 * That is a COMPILE-ONLY red and is labelled as such in the AAR; the
 * behavioural red for the underlying section filter is the Rust pair
 * `mutator_splice_stages_the_model_section_only` /
 * `mutator_sections_partition_the_source_for_re_append`, which measured
 * 3 168 staged triangles where 768 is correct before the section was honoured.
 */

const FULL_RES_SOURCE: FullResMutatorSource = {
  sourcePath: 'C:/models/plate.stl',
  localCenteringVector: [1, 2, 3],
  fingerprint: { sizeBytes: 562_000_000, mtimeMs: 1_700_000_000_000 },
  originalTriangleCount: 11_240_000,
  // Ph3d: this fixture is a WHOLE-file import — the case Ph3b's sectioning was
  // built for. A Split-to-Bodies half would carry `{ kind: 'model' | 'support' }`
  // here and get that section by default, without an explicit request.
  section: { kind: 'whole' },
};

function makeModel(input: {
  sceneTriangles: number;
  modelTriangleCount: number | null;
  nativePreview?: boolean;
  sourcePath?: string | null;
  runtimeRuns?: Uint32Array | null;
  runtimeTotalRunCount?: number;
}): LoadedModel {
  const positions = new Float32Array(input.sceneTriangles * 9);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();

  const runtimeRuns = input.runtimeRuns;
  return {
    id: 'plate',
    name: 'plate.stl',
    visible: true,
    polygonCount: input.sceneTriangles,
    sourcePath: input.sourcePath === undefined ? 'C:/models/plate.stl' : input.sourcePath,
    geometry: {
      geometry,
      bbox,
      center: bbox.getCenter(new THREE.Vector3()),
      size: bbox.getSize(new THREE.Vector3()),
      flatteningPlanes: [],
      ...(input.nativePreview
        ? {
            nativePreview: {
              originalTriangleCount: 11_240_000,
              previewTriangleCount: input.sceneTriangles,
              cPre: [1, 2, 3] as [number, number, number],
              sourceFingerprint: { sizeBytes: 562_000_000, mtimeMs: 1_700_000_000_000 },
            },
          }
        : {}),
      ...(runtimeRuns !== undefined && runtimeRuns !== null
        ? {
            importRunMap: makeFileFrameRunMap({
              runs: runtimeRuns,
              sourceTriangleCount: 11_240_000,
              modelTriangleCount: 9_000_000,
              droppedNonFiniteTriangles: 0,
              totalRunCount: input.runtimeTotalRunCount ?? runtimeRuns.length / 2,
            }),
          }
        : {}),
      meshDefects: {
        hasDefects: false,
        repairedFloats: 0,
        totalVertices: input.sceneTriangles * 3,
        nativeRepairReport: makeGeometryFrameReport({
          modelTriangleCount: input.modelTriangleCount,
          likelySupportGeometry: true,
        }),
      },
    },
    transform: {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  } as unknown as LoadedModel;
}

test('a splice-eligible preview with a live run map is hollowed section by section', () => {
  const model = makeModel({
    sceneTriangles: 10,
    modelTriangleCount: 9_000_000,
    nativePreview: true,
    runtimeRuns: new Uint32Array([0, 4_000_000, 6_000_000, 5_000_000]),
  });
  const plan = planHollowSectionSplice(model, FULL_RES_SOURCE);
  assert.equal(plan.kind, 'sections');
  assert.equal(plan.kind === 'sections' ? plan.recomputeReason : 'x', null);
  assert.deepEqual(
    plan.kind === 'sections' ? Array.from(plan.runs ?? []) : [],
    [0, 4_000_000, 6_000_000, 5_000_000],
  );
  model.geometry.geometry.dispose();
});

test('no full-res source means no sectioning — the mutator gate wins', () => {
  // The Ph2 toggle, a missing cPre and a non-preview model all reach here as a
  // null plan. Hollowing then consumes the scene geometry, which already holds
  // its supports: sectioning it would drop them.
  const model = makeModel({
    sceneTriangles: 10,
    modelTriangleCount: 9_000_000,
    nativePreview: true,
    runtimeRuns: new Uint32Array([0, 4]),
  });
  assert.deepEqual(planHollowSectionSplice(model, null), {
    kind: 'whole',
    reason: 'not-full-res',
  });
  model.geometry.geometry.dispose();
});

test('a model Ph3 does not call splice-eligible is left whole rather than re-derived', () => {
  // No sourcePath ⇒ `resolveOutputSectionPlan` answers `describes-source-file`,
  // not `spliced-sections`. Ph3 owns that question; asking it a second way here
  // is exactly the F3 mistake, so this arm defers instead of deciding.
  const model = makeModel({
    sceneTriangles: 10,
    modelTriangleCount: 9_000_000,
    nativePreview: true,
    sourcePath: null,
    runtimeRuns: new Uint32Array([0, 4]),
  });
  assert.deepEqual(planHollowSectionSplice(model, FULL_RES_SOURCE), {
    kind: 'whole',
    reason: 'sections-not-spliced',
  });
  model.geometry.geometry.dispose();
});

test('an import that found no support section is hollowed whole', () => {
  const model = makeModel({
    sceneTriangles: 10,
    modelTriangleCount: null,
    nativePreview: true,
  });
  assert.deepEqual(planHollowSectionSplice(model, FULL_RES_SOURCE), {
    kind: 'whole',
    reason: 'no-support-verdict',
  });
  model.geometry.geometry.dispose();
});

test('an over-cap run map plans sections with a recompute, never a whole-file pass', () => {
  // The failure this guards: an over-cap map and an absent map both present as
  // an empty array. Reading the first as "no split" hollows the supports with
  // full confidence.
  const model = makeModel({
    sceneTriangles: 10,
    modelTriangleCount: 9_000_000,
    nativePreview: true,
    runtimeRuns: new Uint32Array(0),
    runtimeTotalRunCount: 20_000,
  });
  const plan = planHollowSectionSplice(model, FULL_RES_SOURCE);
  assert.equal(plan.kind, 'sections');
  assert.equal(plan.kind === 'sections' ? plan.runs : 'x', null);
  assert.equal(plan.kind === 'sections' ? plan.recomputeReason : null, 'over-cap');
  model.geometry.geometry.dispose();
});

test('a sectioned preview cannot be served from a whole-file cache entry', () => {
  // The preview-result cache is keyed by model + geometry version + options. A
  // whole-file cavity served for a sectioned model is a stale answer, not a fast
  // one: the user would accept a cavity computed against a different mesh.
  const sectioned = hollowSectionStagingKeySuffix({
    kind: 'sections',
    runs: new Uint32Array([0, 4]),
    recomputeReason: null,
  });
  const whole = hollowSectionStagingKeySuffix({ kind: 'whole', reason: 'no-split' });
  assert.notEqual(sectioned, whole);
  assert.equal(whole, '');
});

test('the re-append is refused when the support block is not what the model pass skipped', () => {
  const ok = checkSupportSectionPartition({
    modelName: 'plate.stl',
    stagedTriangleCount: 9_000_000,
    skippedTriangleCount: 2_240_000,
    sourceTriangleCount: 11_240_000,
    supportPositionFloatCount: 2_240_000 * 9,
  });
  assert.equal(ok.ok, true);

  const short = checkSupportSectionPartition({
    modelName: 'plate.stl',
    stagedTriangleCount: 9_000_000,
    skippedTriangleCount: 2_240_000,
    sourceTriangleCount: 11_240_000,
    supportPositionFloatCount: (2_240_000 - 1) * 9,
  });
  assert.equal(short.ok, false);
  assert.match(short.ok === false ? short.message : '', /plate\.stl/);
  assert.match(short.ok === false ? short.message : '', /2,239,999/);
});

test('the re-append is refused when the support block is not whole triangles', () => {
  const ragged = checkSupportSectionPartition({
    modelName: 'plate.stl',
    stagedTriangleCount: 4,
    skippedTriangleCount: 2,
    sourceTriangleCount: 6,
    supportPositionFloatCount: 17,
  });
  assert.equal(ragged.ok, false);
  assert.match(ragged.ok === false ? ragged.message : '', /whole triangles/);
});

test('the support section is appended after the hollowed model, in one buffer', () => {
  const hollowed = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const support = new Float32Array([10, 11, 12, 13, 14, 15, 16, 17, 18]);
  const joined = concatHollowOutputWithSupportSection(hollowed, support);
  assert.equal(joined.length, 18);
  assert.deepEqual(Array.from(joined.subarray(0, 9)), Array.from(hollowed));
  assert.deepEqual(Array.from(joined.subarray(9)), Array.from(support));
  // Model-first is not cosmetic: it is the layout `model_triangle_count` would
  // index if a later phase re-classifies the mutated mesh.
  assert.equal(joined[0], 1);
  assert.equal(joined[9], 10);
});

test('an empty support section returns the hollow output untouched', () => {
  const hollowed = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(concatHollowOutputWithSupportSection(hollowed, new Float32Array(0)), hollowed);
});
