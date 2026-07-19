import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import * as prepareModelGeometryModule from '../prepareModelGeometry';
import { prepareLoadedModelsForOutput } from '../prepareModelGeometry';

/**
 * P0c RED HARNESS — R1: the output-source contract (STL import decimation
 * remediation, plan Phase 0 step 5 / Phase 1; docs in
 * `agents/Claude/STL-import-perf/`).
 *
 * CONTRACT: output-bearing consumers (slicing staging, mesh export) must not
 * receive preview geometry when `geometry.nativePreview` is set. For a >6M
 * import, the scene geometry is a ~2M unbounded-error decimation of the
 * original file; slicing it produces the reported print defects. Phase 1
 * (Option A hardened, ratification pending) routes such models through a
 * Rust-side full-res splice: re-read `model.sourcePath`, reproject
 * `w = M · (v_raw − C_pre)`, stage without the bytes entering the WebView.
 *
 * SEAM: `prepareLoadedModelsForOutput` is the single choke point every slice
 * job's models pass through (sole prod caller: sliceExportOrchestrator.ts,
 * `Baking Modifiers` step) — the census (20260718-P0-Consumer-census.md §3.1)
 * designates it as the home of Phase 1's source resolver. Today it has NO
 * injectable seam: it resolves every model's staging source to
 * `model.geometry.geometry` (the preview object) unconditionally.
 *
 * WHAT PHASE 1 MUST EXPOSE (so this test can go green):
 *  - preferred: export an output-source resolver from prepareModelGeometry.ts
 *    (looked up below as `resolveOutputGeometrySource`) returning, for a
 *    native-preview model with a `sourcePath`, a full-res source descriptor
 *    (referencing `sourcePath`, never the preview BufferGeometry) that the
 *    orchestrator turns into the Rust-side splice call;
 *  - or: make `prepareLoadedModelsForOutput` itself attach the full-res
 *    routing so the prepared model no longer presents the preview
 *    BufferGeometry as its staging geometry (the fallback branch below).
 *
 * SKIPPED IN-TREE because it FAILS today by design (red-first, plan §D1) and
 * the pinned `npm test` baseline (237/237/0) must gain skips only. Red proof:
 * flip `skip` to false locally, run
 * `node --import tsx --test src/features/mesh-modifiers/__tests__/outputSourceResolution.test.ts`,
 * capture the failure, re-skip. The captured run is quoted in the P0c report.
 */
const R1_SKIP_REASON =
  'red until Phase 1 (full-res output routing for native-preview models) — un-skip locally for the red proof';

function buildNativePreviewMockModel(): { model: LoadedModel; previewGeometry: THREE.BufferGeometry } {
  // Stand-in for the ~2M-triangle preview: what matters is that it is the
  // scene BufferGeometry of a model whose nativePreview marker says the
  // original had 12M triangles.
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
    name: 'pre-supported-plate-12m.stl',
    fileUrl: '',
    // Retained at import for every route that can produce a preview model
    // (decision memo §1.1) — the datum Option A re-reads at output time.
    sourcePath: 'X:/fixtures/pre-supported-plate-12m.stl',
    visible: true,
    color: '#ffffff',
    // The scene stores the ORIGINAL count for preview models (concealment,
    // Phase 2's target) — mirrored here for realism.
    polygonCount: 12_000_000,
    geometry: {
      geometry: previewGeometry,
      bbox,
      center,
      size,
      flatteningPlanes: [],
      nativePreview: {
        originalTriangleCount: 12_000_000,
        previewTriangleCount: 2,
      },
    },
    transform: {
      position: new THREE.Vector3(10, -4, 2.5),
      rotation: new THREE.Euler(0, 0, Math.PI / 6),
      scale: new THREE.Vector3(1.25, 1, 0.8),
    },
  } as unknown as LoadedModel;

  return { model, previewGeometry };
}

test(
  'R1: staging source for a native-preview model resolves to full resolution, not the preview',
  { skip: R1_SKIP_REASON },
  async () => {
    const { model, previewGeometry } = buildNativePreviewMockModel();

    // Preferred Phase-1 seam: a dedicated output-source resolver. Looked up
    // dynamically so this file compiles today (the resolver does not exist
    // yet) and starts exercising the real seam the moment Phase 1 exports it.
    const moduleExports = prepareModelGeometryModule as Record<string, unknown>;
    const resolveOutputGeometrySource = moduleExports['resolveOutputGeometrySource'];
    if (typeof resolveOutputGeometrySource === 'function') {
      const resolved: unknown = await resolveOutputGeometrySource(model);
      assert.ok(
        resolved && typeof resolved === 'object',
        'resolveOutputGeometrySource must return a source descriptor',
      );
      const descriptor = resolved as { sourcePath?: unknown; geometry?: unknown };
      assert.notEqual(
        descriptor.geometry,
        previewGeometry,
        'the resolved staging source must not be the preview BufferGeometry',
      );
      assert.equal(
        descriptor.sourcePath,
        model.sourcePath,
        'a native-preview model with a sourcePath must resolve to a full-res '
          + 'file source for the Rust-side splice (decision memo §4.3)',
      );
      return;
    }

    // Closest testable boundary today: the prepared models handed to the
    // slice orchestrator. RED today: prepareLoadedModelsForOutput passes the
    // preview BufferGeometry through as the staging source for every model,
    // nativePreview or not.
    const prepared = await prepareLoadedModelsForOutput([model]);
    try {
      assert.equal(prepared.models.length, 1);
      const staged = prepared.models[0];
      assert.notEqual(
        staged.geometry.geometry,
        previewGeometry,
        'output-bearing consumers must not receive preview geometry when '
          + 'nativePreview is set: the staging source for this 12M-triangle model '
          + 'resolved to its ~2M preview BufferGeometry (the import-decimation '
          + 'defect — plan §A). Phase 1 must route it to the full-resolution '
          + `source at ${String(model.sourcePath)} via the Rust-side splice.`,
      );
    } finally {
      prepared.dispose();
      previewGeometry.dispose();
    }
  },
);
