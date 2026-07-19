//! P0c RED HARNESS — Phase-3 input-hygiene contract tests (plan:
//! `agents/Claude/STL-import-perf/20260718-Implementation-Plan-stl-import-decimation-remediation.md`,
//! Phase 0 step 5 / Phase 3).
//!
//! These were `#[ignore]`d red tests (red-first discipline, plan §D1); Phase 3
//! (finite filter + weld-ε clamp, `core/mesh.rs`) turned them GREEN and they now
//! run in the default suite.
//!
//! They express the Phase-3 contract for `IndexedMesh::from_triangle_soup`
//! (`src/core/mesh.rs`, soup-entry weld):
//!
//! 1. A non-finite (Inf/NaN) vertex must NOT poison the weld: today one Inf
//!    coordinate makes the bbox diagonal infinite, the quantization step
//!    infinite, `inv_step == 0`, and EVERY vertex maps to grid key (0,0,0) —
//!    the whole mesh welds to a single point. Phase 3 drops the containing
//!    triangle (counted, surfaced in the analysis report) instead.
//! 2. The weld step must be clamped to an absolute ceiling of 50 µm
//!    (`min(1e-5 × bbox_diag, 0.05 mm)`): today a single 10 m outlier vertex
//!    inflates the bbox diagonal to ~17,320 mm, so the bbox-relative step is
//!    ~173 µm and vertices 60 µm apart — a real support-tip gap scale — are
//!    welded together. 50 µm ≈ ¼ of the smallest support-tip gap the slicer
//!    must preserve.

use dragonfruit_mesh_repair::IndexedMesh;

/// The canonical soup-entry epsilon used by the production STL path
/// (`io::stl::parse_binary` / `parse_ascii` pass `io::DEFAULT_MERGE_EPSILON`).
const PRODUCTION_MERGE_EPSILON: f32 = dragonfruit_mesh_repair::io::DEFAULT_MERGE_EPSILON;

/// Phase-3 weld-step ceiling, in mm (50 µm).
const WELD_STEP_CEILING_MM: f32 = 0.05;

fn push_tri(soup: &mut Vec<f32>, a: [f32; 3], b: [f32; 3], c: [f32; 3]) {
    soup.extend_from_slice(&a);
    soup.extend_from_slice(&b);
    soup.extend_from_slice(&c);
}

/// Axis-aligned 12-triangle box soup.
fn push_box(soup: &mut Vec<f32>, min: [f32; 3], max: [f32; 3]) {
    let [x0, y0, z0] = min;
    let [x1, y1, z1] = max;
    // -Z / +Z
    push_tri(soup, [x0, y0, z0], [x1, y1, z0], [x1, y0, z0]);
    push_tri(soup, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
    push_tri(soup, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1]);
    push_tri(soup, [x0, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    // -Y / +Y
    push_tri(soup, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]);
    push_tri(soup, [x0, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    push_tri(soup, [x0, y1, z0], [x1, y1, z1], [x1, y1, z0]);
    push_tri(soup, [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
    // -X / +X
    push_tri(soup, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
    push_tri(soup, [x0, y0, z0], [x0, y1, z1], [x0, y1, z0]);
    push_tri(soup, [x1, y0, z0], [x1, y1, z1], [x1, y0, z1]);
    push_tri(soup, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
}

fn has_position_within(mesh: &IndexedMesh, p: [f32; 3], tol_mm: f32) -> bool {
    mesh.positions.iter().any(|q| {
        let dx = q.x - p[0];
        let dy = q.y - p[1];
        let dz = q.z - p[2];
        (dx * dx + dy * dy + dz * dz).sqrt() <= tol_mm
    })
}

/// R3a — one Inf vertex must not weld the whole mesh to a point.
///
/// RED today: the Inf coordinate makes `bbox.diag()` infinite →
/// `step = (merge_epsilon * diag).max(1e-7)` is infinite → `inv_step == 0` →
/// every vertex (finite or not) quantizes to key (0,0,0) and the entire soup
/// collapses into the first interned vertex (`vertex_count() == 1`).
///
/// GREEN after Phase 3: the triangle containing the non-finite vertex is
/// dropped (and counted); the 10 mm cube survives with its 8 corners and a
/// finite, cube-sized bbox.
#[test]
fn r3a_nonfinite_vertex_must_not_collapse_mesh_to_a_point() {
    // A sane 10 mm cube (12 triangles, 36 soup vertices, 8 unique corners)...
    let mut soup = Vec::new();
    push_box(&mut soup, [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    // ...plus ONE junk triangle carrying a single +Inf coordinate.
    push_tri(
        &mut soup,
        [f32::INFINITY, 0.0, 0.0],
        [5.0, 5.0, 0.0],
        [5.0, 0.0, 5.0],
    );

    let mesh = IndexedMesh::from_triangle_soup(&soup, PRODUCTION_MERGE_EPSILON);

    // Contract: the finite cube geometry must survive.
    assert!(
        mesh.vertex_count() >= 8,
        "one Inf vertex welded the whole mesh to a point: vertex_count = {} (expected >= 8 \
         surviving cube corners); triangle_count = {}",
        mesh.vertex_count(),
        mesh.triangle_count(),
    );

    // Contract: bbox stays finite and cube-sized (10 mm cube diagonal ≈ 17.32 mm).
    let bbox = mesh.bbox();
    let diag = bbox.diag();
    assert!(
        diag.is_finite() && (17.0..18.0).contains(&diag),
        "bbox poisoned by the non-finite vertex: diag = {diag} mm (expected ≈ 17.32 mm cube \
         diagonal); min = {:?}, max = {:?}",
        bbox.min,
        bbox.max,
    );
}

/// R3b — a far outlier vertex must not inflate the weld step past 50 µm.
///
/// Soup bbox: exactly (0,0,0)–(10_000,10_000,10_000) mm (a 10 m outlier
/// triangle plus a small anchor triangle at the origin). Today's weld step:
///
/// ```text
/// step = 1e-5 × diag = 1e-5 × 10_000·√3 ≈ 0.1732 mm  (173 µm)
/// ```
///
/// The two probe vertices A=(2.05, 3, 4) and B=(2.11, 3, 4) are 60 µm apart —
/// larger than any real support-tip gap tolerance — and both quantize to the
/// same 173 µm grid cell (x: 11.84 → 12 and 12.18 → 12), so TODAY they weld
/// into one vertex and B's position disappears from the output. RED.
///
/// GREEN after Phase 3: with the step clamped to ≤ 50 µm, a 60 µm separation
/// can never share a rounding cell (60/50 = 1.2 > 1 cell), so both probe
/// positions survive verbatim regardless of grid alignment.
#[test]
fn r3b_outlier_vertex_must_not_inflate_weld_step_past_50_microns() {
    let probe_a = [2.05_f32, 3.0, 4.0];
    let probe_b = [2.11_f32, 3.0, 4.0]; // 60 µm from probe_a along x
    let probe_separation_mm = 0.06_f32;
    assert!(probe_separation_mm > WELD_STEP_CEILING_MM); // the proxy is valid

    let mut soup = Vec::new();
    // Anchor triangle pinning bbox.min at the origin.
    push_tri(&mut soup, [0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [0.0, 10.0, 0.0]);
    // The 10 m outlier triangle pinning bbox.max at (10_000, 10_000, 10_000).
    push_tri(
        &mut soup,
        [10_000.0, 10_000.0, 10_000.0],
        [9_990.0, 10_000.0, 10_000.0],
        [10_000.0, 9_990.0, 10_000.0],
    );
    // Probe triangles: only the FIRST vertex of each is under test; the other
    // vertices sit far (≫ step) from the probes and from each other.
    push_tri(&mut soup, probe_a, [6.0, 3.0, 4.0], [2.05, 7.0, 4.0]);
    push_tri(&mut soup, probe_b, [6.0, 3.0, 8.0], [2.11, 7.0, 8.0]);

    let mesh = IndexedMesh::from_triangle_soup(&soup, PRODUCTION_MERGE_EPSILON);

    // Both probe positions must survive the weld exactly (they are stored
    // verbatim when interned; 1 µm tolerance covers nothing but themselves —
    // the nearest other vertex is ≥ 60 µm away).
    assert!(
        has_position_within(&mesh, probe_a, 0.001),
        "probe A {probe_a:?} missing from welded output (vertex_count = {})",
        mesh.vertex_count(),
    );
    assert!(
        has_position_within(&mesh, probe_b, 0.001),
        "probe B {probe_b:?} was welded into probe A (60 µm apart) — the 10 m outlier \
         inflated the weld step to ~173 µm (> the 50 µm Phase-3 ceiling); \
         vertex_count = {}",
        mesh.vertex_count(),
    );
}
