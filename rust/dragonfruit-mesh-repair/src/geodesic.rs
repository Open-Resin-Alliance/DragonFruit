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
    let graph = VertexGraph::build(mesh, topo);
    surface_loop_positions_with_graph(mesh, &graph, waypoints, close)
}

/// Convenience: build the topology internally and compute a closed surface loop
/// from waypoints. The high-level entry point for callers (e.g. Tauri) that just
/// have a mesh + clicked points.
///
/// NOTE: this rebuilds the full-mesh [`Topology`] and [`VertexGraph`] on every
/// call. For repeated queries against an UNCHANGING mesh (e.g. dragging a
/// waypoint live), build a [`GeodesicSolver`] once and reuse it instead — the
/// per-call cost then drops to just the Dijkstra + straightening.
pub fn surface_loop_from_mesh(mesh: &IndexedMesh, waypoints: &[Vec3], close: bool) -> Option<Vec<Vec3>> {
    surface_loop_from_mesh_smoothed(mesh, waypoints, close, DEFAULT_SEAM_SMOOTHING)
}

/// Default seam smoothing (0..1). 0.5 reproduces the original corner-rounding
/// window (4 points/side); 0 = sharp corners at waypoints, 1 = very rounded.
pub const DEFAULT_SEAM_SMOOTHING: f32 = 0.5;

/// Like [`surface_loop_from_mesh`] but with an explicit seam `smoothing` (0..1)
/// controlling how much the seam rounds through each waypoint.
pub fn surface_loop_from_mesh_smoothed(
    mesh: &IndexedMesh,
    waypoints: &[Vec3],
    close: bool,
    smoothing: f32,
) -> Option<Vec<Vec3>> {
    let topo = Topology::build(mesh);
    let graph = VertexGraph::build(mesh, &topo);
    let (path, is_anchor) = surface_loop_with_anchors(mesh, &graph, waypoints, close)?;
    let straight = straighten_path(mesh, &topo, &path, &is_anchor, close);
    Some(smooth_through_anchors(mesh, &topo, &straight, &is_anchor, close, smoothing))
}

/// A reusable geodesic solver that owns a mesh plus its precomputed [`Topology`]
/// and [`VertexGraph`]. Building these is O(mesh) and dominates the cost of a
/// single query, so for live interaction (dragging waypoints) the caller builds
/// the solver ONCE per staged mesh and calls [`Self::surface_loop`] per drag
/// update — each query is then only Dijkstra + path straightening.
pub struct GeodesicSolver {
    mesh: IndexedMesh,
    topo: Topology,
    graph: VertexGraph,
}

impl GeodesicSolver {
    /// Builds the solver from a mesh (computes topology + vertex graph once).
    pub fn build(mesh: IndexedMesh) -> Self {
        let topo = Topology::build(&mesh);
        let graph = VertexGraph::build(&mesh, &topo);
        Self { mesh, topo, graph }
    }

    /// Computes a closed (or open) on-surface loop through `waypoints`, reusing
    /// the cached topology/graph. Equivalent result to [`surface_loop_from_mesh`]
    /// but without rebuilding the per-mesh structures. The waypoints are pinned,
    /// so the smoothed line passes exactly through every clicked point.
    pub fn surface_loop(&self, waypoints: &[Vec3], close: bool) -> Option<Vec<Vec3>> {
        self.surface_loop_smoothed(waypoints, close, DEFAULT_SEAM_SMOOTHING)
    }

    /// As [`Self::surface_loop`] but with explicit seam `smoothing` (0..1).
    pub fn surface_loop_smoothed(
        &self,
        waypoints: &[Vec3],
        close: bool,
        smoothing: f32,
    ) -> Option<Vec<Vec3>> {
        let (path, is_anchor) =
            surface_loop_with_anchors(&self.mesh, &self.graph, waypoints, close)?;
        let straight = straighten_path(&self.mesh, &self.topo, &path, &is_anchor, close);
        Some(smooth_through_anchors(
            &self.mesh,
            &self.topo,
            &straight,
            &is_anchor,
            close,
            smoothing,
        ))
    }
}

/// Like [`surface_loop_positions`] but takes a prebuilt [`VertexGraph`] instead
/// of constructing one — the hot path for [`GeodesicSolver`].
pub fn surface_loop_positions_with_graph(
    mesh: &IndexedMesh,
    graph: &VertexGraph,
    waypoints: &[Vec3],
    close: bool,
) -> Option<Vec<Vec3>> {
    Some(surface_loop_with_anchors(mesh, graph, waypoints, close)?.0)
}

/// Like [`surface_loop_positions_with_graph`] but ALSO returns, for each output
/// path point, whether it is a waypoint ANCHOR — i.e. one of the user's clicked
/// points (the join points between segments). The straightening pass uses this to
/// pin those points so the smoothed line still passes exactly through every
/// waypoint instead of drifting off them.
///
/// Returns `(path, is_anchor)` where `is_anchor.len() == path.len()`.
pub fn surface_loop_with_anchors(
    mesh: &IndexedMesh,
    graph: &VertexGraph,
    waypoints: &[Vec3],
    close: bool,
) -> Option<(Vec<Vec3>, Vec<bool>)> {
    if waypoints.len() < 2 {
        return None;
    }

    // Snap each waypoint to its nearest mesh vertex (for the edge-path Dijkstra),
    // but remember the EXACT clicked position so the anchor can be pinned there.
    let verts: Vec<u32> = waypoints
        .iter()
        .map(|&w| nearest_vertex(mesh, w))
        .collect::<Option<Vec<_>>>()?;

    let mut out: Vec<Vec3> = Vec::new();
    let mut is_anchor: Vec<bool> = Vec::new();

    // Pushes the edge-path between two waypoint vertices. `from_pos`/`to_pos` are
    // the EXACT clicked waypoint positions for the segment's endpoints, used to
    // override the snapped-vertex position at the anchors so the rendered line
    // touches the dot precisely.
    // `drop_last` omits the segment's final point — used for the CLOSING segment
    // of a loop, whose endpoint is the first waypoint already present at out[0].
    // Without this the first waypoint would be duplicated (two anchors for one
    // click), corrupting the anchor count and the downstream spline control set.
    let push_path = |from: u32,
                     to: u32,
                     from_pos: Vec3,
                     to_pos: Vec3,
                     drop_last: bool,
                     out: &mut Vec<Vec3>,
                     is_anchor: &mut Vec<bool>|
     -> bool {
        let path = match shortest_vertex_path(graph, from, to) {
            Some(p) => p,
            None => return false,
        };
        let last = path.len().saturating_sub(1);
        for (i, &v) in path.iter().enumerate() {
            // Skip the first vertex of every segment after the first — it's the
            // shared join already emitted as the previous segment's endpoint.
            if !out.is_empty() && i == 0 {
                continue;
            }
            // For the closing segment, skip the final point (== out[0]).
            if drop_last && i == last {
                continue;
            }
            let anchor = i == 0 || i == last;
            // At anchors use the exact clicked position; elsewhere the vertex.
            let pos = if i == 0 {
                from_pos
            } else if i == last {
                to_pos
            } else {
                mesh.positions[v as usize]
            };
            out.push(pos);
            is_anchor.push(anchor);
        }
        true
    };

    for i in 0..(verts.len() - 1) {
        if !push_path(
            verts[i],
            verts[i + 1],
            waypoints[i],
            waypoints[i + 1],
            false,
            &mut out,
            &mut is_anchor,
        ) {
            return None;
        }
    }
    if close {
        let last = verts.len() - 1;
        if verts[last] != verts[0]
            && !push_path(
                verts[last],
                verts[0],
                waypoints[last],
                waypoints[0],
                true, // drop the closing endpoint (it's out[0])
                &mut out,
                &mut is_anchor,
            )
        {
            return None;
        }
    }

    if out.len() < 2 {
        return None;
    }
    debug_assert_eq!(out.len(), is_anchor.len());
    Some((out, is_anchor))
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

/// Grows a patch of faces `rings` vertex-rings out from `seed_face` (BFS over the
/// vertex→face adjacency). Used to build, once per anchor, a candidate set large
/// enough to cover that anchor's whole corner-rounding window — so each window
/// sample projects against a shared local patch instead of doing its own O(n)
/// nearest-vertex search.
fn grow_faces(mesh: &IndexedMesh, topo: &Topology, seed_face: u32, rings: usize) -> Vec<u32> {
    let mut faces: Vec<u32> = Vec::new();
    let mut seen_face: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut frontier: Vec<u32> = mesh.triangles[seed_face as usize].to_vec();
    let mut seen_vert: std::collections::HashSet<u32> = frontier.iter().copied().collect();
    seen_face.insert(seed_face);
    faces.push(seed_face);

    for _ in 0..rings.max(1) {
        let mut next: Vec<u32> = Vec::new();
        for &v in &frontier {
            for &f in &topo.vertex_faces[v as usize] {
                if seen_face.insert(f) {
                    faces.push(f);
                    for &fv in &mesh.triangles[f as usize] {
                        if seen_vert.insert(fv) {
                            next.push(fv);
                        }
                    }
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    faces
}

/// Straightens a surface path toward the true geodesic by iterative local
/// relaxation: each point is pulled toward the midpoint of its neighbours, then
/// reprojected onto the surface (nearby faces). Repeated until it stops
/// shortening. Crosses triangle faces, so the result is smooth rather than
/// edge-locked. `closed` treats the path as a loop.
///
/// `is_anchor[i] == true` PINS point `i` (a user waypoint) to its exact clicked
/// position: it is excluded from relaxation and snapped back after every pass, so
/// the straightened path passes precisely through each waypoint. The corner that
/// forms at each pinned waypoint is rounded into a smooth pass-through separately
/// by [`smooth_through_anchors`]. On an open path the endpoints are also pinned.
fn straighten_path(
    mesh: &IndexedMesh,
    topo: &Topology,
    path: &[Vec3],
    is_anchor: &[bool],
    closed: bool,
) -> Vec<Vec3> {
    let n = path.len();
    if n < 3 {
        return path.to_vec();
    }

    let mut pts = path.to_vec();
    // The exact positions anchors must return to after each pass (their clicks).
    let anchor_pos: Vec<Vec3> = path.to_vec();

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

    let is_pinned = |i: usize| -> bool {
        is_anchor.get(i).copied().unwrap_or(false) || (!closed && (i == 0 || i == n - 1))
    };

    // Enough passes that points can walk a long way across the mesh toward the
    // geodesic (one triangle/pass via the carried home face). Cheap: each pass is
    // O(path · one-ring). Converges early via the length-improvement break below.
    const MAX_PASSES: usize = 120;
    const RELAX: f32 = 0.5; // pull strength toward the neighbour midpoint
    let mut prev_len = path_length(&pts, closed);

    for _ in 0..MAX_PASSES {
        for i in 0..n {
            // Anchors (and open-path endpoints) don't move in the relax step —
            // they're snapped back below — but they DO stay in the chain so their
            // neighbours average through them, giving a smooth pass-through.
            if is_pinned(i) {
                continue;
            }
            let (prev_i, next_i) = if closed {
                ((i + n - 1) % n, (i + 1) % n)
            } else {
                (i - 1, i + 1)
            };

            let target = pts[prev_i].add(pts[next_i]).scale(0.5);
            let moved = pts[i].add(target.sub(pts[i]).scale(RELAX));

            // Reproject onto the surface, searching the local face neighbourhood
            // around this point's current home face. The home face is carried
            // forward each pass (`faces[i] = f`), so a point walks across the mesh
            // one triangle per pass toward the geodesic — enough passes let it
            // travel far. Kept local (one-ring) so this stays cheap on big meshes.
            let cand = local_faces(mesh, topo, faces[i]);
            let (proj, f) = project_to_faces(mesh, moved, &cand);
            pts[i] = proj;
            faces[i] = f;
        }

        // Snap every anchor back to its exact click so it never drifts, while the
        // neighbours that just relaxed toward it now curve smoothly through it.
        for i in 0..n {
            if is_anchor.get(i).copied().unwrap_or(false) {
                pts[i] = anchor_pos[i];
            }
        }

        let len = path_length(&pts, closed);
        // Converged once the improvement is negligible over a STRICTER threshold —
        // on a closed loop the length plateaus early while the path is still
        // kinky, so a loose break stops short of a smooth geodesic. Require the
        // length to be essentially stationary before stopping.
        if (prev_len - len).abs() < prev_len * 1e-6 {
            break;
        }
        prev_len = len;
    }

    pts
}

/// Rounds the sharp CORNER at each pinned waypoint into a smooth arc, leaving the
/// already-smooth straightened segments BETWEEN waypoints untouched.
///
/// The straightened path is essentially smooth between waypoints (the relaxation
/// straightens those into geodesics) but corners sharply AT each pinned waypoint.
/// So we don't rebuild the whole curve — we only Laplacian-smooth a small WINDOW
/// of points on each side of every anchor, snapping the anchor itself back to its
/// exact click each pass. The points flanking the anchor bend into a fillet that
/// flows smoothly through the (fixed) waypoint, while points far from any anchor
/// never move. Every moved point is reprojected onto the surface so the curve
/// stays on the mesh.
fn smooth_through_anchors(
    mesh: &IndexedMesh,
    topo: &Topology,
    path: &[Vec3],
    is_anchor: &[bool],
    closed: bool,
    smoothing: f32,
) -> Vec<Vec3> {
    let n = path.len();
    if n < 3 {
        return path.to_vec();
    }

    let mut pts = path.to_vec();

    // Up to MAX_WINDOW points on each side of an anchor are reshaped into a smooth
    // arc through the (fixed) waypoint. Beyond the window the path is the
    // already-smooth straightened geodesic and is left untouched. The window is
    // capped per-anchor to a fraction of the gap to its neighbouring anchors so
    // adjacent fillets never overlap and fight each other.
    //
    // `smoothing` (0..2) scales the window: 0 → no rounding (sharp corners), 0.5
    // → ~4 points/side (the original default), 1 → ~8, 2 → ~16 (very rounded).
    let max_window = (smoothing.clamp(0.0, 2.0) * 8.0).round() as isize;
    if max_window < 1 {
        return pts; // smoothing ~0: leave the sharp straightened corners as-is
    }
    let anchor_idx: Vec<usize> = (0..n).filter(|&i| is_anchor[i]).collect();
    if anchor_idx.len() < 2 {
        return pts;
    }

    // Steps from each anchor to the next/prev anchor along the path (wrapping).
    let gap_after = |k: usize| -> isize {
        let ai = anchor_idx[k] as isize;
        let next = anchor_idx[(k + 1) % anchor_idx.len()] as isize;
        let raw = if closed {
            (next - ai).rem_euclid(n as isize)
        } else {
            next - ai
        };
        raw.max(1)
    };

    for (k, &ai) in anchor_idx.iter().enumerate() {
        let prev_gap = gap_after((k + anchor_idx.len() - 1) % anchor_idx.len());
        let next_gap = gap_after(k);
        // Leave at least 1 untouched point before the neighbouring anchor so the
        // fillet blends into the straight segment instead of colliding.
        let win = max_window
            .min((prev_gap - 1).max(0) / 2)
            .min((next_gap - 1).max(0) / 2);
        if win < 1 {
            continue;
        }
        let i0 = ai as isize - win;
        let i2 = ai as isize + win;
        // Window endpoints (clamped for open paths, wrapped for closed loops).
        let idx = |k: isize| -> Option<usize> {
            if closed {
                Some(k.rem_euclid(n as isize) as usize)
            } else if k < 0 || k >= n as isize {
                None
            } else {
                Some(k as usize)
            }
        };
        let (Some(a0), Some(a2)) = (idx(i0), idx(i2)) else {
            continue; // not enough room (open-path end) — leave the corner as-is
        };
        let p0 = path[a0]; // window start (on one arm)
        let p1 = path[ai]; // the exact clicked waypoint (INTERPOLATED, stays put)
        let p2 = path[a2]; // window end (on the other arm)

        // Candidate faces for reprojecting this anchor's window samples, built
        // ONCE here (not per sample): a k-ring grown from the anchor vertex, big
        // enough to cover the whole small window. One O(n) nearest-vertex scan per
        // anchor — cheap — instead of one per window point.
        let anchor_vert = nearest_vertex(mesh, p1).unwrap_or(0);
        let seed_face = topo.vertex_faces[anchor_vert as usize]
            .first()
            .copied()
            .unwrap_or(0);
        let cand = grow_faces(mesh, topo, seed_face, (win as usize) + 1);

        // Reshape each interior window point onto a Catmull-Rom curve that
        // INTERPOLATES [P0, anchor, P2]. Unlike a quadratic Bézier (which only
        // approaches P1), Catmull-Rom passes THROUGH the anchor with a continuous
        // tangent = (P2 - P0)/2, so the arms meet the waypoint tangentially — a
        // smooth pass-through, no cusp. The anchor (d == 0) is left exactly put.
        //
        // For 3 control points we treat the ends as their own phantom neighbours
        // (P0 and P2 repeated), giving two segments: P0→anchor (u in [0,1]) and
        // anchor→P2 (u in [0,1]).
        let catmull = |pm1: Vec3, p_0: Vec3, p_1: Vec3, p_2: Vec3, u: f32| -> Vec3 {
            let u2 = u * u;
            let u3 = u2 * u;
            p_0.scale(2.0)
                .add(p_1.sub(pm1).scale(u))
                .add(pm1.scale(2.0).add(p_0.scale(-5.0)).add(p_1.scale(4.0)).sub(p_2).scale(u2))
                .add(pm1.scale(-1.0).add(p_0.scale(3.0)).add(p_1.scale(-3.0)).add(p_2).scale(u3))
                .scale(0.5)
        };

        for d in -win..=win {
            if d == 0 {
                continue; // anchor interpolated exactly — leave it put
            }
            let Some(j) = idx(ai as isize + d) else { continue };
            if is_anchor.get(j).copied().unwrap_or(false) {
                continue; // don't disturb a neighbouring waypoint
            }
            // Map d to a curve sample. Negative side: segment P0→anchor with
            // u = (d + win)/win ∈ (0,1). Positive side: segment anchor→P2 with
            // u = d/win ∈ (0,1].
            let arc = if d < 0 {
                let u = (d as f32 + win as f32) / win as f32;
                catmull(p0, p0, p1, p2, u) // ends clamped (phantom = P0)
            } else {
                let u = d as f32 / win as f32;
                catmull(p0, p1, p2, p2, u) // ends clamped (phantom = P2)
            };
            // Project onto the surface using the anchor's prebuilt k-ring patch.
            let (proj, _f) = project_to_faces(mesh, arc, &cand);
            pts[j] = proj;
        }
    }

    // Anchors are never moved above, so they remain exactly on their clicks.
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

    #[test]
    fn straightened_loop_passes_through_every_waypoint() {
        // A finer grid so straightening actually moves interior points, then
        // verify each clicked waypoint still appears EXACTLY in the output (the
        // anchors are pinned). Waypoints are placed OFF the grid vertices to also
        // confirm the anchor uses the exact clicked position, not a snapped vertex.
        let mesh = fine_grid(9);
        let topo = Topology::build(&mesh);
        let graph = VertexGraph::build(&mesh, &topo);

        let waypoints = vec![
            Vec3::new(0.3, 0.2, 0.0),
            Vec3::new(7.6, 0.4, 0.0),
            Vec3::new(7.5, 7.7, 0.0),
            Vec3::new(0.4, 7.6, 0.0),
        ];

        // Full pipeline: straighten then spline-smooth. Every clicked waypoint
        // must still appear EXACTLY in the final smoothed line.
        let (path, is_anchor) =
            surface_loop_with_anchors(&mesh, &graph, &waypoints, true).expect("loop");
        let straight = straighten_path(&mesh, &topo, &path, &is_anchor, true);
        let line = smooth_through_anchors(&mesh, &topo, &straight, &is_anchor, true, DEFAULT_SEAM_SMOOTHING);

        for (wi, w) in waypoints.iter().enumerate() {
            let hit = line.iter().any(|p| p.sub(*w).length() < 1e-4);
            assert!(hit, "waypoint {wi} ({w:?}) not found exactly in smoothed loop");
        }
    }

    #[test]
    fn line_rounds_smoothly_through_a_sharp_waypoint() {
        // A V-shape: three waypoints where the middle one is a sharp apex. After
        // straightening + corner-rounding, the line must (a) still pass exactly
        // through the apex, and (b) bend SMOOTHLY through it — the turn at the
        // apex's immediate neighbours should be much closer to straight (180°)
        // than the raw corner formed by the apex and the two outer waypoints.
        let mesh = fine_grid(13);
        let topo = Topology::build(&mesh);
        let graph = VertexGraph::build(&mesh, &topo);

        let a = Vec3::new(0.0, 6.0, 0.0); // left arm
        let apex = Vec3::new(6.0, 0.0, 0.0); // sharp bottom apex
        let c = Vec3::new(12.0, 6.0, 0.0); // right arm
        let waypoints = vec![a, apex, c];

        // Full pipeline: straighten (corners at anchors) then spline-smooth.
        let (path, is_anchor) =
            surface_loop_with_anchors(&mesh, &graph, &waypoints, false).expect("loop");
        let straight = straighten_path(&mesh, &topo, &path, &is_anchor, false);
        let line = smooth_through_anchors(&mesh, &topo, &straight, &is_anchor, false, DEFAULT_SEAM_SMOOTHING);

        // The apex (snapped back exactly) is present in the smoothed line.
        let ai = line
            .iter()
            .position(|p| p.sub(apex).length() < 1e-4)
            .expect("apex present exactly");
        assert!(ai > 0 && ai < line.len() - 1, "apex has neighbours");

        let angle = |u: Vec3, v: Vec3| -> f32 {
            let lu = u.length();
            let lv = v.length();
            if lu < 1e-6 || lv < 1e-6 {
                return std::f32::consts::PI;
            }
            (u.dot(v) / (lu * lv)).clamp(-1.0, 1.0).acos()
        };

        // Raw corner: the turn the arms make AT the apex (apex→a vs apex→c) — the
        // sharp ~90° V the un-smoothed line has.
        let raw_turn = angle(a.sub(apex), c.sub(apex));
        // Smoothed: the turn at the apex using its IMMEDIATE spline neighbours.
        // A smooth pass-through opens this toward straight (π).
        let smooth_turn = angle(line[ai - 1].sub(apex), line[ai + 1].sub(apex));

        assert!(
            smooth_turn > raw_turn + 0.15,
            "apex not smoothed: raw_turn={raw_turn:.3} smooth_turn={smooth_turn:.3}"
        );
        // The apex itself must stay exactly on the click.
        assert!(line[ai].sub(apex).length() < 1e-4, "apex drifted");

        // The smoothed line must stay on the surface (z ≈ 0 for this flat grid).
        for p in &line {
            assert!(p.z.abs() < 1e-3, "smoothed point left the surface: z={}", p.z);
        }
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

        // No interior anchors here — open-path endpoints are pinned implicitly.
        let no_anchors = vec![false; edge_path.len()];
        let straight = straighten_path(&mesh, &topo, &edge_path, &no_anchors, false);
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

    #[test]
    fn closed_loop_is_smooth_and_dense_between_waypoints() {
        // Reproduces the real scenario: a CLOSED loop of several waypoints. The
        // output must be (a) DENSE (spline-sampled, not the raw sparse edge-path),
        // (b) SMOOTH (small turn angle between consecutive points — no sawtooth),
        // and (c) pass exactly through every waypoint. This guards the regression
        // where the smoothing silently fell back to the raw jagged path.
        let mesh = fine_grid(15);
        let topo = Topology::build(&mesh);
        let graph = VertexGraph::build(&mesh, &topo);

        let waypoints = vec![
            Vec3::new(2.0, 2.0, 0.0),
            Vec3::new(11.0, 3.0, 0.0),
            Vec3::new(12.0, 11.0, 0.0),
            Vec3::new(3.0, 12.0, 0.0),
        ];

        let (path, is_anchor) =
            surface_loop_with_anchors(&mesh, &graph, &waypoints, true).expect("loop");
        let straight = straighten_path(&mesh, &topo, &path, &is_anchor, true);
        let line = smooth_through_anchors(&mesh, &topo, &straight, &is_anchor, true, DEFAULT_SEAM_SMOOTHING);

        // (a) Same point set (corner-rounding smooths in place, doesn't resample).
        assert_eq!(
            line.len(),
            straight.len(),
            "corner-rounding should not change the point count"
        );

        // (c) Passes through every waypoint.
        for (wi, w) in waypoints.iter().enumerate() {
            assert!(
                line.iter().any(|p| p.sub(*w).length() < 1e-4),
                "waypoint {wi} ({w:?}) missing from smoothed loop"
            );
        }

        // (b) Smooth: the WORST turn angle between consecutive segments (away from
        // the waypoints, where a deliberate bend is expected) must be gentle. A
        // sawtooth edge-path would show near-90° turns. We measure the median-ish
        // worst by allowing the few waypoint corners but requiring the rest small.
        let n = line.len();
        let turn_at = |i: usize| -> f32 {
            let prev = line[(i + n - 1) % n];
            let cur = line[i];
            let next = line[(i + 1) % n];
            let a = cur.sub(prev);
            let b = next.sub(cur);
            let (la, lb) = (a.length(), b.length());
            if la < 1e-6 || lb < 1e-6 {
                return 0.0;
            }
            (a.dot(b) / (la * lb)).clamp(-1.0, 1.0).acos()
        };
        let mut turns: Vec<f32> = (0..n).map(turn_at).collect();
        turns.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        // Drop the 4 sharpest (the deliberate waypoint bends); the rest must be
        // smooth — no point should turn more than ~25° on a gentle spline.
        let cutoff = turns.len().saturating_sub(4);
        for (k, &t) in turns.iter().take(cutoff).enumerate() {
            assert!(
                t < 0.45,
                "segment {k} too sharp ({t:.3} rad) — line is not smooth"
            );
        }
    }
}
