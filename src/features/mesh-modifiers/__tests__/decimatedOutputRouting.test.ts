import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import {
  PREVIEW_GEOMETRY_OPT_OUT_REASONS,
  resolveFullResSourceForModel,
  resolveOutputGeometrySource,
  resolvePreviewGeometryForRustConsumer,
  isFullResSpliceEligible,
} from '../prepareModelGeometry';
import { resolveModelOutputMode } from '../modelOutputPolicy';
import { planMutatorFullResStaging } from '@/utils/fullResMutatorStaging';
import { planModelRustAnalysisStaging } from '@/utils/rustAnalysisStaging';
import { resolveIslandScanFrame, type IslandScanFrameInput } from '@/volumeAnalysis/Islands/islandScanSource';

/**
 * Ph2 RED HARNESS — the Original/Decimated toggle, and the single chokepoint
 * every Rust-bound geometry consumer routes through (plan
 * `20260725-Plan-support-aware-import-FINAL.md` §Ph2).
 *
 * THE RULING BEING PINNED (user answer #12): "treat decimated as the original
 * mesh when the user chooses that toggle." So `outputPolicy.mode === 'decimated'`
 * must make EVERY Rust round-trip consume the scene (decimated) geometry — with
 * no per-consumer override, and no consumer left resolving full-res because its
 * author never heard of the flag.
 *
 * RED BEFORE THE FIX (measured, this file, pre-implementation):
 *  - R1/R2/R4: `resolveOutputGeometrySource` / `resolveFullResSourceForModel` /
 *    `planMutatorFullResStaging` all returned the full-res source descriptor for
 *    a model flagged `decimated` — the flag was inert.
 *  - R5: `resolveIslandScanFrame` returned a sideload frame for the same model.
 *  - R3/R6/R7/R8: COMPILE failures (the modules/exports did not exist). Recorded
 *    honestly as such in the Ph2 AAR rather than dressed up as behavioural reds.
 */

function buildDecimatedImportModel(overrides?: Partial<LoadedModel>): {
  model: LoadedModel;
  previewGeometry: THREE.BufferGeometry;
} {
  const previewGeometry = new THREE.BufferGeometry();
  previewGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 2, 0, 0, 0, 2, 0,
    0, 0, 1, 2, 0, 1, 0, 2, 1,
  ], 3));
  previewGeometry.computeBoundingBox();
  const bbox = previewGeometry.boundingBox?.clone() ?? new THREE.Box3();
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());

  const model = {
    id: 'preview-plate',
    name: 'pre-supported-plate-11m.stl',
    fileUrl: '',
    sourcePath: 'X:/fixtures/pre-supported-plate-11m.stl',
    visible: true,
    color: '#ffffff',
    polygonCount: 2,
    geometry: {
      geometry: previewGeometry,
      bbox,
      center,
      size,
      flatteningPlanes: [],
      cPre: [1, 2, 3] as [number, number, number],
      nativePreview: {
        originalTriangleCount: 11_240_000,
        previewTriangleCount: 2,
        // Both datum sites are populated on a real import: the resolver reads
        // `nativePreview.cPre`, the islands frame reads the wrapper-level one.
        cPre: [1, 2, 3] as [number, number, number],
        sourceFingerprint: { sizeBytes: 562_000_084, mtimeMs: 1_700_000_000_000 },
      },
    },
    transform: {
      position: new THREE.Vector3(10, -4, 2.5),
      rotation: new THREE.Euler(0, 0, Math.PI / 6),
      scale: new THREE.Vector3(1, 1, 1),
    },
    ...overrides,
  } as unknown as LoadedModel;

  return { model, previewGeometry };
}

test('Ph2 R0: an absent outputPolicy means `original` — the default is never implicit-decimated', () => {
  const { model, previewGeometry } = buildDecimatedImportModel();
  try {
    assert.equal(resolveModelOutputMode(model), 'original');
    assert.equal(resolveOutputGeometrySource(model).kind, 'fullres-source-file');
    assert.equal(isFullResSpliceEligible(model), true);
  } finally {
    previewGeometry.dispose();
  }
});

test('Ph2 R1: `decimated` routes the output chokepoint to the scene geometry', () => {
  const { model, previewGeometry } = buildDecimatedImportModel({
    outputPolicy: { mode: 'decimated' },
  } as Partial<LoadedModel>);
  try {
    assert.equal(resolveModelOutputMode(model), 'decimated');
    const resolved = resolveOutputGeometrySource(model);
    assert.equal(
      resolved.kind,
      'scene-geometry',
      'the user chose decimated: the decimated mesh IS the original for every '
        + 'Rust round-trip (ruling #12). Resolving full-res here would slice a '
        + 'mesh the user explicitly opted out of.',
    );
    assert.equal(
      resolved.kind === 'scene-geometry' ? resolved.geometry : null,
      previewGeometry,
    );
    assert.equal(resolveFullResSourceForModel(model), null);
    assert.equal(isFullResSpliceEligible(model), false);
  } finally {
    previewGeometry.dispose();
  }
});

test('Ph2 R2: `decimated` routes the permanent mutators (hollow / punch / repair) to the preview', () => {
  const { model, previewGeometry } = buildDecimatedImportModel({
    outputPolicy: { mode: 'decimated' },
  } as Partial<LoadedModel>);
  try {
    assert.equal(
      planMutatorFullResStaging(model),
      null,
      'hollow apply/preview, hole-punch apply and repair-in-place all plan their '
        + 'staging through resolveFullResSourceForModel — a null plan is what makes '
        + 'them stage the scene geometry.',
    );
  } finally {
    previewGeometry.dispose();
  }
});

test('Ph2 R3: `decimated` routes the SDF / Rust-analysis staging helper to the preview', () => {
  const { model, previewGeometry } = buildDecimatedImportModel({
    outputPolicy: { mode: 'decimated' },
  } as Partial<LoadedModel>);
  try {
    const plan = planModelRustAnalysisStaging(model);
    assert.equal(plan.kind, 'scene-geometry');
    assert.equal(plan.kind === 'scene-geometry' ? plan.geometry : null, previewGeometry);
  } finally {
    previewGeometry.dispose();
  }
});

test('Ph2 R4: `original` (explicit) is byte-identical to Ph1 for all Rust-bound consumers', () => {
  const { model, previewGeometry } = buildDecimatedImportModel({
    outputPolicy: { mode: 'original' },
  } as Partial<LoadedModel>);
  try {
    const resolved = resolveOutputGeometrySource(model);
    assert.equal(resolved.kind, 'fullres-source-file');
    assert.equal(
      resolved.kind === 'fullres-source-file' ? resolved.sourcePath : null,
      model.sourcePath,
    );
    const mutatorPlan = planMutatorFullResStaging(model);
    assert.ok(mutatorPlan, 'explicit `original` must keep the full-res mutator plan');
    assert.equal(mutatorPlan?.sourcePath, model.sourcePath);
    assert.equal(planModelRustAnalysisStaging(model).kind, 'fullres-source-file');
    const frame = resolveIslandScanFrame({
      sourcePath: model.sourcePath,
      geometry: model.geometry,
      outputMode: 'original',
    });
    assert.ok(frame, 'explicit `original` must keep the islands sideload');
  } finally {
    previewGeometry.dispose();
  }
});

test('Ph2 R5: `decimated` suppresses the islands sideload frame', () => {
  const { model, previewGeometry } = buildDecimatedImportModel();
  try {
    const input: IslandScanFrameInput = {
      sourcePath: model.sourcePath,
      geometry: model.geometry,
      outputMode: 'decimated',
    };
    assert.equal(
      resolveIslandScanFrame(input),
      null,
      'the sideload re-reads the ORIGINAL file from disk — under `decimated` it '
        + 'must return null so the caller scans the scene geometry instead.',
    );
  } finally {
    previewGeometry.dispose();
  }
});

/**
 * #11 LOCK — mesh minima is NOT routed.
 *
 * The user ruled that mesh-minima behaviour is UNCHANGED: it consumes the full
 * model on that path, preview-fidelity by construction. That is a BEHAVIOUR
 * guarantee, so it needs a test, not a comment. `scanMeshMinima` takes a bare
 * `Float32Array` of world positions — it has no model, no policy, and no way to
 * consult the chokepoint — and this test pins that shape so a future "route
 * everything" sweep cannot quietly rewire it.
 */
test('Ph2 R6 (#11 LOCK): mesh minima takes raw positions and never consults the chokepoint', async () => {
  const meshMinima = await import('@/volumeAnalysis/Islands/meshMinima');
  assert.equal(typeof meshMinima.scanMeshMinima, 'function');
  assert.equal(
    meshMinima.scanMeshMinima.length,
    2,
    'scanMeshMinima(positions, k) — a model-aware signature would mean it had '
      + 'been rewired through the output policy, which ruling #11 forbids.',
  );
  const moduleExports = meshMinima as Record<string, unknown>;
  assert.equal(
    Object.keys(moduleExports).filter((key) => key.toLowerCase().includes('policy')).length,
    0,
  );
});

/**
 * The opt-out must be an explicit, NAMED call — silence must not be a valid way
 * to get preview geometry into a Rust round-trip. The reason is a closed union,
 * so adding a new preview-consuming Rust caller is a visible diff in the
 * chokepoint module rather than an omission at a call site nobody reviews.
 */
test('Ph2 R7: preview geometry for a Rust consumer requires a named, enumerated reason', () => {
  const { model, previewGeometry } = buildDecimatedImportModel();
  try {
    assert.ok(PREVIEW_GEOMETRY_OPT_OUT_REASONS.includes('mesh-minima-full-model'));
    assert.ok(PREVIEW_GEOMETRY_OPT_OUT_REASONS.includes('islands-client-scan'));
    assert.equal(
      resolvePreviewGeometryForRustConsumer(model, 'mesh-minima-full-model'),
      previewGeometry,
    );
    assert.equal(
      resolvePreviewGeometryForRustConsumer.length,
      2,
      'the reason argument is mandatory — an arity of 1 would let a caller opt '
        + 'out silently.',
    );
  } finally {
    previewGeometry.dispose();
  }
});

/**
 * A model with no `nativePreview` has no full-resolution source to toggle TO.
 * The flag must be inert for it in BOTH directions — `decimated` on an ordinary
 * model resolves to exactly the same scene BufferGeometry object it always did,
 * so the byte-identical path for ≤budget models is untouched by Ph2.
 */
test('Ph2 R8: the flag is inert for a model that was never decimated', () => {
  const { model, previewGeometry } = buildDecimatedImportModel({
    outputPolicy: { mode: 'decimated' },
  } as Partial<LoadedModel>);
  delete (model.geometry as { nativePreview?: unknown }).nativePreview;
  try {
    const resolved = resolveOutputGeometrySource(model);
    assert.equal(resolved.kind, 'scene-geometry');
    assert.equal(resolved.kind === 'scene-geometry' ? resolved.geometry : null, previewGeometry);
    assert.equal(planModelRustAnalysisStaging(model).kind, 'scene-geometry');
  } finally {
    previewGeometry.dispose();
  }
});
