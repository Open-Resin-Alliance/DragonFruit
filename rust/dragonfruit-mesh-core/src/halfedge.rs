//! Half-edge topology over an [`IndexedMesh`]. Builds edge adjacency, boundary
//! loops, non-manifold edge classification, and per-vertex face rings.

use crate::mesh::IndexedMesh;
use ahash::AHashMap;

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
}

impl Topology {
    pub fn build(mesh: &IndexedMesh) -> Self {
        let mut edges: AHashMap<EdgeKey, EdgeInfo> =
            AHashMap::with_capacity(mesh.triangles.len() * 2);
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
        Self { edges, vertex_faces }
    }

    pub fn boundary_edges(&self) -> Vec<EdgeKey> {
        self.edges
            .iter()
            .filter(|(_, info)| info.faces.len() == 1)
            .map(|(k, _)| *k)
            .collect()
    }

    pub fn non_manifold_edges(&self) -> Vec<EdgeKey> {
        self.edges
            .iter()
            .filter(|(_, info)| info.faces.len() > 2)
            .map(|(k, _)| *k)
            .collect()
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

    /// Walk boundary edges into closed loops. Returns loops as sequences of
    /// vertex indices.
    pub fn boundary_loops(&self) -> Vec<Vec<u32>> {
        // Build adjacency: vertex -> unvisited boundary neighbours.
        let mut adj: AHashMap<u32, smallvec::SmallVec<[u32; 4]>> = AHashMap::new();
        for (k, info) in &self.edges {
            if info.faces.len() == 1 {
                adj.entry(k.0).or_default().push(k.1);
                adj.entry(k.1).or_default().push(k.0);
            }
        }
        let mut loops = Vec::new();
        while let Some((&start, _)) = adj.iter().next() {
            let mut loop_verts = vec![start];
            let mut current = start;
            let mut prev: Option<u32> = None;
            loop {
                let next = {
                    let neighbours = adj.get_mut(&current);
                    if neighbours.is_none() {
                        break;
                    }
                    let neighbours = neighbours.unwrap();
                    // Prefer a neighbour that isn't the previous vertex.
                    let pick_idx = neighbours
                        .iter()
                        .position(|&n| Some(n) != prev)
                        .or_else(|| if neighbours.is_empty() { None } else { Some(0) });
                    match pick_idx {
                        Some(i) => neighbours.remove(i),
                        None => break,
                    }
                };
                // Remove reverse edge.
                if let Some(back) = adj.get_mut(&next) {
                    if let Some(pos) = back.iter().position(|&n| n == current) {
                        back.remove(pos);
                    }
                }
                if adj.get(&current).map(|v| v.is_empty()).unwrap_or(true) {
                    adj.remove(&current);
                }
                if next == start {
                    break;
                }
                loop_verts.push(next);
                prev = Some(current);
                current = next;
            }
            if adj.get(&start).map(|v| v.is_empty()).unwrap_or(true) {
                adj.remove(&start);
            }
            if loop_verts.len() >= 3 {
                loops.push(loop_verts);
            }
        }
        loops
    }
}
