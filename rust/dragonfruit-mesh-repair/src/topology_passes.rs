use std::collections::{BTreeMap, VecDeque};

use ahash::{AHashMap, AHashSet};

use crate::core::bvh::Bvh;
use crate::core::halfedge::{edge_key, Topology};
use crate::core::mesh::{Aabb, IndexedMesh, Vec3};

const MIN_AREA_DP_MAX_LOOP: usize = 1024;

#[inline]
fn d3(v: Vec3) -> [f64; 3] {
    [v.x as f64, v.y as f64, v.z as f64]
}

#[inline]
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn len3(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn cross_len(a: [f64; 3], b: [f64; 3]) -> f64 {
    let c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    dot(c, c).sqrt()
}

/// 0.01 in a space where the largest extent is clamped to [5, 400].
pub fn stitch_tolerance(mesh: &IndexedMesh) -> f32 {
    let b = mesh.bbox();
    let d = b.max.sub(b.min);
    let extent = d.x.max(d.y).max(d.z);
    if !extent.is_finite() || extent <= 0.0 {
        return 0.0;
    }
    0.01 * extent / extent.clamp(5.0, 400.0)
}

/// Boundary loops ordered opposite to their bordering face edges, split at repeated vertices.

/// Propagates winding across two-face edges; per patch the smaller-area side is flipped.
pub fn unify_winding(mesh: &mut IndexedMesh) -> usize {
    let n = mesh.triangles.len();
    if n == 0 {
        return 0;
    }
    let topo = Topology::build(mesh);
    let mut adj: Vec<smallvec::SmallVec<[(u32, bool); 3]>> = vec![smallvec::SmallVec::new(); n];
    for info in topo.edges.values() {
        if info.directed.len() != 2 {
            continue;
        }
        let (a0, _, f0) = info.directed[0];
        let (a1, _, f1) = info.directed[1];
        if f0 == f1 {
            continue;
        }
        let agree = a0 != a1;
        adj[f0 as usize].push((f1, agree));
        adj[f1 as usize].push((f0, agree));
    }

    let area: Vec<f64> = (0..n).map(|f| mesh.tri_area(f as u32) as f64).collect();
    let mut side = vec![0u8; n];
    let mut queue = VecDeque::new();
    let mut group = Vec::new();
    let mut flipped = 0usize;
    for seed in 0..n {
        if side[seed] != 0 {
            continue;
        }
        group.clear();
        side[seed] = 1;
        queue.push_back(seed);
        let (mut keep_area, mut flip_area) = (0.0f64, 0.0f64);
        while let Some(x) = queue.pop_front() {
            group.push(x);
            if side[x] == 1 {
                keep_area += area[x];
            } else {
                flip_area += area[x];
            }
            for &(y, agree) in &adj[x] {
                let y = y as usize;
                if side[y] == 0 {
                    side[y] = if agree { side[x] } else { 3 - side[x] };
                    queue.push_back(y);
                }
            }
        }
        let minority = if flip_area > keep_area { 1 } else { 2 };
        for &x in &group {
            if side[x] == minority {
                mesh.triangles[x].swap(1, 2);
                flipped += 1;
            }
        }
    }
    flipped
}

struct PointGrid {
    cell: f64,
    cells: AHashMap<(i64, i64, i64), Vec<u32>>,
}

impl PointGrid {
    fn new(cell: f64) -> Self {
        Self { cell, cells: AHashMap::new() }
    }

    fn key(&self, p: [f64; 3]) -> (i64, i64, i64) {
        (
            (p[0] / self.cell).floor() as i64,
            (p[1] / self.cell).floor() as i64,
            (p[2] / self.cell).floor() as i64,
        )
    }

    fn insert(&mut self, p: [f64; 3], id: u32) {
        let k = self.key(p);
        self.cells.entry(k).or_default().push(id);
    }

    fn in_box(&self, lo: [f64; 3], hi: [f64; 3], out: &mut Vec<u32>) {
        out.clear();
        let (a, b) = (self.key(lo), self.key(hi));
        let span = (b.0 - a.0 + 1) * (b.1 - a.1 + 1) * (b.2 - a.2 + 1);
        if span > 4096 {
            return;
        }
        for x in a.0..=b.0 {
            for y in a.1..=b.1 {
                for z in a.2..=b.2 {
                    if let Some(ids) = self.cells.get(&(x, y, z)) {
                        out.extend_from_slice(ids);
                    }
                }
            }
        }
        out.sort_unstable();
    }
}

fn closed_edge(topo: &Topology, e: (u32, u32)) -> bool {
    topo.edges.get(&e).is_some_and(|i| i.faces.len() >= 2)
}

fn boundary_halfedges(topo: &Topology) -> Vec<(u32, u32, u32)> {
    let mut v: Vec<(u32, u32, u32)> = topo
        .edges
        .values()
        .filter(|i| i.faces.len() == 1)
        .map(|i| i.directed[0])
        .collect();
    v.sort_unstable();
    v
}

fn find(parent: &mut [u32], i: u32) -> u32 {
    let mut r = i;
    while parent[r as usize] != r {
        r = parent[r as usize];
    }
    let mut c = i;
    while parent[c as usize] != r {
        let n = parent[c as usize];
        parent[c as usize] = r;
        c = n;
    }
    r
}

/// Closes gaps narrower than `tol` between open borders; interior vertices never move.
pub fn stitch_borders(mesh: &mut IndexedMesh, tol: f32, max_rounds: usize) -> usize {
    if tol <= 0.0 {
        return 0;
    }
    let tol = tol as f64;
    let mut changed = 0usize;
    for _ in 0..max_rounds {
        let topo = Topology::build(mesh);
        let border = boundary_halfedges(&topo);
        if border.is_empty() {
            break;
        }
        let mut bverts: Vec<u32> = border.iter().flat_map(|&(a, b, _)| [a, b]).collect();
        bverts.sort_unstable();
        bverts.dedup();

        let mut lens: Vec<f64> = border
            .iter()
            .map(|&(a, b, _)| {
                let d = sub(d3(mesh.positions[b as usize]), d3(mesh.positions[a as usize]));
                dot(d, d).sqrt()
            })
            .collect();
        lens.sort_unstable_by(|a, b| a.total_cmp(b));
        let cell = lens[lens.len() / 2].max(tol);
        let mut grid = PointGrid::new(cell);
        for &v in &bverts {
            grid.insert(d3(mesh.positions[v as usize]), v);
        }

        let mut split_face: AHashMap<u32, (u32, u32, u32)> = AHashMap::new();
        let mut cand = Vec::new();
        for &(a, b, f) in &border {
            if split_face.contains_key(&f) {
                continue;
            }
            let (pa, pb) = (d3(mesh.positions[a as usize]), d3(mesh.positions[b as usize]));
            let d = sub(pb, pa);
            let dd = dot(d, d);
            if dd <= tol * tol {
                continue;
            }
            let lo = [pa[0].min(pb[0]) - tol, pa[1].min(pb[1]) - tol, pa[2].min(pb[2]) - tol];
            let hi = [pa[0].max(pb[0]) + tol, pa[1].max(pb[1]) + tol, pa[2].max(pb[2]) + tol];
            grid.in_box(lo, hi, &mut cand);
            for &p in &cand {
                if p == a || p == b {
                    continue;
                }
                let pp = d3(mesh.positions[p as usize]);
                let t = dot(sub(pp, pa), d) / dd;
                if t <= 0.0 || t >= 1.0 {
                    continue;
                }
                let q = [pa[0] + t * d[0], pa[1] + t * d[1], pa[2] + t * d[2]];
                let dq = sub(pp, q);
                let (da, db) = (sub(pp, pa), sub(pp, pb));
                if dot(dq, dq) < tol * tol && dot(da, da) > tol * tol && dot(db, db) > tol * tol {
                    split_face.insert(f, (a, b, p));
                    break;
                }
            }
        }
        let mut round_changed = 0usize;
        if !split_face.is_empty() {
            let mut faces: Vec<(u32, (u32, u32, u32))> = split_face.into_iter().collect();
            faces.sort_unstable();
            let mut added: AHashSet<(u32, u32)> = AHashSet::new();
            for (f, (a, b, p)) in faces {
                let tri = mesh.triangles[f as usize];
                let Some(&w) = tri.iter().find(|&&x| x != a && x != b) else { continue };
                let new_edges = [edge_key(a, p), edge_key(p, b), edge_key(p, w)];
                if p == w || new_edges.iter().any(|e| closed_edge(&topo, *e) || added.contains(e)) {
                    continue;
                }
                added.extend(new_edges);
                mesh.triangles[f as usize] = [a, p, w];
                mesh.triangles.push([p, b, w]);
                round_changed += 1;
            }
        }

        // Zip opposite border edge pairs only, so a merge never puts a third face on an edge.
        if round_changed > 0 {
            changed += round_changed;
            continue;
        }
        let mut ending_at: AHashMap<u32, smallvec::SmallVec<[u32; 2]>> = AHashMap::new();
        for &(a, b, _) in &border {
            ending_at.entry(b).or_default().push(a);
        }
        let near = |p: u32, q: u32| {
            let d = sub(d3(mesh.positions[p as usize]), d3(mesh.positions[q as usize]));
            dot(d, d) < tol * tol
        };
        let mut parent: Vec<u32> = (0..mesh.positions.len() as u32).collect();
        let mut merged = 0usize;
        for &(a, b, _) in &border {
            let pa = d3(mesh.positions[a as usize]);
            grid.in_box(
                [pa[0] - tol, pa[1] - tol, pa[2] - tol],
                [pa[0] + tol, pa[1] + tol, pa[2] + tol],
                &mut cand,
            );
            for &d in &cand {
                let Some(froms) = ending_at.get(&d) else { continue };
                for &c in froms {
                    if (c, d) == (b, a) || (c == a && d == b) || !near(a, d) || !near(b, c) {
                        continue;
                    }
                    for (x, y) in [(a, d), (b, c)] {
                        let (rx, ry) = (find(&mut parent, x), find(&mut parent, y));
                        if rx != ry {
                            parent[rx.max(ry) as usize] = rx.min(ry);
                            merged += 1;
                        }
                    }
                }
            }
        }
        if merged > 0 {
            for tri in mesh.triangles.iter_mut() {
                for v in tri.iter_mut() {
                    *v = find(&mut parent, *v);
                }
            }
            round_changed += merged;
        }
        if round_changed == 0 {
            break;
        }
        changed += round_changed;
    }
    changed
}

/// `chord_taken[i * n + j]` marks loop chords that already exist as mesh edges.
fn min_area_triangulation(pts: &[[f64; 3]], chord_taken: &[bool], sliver: f64, penalty: f64, weight: f64) -> Option<Vec<[usize; 3]>> {
    let n = pts.len();
    let mut w = vec![0.0f64; n * n];
    let mut k_of = vec![usize::MAX; n * n];
    let idx = |i: usize, j: usize| i * n + j;
    let usable = |i: usize, j: usize| j == i + 1 || !chord_taken[i * n + j];
    for gap in 2..n {
        for i in 0..n - gap {
            let j = i + gap;
            let mut best = f64::INFINITY;
            let mut best_k = i + 1;
            for k in i + 1..j {
                if !usable(i, k) || !usable(k, j) {
                    continue;
                }
                let c = cross_len(sub(pts[k], pts[i]), sub(pts[j], pts[i]));
                // Area alone is not the objective. On a *non-planar* band the fan's triangles lie across the
                // opening and their total area is *less* than the strip's, so minimising area prefers the
                // fan: measured on the reported model, a 937-edge rim came out of this plan as a fan with 937
                // faces at one vertex, where the input's worst vertex carries 135. That is what a viewer shows
                // as stray triangles.
                //
                // The two diagonals this step introduces are what distinguishes the two. A fan reaches across
                // the band (diagonals about as long as the band), a strip spans its width, so adding their
                // length to the cost is the classic minimum-weight objective and it is what makes a band come
                // out as a strip. `weight` is the model's own diagonal, so the term is scale-free; the sliver
                // penalty stays far larger than either, so nothing here reintroduces slivers.
                let reach = len3(sub(pts[k], pts[i])) + len3(sub(pts[j], pts[k]));
                let tri = if c < sliver { penalty } else { 0.5 * c + weight * reach };
                let cost = w[idx(i, k)] + w[idx(k, j)] + tri;
                if cost < best {
                    best = cost;
                    best_k = k;
                }
            }
            w[idx(i, j)] = best;
            k_of[idx(i, j)] = best_k;
        }
    }
    if !w[idx(0, n - 1)].is_finite() {
        return None;
    }
    let mut tris = Vec::with_capacity(n - 2);
    let mut stack = vec![(0usize, n - 1)];
    while let Some((i, j)) = stack.pop() {
        if j < i + 2 {
            continue;
        }
        let k = k_of[idx(i, j)];
        tris.push([i, k, j]);
        stack.push((i, k));
        stack.push((k, j));
    }
    Some(tris)
}

/// Whether a triangulation is fan-shaped: one vertex carrying a large share of its triangles.
///
/// A strip uses each of its loop's vertices two or three times; a fan uses one of them for most of the
/// triangles. The share is what separates them, and a quarter is far above any strip and far below any fan.
fn fan_shaped(tris: &[[usize; 3]], n: usize) -> bool {
    if n < 8 {
        return false;
    }
    let mut count: ahash::AHashMap<usize, usize> = ahash::AHashMap::new();
    for t in tris {
        for &v in t.iter() {
            *count.entry(v).or_insert(0) += 1;
        }
    }
    let worst = count.values().copied().max().unwrap_or(0);
    worst * 4 > tris.len()
}


/// The normal of the face on each edge of `boundary`, in the order the loop traverses it.
///
/// A boundary edge has exactly one face, so this is the surface the loop is a hole *in* rather than an
/// average over a neighbourhood that might belong to a different surface.
fn loop_edge_normals(mesh: &IndexedMesh, topo: &Topology, boundary: &[u32]) -> Vec<Vec3> {
    let n = boundary.len();
    (0..n)
        .map(|i| {
            let key = edge_key(boundary[i], boundary[(i + 1) % n]);
            match topo
                .edges
                .get(&key)
                .and_then(|info| info.directed.first().map(|&(_, _, f)| f))
            {
                Some(f) => unit_vec(mesh.tri_normal(f)),
                None => Vec3::ZERO,
            }
        })
        .collect()
}

fn unit_vec(v: Vec3) -> Vec3 {
    let len = v.length();
    if len > 1e-12 {
        v.scale(1.0 / len)
    } else {
        Vec3::ZERO
    }
}

fn mean(pts: &[Vec3]) -> Vec3 {
    if pts.is_empty() {
        return Vec3::ZERO;
    }
    pts.iter()
        .fold(Vec3::ZERO, |acc, p| acc.add(*p))
        .scale(1.0 / pts.len() as f32)
}

/// The area a closed loop encloses, as the magnitude of its vector area.
///
/// This is what says whether a ring is closing the hole. A perimeter does not: a hole that is a band
/// closes across its width first, which leaves its two long sides as long as they ever were.
fn loop_area(pts: &[Vec3]) -> f32 {
    let n = pts.len();
    if n < 3 {
        return 0.0;
    }
    let sum = (0..n).fold(Vec3::ZERO, |acc, i| {
        acc.add(pts[i].cross(pts[(i + 1) % n]))
    });
    sum.length() * 0.5
}

fn face_normal(mesh: &IndexedMesh, t: [u32; 3]) -> Vec3 {
    let a = mesh.positions[t[0] as usize];
    let b = mesh.positions[t[1] as usize];
    let c = mesh.positions[t[2] as usize];
    b.sub(a).cross(c.sub(a))
}

/// Cap a loop with a flat triangulation of its own vertices.
///
/// `topo` is the mesh the loop came from, when it came from one: a diagonal that is already an edge of
/// the mesh cannot be used, because the patch would then fold the surface onto itself. A loop the patch
/// itself made has no such edges and passes `None`.
fn flat_cap(mesh: &mut IndexedMesh, topo: Option<&Topology>, lp: &[u32]) -> usize {
    let n = lp.len();
    if n < 3 {
        return 0;
    }
    let pts: Vec<[f64; 3]> = lp.iter().map(|&v| d3(mesh.positions[v as usize])).collect();
    let diag = mesh.bbox().diag().max(1e-6) as f64;
    let sliver = 1e-12 * diag * diag;
    let penalty = 1e6 * diag * diag;

    let plan = if n <= MIN_AREA_DP_MAX_LOOP {
        let taken = match topo {
            Some(topo) => {
                let mut taken = vec![false; n * n];
                for i in 0..n {
                    for j in i + 2..n {
                        taken[i * n + j] =
                            !(i == 0 && j == n - 1) && closed_edge(topo, edge_key(lp[i], lp[j]));
                    }
                }
                taken
            }
            None => vec![false; n * n],
        };
        // Area alone first, because that is the plan every other model in the corpus was measured with.
        // It is only when that plan comes out *fan-shaped* — one vertex carrying a large share of the loop's
        // triangles — that the minimum-weight objective is asked for, and it is what turns a band into a
        // strip. Asking for it always changes the plans of loops that were already fine, and that is a
        // regression on a model whose rims are not bands at all.
        match min_area_triangulation(&pts, &taken, sliver, penalty, 0.0) {
            Some(plan) if !fan_shaped(&plan, n) => Some(plan),
            _ => min_area_triangulation(&pts, &taken, sliver, penalty, diag),
        }
    } else {
        None
    };
    if let Some(tris) = plan {
        let added = tris.len();
        for [i, j, k] in tris {
            mesh.triangles.push([lp[i], lp[j], lp[k]]);
        }
        return added;
    }

    // The zipper: the loop's two sides welded to each other.
    //
    // This is the closure the reference's own hole filler names when it logs `welding holes %d and %d` — two
    // loops joined to each other — and for a break-through it is the only closure that is right. Such a rim
    // is a wide band: its two long sides face each other across the opening, and the surface that belongs
    // there is the strip between them. Every cap over it is wrong in the same way: a fan from a centre vertex
    // (which is what this function used to fall back to) puts every triangle of the closure on one point,
    // measured at 899 faces on the reported model where the input's worst vertex carries 135, and that fan is
    // what a viewer shows as stray triangles.
    //
    // A minimum-area triangulation of a band *is* the strip across it, so the plan above is used when it can
    // be built. This is for the loops it cannot: past `MIN_AREA_DP_MAX_LOOP` edges it is not attempted at
    // all, and a rim that does not project to a simple polygon has no plan either.
    if let Some(zipped) = zip_loop_sides(&pts, lp, topo) {
        let added = zipped.len();
        mesh.triangles.extend_from_slice(&zipped);
        return added;
    }

    // Last resort, for a loop whose sides cannot be paired at all.
    let centre_pt = mean(&pts.iter().map(|p| Vec3::new(p[0] as f32, p[1] as f32, p[2] as f32)).collect::<Vec<_>>());
    mesh.positions.push(centre_pt);
    let centre = (mesh.positions.len() - 1) as u32;
    for i in 0..n {
        mesh.triangles.push([lp[i], lp[(i + 1) % n], centre]);
    }
    n
}

/// Close a loop by welding its two sides to each other.
///
/// The loop is split at its own narrowest crossing — the closest pair of vertices that are not neighbours —
/// which for a band is the opening's width and for a round hole is any diameter. That leaves two arcs, the
/// two sides, and they are stitched to each other the way a zip closes: at each step the side whose next
/// vertex is nearer the other side advances, and one triangle is emitted for the step. Every vertex of the
/// loop ends up used by two or three of the strip's triangles rather than all of them, which is what keeps
/// the closure from becoming a fan.
///
/// `None` for a loop with fewer than four vertices, which is already a triangle.
fn zip_loop_sides(pts: &[[f64; 3]], lp: &[u32], topo: Option<&Topology>) -> Option<Vec<[u32; 3]>> {
    let n = pts.len();
    if n < 4 || lp.len() != n {
        return None;
    }
    let d2 = |a: [f64; 3], b: [f64; 3]| -> f64 {
        let (x, y, z) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        x * x + y * y + z * z
    };
    // The narrowest crossing, and it has to leave both sides a real length.
    //
    // The closest non-adjacent pair on its own is a trap: on a long rim the two nearest vertices are often
    // two apart, so the split leaves one side with two vertices and the other with the rest, and the zip
    // between them degenerates into exactly the fan it was written to replace — measured on the reported
    // model, a 958-edge rim zipped as 958 triangles with one vertex in most of them. The band's width is
    // between vertices about *half the loop apart*, so each side is required to hold a quarter of it.
    let quarter = (n / 4).max(1);
    let mut best: Option<(f64, usize, usize)> = None;
    for i in 0..n {
        for j in (i + 1)..n {
            if j == i + 1 || (i == 0 && j == n - 1) {
                continue;
            }
            let (arc_a, arc_b) = (j - i, n - (j - i));
            if arc_a < quarter || arc_b < quarter {
                continue;
            }
            let d = d2(pts[i], pts[j]);
            if best.as_ref().map_or(true, |(bd, _, _)| d < *bd) {
                best = Some((d, i, j));
            }
        }
    }
    // Nothing balanced and close: any crossing is better than none, so fall back to the closest pair.
    if best.is_none() {
        for i in 0..n {
            for j in (i + 2)..n.min(i + n - 1) {
                let d = d2(pts[i], pts[j]);
                if best.as_ref().map_or(true, |(bd, _, _)| d < *bd) {
                    best = Some((d, i, j));
                }
            }
        }
    }
    let (_, i0, j0) = best?;
    // The two sides, both walked from the crossing back to it, in opposite senses along the loop.
    let side_a: Vec<usize> = (i0..=j0).collect();
    let mut side_b: Vec<usize> = (j0..n).chain(0..=i0).collect();
    side_b.reverse();
    if side_a.len() < 2 || side_b.len() < 2 {
        return None;
    }
    let mut out: Vec<[u32; 3]> = Vec::with_capacity(n - 2);
    let (mut p, mut q) = (0usize, 0usize);
    let (na, nb) = (side_a.len(), side_b.len());
    while p + 1 < na || q + 1 < nb {
        // Advance the side that is *behind*, not the side whose next vertex is nearer.
        //
        // The nearer-vertex rule is what a zip does and it is right for a band whose sides face each other,
        // but it has no bound: where the two sides run far apart, one of them is nearer at every step, so it
        // advances alone and the strip becomes a fan — measured on the reported model, a 958-edge rim zipped
        // with one vertex in 286 of its 958 triangles. Progress has no such failure mode: each side advances
        // in proportion to its length, so the strip stays a strip whatever shape the loop is, and every
        // vertex of the loop ends up in two or three of its triangles.
        // Both sides exhausted: the strip ends here. The rule that decides which side advances is applied
        // below, where each side is asked about its rung first.
        if !(p + 1 < na) && !(q + 1 < nb) {
            break;
        }
        // A rung that is *already an edge of the mesh* cannot be used: the strip would fold the surface onto
        // itself and leave an edge with three faces. This is the check the minimum-area plan makes before it
        // starts, and the zip needs it too — measured, a supported model came out of a zip with one
        // non-manifold edge and two pinched vertices without it.
        let taken = |a: u32, b: u32| -> bool {
            topo.map_or(false, |t| closed_edge(t, edge_key(a, b)))
        };
        // Both sides can run out at different times, and the side that is ahead is not asked about its rung:
        // reading `side_b[q + 1]` past the end is a panic, and it is reachable — a loop whose sides differ in
        // length by one hits it as soon as one of them is exhausted.
        let can_a = p + 1 < na && !taken(lp[side_a[p]], lp[side_b[q]]);
        let can_b = q + 1 < nb && !taken(lp[side_a[p]], lp[side_b[q + 1]]);
        let advance_a = match (can_a, can_b) {
            (true, false) => true,
            (false, true) => false,
            _ => (p + 1) as f64 * nb as f64 <= (q + 1) as f64 * na as f64,
        };
        if advance_a && p + 1 < na {
            out.push([lp[side_a[p]], lp[side_a[p + 1]], lp[side_b[q]]]);
            p += 1;
        } else if q + 1 < nb {
            out.push([lp[side_a[p]], lp[side_b[q]], lp[side_b[q + 1]]]);
            q += 1;
        } else {
            break;
        }
    }
    if out.is_empty() {
        return None;
    }
    // Only a *band* is zipped. The zip's rungs are what closes the opening, and on a band they are the
    // band's width — short, and each one lands on the surface the rim already runs along. On a rim that is
    // not a band they reach across the model, and a strip of long rungs folds onto surfaces it does not
    // belong to: measured, a supported model came out with a non-manifold edge and two pinched vertices.
    // A long-runged loop is left to the minimum-area plan, which refuses chords the mesh already has, and
    // to the caller's fallback.
    let diameter = {
        let mut d = 0.0f64;
        for i in 0..n {
            for j in (i + 1)..n {
                d = d.max(d2(pts[i], pts[j]));
            }
        }
        d.sqrt()
    };
    let mut longest_rung = 0.0f64;
    for t in &out {
        // The rung is the edge whose two ends are not neighbours on the loop.
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let (ia, ib) = (
                lp.iter().position(|&v| v == a).unwrap_or(0),
                lp.iter().position(|&v| v == b).unwrap_or(0),
            );
            let gap = (ia as isize - ib as isize).abs() as usize;
            if gap > 1 && gap < n - 1 {
                longest_rung = longest_rung.max(len3(sub(pts[ia], pts[ib])));
            }
        }
    }
    if diameter > 0.0 && longest_rung > 0.25 * diameter {
        return None;
    }
    // The strip has to be a strip: every edge of it either borders the rim (one triangle) or is shared by
    // exactly two of its triangles. A rung the zip visits twice — which it can, when one side stalls — gives
    // an edge three of them, and that is a non-manifold edge the caller would have to live with. Measured, a
    // supported model came out of a zip with one. Refusing here leaves the loop to the plan and the caller's
    // fallback, which is where it would have gone without the zip at all.
    let mut uses: ahash::AHashMap<(u32, u32), u32> = ahash::AHashMap::new();
    for t in &out {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *uses.entry(edge_key(a, b)).or_insert(0) += 1;
        }
    }
    if uses.values().any(|&c| c > 2) {
        return None;
    }
    Some(out)
}

/// Loops at or above this many edges get the tangent-continuing patch instead of a flat cap.
///
/// A flat cap is right for a small hole in a surface that is locally flat, which is what the trivial
/// pass deals in. A break-through is neither small nor flat.
const PATCH_MIN_LOOP: usize = 7;

/// How far in each ring of the patch sits, as a fraction of the local loop edge length.
///
/// Too small and a ring is too close to the one before it for its tangent planes to matter; too large
/// and a ring turns faster than the surface beneath it does. Six tenths of an edge insets a loop in a
/// handful of rings: a twenty-edge loop is under the flat-cap threshold in three.
const PATCH_INSET_FRACTION: f32 = 0.6;

/// The largest a ring's inset may be, as a share of the narrowest edge on the loop it comes from.
///
/// Without a bound, a ring from a hole that is a band crosses the band's own far side in a single pass
/// and every face after it is nonsense.
const PATCH_MAX_INSET_SHARE: f32 = 0.4;

/// A ring has to shrink the loop by this share of its perimeter to be worth keeping.
///
/// A hole that is a band closes across its width in a ring or two and then has nothing left to give;
/// carrying on folds the ring over itself.
const PATCH_MIN_SHRINK: f32 = 0.95;

/// How many rings the patch may grow before it caps whatever is left.
const PATCH_MAX_RINGS: usize = 12;

/// Fill one loop with a patch that leaves the rim along the surface it belongs to.
///
/// A flat triangulation of the loop's own vertices is what this engine did, and it is right when the
/// rim lies in the surface around it. Where the rim is a break-through — a sheet meeting a wall, or a
/// cavity that broke through the outer wall — the surrounding surface is not flat there, and the flat
/// patch is a visible sheet spanning the opening, which is the first thing an eye finds in a repair.
/// Measured against a reference repair of a model with an internal cavity that breaks through its outer
/// wall, the reference's patch continues that surface and ours was a flat.
///
/// The patch is grown in rings. Each ring's vertices sit **in the plane of the surface at the ring
/// before it**, a fraction of the local edge length inward, so every ring leaves the one it came from
/// tangentially; each ring's own surface then becomes the plane the next ring follows, which is the
/// discrete form of continuing the surface. When the loop is small enough for a flat cap to be right,
/// it is capped. On a cylinder this walks the patch around the wall ring by ring and converges on the
/// wall; on a flat wall every plane is that wall's, so the patch is flat — a generalisation of the flat
/// cap, not a replacement for it.
///
/// The rim's own vertices are never moved and no rim edge is split. That is the mistake an earlier
/// attempt at this made: it subdivided the patch in place, so it split the rim edges the model shares
/// and left a T-junction on every one of them.
fn fill_loop_with_patch(mesh: &mut IndexedMesh, topo: &Topology, lp: &[u32]) -> usize {
    let mut boundary: Vec<u32> = lp.to_vec();
    let mut edge_normal = loop_edge_normals(mesh, topo, &boundary);
    let mut added = 0usize;

    for _ in 0..PATCH_MAX_RINGS {
        let n = boundary.len();
        if n < PATCH_MIN_LOOP {
            break;
        }
        let rim: Vec<Vec3> = boundary.iter().map(|&v| mesh.positions[v as usize]).collect();
        let centroid = mean(&rim);
        // The narrowest edge on the loop. An inset larger than a fraction of it turns the ring inside
        // out: a hole that is a band closes across its width first, and a ring that crossed its own
        // opposite side makes every face after it nonsense. Measured on a band spanning half a
        // cylinder's circumference, an unbounded inset of up to 2.4 units across a band 1.0 unit wide
        // collapsed the ring in one pass and the cap then spanned the whole hole.
        let narrowest = (0..n)
            .map(|i| {
                rim[i]
                    .sub(rim[(i + 1) % n])
                    .length()
                    .min(rim[i].sub(rim[(i + n - 1) % n]).length())
            })
            .fold(f32::INFINITY, f32::min)
            .max(1e-9);
        let area_before = loop_area(&rim);

        let mut ring: Vec<Vec3> = Vec::with_capacity(n);
        let mut inset = 0.0f32;
        // Every vertex's inset direction first, then **one** sign for all of them.
        //
        // The direction into the hole is perpendicular to the rim and in the surface at it, and the
        // cross product of those two gives it up to a sign. Taking that sign per vertex was the bug an
        // earlier attempt had: at a corner of the loop the loop's centre is nearly perpendicular to the
        // inset, so the test is a coin toss there, and one vertex landing the other way puts a sliver
        // across the whole hole. The loop is wound one way round, so the sign is one property of the
        // loop and is decided once, from which way the centre lies on average.
        let mut inward: Vec<Vec3> = Vec::with_capacity(n);
        let mut toward_centre = 0.0f32;
        for i in 0..n {
            let p = rim[i];
            let normal = unit_vec(edge_normal[i].add(edge_normal[(i + n - 1) % n]));
            let along = unit_vec(rim[(i + 1) % n].sub(rim[(i + n - 1) % n]));
            let direction = unit_vec(normal.cross(along));
            toward_centre += direction.dot(centroid.sub(p));
            inward.push(direction);
        }
        let flip = toward_centre < 0.0;

        for i in 0..n {
            let p = rim[i];
            let local = rim[i]
                .sub(rim[(i + n - 1) % n])
                .length()
                .min(rim[i].sub(rim[(i + 1) % n]).length())
                .max(1e-9);
            let direction = inward[i];
            if direction.length() <= 0.5 {
                // No surface here to continue, so this vertex stays where it is.
                ring.push(p);
                continue;
            }
            let direction = if flip { direction.scale(-1.0) } else { direction };
            let step = (PATCH_INSET_FRACTION * local).min(PATCH_MAX_INSET_SHARE * narrowest);
            inset += step;
            ring.push(p.add(direction.scale(step)));
        }
        if inset <= 0.0 {
            // Nothing moved anywhere, so there is no surface here to continue: cap it flat.
            break;
        }
        // The ring has to have proved it is closing the hole *before* it is kept. The loop has to be
        // closing, and area is the measure that sees it: a perimeter does not, because a hole that is a
        // band closes across its width first and leaves its two long sides as long as they ever were.
        // Measured on a band spanning half a cylinder's circumference, one more ring after the loop's
        // area reached zero inverted it, and having committed that ring the cap over it spanned the
        // hole at a third of the wall's radius.
        //
        // An open end is the case this rejects: the loop at the end of an open tube has the tube's side
        // as its surface, the direction into the hole there is along the tube, and a ring placed on it
        // walks off the end of the model with the loop's area unchanged.
        if loop_area(&ring) > area_before * PATCH_MIN_SHRINK {
            break;
        }

        let base = mesh.positions.len() as u32;
        for p in &ring {
            mesh.positions.push(*p);
        }
        for i in 0..n {
            let j = (i + 1) % n;
            // The two faces between one rim edge and the ring edge inside it.
            mesh.triangles.push([boundary[i], boundary[j], base + j as u32]);
            mesh.triangles.push([boundary[i], base + j as u32, base + i as u32]);
            added += 2;
        }

        let mut next_normal = Vec::with_capacity(n);
        for i in 0..n {
            let j = (i + 1) % n;
            next_normal.push(unit_vec(face_normal(
                mesh,
                [boundary[i], base + j as u32, base + i as u32],
            )));
        }
        boundary = (0..n).map(|i| base + i as u32).collect();
        edge_normal = next_normal;
    }

    added + flat_cap(mesh, None, &boundary)
}

pub fn fill_holes_oriented(mesh: &mut IndexedMesh, max_edges: usize) -> usize {
    let topo = Topology::build(mesh);
    // Reversed: `boundary_loops` walks *with* the faces' winding, and the fill wants the cycle the other
    // way round so that the triangles it adds face outwards. The walk it replaced produced the reversed
    // order, which is why this is a reversal rather than a preference.
    let loops: Vec<Vec<u32>> = topo
        .boundary_loops()
        .into_iter()
        .map(|l| l.into_iter().rev().collect())
        .collect();
    let mut added = 0usize;
    for lp in loops
        .into_iter()
        .filter(|l| l.len() >= 3 && l.len() <= max_edges)
    {
        // A hole big enough to be a break-through gets a patch that follows the surface. A small one
        // gets the flat cap, which is what a flat cap is for: a hole of a few edges in a surface that
        // is locally flat is capped correctly by triangulating it.
        added += if lp.len() >= PATCH_MIN_LOOP {
            fill_loop_with_patch(mesh, &topo, &lp)
        } else {
            flat_cap(mesh, Some(&topo), &lp)
        };
    }
    added
}

/// The component pairs whose surfaces actually cross, by triangle, rather than whose boxes overlap.
///
/// This is the test the union's operand rule needed. It used to be "the bounding boxes overlap",
/// with the note that a shared box may still be a disjoint pair, so the rule was conservative in the
/// safe direction. It is not: a plate of parts laid out side by side — which is what a print plate
/// is, and what `Untitled2.stl` in the corpus is, 25 parts of them — shares one bounding box across
/// most of its pairs (measured on that file: 266 of 406), and `Manifold::batch_union` answers a set
/// of separate solids with the union of them, which is one part where the user had dozens. The stage
/// would then be *kept*, because its acceptance test is a falling part count.
///
/// A pair is an operand here when a triangle of one crosses a triangle of the other. Components that
/// meet only at a vertex are left out: that is a pinch, and `split_pinched_vertices` owns it.
/// Components that merely nest are left out too — their surfaces do not cross, and a union of a
/// solid with a cavity would fill the cavity.
///
/// The walk is the one `arrangement::collect_face_segments` does, with the pair recorded instead of
/// the segment: every triangle asks the BVH for its neighbours and tests the ones it has not already
/// answered for.
pub fn crossing_component_pairs(mesh: &IndexedMesh, components: &[u32]) -> AHashSet<(u32, u32)> {
    let n = mesh.triangles.len();
    let mut pairs: AHashSet<(u32, u32)> = AHashSet::new();
    if n < 2 {
        return pairs;
    }
    let bvh = Bvh::build(mesh);
    for fi in 0..n as u32 {
        let tri_a = mesh.tri_positions(fi);
        let mut bb = Aabb::empty();
        bb.expand(tri_a[0]);
        bb.expand(tri_a[1]);
        bb.expand(tri_a[2]);
        let ca = components[fi as usize];
        let va = mesh.triangles[fi as usize];
        let mut candidates: Vec<u32> = Vec::new();
        bvh.query_aabb(mesh, &bb, |other| candidates.push(other));
        for fj in candidates {
            if fj <= fi {
                continue;
            }
            let cb = components[fj as usize];
            if cb == ca {
                continue;
            }
            let key = (ca.min(cb), ca.max(cb));
            if pairs.contains(&key) {
                continue;
            }
            let vb = mesh.triangles[fj as usize];
            if va.iter().any(|v| vb.contains(v)) {
                continue; // they meet at a vertex: a pinch, not a crossing
            }
            if crate::arrangement::tri_tri_segment(tri_a, mesh.tri_positions(fj)).is_some() {
                pairs.insert(key);
            }
        }
    }
    pairs
}

#[cfg(feature = "manifold")]
pub fn union_closed_components(mesh: &mut IndexedMesh, components: &[u32]) -> Option<(usize, usize, usize)> {
    use manifold_csg::Manifold;

    let n_comps = components.iter().copied().max().map_or(0, |m| m as usize + 1);
    let mut by_comp: Vec<Vec<[u32; 3]>> = vec![Vec::new(); n_comps];
    for (fi, tri) in mesh.triangles.iter().enumerate() {
        by_comp[components[fi] as usize].push(*tri);
    }
    // The boolean needs its input welded at *exact* positions: two surfaces that touch where their vertices
    // are merely close read to it as separate shells, and it returns them fragmented instead of merged.
    // Measured on the reported model, that is why the union there comes out of 8 parts as 12 with its bad
    // edges 2,157 -> 5,567 and is refused. So each component is welded at the loader's own cell first —
    // component by component, so nothing outside the union's input is re-indexed.
    let weld_cell = (crate::io::DEFAULT_MERGE_EPSILON * mesh.bbox().diag().max(1e-6)).max(1e-7);
    let mut solids: Vec<(u32, Manifold)> = Vec::new();
    let mut kept: Vec<[u32; 3]> = Vec::new();
    for (ci, tris) in by_comp.into_iter().enumerate() {
        let mut remap: AHashMap<(i32, i32, i32), u32> = AHashMap::new();
        let mut vp: Vec<f32> = Vec::new();
        let mut idx: Vec<u32> = Vec::with_capacity(tris.len() * 3);
        for tri in &tris {
            for &v in tri {
                let p = mesh.positions[v as usize];
                let key = (
                    (p.x / weld_cell).round() as i32,
                    (p.y / weld_cell).round() as i32,
                    (p.z / weld_cell).round() as i32,
                );
                let next = remap.len() as u32;
                let id = *remap.entry(key).or_insert_with(|| {
                    vp.extend_from_slice(&[p.x, p.y, p.z]);
                    next
                });
                idx.push(id);
            }
        }
        match Manifold::from_mesh_f32(&vp, 3, &idx) {
            Ok(m) if !m.is_empty() && m.num_tri() > 0 => solids.push((ci as u32, m)),
            _ => kept.extend_from_slice(&tris),
        }
    }
    if solids.len() < 2 {
        // Nothing to union, and the count of separate solids is still worth reporting: it is one or
        // none at this point.
        return Some((0, 0, solids.len()));
    }
    // Only operands that actually cross each other go to the boolean.
    //
    // A boolean is for overlapping operands; feeding it a set of disjoint solids asks it to return them
    // unchanged, and it answers with *more* shells than it was given — measured on the reported model, 7
    // solids in and 12 shells out, which is why the union there is refused: the part count is one of the
    // classes it is judged on, and it can only be kept when it drops.
    //
    // The rule used to be "the bounding boxes overlap", on the reasoning that a shared box may still be
    // a disjoint pair, so the rule erred in the safe direction. It does not: on a plate of separate
    // parts the boxes of most pairs overlap (266 of 406 on the reported plate), so that rule hands the
    // boolean *everything* and the pass merges the user's parts into one — and is kept for it, because
    // the acceptance test is a falling part count. What decides an operand now is surface contact:
    // `crossing_component_pairs` below.
    let crossing = crossing_component_pairs(mesh, components);
    // How many distinct solids are in some crossing pair, and how many are in none: the latter are
    // the separate parts of a plate, and saying so is the point of the rule.
    let mut meeting: AHashSet<u32> = AHashSet::new();
    for (a, b) in crossing.iter() {
        meeting.insert(*a);
        meeting.insert(*b);
    }
    let solid_ids: AHashSet<u32> = solids.iter().map(|(ci, _)| *ci).collect();
    let separate = solid_ids.iter().filter(|ci| !meeting.contains(ci)).count();
    let touching: Vec<usize> = (0..solids.len())
        .filter(|&i| meeting.contains(&solids[i].0))
        .collect();
    if touching.len() < 2 {
        // Several solids, none of them meeting: a plate of parts, and the boolean has no operands.
        // This is the answer the caller needs — the old rule would have unioned every one of them.
        return Some((0, 0, separate));
    }
    let operand_index: AHashMap<usize, usize> =
        touching.iter().enumerate().map(|(k, &i)| (i, k)).collect();
    let unioned = touching.len();
    let operands: Vec<Manifold> = touching.iter().map(|&i| solids[i].1.clone()).collect();
    let m = Manifold::batch_union(&operands);
    if m.is_empty() || m.num_tri() < 4 {
        return None;
    }
    for (i, (_, m)) in solids.iter().enumerate() {
        if !operand_index.contains_key(&i) {
            let (vp, np, ti) = m.to_mesh_f32();
            let base = mesh.positions.len() as u32;
            for c in vp.chunks_exact(np) {
                mesh.positions.push(Vec3::new(c[0], c[1], c[2]));
            }
            for c in ti.chunks_exact(3) {
                kept.push([c[0] + base, c[1] + base, c[2] + base]);
            }
        }
    }
    let (vp, np, ti) = m.to_mesh_f32();
    let base = mesh.positions.len() as u32;
    let mut positions = mesh.positions.clone();
    positions.extend(vp.chunks_exact(np).map(|c| Vec3::new(c[0], c[1], c[2])));
    let mut triangles = kept;
    let kept_tris = triangles.len();
    triangles.extend(ti.chunks_exact(3).map(|c| [c[0] + base, c[1] + base, c[2] + base]));
    mesh.positions = positions;
    mesh.triangles = triangles;
    Some((unioned, kept_tris, separate))
}

/// Split vertices whose incident triangles form more than one fan.
///
/// A pinch is a vertex where two sheets of a surface meet at a single point. Every edge is still
/// shared by exactly two faces, so none of the defect counters see anything, but the surface is not
/// a manifold *at that vertex* — and a pinch can leave it combinatorially non-orientable, or leave a
/// boundary loop that is not a simple cycle and therefore unfillable.
///
/// Two callers need it. Marching tetrahedra pinches the surface at every crease in its field:
/// measured on a cube, 2,400 edges had no winding assignment that satisfies them all, on a surface
/// that is geometrically a cube. And a non-manifold split exposes rims that meet at a point, which
/// the hole pass skips by design — measured on the corbu model, six loops holding 1,332 boundary
/// edges that no cap would have filled because they are not simple cycles.
///
/// One copy of the vertex per fan removes the pinch.
pub(crate) fn split_pinched_vertices(mesh: &mut IndexedMesh) -> usize {
    let nv = mesh.positions.len();
    let mut incident: Vec<Vec<u32>> = vec![Vec::new(); nv];
    for (f, t) in mesh.triangles.iter().enumerate() {
        for &v in t.iter() {
            incident[v as usize].push(f as u32);
        }
    }
    let mut splits = 0usize;
    for v in 0..nv {
        if incident[v].len() < 2 {
            continue;
        }
        // Which faces meet at each of this vertex's two edges within a face. Two faces in the same
        // fan share one of those edges; two in different fans share nothing.
        let mut edge_faces: ahash::AHashMap<(u32, u32), Vec<u32>> = ahash::AHashMap::new();
        for &f in &incident[v] {
            let t = mesh.triangles[f as usize];
            let Some(k) = t.iter().position(|&x| x == v as u32) else {
                continue;
            };
            for other in [t[(k + 1) % 3], t[(k + 2) % 3]] {
                let key = if (v as u32) < other {
                    (v as u32, other)
                } else {
                    (other, v as u32)
                };
                edge_faces.entry(key).or_default().push(f);
            }
        }
        let mut fan_of: ahash::AHashMap<u32, u32> = ahash::AHashMap::new();
        let mut fans: Vec<Vec<u32>> = Vec::new();
        for &seed in &incident[v] {
            if fan_of.contains_key(&seed) {
                continue;
            }
            let id = fans.len() as u32;
            let mut stack = vec![seed];
            let mut fan = Vec::new();
            while let Some(f) = stack.pop() {
                if fan_of.insert(f, id).is_some() {
                    continue;
                }
                fan.push(f);
                let t = mesh.triangles[f as usize];
                let Some(k) = t.iter().position(|&x| x == v as u32) else {
                    continue;
                };
                for other in [t[(k + 1) % 3], t[(k + 2) % 3]] {
                    let key = if (v as u32) < other {
                        (v as u32, other)
                    } else {
                        (other, v as u32)
                    };
                    if let Some(neighbours) = edge_faces.get(&key) {
                        for &g in neighbours {
                            if !fan_of.contains_key(&g) {
                                stack.push(g);
                            }
                        }
                    }
                }
            }
            fans.push(fan);
        }
        // The first fan keeps the vertex; every other fan gets a copy of it.
        for fan in fans.iter().skip(1) {
            let copy = mesh.positions.len() as u32;
            mesh.positions.push(mesh.positions[v]);
            splits += 1;
            for &f in fan {
                let t = &mut mesh.triangles[f as usize];
                for slot in t.iter_mut() {
                    if *slot == v as u32 {
                        *slot = copy;
                    }
                }
            }
        }
    }
    splits
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn unit(a: [f64; 3]) -> Option<[f64; 3]> {
    let l = dot(a, a).sqrt();
    (l > 1e-300).then(|| [a[0] / l, a[1] / l, a[2] / l])
}

/// Pairs the faces around an edge used by more than two, sorted by angle about
/// it: two neighbours are paired when the wedge between them is solid, i.e.
/// both normals point away from it and they cross the edge in opposite
/// directions. Faces left unpaired are sheets ending on the edge.
fn pair_around_edge(mesh: &IndexedMesh, p: u32, q: u32, faces: &[u32]) -> Vec<(u32, u32)> {
    let a = d3(mesh.positions[p as usize]);
    let Some(d) = unit(sub(d3(mesh.positions[q as usize]), a)) else { return Vec::new() };
    let seed = if d[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let Some(u) = unit(cross3(d, seed)) else { return Vec::new() };
    let w = cross3(d, u);
    let mut around: Vec<(f64, u32, bool, bool)> = Vec::with_capacity(faces.len());
    for &fi in faces {
        let t = mesh.triangles[fi as usize];
        let Some(&c) = t.iter().find(|&&x| x != p && x != q) else { continue };
        let r = sub(d3(mesh.positions[c as usize]), a);
        let s = dot(r, d);
        let r = [r[0] - d[0] * s, r[1] - d[1] * s, r[2] - d[2] * s];
        let [x, y, z] = t.map(|v| d3(mesh.positions[v as usize]));
        let normal = cross3(sub(y, x), sub(z, x));
        let ccw = dot(normal, cross3(d, r)) > 0.0;
        let forward = (0..3).any(|i| t[i] == p && t[(i + 1) % 3] == q);
        around.push((dot(r, w).atan2(dot(r, u)), fi, ccw, forward));
    }
    around.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)));
    let k = around.len();
    let mut used = vec![false; k];
    let mut pairs = Vec::new();
    for i in 0..k {
        let j = (i + 1) % k;
        if i == j || used[i] || used[j] {
            continue;
        }
        let (_, fi, ccw_i, fwd_i) = around[i];
        let (_, fj, ccw_j, fwd_j) = around[j];
        if !ccw_i && ccw_j && fwd_i != fwd_j {
            used[i] = true;
            used[j] = true;
            pairs.push((fi, fj));
        }
    }
    pairs
}

/// Gives every surface meeting at a non-manifold edge its own copy of the
/// edge's vertices, then moves each copy `offset` into its own solid so a weld
/// by position cannot merge them back. Returns the number of vertices added.
pub fn split_non_manifold_edges(mesh: &mut IndexedMesh, offset: f32) -> usize {
    let mut edge_faces: AHashMap<(u32, u32), Vec<u32>> =
        AHashMap::with_capacity(mesh.triangles.len() * 3 / 2);
    for (fi, t) in mesh.triangles.iter().enumerate() {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            edge_faces.entry(edge_key(a, b)).or_default().push(fi as u32);
        }
    }
    let mut links: AHashMap<(u32, u32), Vec<(u32, u32)>> = AHashMap::new();
    let mut verts: Vec<u32> = Vec::new();
    for (&(p, q), faces) in &edge_faces {
        if faces.len() > 2 {
            links.insert((p, q), pair_around_edge(mesh, p, q, faces));
            verts.push(p);
            verts.push(q);
        }
    }
    if verts.is_empty() {
        return 0;
    }
    verts.sort_unstable();
    verts.dedup();
    let index: AHashMap<u32, usize> = verts.iter().enumerate().map(|(i, &v)| (v, i)).collect();
    let mut incident: Vec<Vec<u32>> = vec![Vec::new(); verts.len()];
    for (fi, t) in mesh.triangles.iter().enumerate() {
        for &v in t {
            if let Some(&i) = index.get(&v) {
                incident[i].push(fi as u32);
            }
        }
    }

    let normal_of = |mesh: &IndexedMesh, fi: u32| {
        let [x, y, z] = mesh.triangles[fi as usize].map(|v| d3(mesh.positions[v as usize]));
        cross3(sub(y, x), sub(z, x))
    };
    let mut moves: Vec<(u32, [f64; 3])> = Vec::new();
    let mut added = 0usize;
    for (i, &v) in verts.iter().enumerate() {
        let fs = &incident[i];
        let local: AHashMap<u32, u32> = fs.iter().enumerate().map(|(k, &f)| (f, k as u32)).collect();
        let mut parent: Vec<u32> = (0..fs.len() as u32).collect();
        for &f in fs {
            let t = mesh.triangles[f as usize];
            for &o in t.iter().filter(|&&o| o != v) {
                let e = edge_key(v, o);
                let joined: Vec<(u32, u32)> = match edge_faces.get(&e) {
                    Some(ef) if ef.len() == 2 => vec![(ef[0], ef[1])],
                    Some(ef) if ef.len() > 2 => links.get(&e).cloned().unwrap_or_default(),
                    _ => Vec::new(),
                };
                for (x, y) in joined {
                    if let (Some(&lx), Some(&ly)) = (local.get(&x), local.get(&y)) {
                        let (rx, ry) = (find(&mut parent, lx), find(&mut parent, ly));
                        if rx != ry {
                            parent[rx.max(ry) as usize] = rx.min(ry);
                        }
                    }
                }
            }
        }
        let mut groups: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for (k, &f) in fs.iter().enumerate() {
            groups.entry(find(&mut parent, k as u32)).or_default().push(f);
        }
        if groups.len() < 2 {
            continue;
        }
        for (g, members) in groups.values().enumerate() {
            let mut n = [0.0f64; 3];
            for &f in members {
                let fnrm = normal_of(mesh, f);
                n = [n[0] + fnrm[0], n[1] + fnrm[1], n[2] + fnrm[2]];
            }
            let target = if g == 0 {
                v
            } else {
                mesh.positions.push(mesh.positions[v as usize]);
                added += 1;
                let nv = (mesh.positions.len() - 1) as u32;
                for &f in members {
                    for x in mesh.triangles[f as usize].iter_mut() {
                        if *x == v {
                            *x = nv;
                        }
                    }
                }
                nv
            };
            if let Some(n) = unit(n) {
                moves.push((target, n));
            }
        }
    }
    let off = offset as f64;
    for (v, n) in moves {
        let p = &mut mesh.positions[v as usize];
        *p = Vec3::new(
            (p.x as f64 - n[0] * off) as f32,
            (p.y as f64 - n[1] * off) as f32,
            (p.z as f64 - n[2] * off) as f32,
        );
    }
    added
}

/// Removes open shells of fewer than `max_faces` faces. Splitting leaves stray
/// faces like these, and their borders tangle with the rims the fill must close.
pub fn remove_open_fragments(mesh: &mut IndexedMesh, max_faces: usize) -> usize {
    let n = mesh.triangles.len();
    let mut edge_faces: AHashMap<(u32, u32), Vec<u32>> = AHashMap::with_capacity(n * 3 / 2);
    for (fi, t) in mesh.triangles.iter().enumerate() {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            edge_faces.entry(edge_key(a, b)).or_default().push(fi as u32);
        }
    }
    let mut parent: Vec<u32> = (0..n as u32).collect();
    for fs in edge_faces.values() {
        if fs.len() == 2 {
            let (a, b) = (find(&mut parent, fs[0]), find(&mut parent, fs[1]));
            if a != b {
                parent[a.max(b) as usize] = a.min(b);
            }
        }
    }
    let roots: Vec<u32> = (0..n as u32).map(|f| find(&mut parent, f)).collect();
    let mut size: AHashMap<u32, usize> = AHashMap::new();
    for &r in &roots {
        *size.entry(r).or_insert(0) += 1;
    }
    let mut open: AHashSet<u32> = AHashSet::new();
    for fs in edge_faces.values() {
        if fs.len() == 1 {
            open.insert(roots[fs[0] as usize]);
        }
    }
    let before = mesh.triangles.len();
    let mut i = 0;
    mesh.triangles.retain(|_| {
        let r = roots[i];
        i += 1;
        !(open.contains(&r) && size[&r] < max_faces)
    });
    before - mesh.triangles.len()
}

/// Removes every face touching a spot no local rule can untangle, measured by
/// position: an edge with more than two faces, an edge whose two faces run the
/// same way, or a border vertex where borders do not enter and leave in equal
/// numbers, which no hole loop can pass through. Returns the faces removed.
pub fn excise_tangles(mesh: &mut IndexedMesh) -> usize {
    let ids = mesh.position_weld_ids();
    // (faces, faces running low id -> high id)
    let mut uses: AHashMap<(u32, u32), (u32, u32)> = AHashMap::with_capacity(mesh.triangles.len() * 3 / 2);
    for t in &mesh.triangles {
        let w = t.map(|v| ids[v as usize]);
        for (a, b) in [(w[0], w[1]), (w[1], w[2]), (w[2], w[0])] {
            if a != b {
                let e = uses.entry(edge_key(a, b)).or_insert((0, 0));
                e.0 += 1;
                e.1 += (a < b) as u32;
            }
        }
    }
    let mut hit: AHashSet<u32> = AHashSet::new();
    let mut balance: AHashMap<u32, i32> = AHashMap::new();
    for (&(a, b), &(n, low_to_high)) in &uses {
        if n > 2 || (n == 2 && low_to_high != 1) {
            hit.insert(a);
            hit.insert(b);
        } else if n == 1 {
            let (from, to) = if low_to_high == 1 { (a, b) } else { (b, a) };
            *balance.entry(from).or_insert(0) += 1;
            *balance.entry(to).or_insert(0) -= 1;
        }
    }
    hit.extend(balance.iter().filter(|(_, &d)| d != 0).map(|(&v, _)| v));
    if hit.is_empty() {
        return 0;
    }
    let before = mesh.triangles.len();
    mesh.triangles.retain(|t| !t.iter().any(|&v| hit.contains(&ids[v as usize])));
    mesh.weld_by_position();
    before - mesh.triangles.len()
}

/// Removes faces lying on the same three positions as another: pairs wound in
/// opposite directions are a wall of zero thickness and both go, and of faces
/// wound the same way one is kept.
pub fn remove_coincident_faces(mesh: &mut IndexedMesh) -> usize {
    let ids = mesh.position_weld_ids();
    let mut groups: AHashMap<[u32; 3], (Vec<usize>, Vec<usize>)> = AHashMap::new();
    for (fi, t) in mesh.triangles.iter().enumerate() {
        let w = t.map(|v| ids[v as usize]);
        if w[0] == w[1] || w[1] == w[2] || w[0] == w[2] {
            continue;
        }
        let r = (0..3).min_by_key(|&i| w[i]).unwrap();
        let rot = [w[r], w[(r + 1) % 3], w[(r + 2) % 3]];
        let (key, forward) = if rot[1] < rot[2] { (rot, true) } else { ([rot[0], rot[2], rot[1]], false) };
        let g = groups.entry(key).or_default();
        if forward { g.0.push(fi) } else { g.1.push(fi) }
    }
    let mut drop = vec![false; mesh.triangles.len()];
    let mut removed = 0usize;
    for (fwd, bwd) in groups.values() {
        let pairs = fwd.len().min(bwd.len());
        for (&a, &b) in fwd.iter().zip(bwd.iter()) {
            drop[a] = true;
            drop[b] = true;
            removed += 2;
        }
        for &f in fwd.iter().skip(pairs + 1).chain(bwd.iter().skip(pairs + 1)) {
            drop[f] = true;
            removed += 1;
        }
    }
    if removed > 0 {
        let mut i = 0;
        mesh.triangles.retain(|_| {
            i += 1;
            !drop[i - 1]
        });
    }
    removed
}

/// Removes collinear caps by flipping their longest edge, which keeps the surface closed.
pub fn flip_degenerate_caps(mesh: &mut IndexedMesh, area_eps: f32, max_rounds: usize) -> usize {
    let mut flips = 0usize;
    for _ in 0..max_rounds {
        let caps: Vec<u32> = (0..mesh.triangles.len() as u32)
            .filter(|&f| {
                let [a, b, c] = mesh.triangles[f as usize];
                a != b && b != c && a != c && mesh.tri_area(f) <= area_eps
            })
            .collect();
        if caps.is_empty() {
            break;
        }
        let topo = Topology::build(mesh);
        let mut touched: AHashSet<u32> = AHashSet::new();
        let mut round = 0usize;
        for f in caps {
            if touched.contains(&f) {
                continue;
            }
            let tri = mesh.triangles[f as usize];
            let p = [d3(mesh.positions[tri[0] as usize]), d3(mesh.positions[tri[1] as usize]), d3(mesh.positions[tri[2] as usize])];
            let len2 = |i: usize| {
                let d = sub(p[(i + 1) % 3], p[i]);
                dot(d, d)
            };
            let k = (0..3).max_by(|&x, &y| len2(x).total_cmp(&len2(y))).unwrap();
            let (u, v, c) = (tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]);
            let Some(info) = topo.edges.get(&edge_key(u, v)) else { continue };
            if info.faces.len() != 2 {
                continue;
            }
            let nb = if info.faces[0] == f { info.faces[1] } else { info.faces[0] };
            if touched.contains(&nb) {
                continue;
            }
            let ntri = mesh.triangles[nb as usize];
            let Some(&d) = ntri.iter().find(|&&x| x != u && x != v) else { continue };
            let consistent = (0..3).any(|i| ntri[i] == v && ntri[(i + 1) % 3] == u);
            if !consistent || c == d || topo.edges.contains_key(&edge_key(c, d)) {
                continue;
            }
            mesh.triangles[f as usize] = [c, u, d];
            mesh.triangles[nb as usize] = [v, c, d];
            touched.insert(f);
            touched.insert(nb);
            round += 1;
        }
        if round == 0 {
            break;
        }
        flips += round;
    }
    flips
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::mesh::IndexedMesh;

    fn v(x: f32, y: f32, z: f32) -> Vec3 {
        Vec3::new(x, y, z)
    }

    /// A closed box as twelve triangles, from `lo` to `hi`.
    fn box_mesh(lo: Vec3, hi: Vec3) -> (Vec<Vec3>, Vec<[u32; 3]>) {
        let p = [
            v(lo.x, lo.y, lo.z),
            v(hi.x, lo.y, lo.z),
            v(hi.x, hi.y, lo.z),
            v(lo.x, hi.y, lo.z),
            v(lo.x, lo.y, hi.z),
            v(hi.x, lo.y, hi.z),
            v(hi.x, hi.y, hi.z),
            v(lo.x, hi.y, hi.z),
        ];
        let quads: [[usize; 4]; 6] = [
            [0, 3, 2, 1],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [2, 3, 7, 6],
            [1, 2, 6, 5],
            [0, 4, 7, 3],
        ];
        let mut tris = Vec::new();
        for q in quads {
            tris.push([q[0] as u32, q[1] as u32, q[2] as u32]);
            tris.push([q[0] as u32, q[2] as u32, q[3] as u32]);
        }
        (p.to_vec(), tris)
    }

    /// Two solids at opposite corners of each other's bounding boxes are two parts, not one object.
    ///
    /// This is the plate: parts laid out side by side share one bounding box across most of their
    /// pairs, and a union that took "the boxes overlap" as its operand rule handed every one of them
    /// to the boolean, which answers a set of separate solids with the union of them. Two
    /// axis-aligned boxes cannot stand in for it — boxes that share a box on all three axes do
    /// intersect — so the fixture is two tetrahedra occupying opposite corners.
    #[test]
    fn solids_that_only_share_a_bounding_box_are_separate() {
        let near = [
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [0.0, 0.0, 2.0],
        ];
        let far = [
            [3.0, 3.0, 3.0],
            [1.0, 3.0, 3.0],
            [3.0, 1.0, 3.0],
            [3.0, 3.0, 1.0],
        ];
        let mut positions: Vec<Vec3> = Vec::new();
        let mut triangles: Vec<[u32; 3]> = Vec::new();
        for tet in [near, far] {
            let base = positions.len() as u32;
            positions.extend(tet.iter().map(|p| v(p[0], p[1], p[2])));
            for t in [
                [0u32, 2, 1],
                [0, 1, 3],
                [0, 3, 2],
                [1, 2, 3],
            ] {
                triangles.push([t[0] + base, t[1] + base, t[2] + base]);
            }
        }
        let mesh = IndexedMesh {
            positions,
            triangles,
        };
        let components = crate::repair::triangle_components(&mesh);
        assert_eq!(components.iter().copied().max().unwrap_or(0) + 1, 2);
        let crossing = crossing_component_pairs(&mesh, &components);
        assert!(
            crossing.is_empty(),
            "sharing a bounding box is not meeting: {crossing:?}"
        );
    }

    /// Two boxes standing apart are two parts, and each is repaired on its own.
    ///
    /// The unit matters: the plate in the corpus gets one verdict for all 25 of its objects when it
    /// is repaired whole, which says nothing about which object is the problem. Per part it says
    /// `26 of 39 repaired` and names the 13 that carry their own winding defect.
    #[test]
    fn separate_boxes_are_repaired_as_parts() {
        let (mut positions, mut triangles) = box_mesh(v(0.0, 0.0, 0.0), v(1.0, 1.0, 1.0));
        let (more_positions, more_triangles) = box_mesh(v(5.0, 5.0, 5.0), v(6.0, 6.0, 6.0));
        let base = positions.len() as u32;
        positions.extend_from_slice(&more_positions);
        for t in more_triangles {
            triangles.push([t[0] + base, t[1] + base, t[2] + base]);
        }
        let mesh = IndexedMesh {
            positions,
            triangles,
        };
        let parts = crate::repair::repair_separate_parts(
            &mesh,
            &crate::repair::RepairOptions::default(),
            None,
        )
        .expect("two boxes that do not meet are two parts");
        assert_eq!(parts.parts.len(), 2);
        assert_eq!(parts.joined, 0, "neither part is several shells");
        for part in &parts.parts {
            assert_eq!(part.before.triangle_count, 12);
            assert!(
                part.outcome.report.fully_repaired,
                "a closed box needs no repair: {:?}",
                part.outcome.report.residual_issues
            );
            assert_eq!(part.outcome.mesh.triangles.len(), 12);
        }
    }

    /// Two boxes that cross are one object, and are not split: repairing them apart would separate
    /// the surfaces the repair is supposed to join.
    #[test]
    fn crossing_boxes_are_not_split() {
        let (mut positions, mut triangles) = box_mesh(v(0.0, 0.0, 0.0), v(2.0, 2.0, 2.0));
        let (more_positions, more_triangles) = box_mesh(v(1.0, 1.0, 1.0), v(3.0, 3.0, 3.0));
        let base = positions.len() as u32;
        positions.extend_from_slice(&more_positions);
        for t in more_triangles {
            triangles.push([t[0] + base, t[1] + base, t[2] + base]);
        }
        let mesh = IndexedMesh {
            positions,
            triangles,
        };
        assert!(
            crate::repair::repair_separate_parts(
                &mesh,
                &crate::repair::RepairOptions::default(),
                None
            )
            .is_none(),
            "one object between them, so there is nothing to separate"
        );
    }

    /// The union's own answer on that fixture: nothing to union, and two separate solids reported.
    #[cfg(feature = "manifold")]
    #[test]
    fn the_union_leaves_separate_solids_alone() {
        let near = [
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [0.0, 0.0, 2.0],
        ];
        let far = [
            [3.0, 3.0, 3.0],
            [1.0, 3.0, 3.0],
            [3.0, 1.0, 3.0],
            [3.0, 3.0, 1.0],
        ];
        let mut positions: Vec<Vec3> = Vec::new();
        let mut triangles: Vec<[u32; 3]> = Vec::new();
        for tet in [near, far] {
            let base = positions.len() as u32;
            positions.extend(tet.iter().map(|p| v(p[0], p[1], p[2])));
            for t in [[0u32, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]] {
                triangles.push([t[0] + base, t[1] + base, t[2] + base]);
            }
        }
        let mut mesh = IndexedMesh {
            positions,
            triangles,
        };
        let before = mesh.triangles.clone();
        let components = crate::repair::triangle_components(&mesh);
        let outcome = union_closed_components(&mut mesh, &components);
        assert_eq!(
            outcome,
            Some((0, 0, 2)),
            "two solids that share a bounding box and meet nowhere are two parts"
        );
        assert_eq!(mesh.triangles, before, "and nothing is rewritten to say so");
    }

    /// Two boxes that penetrate each other are one object, and are left in the operand set.
    #[test]
    fn boxes_that_penetrate_are_one_object() {
        let (mut positions, mut triangles) = box_mesh(v(0.0, 0.0, 0.0), v(2.0, 2.0, 2.0));
        let (more_positions, more_triangles) = box_mesh(v(1.0, 1.0, 1.0), v(3.0, 3.0, 3.0));
        let base = positions.len() as u32;
        positions.extend_from_slice(&more_positions);
        for t in more_triangles {
            triangles.push([t[0] + base, t[1] + base, t[2] + base]);
        }
        let mesh = IndexedMesh {
            positions,
            triangles,
        };
        let components = crate::repair::triangle_components(&mesh);
        let crossing = crossing_component_pairs(&mesh, &components);
        assert_eq!(crossing.len(), 1, "the two boxes cross: {crossing:?}");
    }

    /// A shell inside another one, touching nothing, is not a crossing either: a union of a solid
    /// with a solid inside it fills the void, and that is a different object, not a merged one.
    #[test]
    fn a_nested_shell_is_not_a_crossing() {
        let (mut positions, mut triangles) = box_mesh(v(0.0, 0.0, 0.0), v(4.0, 4.0, 4.0));
        let (more_positions, more_triangles) = box_mesh(v(1.0, 1.0, 1.0), v(2.0, 2.0, 2.0));
        let base = positions.len() as u32;
        positions.extend_from_slice(&more_positions);
        for t in more_triangles {
            triangles.push([t[0] + base, t[1] + base, t[2] + base]);
        }
        let mesh = IndexedMesh {
            positions,
            triangles,
        };
        let components = crate::repair::triangle_components(&mesh);
        assert!(
            crossing_component_pairs(&mesh, &components).is_empty(),
            "a shell inside another does not cross it"
        );
    }
}
