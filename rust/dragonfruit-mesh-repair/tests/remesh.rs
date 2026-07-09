mod common;

use common::{cube_at, uv_sphere, Rng};
use dragonfruit_mesh_repair::core::bvh::Bvh;
use dragonfruit_mesh_repair::core::halfedge::Topology;
use dragonfruit_mesh_repair::volumetric::remesh::{remesh, RemeshParams};
use dragonfruit_mesh_repair::{IndexedMesh, Vec3};

const O: Vec3 = Vec3::ZERO;

fn assert_closed_manifold(m: &IndexedMesh, ctx: &str) {
    let topo = Topology::build(m);
    assert_eq!(topo.boundary_edges().len(), 0, "{ctx}: boundary edges");
    assert_eq!(topo.non_manifold_edges().len(), 0, "{ctx}: non-manifold edges");
    assert_eq!(topo.inconsistent_edges(), 0, "{ctx}: winding flips");
    assert!(m.signed_volume() > 0.0, "{ctx}: orientation");
}

#[test]
fn remesh_sphere_stays_manifold_and_round() {
    let sphere = uv_sphere(O, 1.0, 24, 32);
    let bvh = Bvh::build(&sphere);
    let out = remesh(
        &sphere,
        Some((&sphere, &bvh)),
        &RemeshParams {
            target_triangles: usize::MAX,
            sizing_min: 0.05,
            sizing_max: 0.5,
            reproject_max_dist: 0.2,
            ..Default::default()
        },
    );
    assert_closed_manifold(&out, "sphere remesh");
    // Radius fidelity: every vertex close to the unit sphere.
    for p in &out.positions {
        assert!((p.length() - 1.0).abs() < 0.05, "vertex drifted: {p:?}");
    }
    let vol = out.signed_volume();
    let expected = 4.0 / 3.0 * std::f64::consts::PI;
    assert!((vol - expected).abs() / expected < 0.05, "volume {vol}");
}

#[test]
fn remesh_hits_triangle_budget() {
    let sphere = uv_sphere(O, 1.0, 48, 64); // 6016 tris
    let bvh = Bvh::build(&sphere);
    let target = 1200usize;
    let out = remesh(
        &sphere,
        Some((&sphere, &bvh)),
        &RemeshParams {
            target_triangles: target,
            sizing_min: 0.01,
            sizing_max: 2.0,
            reproject_max_dist: 0.2,
            ..Default::default()
        },
    );
    assert_closed_manifold(&out, "budget remesh");
    assert!(
        out.triangle_count() <= target + target / 5,
        "budget missed: {} > {}",
        out.triangle_count(),
        target
    );
    assert!(
        out.triangle_count() > target / 4,
        "over-decimated: {}",
        out.triangle_count()
    );
}

#[test]
fn remesh_cube_keeps_feature_edges() {
    let cube = cube_at(O, 2.0);
    // Pre-refine the cube so the remesher has real work.
    let bvh = Bvh::build(&cube);
    let out = remesh(
        &cube,
        Some((&cube, &bvh)),
        &RemeshParams {
            target_triangles: usize::MAX,
            sizing_min: 0.2,
            sizing_max: 0.4,
            feature_angle_deg: 35.0,
            reproject_max_dist: 0.1,
            ..Default::default()
        },
    );
    assert_closed_manifold(&out, "cube remesh");
    // Sharp geometry preserved: all vertices on the cube surface, corners
    // still present.
    let mut worst = 0.0f32;
    for p in &out.positions {
        let linf = p.x.abs().max(p.y.abs()).max(p.z.abs());
        worst = worst.max((linf - 1.0).abs());
    }
    assert!(worst < 0.02, "vertices drifted off cube faces: {worst}");
    for sx in [-1.0f32, 1.0] {
        for sy in [-1.0f32, 1.0] {
            for sz in [-1.0f32, 1.0] {
                let corner = Vec3::new(sx, sy, sz);
                let best = out
                    .positions
                    .iter()
                    .map(|p| p.sub(corner).length())
                    .fold(f32::INFINITY, f32::min);
                assert!(best < 0.05, "corner {corner:?} lost (nearest {best})");
            }
        }
    }
}

#[test]
fn remesh_improves_or_preserves_edge_uniformity() {
    let sphere = uv_sphere(O, 1.0, 40, 8); // pathologically anisotropic tessellation
    let bvh = Bvh::build(&sphere);
    let out = remesh(
        &sphere,
        Some((&sphere, &bvh)),
        &RemeshParams {
            target_triangles: usize::MAX,
            sizing_min: 0.15,
            sizing_max: 0.25,
            reproject_max_dist: 0.3,
            iterations: 6,
            ..Default::default()
        },
    );
    assert_closed_manifold(&out, "anisotropic remesh");
    let stats = |m: &IndexedMesh| -> (f32, f32) {
        let mut lens = Vec::new();
        for t in &m.triangles {
            for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                if a < b {
                    lens.push(m.positions[a as usize].sub(m.positions[b as usize]).length());
                }
            }
        }
        let mean = lens.iter().sum::<f32>() / lens.len() as f32;
        let var =
            lens.iter().map(|l| (l - mean) * (l - mean)).sum::<f32>() / lens.len() as f32;
        (mean, var.sqrt() / mean)
    };
    let (_, cv_in) = stats(&sphere);
    let (_, cv_out) = stats(&out);
    assert!(
        cv_out < cv_in,
        "edge-length variation should drop: {cv_in} -> {cv_out}"
    );
}

#[test]
fn remesh_random_params_never_break_manifoldness() {
    // Randomized stress in lieu of op-level proptest: many parameter
    // combinations over mixed inputs, invariants asserted every time.
    let mut rng = Rng::new(2024);
    let inputs = [uv_sphere(O, 1.0, 16, 24), cube_at(O, 2.0), uv_sphere(O, 0.4, 8, 10)];
    for round in 0..12 {
        let mesh = &inputs[round % inputs.len()];
        let bvh = Bvh::build(mesh);
        let params = RemeshParams {
            target_triangles: if rng.f32() < 0.5 {
                usize::MAX
            } else {
                (mesh.triangle_count() as f32 * rng.range(0.3, 0.9)) as usize
            },
            feature_angle_deg: rng.range(20.0, 60.0),
            sizing_min: rng.range(0.02, 0.15),
            sizing_max: rng.range(0.2, 1.0),
            iterations: 1 + (rng.next_u64() % 5) as usize,
            reproject_max_dist: rng.range(0.05, 0.5),
            ..Default::default()
        };
        let out = remesh(mesh, Some((mesh, &bvh)), &params);
        assert!(out.triangle_count() >= 4, "round {round}: collapsed away");
        assert_closed_manifold(&out, &format!("round {round}"));
    }
}
