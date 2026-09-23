//! Mesh-normal overhang classification — auto-supports redesign, Step 1.
//!
//! Classifies down-facing mesh triangles whose surface is flatter than a
//! configurable self-support angle into connected overhang REGIONS.
//!
//! Why this exists: the slice-growth detector (`current − dilate(prev, buffer)`)
//! only flags surfaces whose per-layer cross-section expansion exceeds the
//! support buffer — with 0.05 mm layers and a 0.25 mm buffer that is
//! `arctan(0.05/0.25) ≈ 11.3°` from horizontal. The entire 11°–45° zone that
//! resin printing wants supported (shallow slopes, rotated-cube undersides)
//! is invisible to growth detection, and shallow slopes accumulate unsupported
//! material without ever triggering the per-layer rule.
//!
//! A surface at angle θ from horizontal (0° = flat ceiling, 90° = vertical wall)
//! is overhang when `θ < self_support_angle_deg`, i.e.
//! `normal.z < -cos(self_support_angle_deg)`. Only genuinely down-facing
//! triangles are eligible (the formula implies normal.z < 0).
//!
//! A steep face is not the end of the story: a LARGE planar face at θ between
//! the self-support angle and [`STEEP_FLAT_MAX_ANGLE_DEG`] is the lever a tall
//! part topples on. Resin peels off a 60° face without anything under it, but
//! the drag on several square centimetres of face rotates the whole part about
//! its bearing edge, and the only thing that resists is contact along that
//! face — the "huge flat plastered as if it were an overhang" shape a
//! professional support pass produces on a leaning plate. Those patches are
//! classified as overhang regions too, so the density grid covers them like
//! any other; see [`classify_steep_flats`].

use dragonfruit_mesh_repair::{core::mesh::Vec3, IndexedMesh};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

use rayon::prelude::*;

/// Steepest face a steep-flat patch may have (deg from horizontal) and still be
/// classified. Past this the face is a wall: a support rises vertically to meet
/// it and would only graze the surface, so there is no contact to place.
const STEEP_FLAT_MAX_ANGLE_DEG: f32 = 80.0;
/// 3D area (mm²) a steep planar patch must reach before it counts as a
/// topple lever rather than a facet. Comfortably above the 25 mm² density-grid
/// threshold, and tunable: too low and every chamfer on a sculpted model gets
/// a patch.
const STEEP_FLAT_MIN_AREA_MM2: f32 = 150.0;
/// How far a triangle's normal may sit from the growing patch's running mean
/// normal (deg). This is what keeps a patch to ONE face: a crease splits it,
/// so a sculpted face contributes its own flat parts instead of dragging every
/// steep triangle that touches it into one giant patch. It bounds curvature,
/// it does not reject it — a smooth curved surface chains until its curvature
/// outruns the running mean (the accepted false positive in
/// `docs/dev/auto-supports.md`).
const STEEP_FLAT_NORMAL_TOL_DEG: f32 = 20.0;

/// Binary raster of a region's XY-projected footprint — the containment test
/// the density grid stage uses to place supports only inside the region.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FootprintMask {
    pub width: u32,
    pub height: u32,
    /// World XY of the mask's top-left pixel center (mm).
    pub origin_x: f32,
    pub origin_y: f32,
    pub px_mm: f32,
    /// Row-major pixels (1 = inside the projected region), width×height.
    pub data: Vec<u8>,
    /// Row-major surface Z (mm) on the region's own triangles, parallel to
    /// `data` — the exact face height at each pixel. The placement pipeline
    /// uses this so tips land on the region surface (not whatever other face
    /// happens to be below it on sloped geometry) and the regular
    /// normal-resolution/pathfinding then works unchanged.
    pub surface_z: Vec<f32>,
}

/// A connected patch of overhang triangles — the atomic unit the density
/// placement stage consumes (grid for large flats, one tip for small ones).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverhangRegion {
    /// Triangle indices into `IndexedMesh::triangles`.
    pub triangle_ids: Vec<u32>,
    /// Sum of the 3D triangle areas (mm²).
    pub area_mm2: f32,
    /// Sum of the XY-projected triangle areas (mm²) — the supportable footprint
    /// a density grid must cover (peel force scales with projected area).
    pub projected_area_mm2: f32,
    /// Area-weighted mean surface angle from horizontal (degrees).
    pub angle_deg: f32,
    /// Area-weighted mean face normal (world space, points away from the model
    /// interior — downward for undersides). Grid points use this instead of a
    /// whole-mesh raycast, which hits the wrong face on sloped geometry.
    pub normal: [f32; 3],
    /// XY bounding box of the region's vertices (mm).
    pub xy_min: [f32; 2],
    pub xy_max: [f32; 2],
    /// Lowest / highest vertex Z of the region (mm) — the leading edge of the
    /// overhang is at `min_z` (where peel starts).
    pub min_z: f32,
    pub max_z: f32,
    /// Projected-footprint mask at the requested resolution.
    pub footprint: FootprintMask,
    /// Triangle-accurate perimeter loops (world mm, each loop closed).
    /// Outer + hole boundaries extracted from region triangle adjacency,
    /// inset by `PERIMETER_CONTACT_INSET_MM` (0.25 mm) so a support's
    /// contact disc sits fully on the surface. Empty for degenerate regions.
    /// Used by the JS Poisson/grid stages instead of the voxel `contactVoxels`
    /// boundary when available — organic curves are not quantized to 0.25 mm.
    #[serde(default)]
    pub perimeter_loops: Vec<Vec<[f32; 3]>>,
}

/// Weld a world-space triangle soup (9 floats per triangle) and classify
/// overhang regions. Mirrors `scan_mesh_minima`'s stateless IPC shape.
pub fn classify_overhangs_from_soup(
    positions: &[f32],
    self_support_angle_deg: f32,
    px_mm: f32,
) -> Vec<OverhangRegion> {
    let mesh = IndexedMesh::from_triangle_soup(positions, 1e-5);
    classify_overhangs(&mesh, self_support_angle_deg, px_mm)
}

/// Classify overhang regions on an already-welded mesh.
pub fn classify_overhangs(
    mesh: &IndexedMesh,
    self_support_angle_deg: f32,
    px_mm: f32,
) -> Vec<OverhangRegion> {
    let tri_count = mesh.triangle_count();
    if tri_count == 0 {
        return Vec::new();
    }

    // A down-facing surface at angle θ from horizontal has normal.z = -cos(θ).
    // Overhang iff θ < threshold ⟺ normal.z < -cos(threshold).
    let threshold = -self_support_angle_deg.to_radians().cos();

    let pairs: Vec<(Vec3, bool)> = (0..tri_count)
        .into_par_iter()
        .map(|fi| {
            let n = mesh.tri_normal(fi as u32);
            (n, n.z < threshold)
        })
        .collect();
    let mut normal = Vec::with_capacity(tri_count);
    let mut is_overhang = Vec::with_capacity(tri_count);
    for (n, o) in pairs {
        normal.push(n);
        is_overhang.push(o);
    }

    // Triangle adjacency through undirected edges (min, max vertex id).
    // Fold into thread-local maps, then merge: union-find is order-independent
    // over the edge pairs, so the result stays deterministic.
    let edge_tris: HashMap<(u32, u32), Vec<u32>> = mesh
        .triangles
        .par_iter()
        .enumerate()
        .fold(
            || HashMap::<(u32, u32), Vec<u32>>::new(),
            |mut acc, (fi, tri)| {
                for pair in [(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
                    let key = if pair.0 < pair.1 {
                        pair
                    } else {
                        (pair.1, pair.0)
                    };
                    acc.entry(key).or_default().push(fi as u32);
                }
                acc
            },
        )
        .reduce(
            || HashMap::<(u32, u32), Vec<u32>>::new(),
            |mut a, b| {
                for (k, v) in b {
                    a.entry(k).or_default().extend(v);
                }
                a
            },
        );

    // Union-find over overhang triangles sharing an edge.
    let mut parent: Vec<u32> = (0..tri_count as u32).collect();
    fn find(parent: &mut [u32], x: u32) -> u32 {
        let mut root = x;
        while parent[root as usize] != root {
            root = parent[root as usize];
        }
        let mut cur = x;
        while parent[cur as usize] != root {
            let next = parent[cur as usize];
            parent[cur as usize] = root;
            cur = next;
        }
        root
    }
    fn union(parent: &mut [u32], a: u32, b: u32) {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            // Deterministic: smaller id wins as root.
            let (keep, drop) = if ra < rb { (ra, rb) } else { (rb, ra) };
            parent[drop as usize] = keep;
        }
    }

    for tris in edge_tris.values() {
        if tris.len() < 2 {
            continue;
        }
        for w in tris.windows(2) {
            union(&mut parent, w[0], w[1]);
        }
    }

    // Group by root (sorted for determinism).
    let mut by_root: HashMap<u32, Vec<u32>> = HashMap::new();
    for fi in 0..tri_count as u32 {
        if !is_overhang[fi as usize] {
            continue;
        }
        let root = find(&mut parent, fi);
        by_root.entry(root).or_default().push(fi);
    }
    let mut groups: Vec<(u32, Vec<u32>)> = by_root.into_iter().collect();
    groups.sort_by_key(|(root, _)| *root);

    let mut regions: Vec<OverhangRegion> = groups
        .into_par_iter()
        .map(|(_, triangle_ids)| build_region(mesh, &normal, triangle_ids, px_mm))
        .collect();

    // Steep flats ride the same region shape, so the density grid, the surface
    // sampler and the perimeter ring all treat them as ordinary overhangs.
    regions.extend(classify_steep_flats(
        mesh, &normal, &edge_tris, threshold, px_mm,
    ));
    regions
}

/// Large planar faces just past the self-support angle — the topple levers
/// (see the module docs). Grown per patch: a seed triangle claims its
/// neighbours while their normals stay within [`STEEP_FLAT_NORMAL_TOL_DEG`] of
/// the patch's running area-weighted mean, so the growth follows one flat face
/// and stops at a crease. Patches under [`STEEP_FLAT_MIN_AREA_MM2`] are
/// dropped — the classifier's answer for a steep face that is *not* huge stays
/// "self-supporting".
///
/// Deterministic: seeds ascend by triangle id, neighbours are sorted before
/// the walk, and the queue is FIFO, so the running mean sees a fixed order.
fn classify_steep_flats(
    mesh: &IndexedMesh,
    normal: &[Vec3],
    edge_tris: &HashMap<(u32, u32), Vec<u32>>,
    self_support_threshold: f32,
    px_mm: f32,
) -> Vec<OverhangRegion> {
    let tri_count = mesh.triangle_count();
    if tri_count == 0 {
        return Vec::new();
    }
    // Band: θ ∈ [self-support, STEEP_FLAT_MAX_ANGLE_DEG]. normal.z = -cos(θ),
    // so θ ≥ self-support ⟺ nz ≥ threshold, and θ ≤ max ⟺ nz ≤ -cos(max).
    let steep_ceiling = -STEEP_FLAT_MAX_ANGLE_DEG.to_radians().cos();
    let cos_tol = STEEP_FLAT_NORMAL_TOL_DEG.to_radians().cos();
    let in_band = |fi: usize| {
        let nz = normal[fi].z;
        nz >= self_support_threshold && nz <= steep_ceiling
    };

    let mut claimed = vec![false; tri_count];
    let mut out: Vec<OverhangRegion> = Vec::new();
    let mut neighbors: Vec<u32> = Vec::with_capacity(8);
    let mut queue: VecDeque<u32> = VecDeque::new();

    for seed in 0..tri_count as u32 {
        if claimed[seed as usize] || !in_band(seed as usize) {
            continue;
        }
        claimed[seed as usize] = true;
        let mut acc = [0f32; 3];
        let mut area = 0f32;
        let mut members: Vec<u32> = vec![seed];
        queue.clear();
        queue.push_back(seed);
        let seed_area = mesh.tri_area(seed);
        accumulate_normal(&mut acc, normal[seed as usize], seed_area);
        area += seed_area;

        while let Some(fi) = queue.pop_front() {
            // Area-weighted mean so far — the plane the patch is fitting.
            let len = (acc[0] * acc[0] + acc[1] * acc[1] + acc[2] * acc[2]).sqrt();
            let (mx, my, mz) = if len > 1e-9 {
                (acc[0] / len, acc[1] / len, acc[2] / len)
            } else {
                (0.0, 0.0, -1.0)
            };

            neighbors.clear();
            let tri = mesh.triangles[fi as usize];
            for pair in [(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
                let key = if pair.0 < pair.1 {
                    pair
                } else {
                    (pair.1, pair.0)
                };
                if let Some(ts) = edge_tris.get(&key) {
                    neighbors.extend_from_slice(ts);
                }
            }
            neighbors.sort_unstable();
            neighbors.dedup();

            for &nb in neighbors.iter() {
                if nb == fi || claimed[nb as usize] || !in_band(nb as usize) {
                    continue;
                }
                let n = normal[nb as usize];
                if mx * n.x + my * n.y + mz * n.z < cos_tol {
                    continue;
                }
                claimed[nb as usize] = true;
                members.push(nb);
                let tri_area = mesh.tri_area(nb);
                area += tri_area;
                accumulate_normal(&mut acc, n, tri_area);
                queue.push_back(nb);
            }
        }

        if area < STEEP_FLAT_MIN_AREA_MM2 {
            continue;
        }
        // build_region's footprint raster keeps the first triangle per pixel,
        // so a stable triangle order keeps the mask stable too.
        members.sort_unstable();
        out.push(build_region(mesh, normal, members, px_mm));
    }
    out
}

fn accumulate_normal(acc: &mut [f32; 3], n: Vec3, area: f32) {
    acc[0] += n.x * area;
    acc[1] += n.y * area;
    acc[2] += n.z * area;
}

fn build_region(
    mesh: &IndexedMesh,
    normal: &[Vec3],
    triangle_ids: Vec<u32>,
    px_mm: f32,
) -> OverhangRegion {
    let mut area_mm2 = 0.0f32;
    let mut projected_area_mm2 = 0.0f32;
    let mut angle_weighted = 0.0f32;
    let mut min_z = f32::INFINITY;
    let mut max_z = f32::NEG_INFINITY;
    let mut xy_min = [f32::INFINITY; 2];
    let mut xy_max = [f32::NEG_INFINITY; 2];

    let mut normal_acc = [0f32; 3];
    for &fi in &triangle_ids {
        let [a, b, c] = mesh.tri_positions(fi);
        let area = mesh.tri_area(fi);
        area_mm2 += area;

        let n = normal[fi as usize];
        normal_acc[0] += n.x * area;
        normal_acc[1] += n.y * area;
        normal_acc[2] += n.z * area;

        // XY-projected area of the triangle.
        let cross2d = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        projected_area_mm2 += cross2d.abs() * 0.5;

        let nz = normal[fi as usize].z.clamp(-1.0, 0.0);
        // Surface angle from horizontal: normal.z = -cos(θ) → θ = acos(-nz).
        let angle = (-nz).acos().to_degrees();
        angle_weighted += area * angle;

        for v in [a, b, c] {
            min_z = min_z.min(v.z);
            max_z = max_z.max(v.z);
            xy_min[0] = xy_min[0].min(v.x);
            xy_min[1] = xy_min[1].min(v.y);
            xy_max[0] = xy_max[0].max(v.x);
            xy_max[1] = xy_max[1].max(v.y);
        }
    }

    let footprint = build_footprint_mask(mesh, &triangle_ids, xy_min, xy_max, px_mm);
    let perimeter_loops = build_perimeter_loops(mesh, &triangle_ids, 0.25);

    // Area-weighted mean normal, normalized.
    let normal_len = (normal_acc[0] * normal_acc[0]
        + normal_acc[1] * normal_acc[1]
        + normal_acc[2] * normal_acc[2])
        .sqrt();
    let normal = if normal_len > 1e-9 {
        [
            normal_acc[0] / normal_len,
            normal_acc[1] / normal_len,
            normal_acc[2] / normal_len,
        ]
    } else {
        [0.0, 0.0, -1.0]
    };

    OverhangRegion {
        triangle_ids,
        area_mm2,
        projected_area_mm2,
        angle_deg: if area_mm2 > 1e-9 {
            angle_weighted / area_mm2
        } else {
            0.0
        },
        normal,
        xy_min,
        xy_max,
        min_z,
        max_z,
        footprint,
        perimeter_loops,
    }
}

/// Rasterize the region's XY-projected triangles into a containment mask.
/// The mask is expanded by half a pixel on each side so edge pixels sample
/// the region interior rather than falling just outside it.
fn build_footprint_mask(
    mesh: &IndexedMesh,
    triangle_ids: &[u32],
    xy_min: [f32; 2],
    xy_max: [f32; 2],
    px_mm: f32,
) -> FootprintMask {
    let px = px_mm.max(1e-4);
    let width = (((xy_max[0] - xy_min[0]) / px).ceil() as u32).max(1);
    let height = (((xy_max[1] - xy_min[1]) / px).ceil() as u32).max(1);

    let mut data = vec![0u8; (width * height) as usize];
    let mut surface_z = vec![0f32; (width * height) as usize];
    // Pixel centers, expanded by half a pixel outward from the bbox.
    let origin_x = xy_min[0] - px * 0.5;
    let origin_y = xy_min[1] - px * 0.5;

    // Rasterize PER TRIANGLE: each triangle fills the pixels inside its own
    // XY bbox. The naive loop tested every region triangle against every
    // pixel — O(W*H*N) — which dominated the scan on large flat undersides
    // (a 364 mm² face at 0.25 mm px ≈ 5.8k pixels × 10–50k triangles).
    // Per-triangle work is O(sum of triangle bboxes) ≈ O(W*H) for a tiled
    // region. First triangle in list order wins, as before — deterministic.
    for &fi in triangle_ids {
        let [a, b, c] = mesh.tri_positions(fi);
        let tmin_x = a.x.min(b.x).min(c.x);
        let tmax_x = a.x.max(b.x).max(c.x);
        let tmin_y = a.y.min(b.y).min(c.y);
        let tmax_y = a.y.max(b.y).max(c.y);

        let px0 = (((tmin_x - origin_x) / px).floor() as i64).max(0) as u32;
        let px1 = (((tmax_x - origin_x) / px).floor() as i64).min(width as i64 - 1) as u32;
        let py0 = (((tmin_y - origin_y) / px).floor() as i64).max(0) as u32;
        let py1 = (((tmax_y - origin_y) / px).floor() as i64).min(height as i64 - 1) as u32;

        for py in py0..=py1 {
            let y = origin_y + (py as f32 + 0.5) * px;
            for px_idx in px0..=px1 {
                let idx = (py * width + px_idx) as usize;
                if data[idx] == 1 {
                    continue;
                }
                let x = origin_x + (px_idx as f32 + 0.5) * px;
                if point_in_triangle_2d(x, y, (a.x, a.y), (b.x, b.y), (c.x, c.y)) {
                    data[idx] = 1;
                    surface_z[idx] = barycentric_z(x, y, a, b, c);
                }
            }
        }
    }

    FootprintMask {
        width,
        height,
        origin_x,
        origin_y,
        px_mm: px,
        data,
        surface_z,
    }
}

/// Extract triangle-accurate perimeter loops for a region and inset them by
/// `inset_mm` so a support contact disc sits fully on the surface.
/// Boundary edges are those with exactly one incident region triangle;
/// loops are traced via vertex adjacency and offset per-vertex toward the
/// interior (edge-mid → opposite vertex, averaged at vertices).
fn build_perimeter_loops(
    mesh: &IndexedMesh,
    triangle_ids: &[u32],
    inset_mm: f32,
) -> Vec<Vec<[f32; 3]>> {
    use std::collections::{HashMap, HashSet};
    if triangle_ids.len() < 1 {
        return Vec::new();
    }
    // Edge → (tri_id, opposite_vertex)
    let mut edge_map: HashMap<(u32, u32), Vec<(u32, u32)>> = HashMap::new();
    for &tid in triangle_ids {
        let tri = mesh.triangles[tid as usize];
        let (v0, v1, v2) = (tri[0], tri[1], tri[2]);
        for (a, b, c) in [(v0, v1, v2), (v1, v2, v0), (v2, v0, v1)] {
            let key = if a < b { (a, b) } else { (b, a) };
            edge_map.entry(key).or_default().push((tid, c));
        }
    }
    // Boundary edges: exactly one region triangle
    let mut boundary: Vec<(u32, u32, u32, u32)> = Vec::new(); // a,b,opp,tri
    let mut edge_opp: HashMap<(u32, u32), (u32, u32)> = HashMap::new(); // key -> (tri,opp)
    let mut adj: HashMap<u32, Vec<u32>> = HashMap::new();
    for (key, vec) in edge_map {
        if vec.len() == 1 {
            let (tri, opp) = vec[0];
            let (a, b) = key;
            boundary.push((a, b, opp, tri));
            adj.entry(a).or_default().push(b);
            adj.entry(b).or_default().push(a);
            edge_opp.insert(key, (tri, opp));
        }
    }
    if boundary.is_empty() {
        return Vec::new();
    }
    // Trace loops via adjacency
    let mut visited: HashSet<(u32, u32)> = HashSet::new();
    let mut loops: Vec<Vec<u32>> = Vec::new();
    for &(a, b, _, _) in &boundary {
        let key = if a < b { (a, b) } else { (b, a) };
        if visited.contains(&key) {
            continue;
        }
        let mut loop_vs: Vec<u32> = vec![a, b];
        visited.insert(key);
        let mut prev = a;
        let mut cur = b;
        loop {
            if cur == a {
                break;
            }
            let neighbors = match adj.get(&cur) {
                Some(n) => n,
                None => break,
            };
            let mut next_opt: Option<u32> = None;
            for &nb in neighbors {
                if nb == prev {
                    continue;
                }
                let k = if cur < nb { (cur, nb) } else { (nb, cur) };
                if !visited.contains(&k) {
                    next_opt = Some(nb);
                    break;
                }
            }
            if next_opt.is_none() {
                for &nb in neighbors {
                    let k = if cur < nb { (cur, nb) } else { (nb, cur) };
                    if !visited.contains(&k) {
                        next_opt = Some(nb);
                        break;
                    }
                }
            }
            if let Some(next) = next_opt {
                let k = if cur < next { (cur, next) } else { (next, cur) };
                visited.insert(k);
                loop_vs.push(next);
                prev = cur;
                cur = next;
                if cur == a {
                    break;
                }
                if loop_vs.len() > boundary.len() + 2 {
                    break;
                }
            } else {
                break;
            }
        }
        if loop_vs.len() > 1 && loop_vs[0] == *loop_vs.last().unwrap() {
            loop_vs.pop();
        }
        if loop_vs.len() >= 3 {
            loops.push(loop_vs);
        }
    }
    if loops.is_empty() {
        return Vec::new();
    }
    // Compute inset loops: per-vertex average of incident edge interior dirs
    let mut out: Vec<Vec<[f32; 3]>> = Vec::new();
    for vs in loops {
        let n = vs.len();
        // Per-edge interior direction (XY) toward opposite vertex
        let mut edge_dirs: Vec<(f32, f32)> = Vec::with_capacity(n);
        for i in 0..n {
            let a = vs[i];
            let b = vs[(i + 1) % n];
            let key = if a < b { (a, b) } else { (b, a) };
            if let Some((_, opp)) = edge_opp.get(&key) {
                let pa = mesh.positions[a as usize];
                let pb = mesh.positions[b as usize];
                let pc = mesh.positions[*opp as usize];
                let mid_x = (pa.x + pb.x) * 0.5;
                let mid_y = (pa.y + pb.y) * 0.5;
                let dx = pc.x - mid_x;
                let dy = pc.y - mid_y;
                let len = (dx * dx + dy * dy).sqrt();
                if len > 1e-6 {
                    edge_dirs.push((dx / len, dy / len));
                } else {
                    edge_dirs.push((0.0, 0.0));
                }
            } else {
                edge_dirs.push((0.0, 0.0));
            }
        }
        let mut inset_loop: Vec<[f32; 3]> = Vec::with_capacity(n);
        for i in 0..n {
            let vid = vs[i];
            let p = mesh.positions[vid as usize];
            let dir_prev = edge_dirs[(i + n - 1) % n];
            let dir_next = edge_dirs[i];
            let avg_x = dir_prev.0 + dir_next.0;
            let avg_y = dir_prev.1 + dir_next.1;
            let len = (avg_x * avg_x + avg_y * avg_y).sqrt();
            let (off_x, off_y) = if len > 1e-6 {
                (avg_x / len * inset_mm, avg_y / len * inset_mm)
            } else if dir_next.0 != 0.0 || dir_next.1 != 0.0 {
                (dir_next.0 * inset_mm, dir_next.1 * inset_mm)
            } else if dir_prev.0 != 0.0 || dir_prev.1 != 0.0 {
                (dir_prev.0 * inset_mm, dir_prev.1 * inset_mm)
            } else {
                (0.0, 0.0)
            };
            let new_x = p.x + off_x;
            let new_y = p.y + off_y;
            // Project Z onto the incident triangle plane so the inset point
            // stays on the surface (overhangs are shallow, but 45° still shifts Z).
            let new_z = if inset_mm.abs() > 1e-6 {
                // Use the next edge's triangle plane (a,b,opp) for this vertex.
                let a = vs[i];
                let b = vs[(i + 1) % n];
                let key = if a < b { (a, b) } else { (b, a) };
                if let Some((tri, _opp)) = edge_opp.get(&key) {
                    let tri_verts = mesh.triangles[*tri as usize];
                    let v_a = mesh.positions[tri_verts[0] as usize];
                    let v_b = mesh.positions[tri_verts[1] as usize];
                    let v_c = mesh.positions[tri_verts[2] as usize];
                    let n = (v_b.sub(v_a)).cross(v_c.sub(v_a));
                    if n.z.abs() > 1e-6 {
                        v_a.z - (n.x * (new_x - v_a.x) + n.y * (new_y - v_a.y)) / n.z
                    } else {
                        p.z
                    }
                } else {
                    p.z
                }
            } else {
                p.z
            };
            inset_loop.push([new_x, new_y, new_z]);
        }
        // Validate: inset loop must still have area and not collapse.
        // For narrow features (<0.5 mm) the inset can invert; fall back to raw.
        let mut use_raw = false;
        if inset_mm > 1e-6 {
            let mut area2: f64 = 0.0;
            for i in 0..n {
                let a = inset_loop[i];
                let b = inset_loop[(i + 1) % n];
                area2 += (a[0] as f64) * (b[1] as f64) - (b[0] as f64) * (a[1] as f64);
            }
            if area2.abs() < 1e-6 {
                use_raw = true;
            } else {
                // Check that inset points remain inside original ring (for outer).
                // Simple heuristic: inset should not push vertices more than 2× inset
                // away from original — catches inversion on tight concavities.
                let mut max_dist2: f32 = 0.0;
                for i in 0..n {
                    let dx = inset_loop[i][0] - mesh.positions[vs[i] as usize].x;
                    let dy = inset_loop[i][1] - mesh.positions[vs[i] as usize].y;
                    max_dist2 = max_dist2.max(dx * dx + dy * dy);
                }
                if max_dist2 > (inset_mm * 3.0) * (inset_mm * 3.0) {
                    use_raw = true;
                }
            }
        }
        if use_raw {
            let raw: Vec<[f32; 3]> = vs
                .iter()
                .map(|id| {
                    let p = mesh.positions[*id as usize];
                    [p.x, p.y, p.z]
                })
                .collect();
            out.push(raw);
        } else {
            out.push(inset_loop);
        }
    }
    out
}

/// Surface Z of a triangle at a projected XY via barycentric interpolation.
fn barycentric_z(px: f32, py: f32, a: Vec3, b: Vec3, c: Vec3) -> f32 {
    let denom = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if denom.abs() < 1e-9 {
        return (a.z + b.z + c.z) / 3.0;
    }
    let w_a = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / denom;
    let w_b = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / denom;
    let w_c = 1.0 - w_a - w_b;
    w_a * a.z + w_b * b.z + w_c * c.z
}

/// Point-in-triangle test (2D, half-plane method).
fn point_in_triangle_2d(px: f32, py: f32, a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> bool {
    let sign = |x1: f32, y1: f32, x2: f32, y2: f32, x3: f32, y3: f32| {
        (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)
    };
    let d1 = sign(px, py, a.0, a.1, b.0, b.1);
    let d2 = sign(px, py, b.0, b.1, c.0, c.1);
    let d3 = sign(px, py, c.0, c.1, a.0, a.1);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Tauri IPC command: weld a world-space triangle soup (9 floats per triangle)
/// and classify overhang regions with projected-footprint masks. Stateless —
/// no model cache. Mirrors `scan_mesh_minima`'s shape.
#[tauri::command]
pub async fn scan_overhangs(
    positions: Vec<f32>,
    self_support_angle_deg: f32,
    px_mm: f32,
) -> Result<Vec<OverhangRegion>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let regions = classify_overhangs_from_soup(&positions, self_support_angle_deg, px_mm);
        log::info!(
            "[overhang] scan complete: {} regions from {} triangles",
            regions.len(),
            positions.len() / 9,
        );
        Ok(regions)
    })
    .await
    .map_err(|e| format!("Overhang scan task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rotate a triangle soup about the X axis by `angle_deg`.
    fn rotate_x(positions: &[f32], angle_deg: f32) -> Vec<f32> {
        let (s, c) = angle_deg.to_radians().sin_cos();
        positions
            .chunks_exact(3)
            .flat_map(|v| {
                let (x, y, z) = (v[0], v[1], v[2]);
                [x, c * y - s * z, s * y + c * z]
            })
            .collect()
    }

    /// 10×10×10 cube, faces wound so normals point outward.
    fn unit_cube_soup() -> Vec<f32> {
        let mut out = Vec::new();
        // v0(0,0,0) v1(10,0,0) v2(10,10,0) v3(0,10,0) v4(0,0,10) v5(10,0,10) v6(10,10,10) v7(0,10,10)
        let v: [[f32; 3]; 8] = [
            [0.0, 0.0, 0.0],
            [10.0, 0.0, 0.0],
            [10.0, 10.0, 0.0],
            [0.0, 10.0, 0.0],
            [0.0, 0.0, 10.0],
            [10.0, 0.0, 10.0],
            [10.0, 10.0, 10.0],
            [0.0, 10.0, 10.0],
        ];
        // bottom (-Z): (v0,v3,v2),(v0,v2,v1)
        // top (+Z):    (v4,v5,v6),(v4,v6,v7)
        // front (-Y):  (v0,v5,v4),(v0,v1,v5)
        // back (+Y):   (v3,v7,v6),(v3,v6,v2)
        // left (-X):   (v0,v4,v7),(v0,v7,v3)
        // right (+X):  (v1,v6,v5),(v1,v2,v6)
        let tris: [[usize; 3]; 12] = [
            [0, 3, 2],
            [0, 2, 1],
            [4, 5, 6],
            [4, 6, 7],
            [0, 5, 4],
            [0, 1, 5],
            [3, 7, 6],
            [3, 6, 2],
            [0, 4, 7],
            [0, 7, 3],
            [1, 6, 5],
            [1, 2, 6],
        ];
        for t in tris {
            for &i in &t {
                out.extend_from_slice(&v[i]);
            }
        }
        out
    }

    fn assert_region(regions: &[OverhangRegion], expected_angle_deg: f32, expected_area_mm2: f32) {
        assert_eq!(regions.len(), 1, "expected exactly one region: {regions:?}");
        let r = &regions[0];
        assert!(
            (r.angle_deg - expected_angle_deg).abs() < 1.5,
            "angle {} vs expected {}",
            r.angle_deg,
            expected_angle_deg
        );
        assert!(
            (r.area_mm2 - expected_area_mm2).abs() < 1.0,
            "area {} vs expected {}",
            r.area_mm2,
            expected_area_mm2
        );
    }

    /// Horizontal quad (10×10, normal −Z) rotated `angle_deg` about X — a
    /// downward-facing surface at that angle from horizontal.
    fn quad_at(angle_deg: f32) -> Vec<f32> {
        let soup: Vec<f32> = vec![
            0.0, 0.0, 0.0, 10.0, 10.0, 0.0, 10.0, 0.0, 0.0, // tri 0 (normal -Z)
            0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, // tri 1 (normal -Z)
        ];
        rotate_x(&soup, angle_deg)
    }

    #[test]
    fn flat_ceiling_is_overhang() {
        let soup = unit_cube_soup();
        let regions = classify_overhangs_from_soup(&soup, 45.0, 0.25);
        // Only the bottom face (2 triangles, 100 mm², angle 0°) is flagged.
        assert_region(&regions, 0.0, 100.0);
        assert_eq!(regions[0].triangle_ids.len(), 2);
        assert!((regions[0].projected_area_mm2 - 100.0).abs() < 1.0);
        assert!((regions[0].min_z - 0.0).abs() < 1e-3);
    }

    #[test]
    fn rotated_cube_underside_facet_is_single_region() {
        // The user's canonical case: a cube rotated 30° about X. The former
        // bottom face becomes a 30°-from-horizontal facet — invisible to the
        // slice-growth detector (per-layer expansion < buffer) — and must be
        // one overhang region covering the WHOLE face, not just the lowest
        // vertex (which is all the minima detector would catch).
        let soup = rotate_x(&unit_cube_soup(), 30.0);
        let regions = classify_overhangs_from_soup(&soup, 45.0, 0.25);
        assert_region(&regions, 30.0, 100.0);
        assert_eq!(regions[0].triangle_ids.len(), 2, "whole face, not an edge");
        // Projected footprint of a 30° face: 100 × cos(30°) ≈ 86.6 mm².
        assert!(
            (regions[0].projected_area_mm2 - 86.6025).abs() < 1.0,
            "projected {}",
            regions[0].projected_area_mm2
        );
        // The lowest corner of the rotated cube (z = 0) belongs to this region.
        assert!((regions[0].min_z - 0.0).abs() < 1e-3);

        // Footprint mask: the 30°-rotated face projects to a 10 × 8.66 mm
        // rectangle (rotation about X compresses Y), fully covering its bbox.
        let f = &regions[0].footprint;
        assert!((f.width as f32 - 40.0).abs() <= 1.0, "width {}", f.width);
        assert!((f.height as f32 - 35.0).abs() <= 1.0, "height {}", f.height);
        assert!(
            f.data.iter().all(|&v| v == 1),
            "projection is a solid rectangle"
        );
        let mask_area = f.data.len() as f32 * 0.25 * 0.25;
        assert!(
            (mask_area - 86.6).abs() < 10.0,
            "mask area {mask_area} ≈ projected 86.6"
        );

        // Surface Z follows the slope: low edge ≈ 0, high edge ≈ 5 (the 10×10
        // face at 30° spans z 0..5 across its y-extent).
        let z_at = |x: f32, y: f32| -> f32 {
            let col = (((x + 0.125) / 0.25) - 0.5).round() as usize;
            let row = (((y + 0.125) / 0.25) - 0.5).round() as usize;
            f.surface_z[row * f.width as usize + col]
        };
        assert!(
            (z_at(5.0, 0.5) - 0.0).abs() < 0.6,
            "low edge z {}",
            z_at(5.0, 0.5)
        );
        assert!(
            (z_at(5.0, 8.0) - 4.6).abs() < 0.6,
            "high edge z {}",
            z_at(5.0, 8.0)
        );

        // Region normal: the 30°-rotated bottom face has normal (0, 0.5, -0.866).
        let n = regions[0].normal;
        assert!((n[0]).abs() < 0.01, "nx {}", n[0]);
        assert!((n[1] - 0.5).abs() < 0.01, "ny {}", n[1]);
        assert!((n[2] + 0.8660).abs() < 0.01, "nz {}", n[2]);
    }

    #[test]
    fn triangular_facet_mask_respects_containment() {
        // A single right triangle (half of the 10×10 quad): pixels on the
        // y > x side of the diagonal must be outside the mask.
        let soup: Vec<f32> = vec![
            0.0, 0.0, 0.0, 10.0, 10.0, 0.0, 10.0, 0.0, 0.0, // normal -Z
        ];
        let regions = classify_overhangs_from_soup(&soup, 45.0, 0.25);
        assert_eq!(regions.len(), 1);
        assert!((regions[0].projected_area_mm2 - 50.0).abs() < 1.0);

        let f = &regions[0].footprint;
        // Pixel centers: x = origin_x + (col + 0.5)*px, origin_x = -0.125.
        let idx = |x: f32, y: f32| -> usize {
            let col = (((x + 0.125) / 0.25) - 0.5).round() as usize;
            let row = (((y + 0.125) / 0.25) - 0.5).round() as usize;
            row * f.width as usize + col
        };
        assert_eq!(
            f.data[idx(2.0, 1.0)],
            1,
            "(2,1) is inside the triangle (y ≤ x)"
        );
        assert_eq!(
            f.data[idx(1.0, 2.0)],
            0,
            "(1,2) is outside the triangle (y > x)"
        );
    }

    #[test]
    fn vertical_wall_is_not_overhang() {
        let regions = classify_overhangs_from_soup(&quad_at(90.0), 45.0, 0.25);
        assert!(
            regions.is_empty(),
            "no overhang on a vertical wall: {regions:?}"
        );
    }

    #[test]
    fn slope_steeper_than_threshold_is_self_supporting() {
        // 60° slope: self-supporting at the 45° threshold, flagged at 70°.
        let soup60 = quad_at(60.0);
        let regions = classify_overhangs_from_soup(&soup60, 45.0, 0.25);
        assert!(
            regions.is_empty(),
            "60° slope must be self-supporting at 45°: {regions:?}"
        );
        let regions70 = classify_overhangs_from_soup(&soup60, 70.0, 0.25);
        assert_eq!(regions70.len(), 1, "60° slope flagged at 70° threshold");
        assert!((regions70[0].angle_deg - 60.0).abs() < 1.5);
    }

    /// Horizontal `size`×`size` quad (normal −Z) rotated `angle_deg` about X.
    fn big_quad_at(size: f32, angle_deg: f32) -> Vec<f32> {
        let s = size;
        let soup: Vec<f32> = vec![
            0.0, 0.0, 0.0, s, s, 0.0, s, 0.0, 0.0, // tri 0 (normal -Z)
            0.0, 0.0, 0.0, 0.0, s, 0.0, s, s, 0.0, // tri 1 (normal -Z)
        ];
        rotate_x(&soup, angle_deg)
    }

    /// Two `width`×`len` faces folded along a shared X-axis edge, each at its
    /// own angle from horizontal — a crease, so the two normals differ by
    /// `angle_b - angle_a` exactly.
    fn folded_quads(width: f32, len: f32, angle_a: f32, angle_b: f32) -> Vec<f32> {
        let dir = |deg: f32| {
            let r = deg.to_radians();
            (0.0f32, -r.cos() * len, -r.sin() * len)
        };
        let mut out = Vec::new();
        for deg in [angle_a, angle_b] {
            let (_, y, z) = dir(deg);
            // Winding p0,p1,p2 / p0,p2,p3 gives normal (0, sin α, −cos α).
            out.extend_from_slice(&[0.0, 0.0, 0.0, width, 0.0, 0.0, width, y, z]);
            out.extend_from_slice(&[0.0, 0.0, 0.0, width, y, z, 0.0, y, z]);
        }
        out
    }

    #[test]
    fn large_steep_flat_is_classified_as_overhang() {
        // A 30×30 mm face at 60° from horizontal: 900 mm² of down-facing
        // surface the angle rule calls self-supporting. It is the topple lever
        // the steep-flat pass exists for, so it must come back as a region.
        let regions = classify_overhangs_from_soup(&big_quad_at(30.0, 60.0), 45.0, 0.25);
        assert_region(&regions, 60.0, 900.0);
    }

    #[test]
    fn steep_flat_region_carries_a_usable_footprint() {
        // The density grid places only inside the region's projected footprint
        // and takes each point's Z from its surface raster, so the mask must
        // cover the projection (900 × cos 60° = 450 mm²) and follow the slope.
        let regions = classify_overhangs_from_soup(&big_quad_at(30.0, 60.0), 45.0, 0.25);
        assert_eq!(regions.len(), 1, "one region: {regions:?}");
        let f = &regions[0].footprint;
        let inside = f.data.iter().filter(|&&v| v == 1).count() as f32;
        let mask_area = inside * f.px_mm * f.px_mm;
        assert!(
            (mask_area - 450.0).abs() < 20.0,
            "mask covers the projected face: {mask_area} vs 450"
        );
        // Surface Z rises with y at tan(60°) across the face (y spans 0..15).
        let col = (f.width / 2) as usize;
        let row_of = |y: f32| (((y - f.origin_y) / f.px_mm) - 0.5).round() as usize;
        let z_lo = f.surface_z[row_of(1.0) * f.width as usize + col];
        let z_hi = f.surface_z[row_of(14.0) * f.width as usize + col];
        assert!(
            (z_hi - z_lo - 13.0 * 60f32.to_radians().tan()).abs() < 1.0,
            "surface raster follows the slope: {z_lo} → {z_hi}"
        );
    }

    #[test]
    fn small_steep_facet_is_not_classified() {
        // Half the area gate at 60° is a facet, not a lever — it stays
        // unsupported. Derived from the constant so tuning the gate does not
        // silently turn this into a test of something else.
        let side = (STEEP_FLAT_MIN_AREA_MM2 * 0.5).sqrt();
        let regions = classify_overhangs_from_soup(&big_quad_at(side, 60.0), 45.0, 0.25);
        assert!(
            regions.is_empty(),
            "{} mm² facet: {regions:?}",
            side * side
        );
    }

    #[test]
    fn steep_flat_past_the_ceiling_is_not_classified() {
        // Past the ceiling the face is a wall: a support rises vertically to
        // meet it and only grazes the surface, so there is no contact to
        // place. Clamped below vertical, which is the other end of the band.
        let angle = (STEEP_FLAT_MAX_ANGLE_DEG + 5.0).min(89.0);
        let regions = classify_overhangs_from_soup(&big_quad_at(30.0, angle), 45.0, 0.25);
        assert!(
            regions.is_empty(),
            "no contact on a wall at {angle}°: {regions:?}"
        );
    }

    #[test]
    fn crease_splits_a_patch_that_would_be_huge_only_together() {
        // Two faces just under the area gate, more than the growth tolerance
        // apart: neither is a lever on its own, and the growth must not fuse
        // them into one that is — a patch is one flat face, not every steep
        // triangle that happens to touch it.
        let tolerance = STEEP_FLAT_NORMAL_TOL_DEG;
        let angle_a = 50.0;
        let angle_b = angle_a + tolerance + 3.0;
        assert!(
            angle_b <= STEEP_FLAT_MAX_ANGLE_DEG,
            "fixture needs both angles inside [{}, {}]",
            45.0,
            STEEP_FLAT_MAX_ANGLE_DEG
        );
        let width = 15.0;
        let len = STEEP_FLAT_MIN_AREA_MM2 * 0.6 / width;
        let regions =
            classify_overhangs_from_soup(&folded_quads(width, len, angle_a, angle_b), 45.0, 0.25);
        assert!(
            regions.is_empty(),
            "crease held the patches apart: {regions:?}"
        );
    }

    #[test]
    fn two_disjoint_slopes_are_two_regions() {
        // Two separate rotated cubes far apart → two distinct regions.
        let mut soup = rotate_x(&unit_cube_soup(), 20.0);
        let second = rotate_x(&unit_cube_soup(), 20.0);
        for v in second.chunks_exact(3) {
            soup.extend_from_slice(&[v[0] + 100.0, v[1], v[2]]);
        }
        let regions = classify_overhangs_from_soup(&soup, 45.0, 0.25);
        assert_eq!(regions.len(), 2, "two disjoint slopes: {regions:?}");
        assert!((regions[0].angle_deg - 20.0).abs() < 1.5);
        assert!((regions[1].angle_deg - 20.0).abs() < 1.5);
        // Deterministic ordering: the two regions are ordered by root triangle id.
        assert!(regions[0].xy_min[0] < regions[1].xy_min[0]);
    }

    /// n×n grid of unit quads on the z=0 plane, wound with −Z normals so the
    /// whole thing is one giant down-facing overhang region (2n² triangles).
    fn grid_mesh(n: usize) -> IndexedMesh {
        let mut positions = Vec::with_capacity((n + 1) * (n + 1));
        let mut triangles = Vec::with_capacity(n * n * 2);
        for y in 0..=n {
            for x in 0..=n {
                positions.push(Vec3::new(x as f32, y as f32, 0.0));
            }
        }
        let idx = |x: usize, y: usize| (y * (n + 1) + x) as u32;
        for y in 0..n {
            for x in 0..n {
                let a = idx(x, y);
                let b = idx(x + 1, y);
                let c = idx(x + 1, y + 1);
                let d = idx(x, y + 1);
                triangles.push([a, c, b]); // −Z normal
                triangles.push([a, d, c]); // −Z normal
            }
        }
        IndexedMesh {
            positions,
            triangles,
        }
    }

    #[test]
    #[ignore]
    fn bench_overhang_classification() {
        use std::time::Instant;
        // 1M triangles (1000×1000 quads) — a single flat overhang region.
        let mesh = grid_mesh(1000);
        let tri_count = mesh.triangle_count();
        let start = Instant::now();
        let regions = classify_overhangs(&mesh, 45.0, 0.25);
        let elapsed = start.elapsed().as_secs_f64();
        eprintln!(
            "overhang bench: {} triangles -> {} regions in {:.1} ms ({:.1} Mtri/s, {} threads)",
            tri_count,
            regions.len(),
            elapsed * 1e3,
            (tri_count as f64 / 1e6) / elapsed,
            rayon::current_num_threads(),
        );
        assert_eq!(regions.len(), 1, "flat plane is one region");
    }

    /// n×n separate 1×1 quads, spaced 5mm apart, each its own overhang region.
    fn disjoint_quads_grid(n: usize) -> IndexedMesh {
        let mut positions = Vec::with_capacity(n * n * 4);
        let mut triangles = Vec::with_capacity(n * n * 2);
        let step = 5.0f32;
        for gy in 0..n {
            for gx in 0..n {
                let ox = gx as f32 * step;
                let oy = gy as f32 * step;
                let base = positions.len() as u32;
                positions.push(Vec3::new(ox, oy, 0.0));
                positions.push(Vec3::new(ox + 1.0, oy, 0.0));
                positions.push(Vec3::new(ox + 1.0, oy + 1.0, 0.0));
                positions.push(Vec3::new(ox, oy + 1.0, 0.0));
                triangles.push([base, base + 2, base + 1]); // −Z
                triangles.push([base, base + 3, base + 2]); // −Z
            }
        }
        IndexedMesh {
            positions,
            triangles,
        }
    }

    #[test]
    #[ignore]
    fn bench_overhang_many_regions() {
        use std::time::Instant;
        // 490k tiny regions / 980k triangles: stresses the parallel phases
        // (per-triangle classification, edge map, per-region build).
        let mesh = disjoint_quads_grid(700);
        let tri_count = mesh.triangle_count();
        let start = Instant::now();
        let regions = classify_overhangs(&mesh, 45.0, 0.25);
        let elapsed = start.elapsed().as_secs_f64();
        eprintln!(
            "overhang many-regions: {} triangles -> {} regions in {:.1} ms ({:.1} Mtri/s, {} threads)",
            tri_count,
            regions.len(),
            elapsed * 1e3,
            (tri_count as f64 / 1e6) / elapsed,
            rayon::current_num_threads(),
        );
        assert_eq!(regions.len(), 490_000, "one region per quad");
    }
}
