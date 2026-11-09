//! TetGen, vendored, behind a small safe surface.
//!
//! TetGen produces exact constrained Delaunay tetrahedralisations and Delaunay tetrahedralisations
//! of a point set. We use the second: the shrinkwrap matching tetrahedralises the model's **points**
//! and then decides which tetrahedra are inside by winding number, rather than constraining the
//! tetrahedralisation with the model's triangles.
//!
//! That is not a shortcut, it is the point. A damaged export is a soup with self-intersecting and
//! non-manifold facets, which is exactly the input a facet-constrained tetrahedralisation rejects;
//! the reference engine adds virtual constraints to make such a soup admissible, and the winding
//! number is the cheaper way to the same end. It also keeps the decomposition adaptive to where the
//! model's own points are, which is why there is no resolution parameter to choose.
//!
//! Licensed AGPL-3.0-or-later, matching this repository. See `vendor/README.md` for provenance.

use std::ffi::CString;

#[allow(non_camel_case_types)]
type c_void = std::ffi::c_void;

extern "C" {
    fn tg_io_new() -> *mut c_void;
    fn tg_io_delete(io: *mut c_void);
    fn tg_io_set_points(io: *mut c_void, xyz: *const f64, count: i32);
    fn tg_io_set_facets(io: *mut c_void, tris: *const i32, count: i32);
    fn tg_tetrahedralize(switches: *const std::os::raw::c_char, input: *mut c_void, output: *mut c_void) -> i32;
    fn tg_io_num_points(io: *mut c_void) -> i32;
    fn tg_io_get_points(io: *mut c_void, dst: *mut f64);
    fn tg_io_num_tetrahedra(io: *mut c_void) -> i32;
    fn tg_io_get_tetrahedra(io: *mut c_void, dst: *mut i32);
    fn tg_io_num_trifaces(io: *mut c_void) -> i32;
    fn tg_io_get_trifaces(io: *mut c_void, dst: *mut i32);
}

/// A tetrahedralisation: the points TetGen used, and the tetrahedra over them.
#[derive(Clone, Debug, Default)]
pub struct TetMesh {
    /// TetGen's own point list, which may differ from the input when it inserts points.
    pub points: Vec<[f64; 3]>,
    /// Tetrahedra as four zero-based indices into [`TetMesh::points`].
    pub tets: Vec<[u32; 4]>,
    /// Boundary triangles, when the switches ask for them.
    pub trifaces: Vec<[u32; 3]>,
}

#[derive(Debug)]
pub enum TetGenError {
    /// TetGen raised. It reports most of its own failures by terminating rather than throwing, so
    /// this covers the exceptions it does raise.
    Raised,
    /// A coordinate is not finite, which no tetrahedralisation can represent.
    NonFiniteCoordinate(usize),
    /// Fewer than four points cannot bound a volume.
    TooFewPoints(usize),
}

impl std::fmt::Display for TetGenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Raised => write!(f, "TetGen raised while tetrahedralising"),
            Self::NonFiniteCoordinate(i) => write!(f, "point {i} has a non-finite coordinate"),
            Self::TooFewPoints(n) => write!(f, "{n} points cannot bound a tetrahedralisation"),
        }
    }
}

impl std::error::Error for TetGenError {}

/// Tetrahedralise a point set.
///
/// `switches` is TetGen's own command line. `"Q"` is the quiet default this crate expects; a caller
/// wanting a specific behaviour appends to it, and the switches are the only way to ask TetGen for
/// anything, since its policy lives there rather than in parameters.
///
/// Rejects non-finite coordinates before calling, because a single NaN makes TetGen's predicates
/// silently produce a tetrahedralisation of the wrong thing rather than failing.
pub fn tetrahedralize_points(
    points: &[[f64; 3]],
    switches: &str,
) -> Result<TetMesh, TetGenError> {
    run(points, None, switches)
}

/// Tetrahedralise a piecewise linear complex: the points, constrained to contain the triangles.
///
/// With `-p -d` this is the path that matches what a quality shrinkwrap does. `-p` reads a PLC
/// instead of a point cloud, so the decomposition is constrained to contain the input's triangles;
/// A PLC keeps the surface following its facets each other and split them, which is what makes a
/// damaged soup admissible at all. Without it a self-intersecting set of facets is rejected, which is
/// why a bare point set was tried here and why that produced slivers reaching across cavities.
pub fn tetrahedralize_plc(
    points: &[[f64; 3]],
    triangles: &[[u32; 3]],
    switches: &str,
) -> Result<TetMesh, TetGenError> {
    run(points, Some(triangles), switches)
}

#[allow(clippy::needless_return)]
fn run(
    points: &[[f64; 3]],
    triangles: Option<&[[u32; 3]]>,
    switches: &str,
) -> Result<TetMesh, TetGenError> {
    if points.len() < 4 {
        return Err(TetGenError::TooFewPoints(points.len()));
    }
    for (i, p) in points.iter().enumerate() {
        if !p.iter().all(|c| c.is_finite()) {
            return Err(TetGenError::NonFiniteCoordinate(i));
        }
    }

    let flat: Vec<f64> = points.iter().flat_map(|p| p.iter().copied()).collect();
    let c_switches = CString::new(switches).unwrap_or_else(|_| CString::new("Q").unwrap());

    // TetGen owns everything on its side: the input and output `tetgenio` are separate objects and
    // both are freed here, including on the error path, so a failure cannot leak a tetrahedraliser's
    // worth of memory.
    let input = unsafe { tg_io_new() };
    let output = unsafe { tg_io_new() };
    let facet_flat: Vec<i32> = triangles
        .map(|tris| {
            tris.iter()
                .flat_map(|t| [t[0] as i32, t[1] as i32, t[2] as i32])
                .collect()
        })
        .unwrap_or_default();
    let result = unsafe {
        tg_io_set_points(input, flat.as_ptr(), points.len() as i32);
        if let Some(tris) = triangles {
            tg_io_set_facets(input, facet_flat.as_ptr(), tris.len() as i32);
        }
        if tg_tetrahedralize(c_switches.as_ptr(), input, output) != 0 {
            Err(TetGenError::Raised)
        } else {
            let point_count = tg_io_num_points(output).max(0) as usize;
            let mut out_points = vec![0f64; point_count * 3];
            tg_io_get_points(output, out_points.as_mut_ptr());

            let tet_count = tg_io_num_tetrahedra(output).max(0) as usize;
            let mut out_tets = vec![0i32; tet_count * 4];
            tg_io_get_tetrahedra(output, out_tets.as_mut_ptr());

            let face_count = tg_io_num_trifaces(output).max(0) as usize;
            let mut out_faces = vec![0i32; face_count * 3];
            if face_count > 0 {
                tg_io_get_trifaces(output, out_faces.as_mut_ptr());
            }

            Ok(TetMesh {
                points: out_points
                    .chunks_exact(3)
                    .map(|c| [c[0], c[1], c[2]])
                    .collect(),
                tets: out_tets
                    .chunks_exact(4)
                    .map(|c| [c[0] as u32, c[1] as u32, c[2] as u32, c[3] as u32])
                    .collect(),
                trifaces: out_faces
                    .chunks_exact(3)
                    .map(|c| [c[0] as u32, c[1] as u32, c[2] as u32])
                    .collect(),
            })
        }
    };
    // Freed on both paths, inside the unsafe block above is not possible once the borrow of the
    // outputs ends, so the handles are released here.
    unsafe {
        tg_io_delete(input);
        tg_io_delete(output);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Four corners of a tetrahedron tetrahedralise to exactly that one tetrahedron.
    #[test]
    fn a_tetrahedron_of_points_yields_one_tet() {
        let points = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let mesh = tetrahedralize_points(&points, "Q").expect("tetrahedralise");
        assert_eq!(mesh.tets.len(), 1, "a four-point set is one tetrahedron");
        assert_eq!(mesh.points.len(), 4);
        // The one tet must reference all four points, in some order.
        let mut referenced = mesh.tets[0];
        referenced.sort_unstable();
        assert_eq!(referenced, [0, 1, 2, 3]);
    }

    /// The eight corners of a cube tetrahedralise into a known count: a triangulation of the cube
    /// has five or six tetrahedra depending on how the diagonals are chosen, and TetGen picks one.
    #[test]
    fn a_cube_of_points_decomposes_into_tets() {
        let mut points = Vec::new();
        for x in [0.0f64, 1.0] {
            for y in [0.0f64, 1.0] {
                for z in [0.0f64, 1.0] {
                    points.push([x, y, z]);
                }
            }
        }
        let mesh = tetrahedralize_points(&points, "Q").expect("tetrahedralise");
        assert_eq!(mesh.points.len(), 8);
        assert!(
            (5..=6).contains(&mesh.tets.len()),
            "a cube is five or six tetrahedra, got {}",
            mesh.tets.len()
        );
        // Every tet references existing points and is non-degenerate in its indices.
        for t in &mesh.tets {
            for &i in t {
                assert!((i as usize) < mesh.points.len(), "tet index out of range");
            }
            let unique: std::collections::HashSet<u32> = t.iter().copied().collect();
            assert_eq!(unique.len(), 4, "a tetrahedron needs four distinct vertices");
        }
    }

    /// A cube given as a PLC: twelve triangles, and the decomposition must be constrained to contain
    /// them, so the tetrahedra fill the cube rather than a hull of its corners.
    #[test]
    fn a_cube_plc_tetrahedralises() {
        let corners = [
            [0.0f64, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0],
            [1.0, 1.0, 0.0], [1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 1.0, 1.0],
        ];
        let quads: [[u32; 4]; 6] = [
            [0, 2, 4, 1], [0, 1, 5, 3], [0, 3, 6, 2],
            [7, 5, 1, 4], [7, 4, 2, 6], [7, 6, 3, 5],
        ];
        let mut triangles = Vec::new();
        for q in quads {
            triangles.push([q[0], q[1], q[3]]);
            triangles.push([q[1], q[2], q[3]]);
        }
        let mesh = tetrahedralize_plc(&corners, &triangles, "pQ").expect("tetrahedralise a PLC");
        assert!(!mesh.tets.is_empty(), "a closed cube must decompose");
        // Six tetrahedra fill a cube; TetGen may split on the boundary too, so allow a little more.
        assert!(
            mesh.tets.len() <= 24,
            "a cube should need few tetrahedra, got {}",
            mesh.tets.len()
        );
        // Every corner must still be present, since the facets constrain the decomposition.
        assert!(mesh.points.len() >= 8);
    }

    /// Points inside the convex hull end up in the output; the hull is all TetGen builds without
    /// facet constraints, which is the mode this crate is for.
    #[test]
    fn interior_points_are_used() {
        let mut points = vec![
            [0.0f64, 0.0, 0.0],
            [4.0, 0.0, 0.0],
            [0.0, 4.0, 0.0],
            [0.0, 0.0, 4.0],
            [4.0, 4.0, 4.0],
        ];
        points.push([0.5, 0.5, 0.5]);
        let mesh = tetrahedralize_points(&points, "Q").expect("tetrahedralise");
        assert_eq!(
            mesh.points.len(),
            points.len(),
            "no point should be dropped from a tetrahedralisation"
        );
    }

    #[test]
    fn non_finite_coordinates_are_rejected_before_tetgen_sees_them() {
        let mut points = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        points[2][1] = f64::NAN;
        match tetrahedralize_points(&points, "Q") {
            Err(TetGenError::NonFiniteCoordinate(2)) => {}
            other => panic!("expected a non-finite rejection, got {other:?}"),
        }
    }

    #[test]
    fn too_few_points_are_rejected() {
        match tetrahedralize_points(&[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], "Q") {
            Err(TetGenError::TooFewPoints(2)) => {}
            other => panic!("expected a too-few-points rejection, got {other:?}"),
        }
    }
}
