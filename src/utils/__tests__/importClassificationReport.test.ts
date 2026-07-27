/**
 * Ph1 wiring (d) — the signals the removed P6 `>= 3M` gate used to starve.
 *
 * `component_count` (the shell count in the model list and stats card),
 * `likely_support_geometry` (the orange support tint and the Split-to-Bodies
 * gate) and `model_triangle_count` (the model/support section split) all reach
 * the UI through ONE structure: `meshDefects.nativeRepairReport`. This is the
 * projection that puts the import-time classification into it, so these are the
 * assertions that say the signals are back.
 *
 * The second thing under test is the honesty contract: a field the cheap tier
 * did not measure must arrive as `null` and render as an em dash — never as a
 * confident `false`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  importClassificationToHealthReport,
  parseImportClassification,
  type ImportClassificationJson,
} from '../meshRepair';

const SUPPORTED_PLATE = {
  model_triangle_count: 768,
  likely_support_geometry: true,
  connected_components: 201,
  model_section: {
    triangle_count: 768,
    vertex_count: 386,
    connected_components: 1,
    boundary_edges: 0,
    boundary_loops: 0,
    largest_boundary_loop: 0,
    non_manifold_edges: 0,
    non_manifold_vertices: 0,
    inconsistent_winding_edges: 0,
    is_watertight: true,
    self_intersection_triangles: null,
    elapsed_ms: 4,
  },
  support_section: {
    triangle_count: 2400,
    vertex_count: 1600,
    connected_components: 200,
    boundary_edges: 0,
    boundary_loops: 0,
    largest_boundary_loop: 0,
    non_manifold_edges: 0,
    non_manifold_vertices: 0,
    inconsistent_winding_edges: 0,
    is_watertight: true,
    self_intersection_triangles: null,
    elapsed_ms: 6,
  },
  source_triangle_count: 3168,
  dropped_nonfinite_triangles: 0,
  model_is_manifold: null,
  model_manifold_status: null,
  manifold_check_size_guarded: true,
  classify_ms: 3774,
  section_stats_ms: 120,
  run_count: 2,
};

test('the classification restores the shell count, the support verdict and the split', () => {
  const classification = parseImportClassification(SUPPORTED_PLATE);
  assert.ok(classification);

  const report = importClassificationToHealthReport(classification, {
    triangleCount: 3168,
    vertexCount: 9504,
  });

  // Shell count — `ModelManagerPanel` / `ModelStatsCard` read `post.component_count`.
  assert.equal(report.post.component_count, 201);
  // Orange tint + Split-to-Bodies gate.
  assert.equal(report.likely_support_geometry, true);
  // The model/support section boundary.
  assert.equal(report.model_triangle_count, 768);
});

test('a size-guarded manifold check is UNKNOWN, not "not manifold"', () => {
  const classification = parseImportClassification(SUPPORTED_PLATE);
  const report = importClassificationToHealthReport(classification!, {
    triangleCount: 3168,
    vertexCount: 9504,
  });

  assert.equal(
    report.model_is_manifold,
    null,
    'a mesh nobody looked at is not a mesh that failed',
  );
  assert.equal(report.model_manifold_status, null);
});

test('an absent model section leaves watertightness UNKNOWN rather than false', () => {
  const classification = parseImportClassification({
    ...SUPPORTED_PLATE,
    model_section: null,
    support_section: null,
  });
  const report = importClassificationToHealthReport(classification!, {
    triangleCount: 8,
    vertexCount: 24,
  });

  assert.equal(report.post.is_watertight, null, 'unmeasured must render as an em dash');
});

test('an unmeasured numeric stat decodes to null, never to a measured-looking zero', () => {
  const classification = parseImportClassification({
    ...SUPPORTED_PLATE,
    model_section: { ...SUPPORTED_PLATE.model_section, boundary_edges: null },
  });
  assert.equal(classification?.model_section?.boundary_edges, null);
  assert.equal(
    classification?.model_section?.self_intersection_triangles,
    null,
    'the BVH sweep never runs at this tier — the field is null by construction',
  );
});

test('no reliable split means no split — not a split covering the whole mesh', () => {
  const classification = parseImportClassification({
    ...SUPPORTED_PLATE,
    model_triangle_count: null,
    likely_support_geometry: false,
    run_count: 0,
  });
  const report = importClassificationToHealthReport(classification!, {
    triangleCount: 3168,
    vertexCount: 9504,
  });

  assert.equal(report.model_triangle_count, null);
  assert.equal(report.likely_support_geometry, false);
});

test('a classify pass does not present itself as a failed repair', () => {
  const classification = parseImportClassification(SUPPORTED_PLATE) as ImportClassificationJson;
  const report = importClassificationToHealthReport(classification, {
    triangleCount: 3168,
    vertexCount: 9504,
  });

  // `repairReportNeedsAttention` treats `!fully_repaired` as "raise the repair
  // report modal". A classify pass has nothing to repair, and must not trip it.
  assert.equal(report.fully_repaired, true);
  assert.deepEqual(report.residual_issues, []);
  assert.deepEqual(report.pre, report.post, 'classification reorders; it does not change the mesh');
});

test('a missing classification block decodes to null rather than to an empty verdict', () => {
  assert.equal(parseImportClassification(null), null);
  assert.equal(parseImportClassification(undefined), null);
});
