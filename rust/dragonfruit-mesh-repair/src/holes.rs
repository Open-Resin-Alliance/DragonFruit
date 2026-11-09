//! Holes, and the two passes the reference engine runs over them.
//!
//! the reference engine closes holes twice in its automatic repair, and the first pass is not a
//! smaller version of the second: `the trivial-hole pass` runs before anything else
//! touches the mesh and attempts only loops of **six boundary edges or fewer**,
//! while `the all-holes pass` comes later and takes every loop.
//!
//! The gate is the point. Six edges is a hole nobody designed, and leaving one
//! means the mesh reads as open for the rest of the pipeline: the weld skips a
//! mesh that is not connected, the extraction is refused for opening a surface, and
//! the report carries it forever. the reference engine attempts those first, before the passes
//! that would otherwise be working around them.
//!
//! What is not implemented is the reference engine's filler *modes*: its calls pass 3 and fall
//! back to 0, then 1 in the second pass, and the RE records the semantics as
//! unconfirmed ("names suggest flat/smooth/minimal-area variants"). This uses one
//! filler, a planar ear clipper over the loop's own vertices, so a loop that is not
//! planar comes out approximate. That is the known gap here.

use crate::core::mesh::IndexedMesh;
use crate::repair::fill_small_holes;

/// the reference engine's `the trivial-hole pass` gate: six boundary edges or fewer.
pub const TRIVIAL_HOLE_MAX_EDGES: usize = 6;

/// Close the holes small enough to be a defect rather than a design.
///
/// Returns the faces added. Runs unconditionally, whatever the caller's hole cap
/// says, because this is not the "fill holes" request the cap governs: it is the
/// repair clearing a defect it cannot work around.
pub fn holes_trivial(mesh: &mut IndexedMesh) -> usize {
    fill_small_holes(mesh, TRIVIAL_HOLE_MAX_EDGES)
}

/// Close every hole the caller's cap allows, which is the reference engine's `the all-holes pass`.
///
/// A cap of zero fills nothing, which is this engine's default for the automatic
/// import path: a boundary is not a defect, and filling one changes the model. A
/// caller that asks for a repair passes a real cap.
pub fn holes_all(mesh: &mut IndexedMesh, max_edges: usize) -> usize {
    if max_edges == 0 {
        return 0;
    }
    fill_small_holes(mesh, max_edges)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::mesh::Vec3;
    use crate::evaluate::evaluate;
    use crate::test_fixtures::unit_cube;

    /// A hole with four edges is trivial, and it goes on the first pass.
    #[test]
    fn a_four_edge_hole_is_closed_by_the_trivial_pass() {
        let mut cube = unit_cube();
        cube.triangles.pop(); // a triangle-shaped hole: three boundary edges
        assert_eq!(evaluate(&cube).holes, 1, "the fixture has a hole");

        let added = holes_trivial(&mut cube);
        assert!(added > 0, "it should be closed");
        let after = evaluate(&cube);
        assert_eq!(after.holes, 0, "and the hole is gone: {after:?}");
    }

    /// A hole wider than the gate is left for the second pass, and taken there.
    #[test]
    fn a_wide_hole_waits_for_the_second_pass() {
        let mut cube = unit_cube();
        // Remove the two triangles of one face, which leaves a four-vertex loop.
        cube.triangles.pop();
        cube.triangles.pop();
        let before = evaluate(&cube);
        assert_eq!(before.holes, 1, "{before:?}");

        // The trivial pass takes loops of six edges or fewer, and this one is four,
        // so it goes here too: the gate is on the loop's edge count, not on the
        // number of faces that were removed.
        let added = holes_trivial(&mut cube);
        assert!(added > 0);
        assert_eq!(evaluate(&cube).holes, 0);
    }

    /// A caller that asks for no filling gets none, except the trivial pass, which
    /// is not theirs to turn off.
    #[test]
    fn the_cap_governs_the_second_pass_only() {
        let mut cube = unit_cube();
        cube.triangles.pop();
        assert_eq!(holes_all(&mut cube, 0), 0, "a cap of zero fills nothing");
        assert_eq!(evaluate(&cube).holes, 1, "and the hole is still there");
    }

    /// A large opening is beyond the trivial gate and left alone by it.
    #[test]
    fn a_large_opening_is_not_trivial() {
        // A ten-sided opening: a pentagon of positions with the middle removed.
        let mut positions = Vec::new();
        for step in 0..10 {
            let angle = step as f32 / 10.0 * std::f32::consts::TAU;
            positions.push(Vec3::new(angle.cos(), angle.sin(), 0.0));
        }
        let mut triangles = Vec::new();
        for step in 1..9 {
            triangles.push([0, step, step + 1]);
        }
        let mut mesh = IndexedMesh {
            positions,
            triangles,
        };
        let before = evaluate(&mesh);
        assert!(before.holes > 0, "{before:?}");

        let added = holes_trivial(&mut mesh);
        assert_eq!(added, 0, "a nine-edge loop is past the gate");
    }
}
