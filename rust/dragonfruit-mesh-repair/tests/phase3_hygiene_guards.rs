//! Phase-3 GUARD tests (green today AND after the Phase-3 fix / CP5 rider).
//!
//! Plan: `agents/Claude/STL-import-perf/20260718-Implementation-Plan-stl-import-decimation-remediation.md`
//! Phase 3, checkpoint CP1. These are NOT `#[ignore]`d — they must pass on the
//! pre-fix code so they can serve as regression/oracle anchors:
//!
//!  * `no_regression_weld_*` — proves the weld-ε CLAMP (CP3) does not change
//!    behaviour at a NORMAL bbox (where `1e-5 × diag ≪ 50 µm`, so the ceiling
//!    never binds): a ~1 µm pair still welds, a 100 µm pair stays distinct.
//!  * `soup_determinism_snapshot` — pins the exact vertex set + triangle→vertex
//!    mapping (first-seen interning order) of `from_triangle_soup` on a fixed
//!    small mesh. This is the ORACLE the CP5 parallelization must reproduce
//!    byte-for-byte; if a parallel reindex changes ordering, this test fails.

use dragonfruit_mesh_repair::core::mesh::TriangleSoupStats;
use dragonfruit_mesh_repair::{IndexedMesh, Vec3};

const PRODUCTION_MERGE_EPSILON: f32 = dragonfruit_mesh_repair::io::DEFAULT_MERGE_EPSILON;

fn push_tri(soup: &mut Vec<f32>, a: [f32; 3], b: [f32; 3], c: [f32; 3]) {
    soup.extend_from_slice(&a);
    soup.extend_from_slice(&b);
    soup.extend_from_slice(&c);
}

/// Axis-aligned 12-triangle box soup (identical helper to the red harness).
fn push_box(soup: &mut Vec<f32>, min: [f32; 3], max: [f32; 3]) {
    let [x0, y0, z0] = min;
    let [x1, y1, z1] = max;
    push_tri(soup, [x0, y0, z0], [x1, y1, z0], [x1, y0, z0]);
    push_tri(soup, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
    push_tri(soup, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1]);
    push_tri(soup, [x0, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    push_tri(soup, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]);
    push_tri(soup, [x0, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    push_tri(soup, [x0, y1, z0], [x1, y1, z1], [x1, y1, z0]);
    push_tri(soup, [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
    push_tri(soup, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
    push_tri(soup, [x0, y0, z0], [x0, y1, z1], [x0, y1, z0]);
    push_tri(soup, [x1, y0, z0], [x1, y1, z1], [x1, y0, z1]);
    push_tri(soup, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
}

fn count_positions_near(mesh: &IndexedMesh, p: [f32; 3], tol_mm: f32) -> usize {
    mesh.positions
        .iter()
        .filter(|q| {
            let dx = q.x - p[0];
            let dy = q.y - p[1];
            let dz = q.z - p[2];
            (dx * dx + dy * dy + dz * dz).sqrt() <= tol_mm
        })
        .count()
}

/// CP1 guard (a): at a NORMAL bbox a ~1 µm pair welds and a 100 µm pair does
/// not. The bbox is a 200 mm cube (diag ≈ 346.4 mm → step = 1e-5·diag ≈
/// 3.46 µm, far under the 50 µm clamp ceiling), so the CP3 clamp is INACTIVE
/// here and this behaviour must be identical before and after the fix.
#[test]
fn no_regression_weld_normal_bbox() {
    // The cube fixes the bbox; both probe regions sit inside it so they never
    // extend it. 1 µm ≈ 0.29 cell → a well-centred pair shares a cell; 100 µm
    // ≈ 29 cells → distinct regardless of grid alignment.
    let weld_p = [50.0_f32, 50.0, 50.0];
    let weld_q = [50.001_f32, 50.0, 50.0]; // +1 µm along x

    let sep_p = [120.0_f32, 50.0, 50.0];
    let sep_q = [120.1_f32, 50.0, 50.0]; // +100 µm along x

    let mut soup = Vec::new();
    push_box(&mut soup, [0.0, 0.0, 0.0], [200.0, 200.0, 200.0]);
    // Two probe triangles whose FIRST vertex is the 1 µm pair (other corners
    // sit far away so only the first vertices are under test).
    push_tri(&mut soup, weld_p, [60.0, 50.0, 50.0], [50.0, 60.0, 50.0]);
    push_tri(&mut soup, weld_q, [60.0, 50.0, 55.0], [50.0, 60.0, 55.0]);
    // Two probe triangles whose FIRST vertex is the 100 µm pair.
    push_tri(&mut soup, sep_p, [130.0, 50.0, 50.0], [120.0, 60.0, 50.0]);
    push_tri(&mut soup, sep_q, [130.0, 50.0, 55.0], [120.1, 60.0, 55.0]);

    let mesh = IndexedMesh::from_triangle_soup(&soup, PRODUCTION_MERGE_EPSILON);

    // The 1 µm pair welds: exactly ONE surviving vertex within 2 µm of weld_p.
    assert_eq!(
        count_positions_near(&mesh, weld_p, 0.002),
        1,
        "1 µm-apart vertices must weld to one at a normal bbox (found {} near {weld_p:?})",
        count_positions_near(&mesh, weld_p, 0.002),
    );

    // The 100 µm pair does NOT weld: both positions survive distinctly.
    assert!(
        count_positions_near(&mesh, sep_p, 0.001) == 1
            && count_positions_near(&mesh, sep_q, 0.001) == 1,
        "100 µm-apart vertices must NOT weld at a normal bbox (near p={}, near q={})",
        count_positions_near(&mesh, sep_p, 0.001),
        count_positions_near(&mesh, sep_q, 0.001),
    );
}

/// Emit one subdivided-cube face as an `s × s` grid of quads (2 tris each)
/// into `soup`. `map` places a grid point `(a, b)` at its 3D position on the
/// given face. Adjacent faces emit shared edge/corner vertices at BYTE-EQUAL
/// coordinates so the weld merges them.
fn push_cube_face(soup: &mut Vec<f32>, s: usize, map: impl Fn(f32, f32) -> [f32; 3]) {
    let sf = s as f32;
    for i in 0..s {
        for j in 0..s {
            let u0 = i as f32 / sf;
            let u1 = (i + 1) as f32 / sf;
            let v0 = j as f32 / sf;
            let v1 = (j + 1) as f32 / sf;
            let a = map(u0, v0);
            let b = map(u1, v0);
            let c = map(u1, v1);
            let d = map(u0, v1);
            push_tri(soup, a, b, c);
            push_tri(soup, a, c, d);
        }
    }
}

/// CP5 verify: the parallel bbox reduction produces a BYTE-IDENTICAL weld to
/// the serial path at scale. A subdivided unit cube at `s = 65` per face is
/// `6·65²·2 = 50 700` triangles — over `PARALLEL_WELD_MIN_TRIS`, so the
/// parallel bbox path runs — and welds to exactly the cube-surface lattice
/// point count `(s+1)³ − (s−1)³`. If the parallel reduction computed a wrong
/// diagonal, the weld step would change and this exact count would not hold.
#[test]
fn parallel_weld_matches_analytic_vertex_count_at_scale() {
    let s = 65usize;
    let mut soup = Vec::new();
    // Six faces of the unit cube; shared edges use identical i/s coordinates.
    push_cube_face(&mut soup, s, |u, v| [u, v, 1.0]); // +Z
    push_cube_face(&mut soup, s, |u, v| [u, v, 0.0]); // -Z
    push_cube_face(&mut soup, s, |u, v| [1.0, u, v]); // +X
    push_cube_face(&mut soup, s, |u, v| [0.0, u, v]); // -X
    push_cube_face(&mut soup, s, |u, v| [u, 1.0, v]); // +Y
    push_cube_face(&mut soup, s, |u, v| [u, 0.0, v]); // -Y

    let mesh = IndexedMesh::from_triangle_soup(&soup, PRODUCTION_MERGE_EPSILON);

    let expected_tris = 6 * s * s * 2;
    assert_eq!(mesh.triangle_count(), expected_tris);
    assert!(
        mesh.triangle_count() >= 50_000,
        "test must cross PARALLEL_WELD_MIN_TRIS to exercise the parallel path"
    );

    // Cube-surface lattice points on an (s+1)^3 grid, minus the (s-1)^3 interior.
    let expected_verts = (s + 1).pow(3) - (s - 1).pow(3);
    assert_eq!(
        mesh.vertex_count(),
        expected_verts,
        "parallel bbox reduction changed the weld: got {} verts, analytic {}",
        mesh.vertex_count(),
        expected_verts
    );
}

/// CP2 verify: non-finite triangles are dropped AND the drop count is
/// surfaced (not silently swallowed) via `from_triangle_soup_reported`. Covers
/// both ±Inf and NaN corners, and confirms a clean mesh reports zero drops.
#[test]
fn nonfinite_triangles_are_counted_and_surfaced() {
    // 12-tri cube (all finite) + one +Inf triangle + one NaN triangle.
    let mut soup = Vec::new();
    push_box(&mut soup, [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    push_tri(
        &mut soup,
        [f32::INFINITY, 0.0, 0.0],
        [5.0, 5.0, 0.0],
        [5.0, 0.0, 5.0],
    );
    push_tri(
        &mut soup,
        [1.0, f32::NAN, 1.0],
        [2.0, 2.0, 1.0],
        [1.0, 2.0, 2.0],
    );

    let (mesh, stats) = IndexedMesh::from_triangle_soup_reported(&soup, PRODUCTION_MERGE_EPSILON);

    assert_eq!(
        stats.dropped_nonfinite_triangles, 2,
        "both the Inf and NaN triangles must be counted as dropped"
    );
    assert_eq!(
        mesh.triangle_count(),
        12,
        "only the 12 finite cube triangles must survive (got {})",
        mesh.triangle_count()
    );
    assert!(
        mesh.bbox().diag().is_finite(),
        "bbox must be finite after non-finite triangles are quarantined"
    );

    // A clean mesh reports zero drops (default stats).
    let mut clean = Vec::new();
    push_box(&mut clean, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let (_clean_mesh, clean_stats) =
        IndexedMesh::from_triangle_soup_reported(&clean, PRODUCTION_MERGE_EPSILON);
    assert_eq!(clean_stats, TriangleSoupStats::default());
    assert_eq!(clean_stats.dropped_nonfinite_triangles, 0);
}

/// CP1 guard (b): deterministic topology/ordering snapshot for
/// `from_triangle_soup`. The soup is 3 triangles with hand-chosen shared
/// corners at 1 mm spacing (bbox diag ≈ 2.24 mm → step ≈ 0.022 µm, so NO
/// accidental welding): the ONLY merges are the intended coincident corners.
///
/// Expected first-seen interning order:
///   A(0,0,0)=0  B(1,0,0)=1  C(0,1,0)=2  D(1,1,0)=3  E(2,0,0)=4
/// Expected triangles: [0,1,2] [0,2,3] [1,3,4]
///
/// CP5's parallelization MUST reproduce this exactly (same vertex set, same
/// order, same index mapping) or this test fails — that is its purpose.
#[test]
fn soup_determinism_snapshot() {
    let a = [0.0_f32, 0.0, 0.0];
    let b = [1.0_f32, 0.0, 0.0];
    let c = [0.0_f32, 1.0, 0.0];
    let d = [1.0_f32, 1.0, 0.0];
    let e = [2.0_f32, 0.0, 0.0];

    let mut soup = Vec::new();
    push_tri(&mut soup, a, b, c); // introduces A,B,C
    push_tri(&mut soup, a, c, d); // reuses A,C; introduces D
    push_tri(&mut soup, b, d, e); // reuses B,D; introduces E

    let mesh = IndexedMesh::from_triangle_soup(&soup, PRODUCTION_MERGE_EPSILON);

    let expected_positions = [
        Vec3::new(0.0, 0.0, 0.0),
        Vec3::new(1.0, 0.0, 0.0),
        Vec3::new(0.0, 1.0, 0.0),
        Vec3::new(1.0, 1.0, 0.0),
        Vec3::new(2.0, 0.0, 0.0),
    ];
    let expected_triangles = [[0u32, 1, 2], [0, 2, 3], [1, 3, 4]];

    assert_eq!(
        mesh.positions, expected_positions,
        "vertex set / first-seen order changed — from_triangle_soup determinism broke"
    );
    assert_eq!(
        mesh.triangles, expected_triangles,
        "triangle→vertex mapping changed — from_triangle_soup determinism broke"
    );
}
