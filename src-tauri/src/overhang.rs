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
//!
//! The angle band and the area floor are both stand-ins for the quantity that
//! actually decides this — the moment the drag puts on the part versus the
//! moment gravity restores. [`compute_stability_report`] computes that moment
//! from the same posed mesh and logs it; it is not consumed yet, because
//! replacing the thresholds means calibrating one peel-pressure constant
//! against real models first.

use dragonfruit_mesh_repair::{core::mesh::Vec3, IndexedMesh};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

use rayon::prelude::*;

/// Steepest face a steep-flat patch may have (deg from horizontal) and still be
/// classified. Past this the face is a wall: a support rises vertically to meet
/// it and would only graze the surface, so there is no contact to place.
const STEEP_FLAT_MAX_ANGLE_DEG: f32 = 85.0;
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
    /// The peel-drag moment this patch carries (mm³): `Σ A·sinθ·z` over its
    /// triangles, with `z` the height above the part's own base — the same sum
    /// `compute_stability_report` totals for the whole pose. This is what
    /// decides whether the patch is worth covering: a steep face is
    /// self-supporting for formation, so contact on it only resists toppling,
    /// and the patch's share of the total is the constant-free measure of how
    /// much of that job it owns. Zero for a patch that does not lean at all.
    pub drag_moment_mm3: f32,
    /// XY direction the patch's drag pushes the part toward (deg, 0 = +X,
    /// 90 = +Y) — the side that lifts, and so the side a brace must hold down.
    pub drag_dir_deg: f32,
    /// True when this patch came from `classify_steep_flats`: a large planar
    /// face past the self-support angle. Those are the anti-topple patches —
    /// formation never needed them.
    pub steep_flat: bool,
    /// Triangle-accurate perimeter loops (world mm, each loop closed).
    /// Outer + hole boundaries extracted from region triangle adjacency,
    /// inset by `PERIMETER_CONTACT_INSET_MM` (0.25 mm) so a support's
    /// contact disc sits fully on the surface. Empty for degenerate regions.
    /// Used by the JS Poisson/grid stages instead of the voxel `contactVoxels`
    /// boundary when available — organic curves are not quantized to 0.25 mm.
    #[serde(default)]
    pub perimeter_loops: Vec<Vec<[f32; 3]>>,
}

/// Weld a world-space triangle soup (9 floats per triangle), classify overhang
/// regions, and compute the topple report from the same mesh. One weld serves
/// both, which is why they share an entry point: the soup for a dense model is
/// tens of megabytes and welding it twice is a second full hash pass. Mirrors
/// `scan_mesh_minima`'s stateless IPC shape.
pub fn overhang_and_stability_from_soup(
    positions: &[f32],
    self_support_angle_deg: f32,
    px_mm: f32,
) -> (Vec<OverhangRegion>, Option<StabilityReport>) {
    let mesh = IndexedMesh::from_triangle_soup(positions, 1e-5);
    let regions = classify_overhangs(&mesh, self_support_angle_deg, px_mm);
    let report = compute_stability_report(&mesh, self_support_angle_deg);
    (regions, report)
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

    // The part's own base plane: the drag moment is measured from it, exactly
    // as `compute_stability_report` does, so a region's share is comparable
    // with the pose total.
    let base_z = mesh
        .positions
        .iter()
        .map(|p| p.z)
        .fold(f32::INFINITY, f32::min);
    if !base_z.is_finite() {
        return Vec::new();
    }

    let mut regions: Vec<OverhangRegion> = groups
        .into_par_iter()
        .map(|(_, triangle_ids)| build_region(mesh, &normal, triangle_ids, px_mm, base_z, false))
        .collect();

    // Steep flats ride the same region shape, so the density grid, the surface
    // sampler and the perimeter ring all treat them as ordinary overhangs.
    regions.extend(classify_steep_flats(
        mesh, &normal, &edge_tris, threshold, px_mm, base_z,
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
    base_z: f32,
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
        out.push(build_region(mesh, normal, members, px_mm, base_z, true));
    }
    out
}

/// One line ranking the regions by the peel-drag moment they carry, largest
/// first — which patches own the toppling job. A steep face is self-supporting
/// for formation, so contact on it only resists toppling; a patch whose share
/// is negligible is decoration, and this is the number that says so. Shares are
/// against the pose total, so they need no calibrated constant.
pub fn region_moment_ranking(regions: &[OverhangRegion], total_mm3: f64, limit: usize) -> String {
    let mut ranked: Vec<(usize, &OverhangRegion)> = regions.iter().enumerate().collect();
    ranked.sort_by(|a, b| {
        b.1.drag_moment_mm3
            .total_cmp(&a.1.drag_moment_mm3)
            .then(a.0.cmp(&b.0))
    });
    let denominator = if total_mm3 > 1e-9 { total_mm3 } else { 0.0 };
    ranked
        .iter()
        .take(limit)
        .map(|(i, r)| {
            let share = if denominator > 0.0 {
                (r.drag_moment_mm3 as f64 / denominator) * 100.0
            } else {
                0.0
            };
            format!(
                "#{i} {} {:.0}° {:.0}mm² z {:.1}-{:.1} M {:.0} ({:.0}%) dir {:.0}°",
                if r.steep_flat { "steep" } else { "overhang" },
                r.angle_deg,
                r.area_mm2,
                r.min_z,
                r.max_z,
                r.drag_moment_mm3,
                share,
                r.drag_dir_deg,
            )
        })
        .collect::<Vec<_>>()
        .join(" · ")
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
    base_z: f32,
    steep_flat: bool,
) -> OverhangRegion {
    let mut area_mm2 = 0.0f32;
    let mut projected_area_mm2 = 0.0f32;
    let mut angle_weighted = 0.0f32;
    let mut drag_moment_mm3 = 0.0f32;
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

        // Drag moment, the same sum `compute_stability_report` totals: the
        // lateral component of a face's peel force (`A·sinθ`) at its height
        // above the part's own base. `sinθ = |n_xy|`.
        let sin_t = (n.x * n.x + n.y * n.y).sqrt();
        let face_z = (a.z + b.z + c.z) / 3.0 - base_z;
        if sin_t > 1e-6 && face_z > 0.0 {
            drag_moment_mm3 += area * sin_t * face_z;
        }

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
        drag_moment_mm3,
        drag_dir_deg: if normal[0].abs() > 1e-9 || normal[1].abs() > 1e-9 {
            normal[1].atan2(normal[0]).to_degrees().rem_euclid(360.0)
        } else {
            0.0
        },
        steep_flat,
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

// ---------------------------------------------------------------------------
// Topple analysis — logged, not yet consumed
// ---------------------------------------------------------------------------

/// Resin weight density (N/mm³) — 1.1 g/cm³ under gravity. Used to put the
/// gravity term in the same units as the peel pressure, so the two can be read
/// against each other.
const RESIN_WEIGHT_DENSITY_N_PER_MM3: f64 = 1.079e-5;
/// Plate-contact band (mm) the bearing hull is measured over. Matches the TS
/// stabilization pass's `BEARING_BAND_MM`, so both describe the same locus.
const STABILITY_BEARING_BAND_MM: f32 = 2.0;
/// Largest-moment faces the report names.
const STABILITY_MAX_DRIVERS: usize = 3;

/// Model-level topple analysis: the shape terms the fixed angle and area
/// thresholds cannot see.
///
/// A part fails by rotating about its bearing edge, so the quantity is a
/// MOMENT, not an area. Driving moment about a bearing-hull edge `e` whose
/// outward XY normal is `u`:
///
/// ```text
/// M_e = Σ_faces  A · sinθ · z · max(0, u · n̂_xy)      [mm³]
/// ```
///
/// with `A` the 3D face area, `θ` its angle from horizontal, `z` its centroid
/// height above the plate, `n̂_xy` the horizontal part of its normal. The
/// restoring moment is gravity, `ρ g V d_e`, where `d_e` is how far the volume
/// centroid sits inside edge `e`.
///
/// Both sides carry one unknown constant — the peel/suction pressure `p` and
/// the resin's weight density `ρ g` — so the ratio collapses to a single
/// LENGTH:
///
/// ```text
/// S_e = margin / L*     margin = V · d_e / M_e  [mm]     L* = p / (ρ g)  [mm]
/// ```
///
/// The pose topples iff `L* > margin`, so the report's job is to print
/// `margin` for real models: the distribution of that number over real prints
/// is what calibrates `L*`, and `L*` is the only constant a shape-aware
/// replacement for [`STEEP_FLAT_MIN_AREA_MM2`] and the TS stabilization gate
/// needs. See `docs/dev/auto-supports.md`.
///
/// Nothing consumes this yet. `margin` is infinite when no down-facing face
/// leans (`M_e = 0` — a part with no lateral drag cannot be rotated by it),
/// and `0` in the two cases where a static margin does not exist at all: a
/// bearing locus with no polygon (a point or edge contact), or a mesh that
/// encloses no volume (an open shell has no mass to restore anything).
#[derive(Debug, Clone)]
pub struct StabilityReport {
    /// Plate-contact band the bearing hull was measured over (mm).
    pub bearing_band_mm: f32,
    /// Absolute model volume (mm³) via the divergence theorem.
    pub volume_mm3: f64,
    /// Raw signed volume (mm³). Near zero means an open shell — the volume and
    /// centroid are then meaningless and `margin` collapses to 0.
    pub signed_volume_mm3: f64,
    /// Volume centroid in world space (mm); the bounding-box center when the
    /// mesh has no enclosed volume. Note this is WORLD z, not height above the
    /// plate — a rotated part's centroid z is not comparable to `height_mm/2`
    /// without `plate_z_mm`, which is exactly how one real reading got
    /// misdiagnosed as a mesh defect.
    pub centroid_mm: [f32; 3],
    /// World Z of the part's lowest point (mm) — the plane the bearing locus is
    /// measured from. Not necessarily the build plate: a part can be lifted
    /// above it, and then nothing touches the plate at all.
    pub plate_z_mm: f32,
    /// Part height above the bearing plane (mm).
    pub height_mm: f32,
    /// XY area of the bearing hull (mm²).
    pub bearing_area_mm2: f32,
    /// Bearing hull edge count; 0 = no bearing polygon (point/edge/sliver).
    pub bearing_edges: usize,
    /// Worst hull edge: outward normal angle in XY (deg, 0 = +X, 90 = +Y,
    /// wrapped to [0, 360)).
    pub worst_edge_dir_deg: f32,
    /// Worst hull edge: how far the centroid sits inside it (mm). Negative
    /// means the centroid is already outside the bearing polygon.
    pub centroid_depth_mm: f32,
    /// Worst hull edge: how far the bearing patch's own centroid sits inside
    /// it (mm). Always positive — a hull centroid is inside its hull by
    /// construction. This is the lever the plate adhesion works on.
    pub contact_depth_mm: f32,
    /// Drag moment summed over every down-facing face, unprojected — how much
    /// lateral drag the pose carries in total (mm³).
    pub drag_moment_mm3: f64,
    /// That moment projected onto the worst bearing edge — the divisor the
    /// margin was computed from (mm³). Zero when there is no bearing polygon.
    pub worst_edge_drag_mm3: f64,
    /// Share of that sum from faces at or above the self-support angle — what
    /// the steep-flat classifier can see today.
    pub steep_band_share: f32,
    /// Moment-weighted drag height (mm) **above the part's own base** — the
    /// lever arm of the total moment, `Σ A·sinθ·z² / Σ A·sinθ·z`. Biased above
    /// the faces' arithmetic mean height because the drag on a face grows with
    /// its height.
    pub drag_height_mm: f32,
    /// `V · d_e / M_e` (mm) — the gravity term's geometry. **This is not a
    /// restoring margin.** A bottom-up printer hangs the part from the plate,
    /// so in the model frame gravity points +z, away from the plate: it PEELS,
    /// and it adds to the drag rather than opposing it. See `gravity_peel_mpa`.
    pub margin_mm: f32,
    /// The gravity term as a pressure (MPa): `ρg·V·d_e / M_e`. In a bottom-up
    /// machine the peel has to beat gravity as well as the plate adhesion, so
    /// this belongs on the driving side and is directly comparable to `p`
    /// (10–50 kPa at the film). Measured at ~1.9e-5 MPa on a 79 cm³ part, i.e.
    /// ~0.06 % of a 30 kPa peel — negligible next to the drag, but not zero and
    /// not restoring.
    pub gravity_peel_mpa: f64,
    /// `A_contact · d̄_e / M_e` (dimensionless): the bearing patch's first
    /// moment about the worst edge over the drag moment. The pose lifts off the
    /// plate iff `p/σ > adhesion_ratio`, where `σ` is the plate adhesion — a
    /// dimensionless constant of order 0.005–0.05, unlike the metres-long `L*`.
    /// This is the comparison that means something in a bottom-up machine:
    /// gravity is 2–3 orders of magnitude too weak to be the restoring force.
    pub adhesion_ratio: f64,
    /// Heights of the largest-moment faces (mm, ascending, deduped within
    /// 1 mm) — which patch drives the moment.
    pub driver_heights_mm: Vec<f32>,
    /// Down-facing faces with a lateral normal component.
    pub drag_faces: usize,
    /// Zero-area triangles in the mesh. They are excluded from the plate plane
    /// and the bearing locus, and a nonzero count means the file is defective.
    pub degenerate_faces: usize,
}

impl StabilityReport {
    /// One greppable line. Every field the calibration reads appears here.
    pub fn to_log_line(&self) -> String {
        // The centroid is world-absolute, so it is paired with its height above
        // the part's own lowest point — the number `height_mm / 2` is
        // comparable to, and the one whose absence made a tilted cube look like
        // a defective mesh.
        let centroid = format!(
            "({:.1}, {:.1}, {:.1}) [{:.1} above the part's base]",
            self.centroid_mm[0],
            self.centroid_mm[1],
            self.centroid_mm[2],
            self.centroid_mm[2] - self.plate_z_mm,
        );
        // Only when it says something the absolute volume does not: an inverted
        // winding (negative) or an open shell (no enclosed volume at all, in
        // which case the centroid is the bounding-box center).
        let volume = if self.signed_volume_mm3 < 0.0 || self.volume_mm3 < 1e-6 {
            format!(
                "{:.1}mm³ (signed {:.1} — inverted or open shell)",
                self.volume_mm3, self.signed_volume_mm3
            )
        } else {
            format!("{:.1}mm³", self.volume_mm3)
        };
        // A defective mesh explains numbers that would otherwise look wrong.
        let defects = if self.degenerate_faces > 0 {
            format!(
                " · {} degenerate faces ignored (defective mesh)",
                self.degenerate_faces
            )
        } else {
            String::new()
        };
        if self.drag_faces == 0 {
            return format!(
                "margin ∞ · adhesion ∞ (no down-facing drag) · volume {volume} · centroid {} · height {:.1}mm · \
                 bearing {:.1}mm² over {} edges (band {:.1}mm){defects}",
                centroid,
                self.height_mm,
                self.bearing_area_mm2,
                self.bearing_edges,
                self.bearing_band_mm,
            );
        }
        // A pose with no bearing polygon has no static margin at all, whatever
        // the drag — say that instead of printing a zeroed direction.
        // In a bottom-up machine the part hangs from the plate, so this is the
        // gravity term's geometry, not a restoring margin: gravity peels too.
        let margin = if self.bearing_edges == 0 {
            "gravity lever 0.00mm (no bearing polygon — point/edge contact)".to_string()
        } else if self.margin_mm.is_finite() {
            format!(
                "gravity lever {:.2}mm · peel {:.1}e-5MPa (driving, not restoring)",
                self.margin_mm,
                self.gravity_peel_mpa * 1e5
            )
        } else {
            "gravity lever ∞ (no drag on the worst edge)".to_string()
        };
        // The comparison that means something in a bottom-up machine: gravity
        // is 2-3 orders of magnitude too weak to restore anything, the plate's
        // adhesion is not. Same drag moment, different lever.
        let adhesion = if self.bearing_edges == 0 {
            "adhesion — (no bearing polygon to lift from)".to_string()
        } else if self.adhesion_ratio.is_finite() {
            format!("adhesion {:.3} (lifts iff p/σ > it)", self.adhesion_ratio)
        } else {
            "adhesion ∞ (no drag on the worst edge)".to_string()
        };
        let worst_edge = if self.bearing_edges == 0 {
            String::new()
        } else {
            format!(
                " · worst edge {:.0}mm³ dir {:.0}° depth {:.2}mm (contact {:.2}mm)",
                self.worst_edge_drag_mm3,
                self.worst_edge_dir_deg,
                self.centroid_depth_mm,
                self.contact_depth_mm,
            )
        };
        let drivers = self
            .driver_heights_mm
            .iter()
            .map(|z| format!("{z:.1}"))
            .collect::<Vec<_>>()
            .join("/");
        format!(
            "{margin} · {adhesion} · volume {volume} · centroid {} · height {:.1}mm · bearing {:.1}mm² over {} edges \
             (band {:.1}mm){worst_edge} · drag {:.0}mm³ over {} faces (steep share {:.0}%, z* {:.1}mm) · \
             drivers z {drivers}mm{defects}",
            centroid,
            self.height_mm,
            self.bearing_area_mm2,
            self.bearing_edges,
            self.bearing_band_mm,
            self.drag_moment_mm3,
            self.drag_faces,
            self.steep_band_share * 100.0,
            self.drag_height_mm,
        )
    }
}

/// Compute the topple report for a posed mesh (world space, plate at the
/// model's minimum Z). Returns `None` for a mesh with no triangles.
///
/// Deterministic: faces are visited in id order, the bearing points are sorted,
/// and the sums are accumulated in that order — no parallelism, so the floats
/// are reproducible run to run. Cost is one face pass with an inner loop over
/// the bearing hull's edges (a handful in practice), so it stays linear in the
/// triangle count. It recomputes the face normals `classify_overhangs` already
/// has rather than taking them as an argument: sharing them would change that
/// function's signature and every one of its callers for a diagnostic, and
/// folding the two into one pass is the right move only once this report
/// actually replaces a threshold.
pub fn compute_stability_report(
    mesh: &IndexedMesh,
    self_support_angle_deg: f32,
) -> Option<StabilityReport> {
    let tri_count = mesh.triangle_count();
    if tri_count == 0 {
        return None;
    }
    // The plate plane and the bearing locus come from NON-degenerate triangles
    // only. A zero-area triangle is a mesh defect (a stray vertex, a collapsed
    // face), and letting one define z_min empties the bearing band: a single
    // stray vertex 10 mm below a 20 mm cube made the report describe a pose
    // with no contact at all, at a height 10 mm too tall. Measured on a real
    // model whose bbox was 30.75 × 23.5 × 30.8 mm for a volume of exactly
    // 20³ mm³ — the giveaway that the extent was defect, not geometry.
    let mut z_min = f32::INFINITY;
    let mut z_max = f32::NEG_INFINITY;
    let mut degenerate_faces = 0usize;
    for fi in 0..tri_count as u32 {
        if mesh.tri_area(fi) <= 0.0 {
            degenerate_faces += 1;
            continue;
        }
        for v in mesh.tri_positions(fi) {
            if v.z < z_min {
                z_min = v.z;
            }
            if v.z > z_max {
                z_max = v.z;
            }
        }
    }
    if !z_min.is_finite() {
        return None;
    }

    // Bearing locus: hull of everything within the contact band of the plate.
    let mut bearing: Vec<(f32, f32)> = Vec::new();
    for fi in 0..tri_count as u32 {
        if mesh.tri_area(fi) <= 0.0 {
            continue;
        }
        for v in mesh.tri_positions(fi) {
            if v.z - z_min <= STABILITY_BEARING_BAND_MM {
                bearing.push((v.x, v.y));
            }
        }
    }
    let hull = convex_hull_2d(&mut bearing);
    let bearing_area_mm2 = polygon_area_2d(&hull);
    // The patch's own centroid — the lever the plate adhesion works on, which
    // is a different point from the volume centroid a leaning part carries.
    let contact_centroid = polygon_centroid_2d(&hull);

    // Bearing edges, as (outward normal xy, a point on the edge). The hull is
    // CCW, so the outward normal is the edge direction rotated -90°. Degenerate
    // edges are dropped here rather than skipped later.
    let edges: Vec<(f64, f64, f64, f64)> = (0..hull.len())
        .filter_map(|i| {
            let a = hull[i];
            let b = hull[(i + 1) % hull.len()];
            let (ex, ey) = ((b.0 - a.0) as f64, (b.1 - a.1) as f64);
            let len = (ex * ex + ey * ey).sqrt();
            if len <= 1e-9 {
                return None;
            }
            Some((ey / len, -ex / len, a.0 as f64, a.1 as f64))
        })
        .collect();
    let mut edge_sums = vec![0.0f64; edges.len()];

    // Volume, volume centroid and the drag moment per bearing edge: one pass.
    let steep_threshold = -self_support_angle_deg.to_radians().cos();
    let mut vol6 = 0.0f64;
    let mut com = [0.0f64; 3];
    let mut drag_total = 0.0f64;
    let mut drag_steep = 0.0f64;
    let mut drag_z = 0.0f64;
    let mut drag_faces = 0usize;
    let mut drivers: Vec<(f64, f32)> = Vec::with_capacity(STABILITY_MAX_DRIVERS + 1);

    for fi in 0..tri_count as u32 {
        let [a, b, c] = mesh.tri_positions(fi);
        let (ax, ay, az) = (a.x as f64, a.y as f64, a.z as f64);
        let (bx, by, bz) = (b.x as f64, b.y as f64, b.z as f64);
        let (gx, gy, gz) = (c.x as f64, c.y as f64, c.z as f64);

        // Signed tetra volume about the origin; the centroid is the same sum
        // weighted by the tetra centroid (a+b+c)/4.
        let det = ax * (by * gz - bz * gy) - ay * (bx * gz - bz * gx) + az * (bx * gy - by * gx);
        vol6 += det;
        com[0] += det * (ax + bx + gx) * 0.25;
        com[1] += det * (ay + by + gy) * 0.25;
        com[2] += det * (az + bz + gz) * 0.25;

        let n = mesh.tri_normal(fi);
        if n.z >= 0.0 {
            continue; // up-facing or vertical: peel drag pulls it onto the part
        }
        // |n_xy| = sinθ. A flat ceiling's drag is purely vertical, and a
        // vertical wall has no contact to place — neither rotates the part.
        let sin_t = ((n.x * n.x + n.y * n.y) as f64).sqrt();
        if sin_t <= 1e-6 {
            continue;
        }
        // The arm is the height above the part's OWN base, not the world Z: a
        // pose lifted off the plate would otherwise inflate every moment by the
        // lift. Matches `measurePoseStability` in the orientation advisor.
        let z = (az + bz + gz) / 3.0 - z_min as f64;
        if z <= 0.0 {
            continue;
        }
        let area = mesh.tri_area(fi) as f64;
        let moment = area * sin_t * z;
        drag_faces += 1;
        drag_total += moment;
        drag_z += moment * z;
        if n.z >= steep_threshold {
            drag_steep += moment;
        }

        // Per-edge moment, projected exactly: the horizontal normal is
        // `n_xy` (length sinθ), so `A · (n_xy · u) · z` needs no re-normalizing
        // and no direction binning — a binned distribution leaks moment onto
        // edges the face does not push on at all.
        let (nhx, nhy) = (n.x as f64, n.y as f64);
        for (ei, e) in edges.iter().enumerate() {
            let proj = nhx * e.0 + nhy * e.1;
            if proj > 0.0 {
                edge_sums[ei] += area * proj * z;
            }
        }

        if drivers.len() < STABILITY_MAX_DRIVERS || drivers.last().is_some_and(|d| moment > d.0) {
            drivers.push((moment, z as f32));
            drivers.sort_by(|p, q| q.0.total_cmp(&p.0));
            drivers.truncate(STABILITY_MAX_DRIVERS);
        }
    }

    let signed_volume_mm3 = vol6 / 6.0;
    let volume_mm3 = signed_volume_mm3.abs();
    let centroid_mm = if vol6.abs() > 1e-9 {
        [
            (com[0] / vol6) as f32,
            (com[1] / vol6) as f32,
            (com[2] / vol6) as f32,
        ]
    } else {
        // Open or degenerate shell: no enclosed volume, so no mass. The
        // bounding-box center still orients the report.
        let c = mesh.bbox().center();
        [c.x, c.y, c.z]
    };

    let mut driver_heights_mm: Vec<f32> = drivers.iter().map(|d| d.1).collect();
    driver_heights_mm.sort_by(f32::total_cmp);
    driver_heights_mm.dedup_by(|a, b| (*a - *b).abs() < 1.0);

    // Worst bearing edge: the least margin. The centroid's depth is measured
    // INWARD, so it is positive while the mass is still over the edge. A mesh
    // with no enclosed volume has no restoring moment at all, so its margin is
    // 0 (least stable) rather than infinite — the drag never even enters.
    let mut worst: Option<(f32, f32, f32, f32, f64)> = None;
    for (ei, e) in edges.iter().enumerate() {
        let depth = (e.2 - centroid_mm[0] as f64) * e.0 + (e.3 - centroid_mm[1] as f64) * e.1;
        let contact_depth = contact_centroid
            .map(|c| (e.2 - c.0) * e.0 + (e.3 - c.1) * e.1)
            .unwrap_or(0.0);
        let sum = edge_sums[ei];
        let margin = if volume_mm3 <= 1e-9 {
            0.0
        } else if sum > 1e-9 {
            (volume_mm3 * depth / sum) as f32
        } else {
            f32::INFINITY
        };
        // Wrapped to [0, 360): atan2 of a negative-zero normal component
        // otherwise reports -180 for the same edge as +180.
        let dir_deg = e.1.atan2(e.0).to_degrees().rem_euclid(360.0) as f32;
        if worst.is_none_or(|w| margin < w.0) {
            worst = Some((margin, dir_deg, depth as f32, contact_depth as f32, sum));
        }
    }
    let (margin_mm, worst_edge_dir_deg, centroid_depth_mm, contact_depth_mm, worst_edge_drag_mm3) =
        match worst {
            // A point or edge contact has no bearing polygon: no static margin.
            Some((margin, dir, depth, contact_depth, sum)) => {
                (margin, dir, depth, contact_depth, sum)
            }
            None => (0.0, 0.0, 0.0, 0.0, 0.0),
        };
    let adhesion_ratio = if worst_edge_drag_mm3 > 1e-9 {
        (bearing_area_mm2 as f64 * contact_depth_mm as f64) / worst_edge_drag_mm3
    } else {
        f64::INFINITY
    };

    Some(StabilityReport {
        bearing_band_mm: STABILITY_BEARING_BAND_MM,
        volume_mm3,
        signed_volume_mm3,
        centroid_mm,
        plate_z_mm: z_min,
        height_mm: z_max - z_min,
        bearing_area_mm2,
        bearing_edges: edges.len(),
        worst_edge_dir_deg,
        centroid_depth_mm,
        contact_depth_mm,
        drag_moment_mm3: drag_total,
        worst_edge_drag_mm3,
        steep_band_share: if drag_total > 1e-9 {
            (drag_steep / drag_total) as f32
        } else {
            0.0
        },
        drag_height_mm: if drag_total > 1e-9 {
            (drag_z / drag_total) as f32
        } else {
            0.0
        },
        margin_mm,
        gravity_peel_mpa: if worst_edge_drag_mm3 > 1e-9 {
            RESIN_WEIGHT_DENSITY_N_PER_MM3 * volume_mm3 * centroid_depth_mm as f64
                / worst_edge_drag_mm3
        } else {
            0.0
        },
        adhesion_ratio,
        driver_heights_mm,
        drag_faces,
        degenerate_faces,
    })
}

/// Andrew monotone chain, CCW, collinear points dropped. Sorts in place and
/// returns an empty vec for fewer than three non-collinear points — the
/// caller reads that as "no bearing polygon".
fn convex_hull_2d(points: &mut Vec<(f32, f32)>) -> Vec<(f32, f32)> {
    points.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    points.dedup();
    if points.len() < 3 {
        return Vec::new();
    }
    let cross = |o: (f32, f32), a: (f32, f32), b: (f32, f32)| -> f32 {
        (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
    };
    let mut hull: Vec<(f32, f32)> = Vec::with_capacity(points.len() * 2);
    for &p in points.iter() {
        while hull.len() >= 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0 {
            hull.pop();
        }
        hull.push(p);
    }
    let lower_len = hull.len();
    for &p in points[..points.len() - 1].iter().rev() {
        while hull.len() > lower_len && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0
        {
            hull.pop();
        }
        hull.push(p);
    }
    hull.pop(); // the walk closes back on the first point
    if hull.len() < 3 {
        Vec::new()
    } else {
        hull
    }
}

fn polygon_area_2d(points: &[(f32, f32)]) -> f32 {
    if points.len() < 3 {
        return 0.0;
    }
    let mut area = 0.0f64;
    for i in 0..points.len() {
        let p = points[i];
        let q = points[(i + 1) % points.len()];
        area += p.0 as f64 * q.1 as f64 - q.0 as f64 * p.1 as f64;
    }
    (area.abs() / 2.0) as f32
}

/// Area centroid of a simple polygon (shoelace), `None` for a degenerate one.
fn polygon_centroid_2d(points: &[(f32, f32)]) -> Option<(f64, f64)> {
    if points.len() < 3 {
        return None;
    }
    let mut area2 = 0.0f64;
    let mut cx = 0.0f64;
    let mut cy = 0.0f64;
    for i in 0..points.len() {
        let p = points[i];
        let q = points[(i + 1) % points.len()];
        let cross = p.0 as f64 * q.1 as f64 - q.0 as f64 * p.1 as f64;
        area2 += cross;
        cx += (p.0 as f64 + q.0 as f64) * cross;
        cy += (p.1 as f64 + q.1 as f64) * cross;
    }
    if area2.abs() <= 1e-9 {
        return None;
    }
    Some((cx / (3.0 * area2), cy / (3.0 * area2)))
}

/// Tauri IPC command: weld a world-space triangle soup (9 floats per triangle)
/// and classify overhang regions with projected-footprint masks. Stateless —
/// no model cache. Mirrors `scan_mesh_minima`'s shape.
///
/// Also emits the topple report ([`compute_stability_report`]) on the same
/// welded soup. This command is the one every model passes through — the
/// sideload path re-classifies here because its triangle ids do not match the
/// rendered geometry, and the client-side fallback has nowhere else to run —
/// so the report is logged here rather than from `scan_islands_from_path`.
#[tauri::command]
pub async fn scan_overhangs(
    positions: Vec<f32>,
    self_support_angle_deg: f32,
    px_mm: f32,
    label: Option<String>,
) -> Result<Vec<OverhangRegion>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (regions, report) =
            overhang_and_stability_from_soup(&positions, self_support_angle_deg, px_mm);
        if let Some(report) = &report {
            log::info!(
                "[stability] {}: {}",
                label.as_deref().unwrap_or("world soup"),
                report.to_log_line(),
            );
            if !regions.is_empty() {
                log::info!(
                    "[stability] regions by drag moment (pose total {:.0}mm³): {}",
                    report.drag_moment_mm3,
                    region_moment_ranking(&regions, report.drag_moment_mm3, 4),
                );
            }
        }
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
        let regions = overhang_and_stability_from_soup(&soup, 45.0, 0.25).0;
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
        let regions = overhang_and_stability_from_soup(&soup, 45.0, 0.25).0;
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
        let regions = overhang_and_stability_from_soup(&soup, 45.0, 0.25).0;
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
        let regions = overhang_and_stability_from_soup(&quad_at(90.0), 45.0, 0.25).0;
        assert!(
            regions.is_empty(),
            "no overhang on a vertical wall: {regions:?}"
        );
    }

    #[test]
    fn slope_steeper_than_threshold_is_self_supporting() {
        // 60° slope: self-supporting at the 45° threshold, flagged at 70°.
        let soup60 = quad_at(60.0);
        let regions = overhang_and_stability_from_soup(&soup60, 45.0, 0.25).0;
        assert!(
            regions.is_empty(),
            "60° slope must be self-supporting at 45°: {regions:?}"
        );
        let regions70 = overhang_and_stability_from_soup(&soup60, 70.0, 0.25).0;
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
        let regions = overhang_and_stability_from_soup(&big_quad_at(30.0, 60.0), 45.0, 0.25).0;
        assert_region(&regions, 60.0, 900.0);
    }

    #[test]
    fn steep_flat_region_carries_a_usable_footprint() {
        // The density grid places only inside the region's projected footprint
        // and takes each point's Z from its surface raster, so the mask must
        // cover the projection (900 × cos 60° = 450 mm²) and follow the slope.
        let regions = overhang_and_stability_from_soup(&big_quad_at(30.0, 60.0), 45.0, 0.25).0;
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
        let regions = overhang_and_stability_from_soup(&big_quad_at(side, 60.0), 45.0, 0.25).0;
        assert!(regions.is_empty(), "{} mm² facet: {regions:?}", side * side);
    }

    #[test]
    fn steep_flat_past_the_ceiling_is_not_classified() {
        // Past the ceiling the face is a wall: a support rises vertically to
        // meet it and only grazes the surface, so there is no contact to
        // place. Clamped below vertical, which is the other end of the band.
        let angle = (STEEP_FLAT_MAX_ANGLE_DEG + 5.0).min(89.0);
        let regions = overhang_and_stability_from_soup(&big_quad_at(30.0, angle), 45.0, 0.25).0;
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
            overhang_and_stability_from_soup(&folded_quads(width, len, angle_a, angle_b), 45.0, 0.25).0;
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
        let regions = overhang_and_stability_from_soup(&soup, 45.0, 0.25).0;
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

    // ---- topple report -------------------------------------------------

    /// Extrude a CCW polygon in the XZ plane along +Y, outward-wound.
    fn prism(section: &[(f32, f32)], width: f32) -> Vec<f32> {
        let mut out: Vec<f32> = Vec::new();
        for i in 0..section.len() {
            let p = section[i];
            let q = section[(i + 1) % section.len()];
            let a = [p.0, 0.0, p.1];
            let b = [q.0, 0.0, q.1];
            let c = [q.0, width, q.1];
            let d = [p.0, width, p.1];
            for v in [a, c, b, a, d, c] {
                out.extend_from_slice(&v);
            }
        }
        // Caps: fan from the first vertex, +Y cap reversed.
        for i in 1..section.len() - 1 {
            let p0 = section[0];
            let pi = section[i];
            let pj = section[i + 1];
            for v in [
                [p0.0, 0.0, p0.1],
                [pi.0, 0.0, pi.1],
                [pj.0, 0.0, pj.1],
                [p0.0, width, p0.1],
                [pj.0, width, pj.1],
                [pi.0, width, pi.1],
            ] {
                out.extend_from_slice(&v);
            }
        }
        out
    }

    /// A slab of thickness `thickness` leaning `lean_deg` from horizontal,
    /// rising `h`, standing on a flat foot `[0, f] × [0, t]`. The slab's
    /// underside is a down-facing face at exactly `lean_deg`.
    fn leaning_tower(f: f32, t: f32, thickness: f32, h: f32, lean_deg: f32) -> Vec<f32> {
        let d = h / lean_deg.to_radians().tan();
        let section = [
            (0.0, 0.0),
            (f, 0.0),
            (f, t),
            (f - d, t + h),
            (f - d - thickness, t + h),
            (f - thickness, t),
            (0.0, t),
        ];
        prism(&section, 10.0)
    }

    fn report_for(soup: &[f32], angle_deg: f32) -> StabilityReport {
        let mesh = IndexedMesh::from_triangle_soup(soup, 1e-5);
        compute_stability_report(&mesh, angle_deg).expect("report")
    }

    #[test]
    fn flat_base_cube_has_no_drag_and_no_margin_limit() {
        let r = report_for(&unit_cube_soup(), 45.0);
        // The only down-facing face is the bottom, whose drag is vertical.
        assert_eq!(r.drag_faces, 0);
        assert!(r.margin_mm.is_infinite(), "margin {}", r.margin_mm);
        assert!(
            (r.volume_mm3 - 1000.0).abs() < 1.0,
            "volume {}",
            r.volume_mm3
        );
        assert!(r.signed_volume_mm3 > 0.0, "outward winding");
        assert!((r.centroid_mm[0] - 5.0).abs() < 0.01);
        assert!((r.centroid_mm[1] - 5.0).abs() < 0.01);
        assert!((r.centroid_mm[2] - 5.0).abs() < 0.01);
        assert!((r.height_mm - 10.0).abs() < 0.01);
        assert_eq!(r.bearing_edges, 4);
        assert!((r.bearing_area_mm2 - 100.0).abs() < 0.01);
    }

    #[test]
    fn edge_down_pose_has_no_bearing_polygon() {
        // A cube on an edge: the bearing locus is a line, so there is no
        // static margin whatever the drag — the same verdict the TS
        // stabilization gate reaches through its 4 mm² hull-area floor.
        let r = report_for(&rotate_x(&unit_cube_soup(), 30.0), 45.0);
        assert_eq!(r.bearing_edges, 0);
        assert_eq!(r.bearing_area_mm2, 0.0);
        assert_eq!(r.margin_mm, 0.0);
        // Underside facet (30°) plus the now-down-facing former -Y face (60°).
        assert_eq!(r.drag_faces, 4);
        assert!(
            (r.steep_band_share - 0.75).abs() < 0.05,
            "steep share {}",
            r.steep_band_share
        );
        // The pose carries real drag (100·0.5·2.5 + 100·0.866·4.33 ≈ 500 mm³)
        // but there is no edge to project it onto, so the worst-edge figure is
        // zero and the log must not read as "no drag".
        assert!((r.drag_moment_mm3 - 500.0).abs() < 2.0, "total {}", r.drag_moment_mm3);
        assert_eq!(r.worst_edge_drag_mm3, 0.0);
        let line = r.to_log_line();
        assert!(line.contains("no bearing polygon"), "{line}");
        assert!(line.contains("drag 500mm³ over 4 faces"), "{line}");
        assert!(!line.contains("worst edge"), "{line}");
    }

    #[test]
    fn steeper_lean_is_all_steep_band_and_flatter_is_none() {
        let steep = report_for(&leaning_tower(20.0, 2.0, 3.0, 6.0, 60.0), 45.0);
        assert_eq!(steep.drag_faces, 2, "the slab underside only");
        assert!((steep.steep_band_share - 1.0).abs() < 1e-6);
        // The moment-weighted height sits above the faces' arithmetic mean
        // (t + h/2 = 5) and no higher than the top of the face (t + h = 8);
        // the underside is one quad split at z = t+h/3 and t+2h/3.
        assert!(
            steep.drag_height_mm > 5.0 && steep.drag_height_mm <= 6.0,
            "z* {}",
            steep.drag_height_mm
        );
        assert_eq!(steep.driver_heights_mm, vec![4.0, 6.0]);

        let flat = report_for(&leaning_tower(20.0, 2.0, 3.0, 6.0, 30.0), 45.0);
        assert_eq!(flat.drag_faces, 2);
        assert_eq!(
            flat.steep_band_share, 0.0,
            "30° is below the self-support angle"
        );
        assert!(flat.drag_moment_mm3 > 0.0);
    }

    #[test]
    fn same_footprint_taller_part_has_less_margin() {
        // The whole point of the report: the same drag face on a taller part
        // is a longer lever. The area threshold cannot tell these apart.
        // Analytic values for both, from the section (foot 20×2, slab 3 thick)
        // and the 60° underside: V = 580 / 760 mm³, d = 12.10 / 12.39 mm,
        // M = 300 / 960 mm³ → margin 23.4 / 9.8 mm.
        let short = report_for(&leaning_tower(20.0, 2.0, 3.0, 6.0, 60.0), 45.0);
        let tall = report_for(&leaning_tower(20.0, 2.0, 3.0, 12.0, 60.0), 45.0);
        assert!(
            (short.volume_mm3 - 580.0).abs() < 2.0,
            "volume {}",
            short.volume_mm3
        );
        assert!(
            (tall.volume_mm3 - 760.0).abs() < 2.0,
            "volume {}",
            tall.volume_mm3
        );
        // The worst edge is the one the drag pushes toward (−X), not the
        // nearest edge — the mass sits 12.1 mm inside it.
        assert!(
            (short.centroid_depth_mm - 12.10).abs() < 0.05,
            "{}",
            short.centroid_depth_mm
        );
        assert!(
            (tall.centroid_depth_mm - 12.39).abs() < 0.05,
            "{}",
            tall.centroid_depth_mm
        );
        assert!(
            (short.worst_edge_dir_deg - 180.0).abs() < 0.01,
            "{}",
            short.worst_edge_dir_deg
        );
        assert!(
            (short.drag_moment_mm3 - 300.0).abs() < 1.0,
            "{}",
            short.drag_moment_mm3
        );
        assert!(
            (tall.drag_moment_mm3 - 960.0).abs() < 1.0,
            "{}",
            tall.drag_moment_mm3
        );
        // The whole drag pushes one way and the worst edge faces it, so the
        // projected figure equals the total here.
        assert!(
            (short.worst_edge_drag_mm3 - 300.0).abs() < 1.0,
            "{}",
            short.worst_edge_drag_mm3
        );
        assert!(
            (tall.worst_edge_drag_mm3 - 960.0).abs() < 1.0,
            "{}",
            tall.worst_edge_drag_mm3
        );
        assert!(
            (short.margin_mm - 23.39).abs() < 0.3,
            "margin {}",
            short.margin_mm
        );
        // The adhesion side of the same pose: the patch's first moment about
        // the worst edge over the drag moment, A·d̄/M = 200·10/300. It is the
        // comparison that survives a leaning pose, where the gravity margin
        // goes negative: the patch centroid is always inside its own hull.
        assert!((short.contact_depth_mm - 10.0).abs() < 0.01, "{}", short.contact_depth_mm);
        assert!((tall.contact_depth_mm - 10.0).abs() < 0.01, "{}", tall.contact_depth_mm);
        assert!(
            (short.adhesion_ratio - 6.6667).abs() < 0.01,
            "ratio {}",
            short.adhesion_ratio
        );
        assert!(
            (tall.adhesion_ratio - 2.0833).abs() < 0.01,
            "ratio {}",
            tall.adhesion_ratio
        );
        assert!(tall.adhesion_ratio < short.adhesion_ratio);
        assert!(
            (tall.margin_mm - 9.81).abs() < 0.3,
            "margin {}",
            tall.margin_mm
        );
        assert!(tall.margin_mm < short.margin_mm);
        // Height is the live term: both carry the identical underside face.
        assert!(tall.drag_height_mm > short.drag_height_mm);
    }

    #[test]
    fn centroid_past_the_bearing_edge_has_negative_margin() {
        // Leaned far enough that the mass is no longer over the foot.
        let r = report_for(&leaning_tower(20.0, 2.0, 3.0, 100.0, 60.0), 45.0);
        assert!(r.centroid_mm[0] < 0.0, "centroid x {}", r.centroid_mm[0]);
        assert!(r.centroid_depth_mm < 0.0, "depth {}", r.centroid_depth_mm);
        assert!(r.margin_mm < 0.0, "margin {}", r.margin_mm);
    }

    #[test]
    fn steep_flat_region_carries_its_drag_moment_and_direction() {
        // A 60° quad, sized past the steep-flat area floor: it is a steep flat,
        // it leans, and its drag pushes along its own normal's XY direction.
        let side = STEEP_FLAT_MIN_AREA_MM2 * 0.6;
        let soup = big_quad_at(side, 60.0);
        let (regions, report) = overhang_and_stability_from_soup(&soup, 45.0, 0.25);
        let report = report.expect("report");
        assert_eq!(regions.len(), 1, "{regions:?}");
        let r = &regions[0];
        assert!(r.steep_flat, "came from the steep-flat pass");
        assert!(r.drag_moment_mm3 > 0.0, "moment {}", r.drag_moment_mm3);
        // The quad starts facing -Z and is rotated 60° about X, so its mean
        // normal's XY part points +Y (90°), not -Y.
        assert!((r.drag_dir_deg - 90.0).abs() < 1.0, "dir {}", r.drag_dir_deg);
        // The region's moment is the pose's whole moment here: one patch.
        // The region sums in f32, so the tolerance is set by its magnitude.
        assert!(
            (r.drag_moment_mm3 as f64 - report.drag_moment_mm3).abs() < 0.5,
            "region {} vs pose {}",
            r.drag_moment_mm3,
            report.drag_moment_mm3,
        );
        let line = region_moment_ranking(&regions, report.drag_moment_mm3, 4);
        assert!(line.starts_with("#0 steep 60°"), "{line}");
        assert!(line.contains("(100%)"), "{line}");
    }

    #[test]
    fn a_region_that_does_not_lean_carries_no_moment() {
        // A 30° quad is a plain overhang below the steep-flat band, and its
        // moment is what the pose total says it is.
        let (regions, report) = overhang_and_stability_from_soup(&quad_at(30.0), 45.0, 0.25);
        assert_eq!(regions.len(), 1);
        assert!(!regions[0].steep_flat, "30° is below the band");
        assert!(regions[0].drag_moment_mm3 > 0.0);
        assert!(
            (regions[0].drag_moment_mm3 as f64 - report.expect("report").drag_moment_mm3).abs()
                < 0.5
        );
    }

    #[test]
    fn empty_mesh_has_no_report() {
        assert!(compute_stability_report(&IndexedMesh::new(), 45.0).is_none());
    }

    #[test]
    fn stray_vertex_does_not_define_the_plate_plane() {
        // The signature of a real defective file: a 20 mm cube with two
        // zero-area triangles referencing one vertex 10 mm below it. The bbox
        // then reads 30.75 × 23.5 × 30.8 for a volume of exactly 20³, and the
        // contact band lands on the stray vertex alone — reporting a pose with
        // no contact at all. Degenerate faces must not decide where the part
        // touches the plate.
        let mut soup = unit_cube_soup();
        let stray = [40.0f32, 33.5, -10.0];
        for _ in 0..2 {
            // [v0, stray, stray] — zero area, zero volume, one new vertex.
            soup.extend_from_slice(&[0.0, 0.0, 0.0]);
            soup.extend_from_slice(&stray);
            soup.extend_from_slice(&stray);
        }
        let r = report_for(&soup, 45.0);
        assert_eq!(r.degenerate_faces, 2);
        assert!((r.volume_mm3 - 1000.0).abs() < 1e-3, "volume {}", r.volume_mm3);
        assert!((r.height_mm - 10.0).abs() < 1e-3, "height {}", r.height_mm);
        assert!((r.centroid_mm[2] - 5.0).abs() < 1e-3, "cz {}", r.centroid_mm[2]);
        // The cube's flat base is the bearing locus, not the stray vertex.
        assert_eq!(r.bearing_edges, 4);
        assert!((r.bearing_area_mm2 - 100.0).abs() < 0.01, "{}", r.bearing_area_mm2);
        assert!(r.margin_mm.is_infinite(), "margin {}", r.margin_mm);
        assert!(r.to_log_line().contains("2 degenerate faces ignored"), "{}", r.to_log_line());
    }

    #[test]
    fn open_shell_reports_no_volume_and_no_margin() {
        // A bare quad: nothing encloses a volume, so there is no mass to
        // restore anything. The centroid falls back to the bounding-box center
        // and the log says the shell is open rather than printing a number
        // that looks physical.
        let r = report_for(&quad_at(0.0), 45.0);
        assert!(
            r.signed_volume_mm3.abs() < 1e-6,
            "signed {}",
            r.signed_volume_mm3
        );
        assert_eq!(r.volume_mm3, 0.0);
        assert_eq!(r.margin_mm, 0.0);
        assert!((r.centroid_mm[0] - 5.0).abs() < 0.01);
        assert!((r.centroid_mm[1] - 5.0).abs() < 0.01);
        assert!(
            r.to_log_line().contains("inverted or open shell"),
            "{}",
            r.to_log_line()
        );
    }

    #[test]
    fn stability_log_line_names_the_margin_and_the_driver() {
        let r = report_for(&leaning_tower(20.0, 2.0, 3.0, 6.0, 60.0), 45.0);
        let line = r.to_log_line();
        // The whole line, so the calibration numbers stay where a reader of the
        // log expects them. Both verdicts carry their own constant: the gravity
        // margin its length L*, the adhesion ratio the dimensionless p/σ. Both
        // divisors are printed so the arithmetic can be checked by hand.
        // Gravity is labelled for what it is in a bottom-up machine — a
        // driving term, not a restoring margin — and carries its pressure so it
        // can be read against p.
        assert!(
            line.starts_with(
                "gravity lever 23.39mm · peel 25.2e-5MPa (driving, not restoring) · \
                 adhesion 6.667 (lifts iff p/σ > it) · volume 580.0mm³"
            ),
            "{line}"
        );
        assert!(line.contains("bearing 200.0mm² over 4 edges"), "{line}");
        // The centroid is world-absolute, so its height above the part's own
        // base is printed with it — the number to compare against height/2.
        // The tower's volume centroid sits at 2.2mm of its 8.0mm height (the
        // foot is heavy and low), so the pairing is readable without arithmetic.
        assert!(line.contains("[2.2 above the part's base]"), "{line}");
        assert!(line.contains("height 8.0mm"), "{line}");
        assert!(
            line.contains("worst edge 300mm³ dir 180° depth 12.10mm (contact 10.00mm)"),
            "{line}"
        );
        assert!(line.contains("drag 300mm³ over 2 faces (steep share 100%, z* 5.2mm)"), "{line}");
        assert!(line.contains("drivers z 4.0/6.0mm"), "{line}");
        // A part with no drag says so rather than printing a bogus margin.
        let flat = report_for(&unit_cube_soup(), 45.0).to_log_line();
        assert!(flat.contains("no down-facing drag"), "{flat}");
    }
}
