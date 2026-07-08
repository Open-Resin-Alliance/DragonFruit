mod common;

use common::{concat, cube_at, inverted_sphere, punched_sphere, uv_sphere, Rng};
use dragonfruit_mesh_repair::volumetric::gwn::{winding_number_naive, WindingTree};
use dragonfruit_mesh_repair::Vec3;

const O: Vec3 = Vec3::ZERO;

#[test]
fn gwn_closed_sphere_inside_is_one_outside_is_zero() {
    let sphere = uv_sphere(O, 1.0, 16, 24);
    assert!((winding_number_naive(&sphere, O) - 1.0).abs() < 1e-3);
    assert!(
        (winding_number_naive(&sphere, Vec3::new(0.5, 0.2, -0.3)) - 1.0).abs() < 1e-3,
        "off-center interior point"
    );
    assert!(winding_number_naive(&sphere, Vec3::new(2.0, 0.0, 0.0)).abs() < 1e-3);
    assert!(winding_number_naive(&sphere, Vec3::new(0.0, -5.0, 1.0)).abs() < 1e-3);
}

#[test]
fn gwn_punched_sphere_interior_still_near_one() {
    // Remove the whole north cap (24 triangles) — a real hole, not a crack.
    let punched = punched_sphere(O, 1.0, 16, 24, 24);
    let w = winding_number_naive(&punched, O);
    assert!(w > 0.9 && w < 1.1, "interior winding {w} should stay ≈1");
    let w_out = winding_number_naive(&punched, Vec3::new(3.0, 0.0, 0.0));
    assert!(w_out.abs() < 0.1, "exterior winding {w_out} should stay ≈0");
}

#[test]
fn gwn_nested_shells_counts_two() {
    let nested = concat(&[uv_sphere(O, 2.0, 16, 24), uv_sphere(O, 1.0, 16, 24)]);
    let w = winding_number_naive(&nested, O);
    assert!((w - 2.0).abs() < 1e-3, "center of nested shells winds {w}");
    let w_between = winding_number_naive(&nested, Vec3::new(1.5, 0.0, 0.0));
    assert!((w_between - 1.0).abs() < 1e-3);
}

#[test]
fn gwn_inverted_sphere_is_minus_one() {
    let inv = inverted_sphere(O, 1.0, 16, 24);
    let w = winding_number_naive(&inv, O);
    assert!((w + 1.0).abs() < 1e-3, "inverted interior winds {w}");
}

#[test]
fn gwn_cube_inside_outside() {
    let cube = cube_at(O, 2.0);
    assert!((winding_number_naive(&cube, O) - 1.0).abs() < 1e-6);
    assert!(winding_number_naive(&cube, Vec3::new(1.7, 0.3, 0.0)).abs() < 1e-6);
}

#[test]
fn winding_tree_matches_naive() {
    let sphere = uv_sphere(O, 1.0, 40, 60); // 4680 tris
    let tree = WindingTree::build(&sphere);
    let mut rng = Rng::new(1234);
    for _ in 0..300 {
        let p = Vec3::new(
            rng.range(-2.0, 2.0),
            rng.range(-2.0, 2.0),
            rng.range(-2.0, 2.0),
        );
        // Skip points hugging the surface where both forms are legitimately
        // sensitive; the band evaluates corners, which quantization keeps off
        // the exact surface in practice.
        if (p.length() - 1.0).abs() < 0.02 {
            continue;
        }
        let exact = winding_number_naive(&sphere, p);
        let approx = tree.winding(p);
        // First-order dipole far-field at β=2: a few-e-3 absolute error is
        // expected and harmless for 0.5-threshold sign classification.
        assert!(
            (exact - approx).abs() < 5e-3,
            "tree {approx} vs naive {exact} at {p:?}"
        );
        assert_eq!(
            exact > 0.5,
            approx > 0.5,
            "classification flip at {p:?}: naive {exact} tree {approx}"
        );
    }
}

#[test]
fn winding_tree_matches_naive_on_broken_input() {
    // Tree accuracy must hold on open + multi-shell soup, not just closed
    // meshes: punched sphere + offset cube shell.
    let soup = concat(&[
        punched_sphere(O, 1.0, 24, 32, 40),
        cube_at(Vec3::new(2.5, 0.0, 0.0), 1.0),
    ]);
    let tree = WindingTree::build(&soup);
    let mut rng = Rng::new(99);
    for _ in 0..300 {
        let p = Vec3::new(
            rng.range(-2.0, 4.0),
            rng.range(-2.0, 2.0),
            rng.range(-2.0, 2.0),
        );
        let exact = winding_number_naive(&soup, p);
        let approx = tree.winding(p);
        assert!(
            (exact - approx).abs() < 5e-3,
            "tree {approx} vs naive {exact} at {p:?}"
        );
    }
}

#[test]
fn gwn_no_nan_on_surface_queries() {
    let sphere = uv_sphere(O, 1.0, 12, 18);
    // Query exactly at vertices and on triangle centroids.
    for f in (0..sphere.triangle_count() as u32).step_by(5) {
        let [a, b, c] = sphere.tri_positions(f);
        let centroid = a.add(b).add(c).scale(1.0 / 3.0);
        assert!(winding_number_naive(&sphere, centroid).is_finite());
        assert!(winding_number_naive(&sphere, a).is_finite());
    }
}
