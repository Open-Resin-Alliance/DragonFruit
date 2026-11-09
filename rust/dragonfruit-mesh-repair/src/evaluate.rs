//! What makes a mesh broken, in the terms the reference engine uses.
//!
//! the reference engine's evaluators are `the orientation evaluator`, `the bad-edge evaluator`, `the hole evaluator`,
//! `the non-manifold evaluator` and `the shell evaluator`. There is no sixth, and in particular
//! **there is no self-intersection evaluator**: the reference engine's repair acts on
//! self-intersections and its verdict does not count them.
//!
//! That distinction is the one this engine kept getting wrong. A mesh was called
//! broken for carrying self-intersections a slicer does not care about, and then
//! minutes were spent trying to remove them, on files that print perfectly. The
//! verdict here is the reference engine's five classes and nothing else; self-intersections are a
//! number to report, not a defect to declare.

use std::cell::RefCell;

use crate::core::halfedge::Topology;
use crate::core::mesh::IndexedMesh;
use crate::shells::noise_shells;

/// The five defect classes, as counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MeshDefects {
    /// `the orientation evaluator`: edges whose two faces traverse them the same way.
    pub inconsistent_edges: usize,
    /// `the bad-edge evaluator`: edges not shared by exactly two faces.
    ///
    /// The union of the two classes below it, which is how the reference engine counts it: an edge
    /// with one face is a hole's edge, an edge with three is non-manifold, and both
    /// are bad edges.
    pub bad_edges: usize,
    /// `the hole evaluator`: boundary loops.
    pub holes: usize,
    /// `the non-manifold evaluator`: edges whose faces cannot be paired by direction.
    pub non_manifold_edges: usize,
    /// The vertices a non-manifold edge passes through, which no winding can fix.
    pub non_manifold_vertices: usize,
    /// `the shell evaluator`: shells small enough to be noise.
    pub noise_shells: usize,
}

impl MeshDefects {
    /// Is there anything here for a repair to do?
    pub fn is_broken(&self) -> bool {
        self.inconsistent_edges > 0
            || self.bad_edges > 0
            || self.holes > 0
            || self.non_manifold_edges > 0
            || self.non_manifold_vertices > 0
            || self.noise_shells > 0
    }

    /// Did this mesh come out worse than `before` on a class that is damage?
    ///
    /// A total is the wrong test. A pass that closes five holes and opens four
    /// non-manifold edges has improved the sum and left the mesh worse, and damage is a
    /// class going up whatever the other classes did.
    ///
    /// Four classes are damage: an edge whose faces disagree, an edge that does not carry exactly two
    /// faces, an edge carrying more, and the vertices those edges pass through. A rise in any of them
    /// is something the pass did to the object.
    ///
    /// Two are not, and refusing on them is how a guard blocks the passes it exists to protect:
    ///
    /// - **holes** is a *count of loops*, not of boundary edges, and `bad_edges` already counts those
    ///   (an edge with one face is a bad edge). Removing a face can open one edge and split one loop
    ///   into two, so the count rises while the boundary gets shorter and every other class improves.
    ///   Measured on a model with a cavity: the cull that removes repeated-vertex faces took
    ///   inconsistent edges from 113 to 18 and non-manifold from 1,364 to 1,363, and was refused
    ///   because the loop count went from 14 to 17. The same geometry re-decomposed into more loops is
    ///   not a worse mesh.
    /// - **noise_shells** is the scrap the pipeline deletes on purpose, one stage later. Capping a
    ///   small hole *makes* a shell that small, so this counts the p删ass's own work as damage: the
    ///   fill that closed all 14 of that model's holes and took its bad edges from 2,186 to 2,129 was
    ///   refused because the noise-shell count went from 3 to 8.
    pub fn worse_than(&self, before: &Self) -> bool {
        self.inconsistent_edges > before.inconsistent_edges
            || self.bad_edges > before.bad_edges
            || self.non_manifold_edges > before.non_manifold_edges
            || self.non_manifold_vertices > before.non_manifold_vertices
    }

    /// Every defect, added up, for comparing a mesh with itself across a pass.
    pub fn total(&self) -> usize {
        self.inconsistent_edges
            + self.bad_edges
            + self.holes
            + self.non_manifold_edges
            + self.non_manifold_vertices
            + self.noise_shells
    }
}

/// The five classes, for a mesh.
///
/// A pure function of the mesh, and the pipeline asks it the same question about the same mesh
/// several times: a guarded pass weighs the mesh it made against the one it started from, the next
/// pass's "before" is that same mesh, and the report's post verdict usually describes a mesh that
/// never moved. Measured on `poussin.stl`, 13 of the run's 21 halfedge builds came from here, for
/// 1041 ms of 2008. The verdict is a handful of integers, so it is worth remembering; see
/// [`crate::memo`] for what a hit is keyed on.
pub fn evaluate(mesh: &IndexedMesh) -> MeshDefects {
    let key = crate::memo::mesh_key(mesh);
    if let Some(verdict) = EVALUATIONS.with(|memo| memo.borrow().get(&key)) {
        return verdict;
    }
    let verdict = evaluate_uncached(mesh);
    EVALUATIONS.with(|memo| memo.borrow_mut().put(key, verdict));
    verdict
}

thread_local! {
    /// The verdicts this thread has already produced, against the meshes they were about.
    static EVALUATIONS: RefCell<crate::memo::Memo<MeshDefects>> =
        const { RefCell::new(crate::memo::Memo::new()) };
}

/// [`evaluate`] without the memo: the work itself, for the first time a mesh is seen.
fn evaluate_uncached(mesh: &IndexedMesh) -> MeshDefects {
    if mesh.triangles.is_empty() {
        return MeshDefects::default();
    }
    let topology = Topology::build(mesh);
    let boundary_edges = topology.boundary_edges().len();
    let non_manifold_edges = topology.non_manifold_edges().len();
    let holes = topology.boundary_loops().len();
    MeshDefects {
        inconsistent_edges: topology.inconsistent_edges(),
        bad_edges: boundary_edges + non_manifold_edges,
        holes,
        non_manifold_edges,
        non_manifold_vertices: count_non_manifold_vertices(&topology),
        noise_shells: noise_shells(mesh).len(),
    }
}

/// The vertices a non-manifold edge passes through, which no winding can fix.
///
/// Derived from the non-manifold edges rather than tested independently. A vertex whose
/// face fan is disconnected is a bowtie, and it is a real thing to find, but the reference
/// engine has no class for it: its panel reports bad edges, holes, bad orientation and
/// shells, and a bowtie with two faces on every edge shows up in none of them. A verdict
/// that flags a file the reference calls clean is worse than one that misses a defect the
/// reference also misses, because the file is the thing being judged.
fn count_non_manifold_vertices(topology: &Topology) -> usize {
    let mut vertices = ahash::AHashSet::new();
    for edge in topology.non_manifold_edges() {
        vertices.insert(edge.0);
        vertices.insert(edge.1);
    }
    vertices.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::mesh::Vec3;
    use crate::test_fixtures::unit_cube;

    /// A closed cube is not broken, and its self-intersections are not consulted.
    #[test]
    fn a_closed_cube_has_no_defects() {
        let defects = evaluate(&unit_cube());
        assert!(!defects.is_broken(), "{defects:?}");
        assert_eq!(defects.total(), 0);
    }

    /// A hole is a hole, and an open surface is broken for the reference engine.
    #[test]
    fn a_missing_face_is_a_hole() {
        let mut cube = unit_cube();
        cube.triangles.pop();
        let defects = evaluate(&cube);
        assert!(defects.is_broken());
        assert_eq!(defects.holes, 1, "{defects:?}");
        assert_eq!(defects.bad_edges, 3, "the hole's three edges");
        assert_eq!(defects.non_manifold_edges, 0);
    }

    /// An edge carrying three faces is non-manifold, and it is also a bad edge.
    #[test]
    fn a_shared_edge_is_non_manifold() {
        let mut mesh = unit_cube();
        let centre = mesh.positions.len() as u32;
        mesh.positions.push(Vec3::new(0.5, 0.5, 0.5));
        mesh.triangles.push([4, 5, centre]);

        let defects = evaluate(&mesh);
        assert!(defects.is_broken());
        assert_eq!(defects.non_manifold_edges, 1, "{defects:?}");
        assert!(defects.bad_edges >= 1);
    }

    /// A bowtie vertex is not its own class.
    ///
    /// Two triangles meeting at one vertex and nowhere else is a pinch, and it is a real
    /// thing to find. It is not counted as a non-manifold vertex, because the reference
    /// engine has no class for it: its panel reports bad edges, holes, bad orientation and
    /// shells, and a bowtie with two faces on every edge appears in none of them. A
    /// verdict that flags a file the reference calls clean is worse than one that misses a
    /// defect the reference also misses, because the file is the thing being judged. This
    /// fixture is still broken, by its boundary.
    #[test]
    fn a_bowtie_vertex_is_not_its_own_class() {
        // Two triangles meeting at one vertex and nowhere else.
        let mesh = IndexedMesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(1.0, 1.0, 0.0),
                Vec3::new(-1.0, 0.0, 0.0),
                Vec3::new(-1.0, -1.0, 0.0),
            ],
            triangles: vec![[0, 1, 2], [0, 3, 4]],
        };
        let defects = evaluate(&mesh);
        assert_eq!(defects.non_manifold_vertices, 0, "{defects:?}");
        assert_eq!(defects.non_manifold_edges, 0, "{defects:?}");
        assert!(
            defects.bad_edges > 0,
            "the boundary is what makes this fixture broken: {defects:?}"
        );
        assert!(defects.is_broken());
    }
}
