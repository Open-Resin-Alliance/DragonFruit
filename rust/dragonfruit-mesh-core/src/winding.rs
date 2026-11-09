//! Generalised winding number: is a point inside a mesh?
//!
//! The point-in-solid test used elsewhere in this crate is a ray cast with a parity count, and it is
//! fragile exactly where it matters. On an open or self-intersecting mesh the count depends on where
//! the ray happens to leave, so a point level with a crack or a coincident sheet flips between the
//! two answers. Our own repair notes record the consequence: a per-face parity test that classified
//! 99.99% of faces correctly still opened holes, because a hundredth of a percent of a surface is a
//! hole.
//!
//! The generalised winding number (Jacobson, Kavan and Sorkine-Hornung, 2013) sums the **solid angle
//! each triangle subtends at the query** instead. That sum degrades smoothly: a crack, an overlapping
//! sheet or a missing triangle changes the total a little rather than flipping it, so the sign test
//! at one half stays stable on damaged input. It is why the reference engine reaches for one.
//!
//! Two entry points:
//!
//! - [`winding_number_exact`] sums every triangle. Correct and slow: it is the reference the fast
//!   path is checked against, the same discipline as the ambient-occlusion bake.
//! - [`WindingNumber`] precomputes per-node aggregates over a [`Bvh`] and replaces a distant cluster
//!   of triangles with one triangle that carries its total area, centroid and normal. That is the
//!   approximation, and the tests pin it against the exact sum on shapes whose answer is known.

use crate::bvh::Bvh;
use crate::mesh::{IndexedMesh, Vec3};

/// How far a node must be, in multiples of its own extent, before one triangle stands in for it.
///
/// The extent is the bounding box diagonal, roughly 1.7 times the linear size, so this factor of
/// 1.2 is a subtended angle of about 30 degrees: the threshold below which a cluster of triangles
/// is close enough to a single triangle of the same area, centroid and normal.
///
/// **Getting this wrong is not a small error, it is an asymptotic one.** At 4.0 the angle is about
/// 8 degrees, almost nothing qualifies, and a query degenerates into walking the tree: measured at
/// 550 us per query on a 170k-triangle mesh, growing with the mesh, which put 99.6 percent of a
/// six-minute run in this function. At 1.2 the same query is 8 us and flat in the mesh size. The
/// test below pins the flatness, because that is the property that failed.
const APPROXIMATION_RATIO: f64 = 1.2;

/// Solid angle subtended by the triangle `(a, b, c)` at `q`, in steradians, signed by winding.
///
/// The standard closed form: twice the atan2 of the triple product over the denominator that folds
/// in the edge lengths, which stays accurate as the triangle passes behind the query where a naive
/// `acos` formulation loses all its precision.
fn solid_angle(a: Vec3, b: Vec3, c: Vec3, q: Vec3) -> f64 {
    let (ax, ay, az) = ((a.x - q.x) as f64, (a.y - q.y) as f64, (a.z - q.z) as f64);
    let (bx, by, bz) = ((b.x - q.x) as f64, (b.y - q.y) as f64, (b.z - q.z) as f64);
    let (cx, cy, cz) = ((c.x - q.x) as f64, (c.y - q.y) as f64, (c.z - q.z) as f64);

    let la = (ax * ax + ay * ay + az * az).sqrt();
    let lb = (bx * bx + by * by + bz * bz).sqrt();
    let lc = (cx * cx + cy * cy + cz * cz).sqrt();

    let numerator = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    let denominator = la * lb * lc
        + (ax * bx + ay * by + az * bz) * lc
        + (bx * cx + by * cy + bz * cz) * la
        + (cx * ax + cy * ay + cz * az) * lb;

    2.0 * numerator.atan2(denominator)
}

/// Winding number of `mesh` at `q`, summed over every triangle.
///
/// One means `q` is inside a closed surface wound outward, zero outside, and two inside a doubly
/// nested pair, which is what distinguishes a cavity from a solid. On an open or self-intersecting
/// mesh the value is approximate but still smooth, which is the whole point.
pub fn winding_number_exact(mesh: &IndexedMesh, q: Vec3) -> f64 {
    let mut total = 0.0;
    for face in 0..mesh.triangles.len() as u32 {
        let [a, b, c] = mesh.tri_positions(face);
        total += solid_angle(a, b, c, q);
    }
    total / (4.0 * std::f64::consts::PI)
}

/// A cluster of triangles collapsed to what the far field needs: total area, area-weighted centroid
/// and the area-weighted normal as a unit vector.
#[derive(Clone, Copy)]
struct NodeAggregate {
    area: f64,
    centroid: Vec3,
    normal: Vec3,
}

impl NodeAggregate {
    /// The one triangle that stands in for the cluster: an equilateral triangle centred on the
    /// centroid, lying in the plane normal to the aggregate normal, with the cluster's own area.
    ///
    /// A triangle rather than a point charge because the solid angle of a triangle is what the exact
    /// sum uses, so the approximation reuses the same formula and stays consistent as the query
    /// crosses between approximated and refined nodes.
    fn pseudo_triangle(&self) -> [Vec3; 3] {
        let n = self.normal;
        // Any tangent will do; pick the axis least aligned with the normal so the cross product is
        // well conditioned.
        let axis = if n.x.abs() < 0.9 {
            Vec3::new(1.0, 0.0, 0.0)
        } else {
            Vec3::new(0.0, 1.0, 0.0)
        };
        let u = n.cross(axis);
        let u = u.scale(1.0 / u.length().max(1e-30));
        let v = n.cross(u);

        // Area of an equilateral triangle of circumradius R is (3*sqrt(3)/4) R^2.
        let r = (4.0 * self.area / (3.0 * 3.0f64.sqrt())) as f32;
        let r = r.max(0.0).sqrt();
        let c = self.centroid;
        let (sin120, cos120) = (0.5f32 * 3.0f32.sqrt(), -0.5f32);
        [
            c.add(u.scale(r)),
            c.add(u.scale(r * cos120)).add(v.scale(r * sin120)),
            c.add(u.scale(r * cos120)).sub(v.scale(r * sin120)),
        ]
    }
}

/// Winding number with a [`Bvh`] over the mesh and per-node aggregates, so a distant cluster costs
/// one triangle instead of all of them.
pub struct WindingNumber<'a> {
    mesh: &'a IndexedMesh,
    bvh: Bvh,
    /// Indexed by flat node.
    aggregates: Vec<NodeAggregate>,
}

impl<'a> WindingNumber<'a> {
    pub fn new(mesh: &'a IndexedMesh) -> Self {
        let bvh = Bvh::build(mesh);
        let layout = bvh.gpu_layout();
        let mut aggregates = vec![
            NodeAggregate {
                area: 0.0,
                centroid: Vec3::new(0.0, 0.0, 0.0),
                normal: Vec3::new(0.0, 0.0, 1.0),
            };
            layout.nodes.len()
        ];
        if !layout.nodes.is_empty() {
            aggregate_node(mesh, &layout, layout.root, &mut aggregates);
        }
        Self {
            mesh,
            bvh,
            aggregates,
        }
    }

    /// Winding number at `q`.
    pub fn at(&self, q: Vec3) -> f64 {
        let layout = self.bvh.gpu_layout();
        if layout.nodes.is_empty() {
            return 0.0;
        }
        let mut total = 0.0;
        // Explicit stack: the tree is built by splitting on the widest axis, so its depth is
        // logarithmic in practice but not bounded, and recursion on a deep tree is a stack overflow
        // waiting for a pathological mesh.
        let mut stack = vec![layout.root];
        while let Some(index) = stack.pop() {
            let node = &layout.nodes[index as usize];
            let centre = Vec3::new(
                (node.min[0] + node.max[0]) * 0.5,
                (node.min[1] + node.max[1]) * 0.5,
                (node.min[2] + node.max[2]) * 0.5,
            );
            let extent = ((node.max[0] - node.min[0]) as f64)
                .hypot((node.max[1] - node.min[1]) as f64)
                .hypot((node.max[2] - node.min[2]) as f64);
            let distance = ((q.x - centre.x) as f64)
                .hypot((q.y - centre.y) as f64)
                .hypot((q.z - centre.z) as f64);

            // Never approximate a node the query sits inside: the cluster subtends the whole sky
            // from in there, and one triangle standing in for it is exactly the case the
            // approximation cannot cover. Recurse to the faces instead, which makes interior points
            // exact and costs only the nodes the query is actually within.
            let inside_box = q.x >= node.min[0]
                && q.x <= node.max[0]
                && q.y >= node.min[1]
                && q.y <= node.max[1]
                && q.z >= node.min[2]
                && q.z <= node.max[2];
            if !inside_box && distance > extent * APPROXIMATION_RATIO {
                let aggregate = &self.aggregates[index as usize];
                let [a, b, c] = aggregate.pseudo_triangle();
                total += solid_angle(a, b, c, q);
                continue;
            }
            if node.b & layout.leaf_flag != 0 {
                let count = (node.b & !layout.leaf_flag) as usize;
                let start = node.a as usize;
                for &face in &layout.faces[start..start + count] {
                    let [a, b, c] = self.mesh.tri_positions(face);
                    total += solid_angle(a, b, c, q);
                }
                continue;
            }
            stack.push(node.a);
            stack.push(node.b);
        }
        total / (4.0 * std::f64::consts::PI)
    }

    /// Whether `q` is inside, by the sign test at one half.
    ///
    /// The half threshold is what makes the value worth the trouble: on a clean closed surface the
    /// value at any point is an integer, so the threshold sits as far from the data as it can.
    pub fn is_inside(&self, q: Vec3) -> bool {
        self.at(q).abs() > 0.5
    }
}

/// Fill `out` for `node` and its descendants, and return the aggregate for `node`.
fn aggregate_node(
    mesh: &IndexedMesh,
    layout: &crate::bvh::BvhGpuLayout<'_>,
    node: u32,
    out: &mut [NodeAggregate],
) -> NodeAggregate {
    let flat = &layout.nodes[node as usize];
    let aggregate = if flat.b & layout.leaf_flag != 0 {
        let count = (flat.b & !layout.leaf_flag) as usize;
        let start = flat.a as usize;
        let mut area = 0.0f64;
        let mut centroid = Vec3::new(0.0, 0.0, 0.0);
        let mut normal = Vec3::new(0.0, 0.0, 0.0);
        for &face in &layout.faces[start..start + count] {
            let [a, b, c] = mesh.tri_positions(face);
            let cross = b.sub(a).cross(c.sub(a));
            let face_area = (cross.length() as f64) * 0.5;
            area += face_area;
            centroid = centroid.add(a.add(b).add(c).scale((face_area / 3.0) as f32));
            // Unnormalised on purpose: summing the area-weighted normals keeps each face's
            // contribution proportional to its size before the direction is taken.
            normal = normal.add(cross.scale(0.5));
        }
        NodeAggregate {
            area,
            centroid: if area > 0.0 {
                centroid.scale((1.0 / area) as f32)
            } else {
                centroid
            },
            normal: unit_or_default(normal),
        }
    } else {
        let left = aggregate_node(mesh, layout, flat.a, out);
        let right = aggregate_node(mesh, layout, flat.b, out);
        let area = left.area + right.area;
        let centroid = if area > 0.0 {
            left.centroid
                .scale((left.area / area) as f32)
                .add(right.centroid.scale((right.area / area) as f32))
        } else {
            left.centroid
        };
        NodeAggregate {
            area,
            centroid,
            normal: unit_or_default(left.normal.add(right.normal)),
        }
    };
    out[node as usize] = aggregate;
    aggregate
}

fn unit_or_default(v: Vec3) -> Vec3 {
    let length = v.length();
    if length > 1e-20 {
        v.scale(1.0 / length)
    } else {
        Vec3::new(0.0, 0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A UV sphere of radius `radius` wound outward, with `stacks` x `slices` quads.
    fn sphere(radius: f32, stacks: usize, slices: usize) -> IndexedMesh {
        let mut positions = Vec::new();
        let mut triangles = Vec::new();
        for i in 0..=stacks {
            let phi = std::f32::consts::PI * i as f32 / stacks as f32;
            for j in 0..=slices {
                let theta = std::f32::consts::TAU * j as f32 / slices as f32;
                positions.push(Vec3::new(
                    radius * phi.sin() * theta.cos(),
                    radius * phi.cos(),
                    radius * phi.sin() * theta.sin(),
                ));
            }
        }
        let at = |i: usize, j: usize| (i * (slices + 1) + j) as u32;
        for i in 0..stacks {
            for j in 0..slices {
                let (a, b, c, d) = (at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
                // Outward: the cross product of (b - a) and (c - a) in this vertex order points
                // inward, so the triangles are wound the other way. Both halves are emitted even
                // where one is degenerate at a pole, because skipping it leaves the cap open and a
                // closed polyhedron is what makes the expected value exact rather than approximate.
                triangles.push([a, c, b]);
                triangles.push([a, d, c]);
            }
        }
        IndexedMesh {
            positions,
            triangles,
        }
    }

    /// A flat open grid in the xy plane, from a punctured surface's point of view: no volume at all.
    fn sheet(half: f32, cells: usize) -> IndexedMesh {
        let mut positions = Vec::new();
        let mut triangles = Vec::new();
        for i in 0..=cells {
            for j in 0..=cells {
                positions.push(Vec3::new(
                    -half + 2.0 * half * i as f32 / cells as f32,
                    -half + 2.0 * half * j as f32 / cells as f32,
                    0.0,
                ));
            }
        }
        let at = |i: usize, j: usize| (i * (cells + 1) + j) as u32;
        for i in 0..cells {
            for j in 0..cells {
                let (a, b, c, d) = (at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
                triangles.push([a, b, c]);
                triangles.push([a, c, d]);
            }
        }
        IndexedMesh {
            positions,
            triangles,
        }
    }

    /// A query must not get slower as the mesh grows.
    ///
    /// This is the property that failed: with too strict an approximation the traversal degrades
    /// into walking the tree, which is invisible on a fixture and costs minutes on a real model. A
    /// generous absolute bound is used rather than a tight one, because the point is to catch an
    /// order-of-magnitude regression, not to measure this machine.
    #[test]
    fn the_query_cost_does_not_grow_with_the_mesh() {
        let mut per_query = Vec::new();
        for (stacks, slices) in [(12usize, 16usize), (48, 64)] {
            let mesh = sphere(1.0, stacks, slices);
            let fast = WindingNumber::new(&mesh);
            // interior points: the case a tetrahedron centroid usually is
            let queries: Vec<Vec3> = (0..200)
                .map(|i| {
                    let t = i as f32 * 0.05;
                    Vec3::new(0.3 * t.cos(), 0.2 * t.sin(), 0.1 * t.cos())
                })
                .collect();
            let started = std::time::Instant::now();
            let mut acc = 0.0f64;
            for &q in &queries {
                acc += fast.at(q);
            }
            let per = started.elapsed().as_secs_f64() * 1e6 / queries.len() as f64;
            println!(
                "query cost: tris={} interior_query_us={:.1} acc={:.3}",
                mesh.triangles.len(),
                per,
                acc
            );
            per_query.push((mesh.triangles.len(), per));
        }
        for (tris, per) in &per_query {
            assert!(
                *per < 80.0,
                "a query on {tris} triangles took {per:.1} us; the approximation has stopped working"
            );
        }
        // Sixteen times the triangles must not cost several times as much per query.
        let (_, small) = per_query[0];
        let (_, large) = per_query[1];
        assert!(
            large < small * 4.0 + 5.0,
            "per-query cost grew with the mesh: {small:.1} us at the small size, {large:.1} us at the large"
        );
    }

    #[test]
    fn a_sphere_reads_one_inside_and_zero_outside() {
        let mesh = sphere(1.0, 24, 32);
        // Outward is not a comment, it is a positive signed volume: without this the test would
        // still pass if the fixture and the formula were both inverted.
        assert!(
            mesh.signed_volume() > 0.0,
            "fixture must be wound outward, signed volume was {}",
            mesh.signed_volume()
        );
        let centre = winding_number_exact(&mesh, Vec3::new(0.0, 0.0, 0.0));
        assert!(
            (centre - 1.0).abs() < 1e-6,
            "centre should read 1, got {centre}"
        );
        let outside = winding_number_exact(&mesh, Vec3::new(0.0, 0.0, 3.0));
        assert!(outside.abs() < 1e-6, "outside should read 0, got {outside}");
        let shallow = winding_number_exact(&mesh, Vec3::new(0.0, 0.0, 0.9));
        assert!(
            (shallow - 1.0).abs() < 1e-6,
            "just inside should read 1, got {shallow}"
        );
    }

    #[test]
    fn nesting_counts_and_flipping_cancels() {
        // Two spheres, both wound outward: inside the inner one the winding is two.
        let outer = sphere(2.0, 16, 24);
        let inner = sphere(1.0, 16, 24);
        let mut nested = outer.clone();
        let offset = nested.positions.len() as u32;
        nested.positions.extend_from_slice(&inner.positions);
        nested
            .triangles
            .extend(inner.triangles.iter().map(|t| [t[0] + offset, t[1] + offset, t[2] + offset]));
        let value = winding_number_exact(&nested, Vec3::new(0.0, 0.0, 0.0));
        assert!((value - 2.0).abs() < 1e-6, "nested pair should read 2, got {value}");

        // Reversing the inner sphere's winding makes the two cancel to zero, which is what a cavity
        // is: the same geometry, the opposite answer, decided entirely by orientation.
        let mut cavity = outer.clone();
        cavity.positions.extend_from_slice(&inner.positions);
        cavity.triangles.extend(
            inner
                .triangles
                .iter()
                .map(|t| [t[2] + offset, t[1] + offset, t[0] + offset]),
        );
        let value = winding_number_exact(&cavity, Vec3::new(0.0, 0.0, 0.0));
        assert!(value.abs() < 1e-6, "a cavity should read 0, got {value}");
    }

    #[test]
    fn an_open_sheet_degrades_smoothly_instead_of_flipping() {
        // A sheet has no interior, so the exact answer is a half: the solid angle from one side of an
        // infinite plane is half the sphere. The point of the winding number is that this is a
        // half rather than a coin toss, and that moving the query a hair does not flip it.
        let mesh = sheet(1.0, 40);
        let above = winding_number_exact(&mesh, Vec3::new(0.0, 0.0, 0.01));
        let below = winding_number_exact(&mesh, Vec3::new(0.0, 0.0, -0.01));
        assert!(
            (above.abs() - 0.5).abs() < 0.02,
            "above a sheet should read near 0.5, got {above}"
        );
        assert!(
            (below.abs() - 0.5).abs() < 0.02,
            "below a sheet should read near 0.5, got {below}"
        );
        // Sign follows the side, which is what makes the test at one half stable.
        // The sign convention of a lone patch is arbitrary; that the two sides disagree is not. It
        // is what makes a surface answer one way from one side and the other way from the other,
        // which is the property the viewport and the wrap both rely on.
        assert!(
            above * below < 0.0,
            "the two sides of a sheet must read opposite signs; got above {above}, below {below}"
        );
    }

    #[test]
    fn the_fast_path_agrees_with_the_exact_sum() {
        let mesh = sphere(1.0, 24, 32);
        let fast = WindingNumber::new(&mesh);
        for q in [
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 0.75),
            Vec3::new(0.0, 0.0, 1.25),
            Vec3::new(0.0, 0.0, 3.0),
            Vec3::new(0.9, 0.1, 0.2),
            Vec3::new(-1.4, 0.9, 0.3),
        ] {
            let exact = winding_number_exact(&mesh, q);
            let approximated = fast.at(q);
            assert!(
                // Three parts in a hundred, worst case, and the number is worth stating plainly
                // rather than tuned until the test passes. The approximation is a classification
                // tool, not an integration: the errors are largest where the true value is near
                // zero, because a monopole sum cancels imperfectly, and smallest where it is near
                // one. Both are far from the half that decides inside from outside, which is
                // asserted below and is what everything using this actually reads.
                (exact - approximated).abs() < 3e-2 || q == Vec3::new(0.0, 0.0, 0.0),
                "at {q:?}: exact {exact} vs fast {approximated}"
            );
            assert_eq!(
                fast.is_inside(q),
                exact.abs() > 0.5,
                "the half test disagrees at {q:?}"
            );
        }
    }

    /// The centre of a closed surface is the one place a cluster approximation has no room: every
    /// node subtends a large angle, so the error there is the honest worst case. It is a number to
    /// know, not a number to hide, and classification does not depend on it, because the sign at
    /// one half is asserted alongside.
    #[test]
    fn the_worst_case_error_is_bounded_and_documented() {
        let mesh = sphere(1.0, 24, 32);
        let fast = WindingNumber::new(&mesh);
        let exact = winding_number_exact(&mesh, Vec3::new(0.0, 0.0, 0.0));
        let approximated = fast.at(Vec3::new(0.0, 0.0, 0.0));
        assert!(
            (exact - approximated).abs() < 2e-2,
            "centre error grew past the documented bound: exact {exact}, fast {approximated}"
        );
        assert_eq!(
            fast.is_inside(Vec3::new(0.0, 0.0, 0.0)),
            true,
            "the centre of a closed surface must still classify as inside"
        );
    }

    #[test]
    fn the_fast_path_classifies_a_sheet_the_same_way() {
        // Near a surface the ratio test keeps refining, so this is where an approximation that is
        // too eager would show up as a flipped answer.
        let mesh = sheet(1.0, 40);
        let fast = WindingNumber::new(&mesh);
        for q in [
            Vec3::new(0.0, 0.0, 0.01),
            Vec3::new(0.0, 0.0, -0.01),
            Vec3::new(0.4, -0.3, 0.02),
        ] {
            let exact = winding_number_exact(&mesh, q);
            let approximated = fast.at(q);
            assert!(
                (exact - approximated).abs() < 0.02,
                "at {q:?}: exact {exact} vs fast {approximated}"
            );
        }
    }
}
