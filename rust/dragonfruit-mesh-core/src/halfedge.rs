//! Half-edge topology over an [`IndexedMesh`]. Builds edge adjacency, boundary
//! loops, non-manifold edge classification, and per-vertex face rings.

use crate::mesh::IndexedMesh;
use ahash::{AHashMap, AHashSet, RandomState};

/// Fixed seeds, rather than `RandomState`'s per-process ones.
///
/// Every pass in the repair pipeline that walks `edges` — stitching, winding propagation, the greedy
/// face flips, the pinch split, and `vertex_faces`, which is built from the same walk — then runs in
/// a different order in each process. The results are not wrong, but they are not the same twice:
/// one binary repaired the V3 Cones to `boundary 0, winding 0` and, on another run, to `boundary 12,
/// winding 1`, and the app disagreed with the CLI for the same reason.
fn edge_hasher() -> RandomState {
    RandomState::with_seeds(
        0x9e37_79b9_7f4a_7c15,
        0xbf58_476d_1ce4_e5b9,
        0x94d0_49bb_1331_11eb,
        0x2545_f491_4f6c_dd1d,
    )
}

/// Canonical undirected edge key (sorted endpoints).
pub type EdgeKey = (u32, u32);

#[inline]
pub fn edge_key(a: u32, b: u32) -> EdgeKey {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

#[derive(Debug, Default, Clone)]
pub struct EdgeInfo {
    /// Faces incident to this edge.
    pub faces: smallvec::SmallVec<[u32; 2]>,
    /// Directed samples `(from, to, face)` — useful to decide if two incident
    /// faces share a consistent winding (opposite directions = manifold +
    /// consistent; same direction = manifold but inconsistent winding).
    pub directed: smallvec::SmallVec<[(u32, u32, u32); 2]>,
}

#[derive(Debug, Default)]
pub struct Topology {
    pub edges: AHashMap<EdgeKey, EdgeInfo>,
    /// One-ring faces per vertex.
    pub vertex_faces: Vec<smallvec::SmallVec<[u32; 8]>>,
    /// The mesh's triangles, in order. Kept so a walk can rotate around a vertex: the face a walk
    /// arrives in says which edge it came along, and the face's own vertices say which edge leaves the
    /// vertex next.
    pub faces: Vec<[u32; 3]>,
}

impl Topology {
    pub fn build(mesh: &IndexedMesh) -> Self {
        let mut edges: AHashMap<EdgeKey, EdgeInfo> =
            AHashMap::with_capacity_and_hasher(mesh.triangles.len() * 2, edge_hasher());
        let mut vertex_faces = vec![smallvec::SmallVec::<[u32; 8]>::new(); mesh.positions.len()];

        for (fi, tri) in mesh.triangles.iter().enumerate() {
            let fi = fi as u32;
            let [a, b, c] = *tri;
            vertex_faces[a as usize].push(fi);
            if !vertex_faces[b as usize].contains(&fi) {
                vertex_faces[b as usize].push(fi);
            }
            if !vertex_faces[c as usize].contains(&fi) {
                vertex_faces[c as usize].push(fi);
            }
            for &(u, v) in &[(a, b), (b, c), (c, a)] {
                let key = edge_key(u, v);
                let entry = edges.entry(key).or_default();
                entry.faces.push(fi);
                entry.directed.push((u, v, fi));
            }
        }
        Self {
            edges,
            vertex_faces,
            faces: mesh.triangles.clone(),
        }
    }

    /// Sorted, so two runs over the same mesh give the same list.
    pub fn boundary_edges(&self) -> Vec<EdgeKey> {
        let mut edges: Vec<EdgeKey> = self
            .edges
            .iter()
            .filter(|(_, info)| info.faces.len() == 1)
            .map(|(k, _)| *k)
            .collect();
        edges.sort_unstable();
        edges
    }

    /// Edges whose faces cannot be paired by direction.
    ///
    /// More than two faces on an edge does not make it non-manifold. Four faces with two
    /// traversing each way are two coincident manifold edges: two surfaces meeting along
    /// a shared edge, each of them closed. Counting those as non-manifold is how a model
    /// the reference engine calls clean, and which is clean, came out of a repair
    /// reported as broken.
    ///
    /// So the test is whether the faces pair. Pair every forward traversal with a
    /// backward one, and what is left over decides: two forward and one backward is a fan
    /// with a face it cannot pair, while a single face is a boundary and not a defect at
    /// all. Two faces traversing the same way are a winding disagreement, which
    /// `inconsistent_edges` reports and a winding pass can fix, so they are not counted
    /// here either.
    /// Sorted, so two runs over the same mesh give the same list.
    pub fn non_manifold_edges(&self) -> Vec<EdgeKey> {
        let mut edges: Vec<EdgeKey> = self
            .edges
            .iter()
            .filter(|(_, info)| {
                let mut forward = 0usize;
                let mut backward = 0usize;
                for &(u, v, _) in &info.directed {
                    if u < v {
                        forward += 1;
                    } else {
                        backward += 1;
                    }
                }
                forward > 0 && backward > 0 && forward != backward
            })
            .map(|(k, _)| *k)
            .collect();
        edges.sort_unstable();
        edges
    }

    /// Count of edges where the two incident faces traverse the edge in the
    /// same direction (indicates inconsistent winding between neighbours).
    pub fn inconsistent_edges(&self) -> usize {
        self.edges
            .values()
            .filter(|info| {
                if info.directed.len() != 2 {
                    return false;
                }
                let (a0, b0, _) = info.directed[0];
                let (a1, b1, _) = info.directed[1];
                (a0, b0) == (a1, b1)
            })
            .count()
    }

    /// Walk boundary edges into closed loops, each an ordered cycle of vertices.
    ///
    /// The walk is by **rotation**: from the face it arrived in, around the shared vertex, to the next
    /// face that carries a boundary edge. That is what makes the *order* right, and the order is the
    /// whole point of this function — a loop is fed to a triangulation, which can only fill a cycle.
    ///
    /// Choosing the next neighbour by index instead is what this used to do ("prefer a neighbour that
    /// isn't the previous vertex", over sorted neighbours). It is correct only while every vertex the
    /// boundary meets, it meets once. A pinch — two openings sharing a vertex — has more than one
    /// boundary edge leaving that vertex, and an index does not know which one continues the lobe it is
    /// walking. Measured on a model whose cavity breaks through its outer wall, three of its rims came
    /// back as 180, 218 and 704 points around a hole one millimetre across, doubling back on themselves:
    /// a loop no triangulation can fill, which renders as a fanned gap, and a loop whose own area and
    /// tangent directions are meaningless, which renders as the flat sheet the fill was supposed to
    /// avoid. The count was wrong too, because the walk merged and split lobes as it went.
    ///
    /// Sorted throughout, so two runs over the same mesh give the same loops: hash iteration order
    /// varies per process, and both the vertex a loop starts from and the choice at a junction would
    /// otherwise differ between runs.
    pub fn boundary_loops(&self) -> Vec<Vec<u32>> {
        let mut boundary: Vec<(u32, u32, u32)> = self
            .edges
            .values()
            .filter(|info| info.faces.len() == 1)
            .filter_map(|info| info.directed.first().copied())
            .collect();
        boundary.sort_unstable();

        let mut used: AHashSet<(u32, u32)> = AHashSet::new();
        let mut loops = Vec::new();
        for &(start_from, start_to, start_face) in &boundary {
            if used.contains(&(start_from, start_to)) {
                continue;
            }
            let mut path = vec![start_from];
            let (mut from, mut to, mut face) = (start_from, start_to, start_face);
            loop {
                if !used.insert((from, to)) {
                    break;
                }
                path.push(to);

                // Rotate around `to`, starting from the face the walk arrived in, until a face carries
                // a boundary edge leaving `to`.
                let mut g = face;
                let mut next = None;
                // Bounded, and the bound is not a formality: an edge whose two faces traverse it the
                // *same* way — inconsistent winding, which damaged meshes have — sends the rotation
                // back to the face it came from, and it would alternate between those two for ever.
                // One turn of the vertex's own fan is all a rotation can need.
                let mut rotations = 0usize;
                loop {
                    rotations += 1;
                    if rotations > self.vertex_faces[to as usize].len() + 1 {
                        break;
                    }
                    let [x, y, z] = self.faces[g as usize];
                    let out = if x == to {
                        y
                    } else if y == to {
                        z
                    } else if z == to {
                        x
                    } else {
                        break;
                    };
                    match self.edges.get(&edge_key(to, out)) {
                        Some(info) if info.faces.len() == 1 => {
                            next = Some((to, out, g));
                            break;
                        }
                        Some(info) => match info.faces.iter().copied().find(|&h| h != g) {
                            Some(h) => g = h,
                            None => break,
                        },
                        None => break,
                    }
                }

                match next {
                    Some((nf, nt, ng)) if !used.contains(&(nf, nt)) => {
                        from = nf;
                        to = nt;
                        face = ng;
                    }
                    _ => break,
                }
            }
            // A cycle has to have closed. The walk stops either by returning to where it started or by
            // running into a path it has already used, and only the first of those is a hole.
            //
            // The second is a boundary that is not a closed curve at all: the fixture of an edge
            // carrying three faces has a boundary of exactly two edges, a path from one end of that
            // edge to the other, because a non-manifold edge is where the boundary passes through
            // itself. Filling a path invents a face — and the face it invents here is a copy of the
            // one already there, which the cull then removes along with the original, quietly deleting
            // the stray sheet the repair was supposed to separate. Reporting it as a loop is also
            // wrong on its own terms: one of the five classes counts *loops*, and a path is not one.
            if path.len() > 1 && path[0] == *path.last().unwrap() {
                path.pop();
                if path.len() >= 3 {
                    loops.push(path);
                }
            }
        }
        loops
    }
}
