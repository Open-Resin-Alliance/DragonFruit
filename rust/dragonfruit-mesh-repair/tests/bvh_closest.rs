mod common;

use common::{cube_at, uv_sphere, Rng};
use dragonfruit_mesh_repair::core::bvh::{closest_point_on_triangle, Bvh};
use dragonfruit_mesh_repair::{IndexedMesh, Vec3};

fn brute_force(mesh: &IndexedMesh, p: Vec3) -> (f32, Vec3) {
    let mut best = (f32::INFINITY, Vec3::ZERO);
    for f in 0..mesh.triangle_count() as u32 {
        let [a, b, c] = mesh.tri_positions(f);
        let q = closest_point_on_triangle(p, a, b, c);
        let d = q.sub(p);
        let d2 = d.dot(d);
        if d2 < best.0 {
            best = (d2, q);
        }
    }
    best
}

fn assert_matches_brute_force(mesh: &IndexedMesh, seed: u64) {
    let bvh = Bvh::build(mesh);
    let bb = mesh.bbox();
    let pad = bb.diag() * 0.5;
    let mut rng = Rng::new(seed);
    for _ in 0..500 {
        let p = Vec3::new(
            rng.range(bb.min.x - pad, bb.max.x + pad),
            rng.range(bb.min.y - pad, bb.max.y + pad),
            rng.range(bb.min.z - pad, bb.max.z + pad),
        );
        let (d2, face, q) = bvh.closest_point(mesh, p);
        let (bd2, _) = brute_force(mesh, p);
        assert!(
            (d2 - bd2).abs() <= 1e-5 * (1.0 + bd2),
            "bvh dist² {d2} != brute-force {bd2} at {p:?}"
        );
        assert!(face != u32::MAX);
        // Returned point must actually realize the returned distance.
        let dq = q.sub(p);
        assert!((dq.dot(dq) - d2).abs() <= 1e-4 * (1.0 + d2));
    }
}

#[test]
fn closest_point_matches_brute_force_on_sphere() {
    let sphere = uv_sphere(Vec3::new(0.0, 0.0, 0.0), 1.0, 12, 18);
    assert_matches_brute_force(&sphere, 42);
}

#[test]
fn closest_point_matches_brute_force_on_cube() {
    let cube = cube_at(Vec3::new(0.0, 0.0, 0.0), 2.0);
    assert_matches_brute_force(&cube, 7);
}

#[test]
fn closest_point_on_surface_is_zero() {
    let sphere = uv_sphere(Vec3::new(0.0, 0.0, 0.0), 1.0, 12, 18);
    let bvh = Bvh::build(&sphere);
    for f in (0..sphere.triangle_count() as u32).step_by(17) {
        let [a, b, c] = sphere.tri_positions(f);
        let centroid = a.add(b).add(c).scale(1.0 / 3.0);
        let (d2, _, _) = bvh.closest_point(&sphere, centroid);
        assert!(d2 <= 1e-10, "on-surface point has dist² {d2}");
    }
}

#[test]
fn closest_point_far_outside_sphere_matches_analytic() {
    // Densely tessellated sphere: distance from a far point should be close
    // to |p| - r.
    let sphere = uv_sphere(Vec3::new(0.0, 0.0, 0.0), 1.0, 48, 64);
    let bvh = Bvh::build(&sphere);
    let p = Vec3::new(5.0, 0.0, 0.0);
    let (d2, _, _) = bvh.closest_point(&sphere, p);
    assert!((d2.sqrt() - 4.0).abs() < 0.01);
}

#[test]
fn fixture_meshes_are_outward_wound() {
    assert!(uv_sphere(Vec3::ZERO, 1.0, 12, 18).signed_volume() > 0.0);
    assert!(cube_at(Vec3::ZERO, 2.0).signed_volume() > 0.0);
}
