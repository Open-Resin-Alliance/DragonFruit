//! Surface-following paths on a triangle mesh.
//!
//! STAGE 1: shortest path along mesh EDGES via Dijkstra over the vertex graph
//! (built from the existing half-edge [`Topology`]). Hugs the surface but is
//! faceted because it follows existing edges.
//!
//! STAGE 2 (current): the edge-path is straightened toward the true geodesic by
//! iterative local relaxation + reprojection (`straighten_path`): each interior
//! point is pulled toward its neighbours' midpoint and reprojected onto nearby
//! faces, so the path crosses triangle faces and converges to a smooth geodesic.
//! `surface_loop_from_mesh` applies this automatically.
//!
//! Used by the Organic Cut tool: the user clicks a few waypoints on the surface;
//! we connect consecutive waypoints with surface paths and close the loop.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::core::halfedge::Topology;
use crate::core::mesh::{IndexedMesh, Vec3};

/// Vertex adjacency derived from the mesh topology: for each vertex, its graph
/// neighbours and the Euclidean length of the connecting edge.
pub struct VertexGraph {
    /// `neighbors[v]` = list of `(other_vertex, edge_length)`.
    neighbors: Vec<Vec<(u32, f32)>>,
}

impl VertexGraph {
    pub fn build(mesh: &IndexedMesh, topo: &Topology) -> Self {
        let mut neighbors = vec![Vec::<(u32, f32)>::new(); mesh.positions.len()];
        for (&(a, b), _info) in &topo.edges {
            let pa = mesh.positions[a as usize];
            let pb = mesh.positions[b as usize];
            let len = pb.sub(pa).length();
            neighbors[a as usize].push((b, len));
            neighbors[b as usize].push((a, len));
        }
        Self { neighbors }
    }
}

/// Min-heap entry keyed by accumulated distance (smaller = higher priority).
#[derive(Copy, Clone)]
struct HeapNode {
    dist: f32,
    vertex: u32,
}
impl PartialEq for HeapNode {
    fn eq(&self, o: &Self) -> bool {
        self.dist == o.dist
    }
}
impl Eq for HeapNode {}
impl PartialOrd for HeapNode {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for HeapNode {
    fn cmp(&self, o: &Self) -> Ordering {
        // Reverse so BinaryHeap (a max-heap) pops the SMALLEST distance.
        o.dist.partial_cmp(&self.dist).unwrap_or(Ordering::Equal)
    }
}

/// Dijkstra shortest path along the vertex graph from `start` to `goal`.
/// Returns the path as a sequence of vertex indices (inclusive of both ends),
/// or `None` if `goal` is unreachable from `start` (disconnected components).
pub fn shortest_vertex_path(graph: &VertexGraph, start: u32, goal: u32) -> Option<Vec<u32>> {
    if start == goal {
        return Some(vec![start]);
    }
    let n = graph.neighbors.len();
    let mut dist = vec![f32::INFINITY; n];
    let mut prev = vec![u32::MAX; n];
    let mut heap = BinaryHeap::new();

    dist[start as usize] = 0.0;
    heap.push(HeapNode { dist: 0.0, vertex: start });

    while let Some(HeapNode { dist: d, vertex }) = heap.pop() {
        if vertex == goal {
            break;
        }
        if d > dist[vertex as usize] {
            continue; // stale entry
        }
        for &(next, w) in &graph.neighbors[vertex as usize] {
            let nd = d + w;
            if nd < dist[next as usize] {
                dist[next as usize] = nd;
                prev[next as usize] = vertex;
                heap.push(HeapNode { dist: nd, vertex: next });
            }
        }
    }

    if dist[goal as usize].is_infinite() {
        return None;
    }

    // Reconstruct path goal -> start, then reverse.
    let mut path = vec![goal];
    let mut cur = goal;
    while cur != start {
        let p = prev[cur as usize];
        if p == u32::MAX {
            return None; // broken chain (shouldn't happen if reachable)
        }
        path.push(p);
        cur = p;
    }
    path.reverse();
    Some(path)
}

/// Finds the mesh vertex nearest to an arbitrary point. O(n) scan — fine for the
/// handful of clicked waypoints. (Later we can snap via faceIndex barycentric.)
pub fn nearest_vertex(mesh: &IndexedMesh, point: Vec3) -> Option<u32> {
    if mesh.positions.is_empty() {
        return None;
    }
    let mut best = 0u32;
    let mut best_d = f32::INFINITY;
    for (i, p) in mesh.positions.iter().enumerate() {
        let d = p.sub(point).dot(p.sub(point));
        if d < best_d {
            best_d = d;
            best = i as u32;
        }
    }
    Some(best)
}

/// Connects an ordered list of surface waypoints into a closed on-surface loop:
/// a surface path between each consecutive pair, plus a closing path from the
/// last waypoint back to the first. Returns the loop as a list of 3D positions
/// (vertex positions along the edge-paths), de-duplicating shared join vertices.
///
/// `close` controls whether the final closing segment is appended.
pub fn surface_loop_positions(
    mesh: &IndexedMesh,
    topo: &Topology,
    waypoints: &[Vec3],
    close: bool,
) -> Option<Vec<Vec3>> {
    if waypoints.len() < 2 {
        return None;
    }
    let graph = VertexGraph::build(mesh, topo);

    // Snap each waypoint to its nearest mesh vertex.
    let verts: Vec<u32> = waypoints
        .iter()
        .map(|&w| nearest_vertex(mesh, w))
        .collect::<Option<Vec<_>>>()?;

    let mut out: Vec<Vec3> = Vec::new();

    let push_path = |from: u32, to: u32, out: &mut Vec<Vec3>| -> bool {
        let path = match shortest_vertex_path(&graph, from, to) {
            Some(p) => p,
            None => return false,
        };
        for (i, &v) in path.iter().enumerate() {
            // Skip the first vertex of every segment after the first to avoid
            // duplicating the shared join vertex.
            if !out.is_empty() && i == 0 {
                continue;
            }
            out.push(mesh.positions[v as usize]);
        }
        true
    };

    for pair in verts.windows(2) {
        if !push_path(pair[0], pair[1], &mut out) {
            return None;
        }
    }
    if close {
        let last = *verts.last().unwrap();
        let first = verts[0];
        if last != first && !push_path(last, first, &mut out) {
            return None;
        }
    }

    if out.len() < 2 {
        return None;
    }
    Some(out)
}

/// Convenience: build the topology internally and compute a closed surface loop
/// from waypoints. The high-level entry point for callers (e.g. Tauri) that just
/// have a mesh + clicked points.
pub fn surface_loop_from_mesh(mesh: &IndexedMesh, waypoints: &[Vec3], close: bool) -> Option<Vec<Vec3>> {
    let topo = Topology::build(mesh);
    let path = surface_loop_positions(mesh, &topo, waypoints, close)?;
    Some(straighten_path(mesh, &topo, &path, close))
}

// ---------------------------------------------------------------------------
// STAGE 2: geodesic straightening (iterative local relaxation + reprojection)
// ---------------------------------------------------------------------------

/// Closest point to `p` on triangle `(a,b,c)`, plus the squared distance.
/// Standard barycentric region test (Ericson, Real-Time Collision Detection).
fn closest_point_on_tri(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> (Vec3, f32) {
    let ab = b.sub(a);
    let ac = c.sub(a);
    let ap = p.sub(a);
    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return (a, p.sub(a).dot(p.sub(a)));
    }
    let bp = p.sub(b);
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return (b, p.sub(b).dot(p.sub(b)));
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        let q = a.add(ab.scale(v));
        return (q, p.sub(q).dot(p.sub(q)));
    }
    let cp = p.sub(c);
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return (c, p.sub(c).dot(p.sub(c)));
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        let q = a.add(ac.scale(w));
        return (q, p.sub(q).dot(p.sub(q)));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        let q = b.add(c.sub(b).scale(w));
        return (q, p.sub(q).dot(p.sub(q)));
    }
    // Inside face region.
    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    let q = a.add(ab.scale(v)).add(ac.scale(w));
    (q, p.sub(q).dot(p.sub(q)))
}

/// Projects `p` onto the nearest of the given candidate faces; returns the
/// projected point and the face it landed on.
fn project_to_faces(mesh: &IndexedMesh, p: Vec3, faces: &[u32]) -> (Vec3, u32) {
    let mut best = p;
    let mut best_d = f32::INFINITY;
    let mut best_face = faces.first().copied().unwrap_or(0);
    for &f in faces {
        let [a, b, c] = mesh.tri_positions(f);
        let (q, d2) = closest_point_on_tri(p, a, b, c);
        if d2 < best_d {
            best_d = d2;
            best = q;
            best_face = f;
        }
    }
    (best, best_face)
}

/// Gathers candidate faces near a point: the faces of `seed_face` plus the faces
/// incident to its three vertices (one ring). Keeps projection local + fast.
fn local_faces(mesh: &IndexedMesh, topo: &Topology, seed_face: u32) -> Vec<u32> {
    let mut set: smallvec::SmallVec<[u32; 32]> = smallvec::SmallVec::new();
    let mut push = |f: u32, set: &mut smallvec::SmallVec<[u32; 32]>| {
        if !set.contains(&f) {
            set.push(f);
        }
    };
    push(seed_face, &mut set);
    let tri = mesh.triangles[seed_face as usize];
    for &v in &tri {
        for &f in &topo.vertex_faces[v as usize] {
            push(f, &mut set);
        }
    }
    set.into_vec()
}

/// Straightens a surface path toward the true geodesic by iterative local
/// relaxation: each interior point is pulled toward the midpoint of its
/// neighbours, then reprojected onto the surface (nearby faces). Repeated until
/// it stops shortening. Crosses triangle faces, so the result is smooth rather
/// than edge-locked. `closed` treats the path as a loop (every point relaxes).
fn straighten_path(mesh: &IndexedMesh, topo: &Topology, path: &[Vec3], closed: bool) -> Vec<Vec3> {
    let n = path.len();
    if n < 3 {
        return path.to_vec();
    }

    let mut pts = path.to_vec();
    // Seed each point's home face by projecting it against the faces of its
    // nearest vertex (path points start on/near vertices).
    let mut faces: Vec<u32> = pts
        .iter()
        .map(|&p| {
            let v = nearest_vertex(mesh, p).unwrap_or(0);
            let cand = &topo.vertex_faces[v as usize];
            project_to_faces(mesh, p, cand).1
        })
        .collect();

    const MAX_PASSES: usize = 24;
    const RELAX: f32 = 0.5; // pull strength toward the neighbour midpoint
    let mut prev_len = path_length(&pts, closed);

    for _ in 0..MAX_PASSES {
        for i in 0..n {
            // Endpoints of an open path stay pinned (they're the waypoints).
            let (prev_i, next_i) = if closed {
                ((i + n - 1) % n, (i + 1) % n)
            } else {
                if i == 0 || i == n - 1 {
                    continue;
                }
                (i - 1, i + 1)
            };

            let target = pts[prev_i].add(pts[next_i]).scale(0.5);
            let moved = pts[i].add(target.sub(pts[i]).scale(RELAX));

            // Reproject onto the surface, searching the local face neighbourhood
            // around this point's current home face (expands across the one-ring,
            // so the point can migrate onto adjacent faces).
            let cand = local_faces(mesh, topo, faces[i]);
            let (proj, f) = project_to_faces(mesh, moved, &cand);
            pts[i] = proj;
            faces[i] = f;
        }

        let len = path_length(&pts, closed);
        // Converged once the improvement is negligible.
        if prev_len - len < prev_len * 1e-4 {
            break;
        }
        prev_len = len;
    }

    pts
}

fn path_length(pts: &[Vec3], closed: bool) -> f32 {
    let n = pts.len();
    if n < 2 {
        return 0.0;
    }
    let mut total = 0.0;
    for i in 0..(n - 1) {
        total += pts[i + 1].sub(pts[i]).length();
    }
    if closed {
        total += pts[0].sub(pts[n - 1]).length();
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat 3x3 vertex grid (2x2 quads → 8 triangles) in the XY plane.
    /// Vertices indexed row-major: idx = row*3 + col, at (col, row, 0).
    fn grid_mesh() -> IndexedMesh {
        let mut positions = Vec::new();
        for row in 0..3 {
            for col in 0..3 {
                positions.push(Vec3::new(col as f32, row as f32, 0.0));
            }
        }
        let v = |r: usize, c: usize| (r * 3 + c) as u32;
        let mut triangles = Vec::new();
        for r in 0..2 {
            for c in 0..2 {
                triangles.push([v(r, c), v(r, c + 1), v(r + 1, c + 1)]);
                triangles.push([v(r, c), v(r + 1, c + 1), v(r + 1, c)]);
            }
        }
        IndexedMesh { positions, triangles }
    }

    #[test]
    fn dijkstra_finds_corner_to_corner_path() {
        let mesh = grid_mesh();
        let topo = Topology::build(&mesh);
        let graph = VertexGraph::build(&mesh, &topo);
        // From vertex 0 (0,0) to vertex 8 (2,2).
        let path = shortest_vertex_path(&graph, 0, 8).expect("path exists");
        assert_eq!(*path.first().unwrap(), 0);
        assert_eq!(*path.last().unwrap(), 8);
        // Path should be along the surface (every step is a real edge).
        for w in path.windows(2) {
            let connected = graph.neighbors[w[0] as usize].iter().any(|&(n, _)| n == w[1]);
            assert!(connected, "consecutive path verts must be edge-connected");
        }
    }

    #[test]
    fn nearest_vertex_snaps_correctly() {
        let mesh = grid_mesh();
        // Near (2,2,0) → vertex 8.
        let v = nearest_vertex(&mesh, Vec3::new(1.9, 2.1, 0.05)).unwrap();
        assert_eq!(v, 8);
    }

    #[test]
    fn surface_loop_closes() {
        let mesh = grid_mesh();
        let topo = Topology::build(&mesh);
        // Three corners of the grid → a closed triangle-ish loop on the surface.
        let waypoints = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(2.0, 0.0, 0.0),
            Vec3::new(2.0, 2.0, 0.0),
        ];
        let loop_pts = surface_loop_positions(&mesh, &topo, &waypoints, true).expect("loop");
        // A closed loop should have several points and return near the start.
        assert!(loop_pts.len() >= 3);
        let start = loop_pts[0];
        let end = *loop_pts.last().unwrap();
        // The closing path ends at the vertex just before the first (not duplicated),
        // so end should be adjacent-ish to start — just assert the loop is non-trivial.
        assert!(start.sub(end).length() <= 3.0);
    }

    /// Finer NxN vertex grid (unit spacing) in the XY plane, for straightening.
    fn fine_grid(nv: usize) -> IndexedMesh {
        let mut positions = Vec::new();
        for row in 0..nv {
            for col in 0..nv {
                positions.push(Vec3::new(col as f32, row as f32, 0.0));
            }
        }
        let v = |r: usize, c: usize| (r * nv + c) as u32;
        let mut triangles = Vec::new();
        for r in 0..(nv - 1) {
            for c in 0..(nv - 1) {
                triangles.push([v(r, c), v(r, c + 1), v(r + 1, c + 1)]);
                triangles.push([v(r, c), v(r + 1, c + 1), v(r + 1, c)]);
            }
        }
        IndexedMesh { positions, triangles }
    }

    #[test]
    fn straightening_shortens_and_stays_on_surface() {
        let nv = 9; // 9x9 grid, corner (0,0) to (8,8): true geodesic = diagonal √128.
        let mesh = fine_grid(nv);
        let topo = Topology::build(&mesh);
        let graph = VertexGraph::build(&mesh, &topo);

        let edge_path: Vec<Vec3> = shortest_vertex_path(&graph, 0, (nv * nv - 1) as u32)
            .unwrap()
            .iter()
            .map(|&v| mesh.positions[v as usize])
            .collect();
        let edge_len = path_length(&edge_path, false);

        let straight = straighten_path(&mesh, &topo, &edge_path, false);
        let straight_len = path_length(&straight, false);

        // The diagonal of an 8x8 square is √128 ≈ 11.31 (the true geodesic).
        // Straightening must never lengthen the path and must reach ~the diagonal.
        // (On this triangulation the edge-path may already BE the diagonal, so use
        // <= with a tiny epsilon rather than strict <.)
        let diagonal = (128.0f32).sqrt();
        assert!(
            straight_len <= edge_len + 1e-3,
            "straightened ({straight_len}) longer than edge ({edge_len})"
        );
        assert!(
            straight_len < diagonal * 1.15,
            "straightened {straight_len} should approach diagonal {diagonal}"
        );

        // Endpoints stay pinned; every point stays on the surface (z ≈ 0).
        assert!(straight[0].sub(edge_path[0]).length() < 1e-3, "start pinned");
        assert!(straight.last().unwrap().sub(*edge_path.last().unwrap()).length() < 1e-3, "end pinned");
        for p in &straight {
            assert!(p.z.abs() < 1e-3, "point left the surface: z={}", p.z);
        }
    }
}
