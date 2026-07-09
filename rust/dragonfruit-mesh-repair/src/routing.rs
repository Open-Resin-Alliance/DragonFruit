//! Per-shell routing for the deep-repair path.
//!
//! Replaces the whole-mesh solidify with a selective pipeline:
//!
//! 0. The cheap local passes (weld, degenerate cull, small-hole fill) have
//!    already run — `repair()` steps 1–3 precede the deep path — so the
//!    partition below always sees locally-repaired geometry (unwelded
//!    fragments would otherwise misclassify as extra support shells).
//! 1. Partition shells into model/support groups FIRST (the split must
//!    survive repair — supports can never fuse into the model, so no repair
//!    job ever mixes groups).
//! 2. Per-shell health metrics + clustering of mutually-intersecting /
//!    mutually-containing shells *within* a group.
//! 3. Decision table per cluster: healthy shells pass through bit-identical;
//!    mild defects get scoped local passes; closed intersecting clusters get
//!    the manifold union tier; open/non-manifold/self-intersecting clusters
//!    get the volumetric wrap. Every escalation rung is validated; the
//!    terminal fallback is the cluster's original triangles + residual flag —
//!    broken output never ships silently.
//! 4. Reassembly preserves the model-triangles-first contract behind
//!    `model_triangle_count` (no post-reassembly welding — welding across the
//!    section boundary would corrupt it).

use crate::analysis::{analyze_lightweight, count_self_intersections, self_intersection_pairs};
use crate::core::mesh::{Aabb, IndexedMesh};
use crate::repair::{
    classify_model_support_group, compute_likely_support_geometry, extract_component_submesh,
    fill_small_holes, repair_orientation, triangle_components, GeometryGroup, RepairOptions,
    MODEL_MIN_TRIS_FLOOR, RAFT_Z_CUTOFF_MM,
};
use crate::report::{MeshHealthReport, RepairStepReport};
use crate::volumetric::{self, gwn::WindingTree, WrapError, WrapOptions};
use ahash::AHashMap;
use rayon::prelude::*;

/// Shared model/support partition. This is THE single source of the
/// model-vs-support decision inside `repair()`; the legacy manifold-union and
/// step-10 classifier paths delegate here so the two can never drift.
pub(crate) struct ShellPartition {
    /// Per-face component id (`triangle_components` output).
    pub components: Vec<u32>,
    pub n_comps: usize,
    /// Per-component group.
    pub group: Vec<GeometryGroup>,
    pub comp_tri_count: Vec<usize>,
    pub comp_min_z: Vec<f32>,
}

pub(crate) fn partition_shells(mesh: &IndexedMesh) -> ShellPartition {
    let components = triangle_components(mesh);
    let n_comps = components.iter().copied().max().map(|m| m as usize + 1).unwrap_or(0);

    let global_min_z = mesh
        .positions
        .iter()
        .map(|p| p.z)
        .fold(f32::INFINITY, f32::min);
    let raft_z_cut = global_min_z + RAFT_Z_CUTOFF_MM;

    let mut comp_max_z = vec![f32::NEG_INFINITY; n_comps];
    let mut comp_min_z = vec![f32::INFINITY; n_comps];
    let mut comp_tri_count = vec![0usize; n_comps];
    for (fi, tri) in mesh.triangles.iter().enumerate() {
        let cid = components[fi] as usize;
        comp_tri_count[cid] += 1;
        for &v in tri {
            let z = mesh.positions[v as usize].z;
            comp_max_z[cid] = comp_max_z[cid].max(z);
            comp_min_z[cid] = comp_min_z[cid].min(z);
        }
    }

    let model_seed = (0..n_comps)
        .filter(|&cid| comp_tri_count[cid] >= 4 && comp_max_z[cid] > raft_z_cut)
        .max_by(|&a, &b| {
            comp_max_z[a]
                .partial_cmp(&comp_max_z[b])
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    let model_min_tris = model_seed
        .map(|seed| (comp_tri_count[seed] / 8).max(MODEL_MIN_TRIS_FLOOR))
        .unwrap_or(MODEL_MIN_TRIS_FLOOR);

    let group = (0..n_comps)
        .map(|cid| {
            classify_model_support_group(
                cid,
                raft_z_cut,
                model_seed,
                model_min_tris,
                &comp_max_z,
                &comp_tri_count,
            )
        })
        .collect();

    ShellPartition {
        components,
        n_comps,
        group,
        comp_tri_count,
        comp_min_z,
    }
}

struct ShellMetrics {
    tri_count: usize,
    bbox: Aabb,
    boundary_edges: usize,
    largest_loop: usize,
    non_manifold_edges: usize,
    inconsistent_edges: usize,
    signed_volume: f64,
    intra_si: usize,
}

impl ShellMetrics {
    fn healthy(&self) -> bool {
        self.boundary_edges == 0
            && self.non_manifold_edges == 0
            && self.inconsistent_edges == 0
            && self.intra_si == 0
            && self.signed_volume > 0.0
    }
    fn open(&self) -> bool {
        self.boundary_edges > 0
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Route {
    Passthrough,
    InteriorCulled,
    Local,
    Union,
    Wrap,
    Fallback,
}

struct Uf(Vec<u32>);
impl Uf {
    fn new(n: usize) -> Self {
        Self((0..n as u32).collect())
    }
    fn find(&mut self, x: u32) -> u32 {
        let mut r = x;
        while self.0[r as usize] != r {
            r = self.0[r as usize];
        }
        let mut c = x;
        while self.0[c as usize] != r {
            let n = self.0[c as usize];
            self.0[c as usize] = r;
            c = n;
        }
        r
    }
    fn union(&mut self, a: u32, b: u32) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.0[rb as usize] = ra;
        }
    }
}

pub(crate) struct RouteSummary {
    pub applied: bool,
    pub model_triangle_count: Option<usize>,
    pub likely_support_geometry: bool,
    /// Every shipped cluster passed validation (⇒ orientation is coherent
    /// and the whole-mesh topology loop can be skipped).
    pub all_validated: bool,
}

/// The per-shell deep-repair path. Returns `applied = false` only when there
/// is nothing to route (empty mesh); otherwise the mesh has been rebuilt
/// group-by-group and the summary carries the split metadata.
pub(crate) fn route_and_repair(
    mesh: &mut IndexedMesh,
    partition: &ShellPartition,
    options: &RepairOptions,
    report: &mut MeshHealthReport,
) -> RouteSummary {
    let t_route = std::time::Instant::now();
    let n = partition.n_comps;
    if n == 0 || mesh.triangles.is_empty() {
        return RouteSummary {
            applied: false,
            model_triangle_count: None,
            likely_support_geometry: false,
            all_validated: false,
        };
    }

    // Extract every shell once; all metric and repair work runs on these.
    let submeshes: Vec<IndexedMesh> = (0..n as u32)
        .into_par_iter()
        .map(|cid| extract_component_submesh(mesh, &partition.components, cid))
        .collect();

    // Per-shell topology metrics (no SI here — that comes from one global
    // pairs walk below, shared between the gate and the clustering).
    let mut metrics: Vec<ShellMetrics> = submeshes
        .par_iter()
        .map(|sub| {
            if sub.triangles.len() < 4 {
                // Degenerate micro-shard; marked open so it can't pass as
                // healthy (it gets dropped outright below, matching the
                // legacy solidify behavior).
                return ShellMetrics {
                    tri_count: sub.triangles.len(),
                    bbox: sub.bbox(),
                    boundary_edges: 1,
                    largest_loop: 0,
                    non_manifold_edges: 0,
                    inconsistent_edges: 0,
                    signed_volume: 0.0,
                    intra_si: 0,
                };
            }
            let a = analyze_lightweight(sub);
            ShellMetrics {
                tri_count: sub.triangles.len(),
                bbox: sub.bbox(),
                boundary_edges: a.boundary_edges,
                largest_loop: a.largest_boundary_loop,
                non_manifold_edges: a.non_manifold_edges,
                inconsistent_edges: a.inconsistent_winding_edges,
                signed_volume: a.signed_volume,
                intra_si: 0,
            }
        })
        .collect();

    // One global self-intersection walk: same-shell pairs feed intra_si,
    // cross-shell same-group pairs become cluster edges. Cross-group
    // intersections are reported but never clustered (they would fuse
    // supports into the model).
    let pairs = self_intersection_pairs(mesh);
    let mut uf = Uf::new(n);
    let mut cross_group_pairs = 0usize;
    let mut si_linked = vec![false; n];
    for (f, g) in &pairs {
        let cf = partition.components[*f as usize];
        let cg = partition.components[*g as usize];
        if cf == cg {
            metrics[cf as usize].intra_si += 1;
        } else if partition.group[cf as usize] == partition.group[cg as usize] {
            uf.union(cf, cg);
            si_linked[cf as usize] = true;
            si_linked[cg as usize] = true;
        } else {
            cross_group_pairs += 1;
        }
    }

    // Containment edges: a closed shell whose bbox sits inside another
    // same-group closed shell joins that shell's cluster (winding probe on a
    // few vertices, lazily built tree per candidate container). This is what
    // dissolves enclosed debris — the volumetric analogue of
    // `cull_interior_components`.
    let mut container_of: Vec<Option<u32>> = vec![None; n];
    {
        let mut trees: AHashMap<u32, WindingTree> = AHashMap::new();
        for inner in 0..n {
            if metrics[inner].tri_count < 4 {
                continue;
            }
            for outer in 0..n as u32 {
                let o = outer as usize;
                if o == inner
                    || partition.group[o] != partition.group[inner]
                    || metrics[o].tri_count < 4
                    || metrics[o].open()
                    || metrics[o].signed_volume.abs() <= metrics[inner].signed_volume.abs()
                    || !bbox_contains(&metrics[o].bbox, &metrics[inner].bbox)
                {
                    continue;
                }
                let tree = trees
                    .entry(outer)
                    .or_insert_with(|| WindingTree::build(&submeshes[o]));
                let probes = [
                    submeshes[inner].positions[0],
                    submeshes[inner].positions[submeshes[inner].positions.len() / 2],
                    submeshes[inner].positions[submeshes[inner].positions.len() - 1],
                ];
                if probes.iter().all(|p| tree.winding(*p) > 0.5) {
                    container_of[inner] = Some(outer);
                    uf.union(outer, inner as u32);
                    break;
                }
            }
        }
    }

    // Group shells into clusters (largest first for budget priority).
    // Degenerate micro-shards (< 4 triangles) are dropped like the legacy
    // solidify path — but only when they are debris (< 1% of the mesh).
    // A mesh that is *mostly* shards must never be emptied out.
    let shard_tris: usize = (0..n)
        .filter(|&c| metrics[c].tri_count < 4)
        .map(|c| metrics[c].tri_count)
        .sum();
    let drop_shards = shard_tris * 100 < mesh.triangles.len();
    let mut dropped_shards = 0usize;
    let mut cluster_members: AHashMap<u32, Vec<u32>> = AHashMap::new();
    for cid in 0..n as u32 {
        let tc = metrics[cid as usize].tri_count;
        if tc == 0 {
            continue;
        }
        if tc < 4 && drop_shards {
            dropped_shards += 1;
            continue;
        }
        cluster_members.entry(uf.find(cid)).or_default().push(cid);
    }
    let mut clusters: Vec<Vec<u32>> = cluster_members.into_values().collect();
    clusters.sort_by_key(|c| {
        std::cmp::Reverse(c.iter().map(|&i| metrics[i as usize].tri_count).sum::<usize>())
    });

    let group_diag = mesh.bbox().diag();
    let mut corner_budget_left = options.wrap_max_cells_total;
    let mut route_counts = [0usize; 6];
    let mut wrap_flags: Vec<String> = Vec::new();
    let mut all_validated = true;
    let mut wrap_notes: Vec<String> = Vec::new();
    let mut wrap_total_ms = 0.0f64;

    // Per-cluster outputs, keyed by group for reassembly.
    let mut model_out: Vec<IndexedMesh> = Vec::new();
    let mut support_out: Vec<IndexedMesh> = Vec::new();

    // Clusters are processed sequentially at the top level: each wrap is
    // internally rayon-parallel, and sequencing keeps peak memory to a
    // single band instead of N (shell soups would otherwise blow the RSS).
    for cluster in &clusters {
        let group = partition.group[cluster[0] as usize];
        // Shells fully contained in another shell of the cluster dissolve:
        // the survivors define the surface. (For union/wrap they dissolve
        // geometrically anyway; for passthrough we drop them explicitly.)
        let live: Vec<u32> = cluster
            .iter()
            .copied()
            .filter(|&cid| container_of[cid as usize].is_none())
            .collect();
        let culled_debris = cluster.len() - live.len();

        let agg_tris: usize = live.iter().map(|&i| metrics[i as usize].tri_count).sum();
        let all_healthy = live.iter().all(|&i| metrics[i as usize].healthy());
        let any_open = live.iter().any(|&i| metrics[i as usize].open());
        let any_nme = live
            .iter()
            .any(|&i| metrics[i as usize].non_manifold_edges > 0);
        let sum_intra_si: usize = live.iter().map(|&i| metrics[i as usize].intra_si).sum();
        let has_cross_si = live.iter().any(|&i| si_linked[i as usize]);

        let mut cluster_bbox = Aabb::empty();
        for &cid in &live {
            cluster_bbox.union(&metrics[cid as usize].bbox);
        }

        let outs: &mut Vec<IndexedMesh> = match group {
            GeometryGroup::Model => &mut model_out,
            GeometryGroup::Support => &mut support_out,
        };

        // ── Decision table ──────────────────────────────────────────────
        let mut route = if live.is_empty() {
            Route::InteriorCulled
        } else if live.len() == 1 && all_healthy {
            if culled_debris > 0 {
                Route::InteriorCulled
            } else {
                Route::Passthrough
            }
        } else if live.len() == 1
            && !any_nme_hard(&metrics[live[0] as usize])
            && metrics[live[0] as usize].intra_si
                < options.solidify_self_intersection_threshold
            && metrics[live[0] as usize].largest_loop <= options.fill_holes_max_edges
        {
            Route::Local
        } else if !any_open
            && !any_nme
            && sum_intra_si == 0
            && has_cross_si
            && cfg!(feature = "manifold")
        {
            Route::Union
        } else {
            Route::Wrap
        };

        // ── Escalation ladder ───────────────────────────────────────────
        let mut shipped = false;
        while !shipped {
            match route {
                Route::InteriorCulled => {
                    for &cid in &live {
                        outs.push(submeshes[cid as usize].clone());
                    }
                    route_counts[1] += 1;
                    shipped = true;
                }
                Route::Passthrough => {
                    for &cid in &live {
                        outs.push(submeshes[cid as usize].clone());
                    }
                    if !all_healthy {
                        all_validated = false;
                    }
                    route_counts[0] += 1;
                    shipped = true;
                }
                Route::Local => {
                    let mut sub = submeshes[live[0] as usize].clone();
                    repair_orientation(&mut sub);
                    fill_small_holes(&mut sub, options.fill_holes_max_edges);
                    let a = analyze_lightweight(&sub);
                    if a.boundary_edges == 0
                        && a.non_manifold_edges == 0
                        && a.inconsistent_winding_edges == 0
                        && a.signed_volume > 0.0
                        && count_self_intersections(&sub) == 0
                        && crate::volumetric::validate::fold_edge_count(&sub) == 0
                    {
                        outs.push(sub);
                        route_counts[2] += 1;
                        shipped = true;
                    } else {
                        route = Route::Wrap;
                    }
                }
                Route::Union => {
                    match union_cluster(&submeshes, &live) {
                        Some(mut unioned) => {
                            // manifold3d unions exactly, but converting back
                            // to f32 can leave a few crossing triangles at
                            // the seam — relax them locally, escalate if
                            // they don't converge.
                            if count_self_intersections(&unioned) == 0
                                || crate::volumetric::validate::relax_self_intersections(
                                    &mut unioned,
                                    3,
                                )
                            {
                                outs.push(unioned);
                                route_counts[3] += 1;
                                shipped = true;
                            } else {
                                route = Route::Wrap;
                            }
                        }
                        None => route = Route::Wrap,
                    }
                }
                Route::Wrap => {
                    // Debris too small to justify a solo wrap: keep verbatim
                    // (small broken shards ride along inside bigger clusters
                    // via SI/containment edges; a lone one isn't worth the
                    // grid).
                    if agg_tris < options.wrap_min_shell_triangles
                        && cluster_bbox.diag() < 0.01 * group_diag
                    {
                        route = Route::Fallback;
                        continue;
                    }
                    let mut cluster_mesh = concat_shells(&submeshes, &live);
                    // Orient before building the winding field: regionally
                    // inverted winding weakens the GWN sign exactly where the
                    // wrap needs it. (Cheap; ray-parity per shell.)
                    repair_orientation(&mut cluster_mesh);
                    let diag = cluster_bbox.diag().max(1e-3);
                    let mut wopts = derive_wrap_options(options, diag, agg_tris, any_open);
                    wopts.max_active_corners =
                        wopts.max_active_corners.min(corner_budget_left);
                    if corner_budget_left == 0 {
                        wrap_flags.push("wrap_budget_exhausted".into());
                        route = Route::Fallback;
                        continue;
                    }
                    let t = std::time::Instant::now();
                    match volumetric::wrap_cluster(&cluster_mesh, &wopts) {
                        Ok((wrapped, wr)) => {
                            wrap_total_ms += t.elapsed().as_secs_f64() * 1000.0;
                            corner_budget_left =
                                corner_budget_left.saturating_sub(wr.active_corners);
                            if wr.thin_wall_fraction > 0.10 {
                                wrap_flags.push(format!(
                                    "thin_walls:{:.0}%",
                                    wr.thin_wall_fraction * 100.0
                                ));
                            }
                            wrap_notes.push(format!(
                                "wrap[{} shells, {} tris]: voxel={:.3} corners={} dc={} out={} fid={:.3}/{:.3}{}",
                                live.len(),
                                agg_tris,
                                wr.voxel_mm,
                                wr.active_corners,
                                wr.dc_triangles,
                                wr.out_triangles,
                                wr.fidelity_in_to_out_max,
                                wr.fidelity_out_to_in_max,
                                if wr.remesh_rolled_back { " (remesh rolled back)" } else { "" },
                            ));
                            outs.push(wrapped);
                            route_counts[4] += 1;
                            shipped = true;
                        }
                        Err((e, wr)) => {
                            wrap_total_ms += t.elapsed().as_secs_f64() * 1000.0;
                            if matches!(e, WrapError::BudgetExceeded { .. }) {
                                wrap_flags.push("wrap_budget_exhausted".into());
                            }
                            wrap_notes.push(format!(
                                "wrap failed [{} shells, {} tris]: {e} (voxel={:.3})",
                                live.len(),
                                agg_tris,
                                wr.voxel_mm,
                            ));
                            route = Route::Fallback;
                        }
                    }
                }
                Route::Fallback => {
                    // Terminal rung: original triangles + residual flag —
                    // never drop geometry, never ship silently. Orient each
                    // kept shell locally (the global orient pass is skipped
                    // for the routing path, so this is the only orientation
                    // fallback geometry gets).
                    all_validated = false;
                    for &cid in cluster {
                        if metrics[cid as usize].tri_count >= 4 || !drop_shards {
                            let mut sub = submeshes[cid as usize].clone();
                            repair_orientation(&mut sub);
                            outs.push(sub);
                        }
                    }
                    wrap_flags.push(format!(
                        "cluster_kept_original:{}tris",
                        cluster
                            .iter()
                            .map(|&i| metrics[i as usize].tri_count)
                            .sum::<usize>()
                    ));
                    route_counts[5] += 1;
                    shipped = true;
                }
            }
        }
    }

    // ── Reassembly: model section first, then support ───────────────────
    let mut model_in_comps = 0usize;
    let mut support_in_comps = 0usize;
    let mut model_in_tris = 0usize;
    let mut support_in_tris = 0usize;
    for cid in 0..n {
        if partition.comp_tri_count[cid] == 0 {
            continue;
        }
        match partition.group[cid] {
            GeometryGroup::Model => {
                model_in_comps += 1;
                model_in_tris += partition.comp_tri_count[cid];
            }
            GeometryGroup::Support => {
                support_in_comps += 1;
                support_in_tris += partition.comp_tri_count[cid];
            }
        }
    }

    let mut out = IndexedMesh::new();
    let append = |out: &mut IndexedMesh, m: &IndexedMesh| {
        let base = out.positions.len() as u32;
        out.positions.extend_from_slice(&m.positions);
        out.triangles
            .extend(m.triangles.iter().map(|t| [t[0] + base, t[1] + base, t[2] + base]));
    };
    for m in &model_out {
        append(&mut out, m);
    }
    let model_triangles_out = out.triangles.len();
    for m in &support_out {
        append(&mut out, m);
    }
    let support_triangles_out = out.triangles.len() - model_triangles_out;
    *mesh = out;

    let likely_support = compute_likely_support_geometry(
        model_triangles_out,
        support_triangles_out,
        model_in_comps,
        support_in_comps,
        model_in_tris,
        support_in_tris,
    );

    // ── Reporting ────────────────────────────────────────────────────────
    report.shells_total = n;
    report.shells_passthrough = route_counts[0] + route_counts[1];
    report.shells_local = route_counts[2];
    report.shells_unioned = route_counts[3];
    report.shells_wrapped = route_counts[4];
    report.shells_fallback = route_counts[5];
    report.wrap_flags = wrap_flags;
    report.steps.push(RepairStepReport {
        name: "route_shells".into(),
        changed: (route_counts[2] + route_counts[3] + route_counts[4] + route_counts[5]) as u32,
        notes: Some(format!(
            "shells={} clusters={} passthrough={} interior_culled={} local={} unioned={} wrapped={} fallback={} dropped_shards={} cross_group_si_pairs={}",
            n,
            clusters.len(),
            route_counts[0],
            route_counts[1],
            route_counts[2],
            route_counts[3],
            route_counts[4],
            route_counts[5],
            dropped_shards,
            cross_group_pairs,
        )),
        elapsed_ms: t_route.elapsed().as_secs_f64() * 1000.0,
    });
    if route_counts[4] > 0 || !wrap_notes.is_empty() {
        for note in &wrap_notes {
            log::debug!("mesh-repair volumetric: {note}");
        }
        report.steps.push(RepairStepReport {
            name: "volumetric_wrap".into(),
            changed: route_counts[4] as u32,
            notes: Some(wrap_notes.join("; ")),
            elapsed_ms: wrap_total_ms,
        });
    }

    RouteSummary {
        applied: true,
        model_triangle_count: if model_triangles_out > 0 && support_triangles_out > 0 {
            Some(model_triangles_out)
        } else {
            None
        },
        likely_support_geometry: likely_support,
        all_validated,
    }
}

fn any_nme_hard(m: &ShellMetrics) -> bool {
    m.non_manifold_edges > 4
}

fn bbox_contains(outer: &Aabb, inner: &Aabb) -> bool {
    outer.min.x <= inner.min.x
        && outer.min.y <= inner.min.y
        && outer.min.z <= inner.min.z
        && outer.max.x >= inner.max.x
        && outer.max.y >= inner.max.y
        && outer.max.z >= inner.max.z
}

fn concat_shells(submeshes: &[IndexedMesh], ids: &[u32]) -> IndexedMesh {
    let mut out = IndexedMesh::new();
    for &cid in ids {
        let m = &submeshes[cid as usize];
        let base = out.positions.len() as u32;
        out.positions.extend_from_slice(&m.positions);
        out.triangles
            .extend(m.triangles.iter().map(|t| [t[0] + base, t[1] + base, t[2] + base]));
    }
    out
}

fn derive_wrap_options(
    options: &RepairOptions,
    cluster_diag: f32,
    input_tris: usize,
    any_open: bool,
) -> WrapOptions {
    let voxel = (cluster_diag / options.wrap_voxel_divisor)
        .clamp(options.wrap_min_voxel_mm, options.wrap_max_voxel_mm);
    // Keep the output near the DC (voxel-resolution) density. The 2M ceiling
    // (was 400k) only trips on genuinely huge clusters; below it the remesh
    // decimation loop never fires, so flat regions stay at their DC tessellation
    // instead of being coarsened into facets.
    let target = ((input_tris as f32 * options.wrap_target_triangle_factor) as usize)
        .clamp(2_000, 2_000_000);
    WrapOptions {
        voxel_mm: voxel,
        band_halfwidth_voxels: 3.0,
        close_radius_voxels: 0,
        // Open clusters need the band to physically span + bridge their holes;
        // target ~0.35 of the cluster diagonal, capped so a large open part
        // doesn't demand an enormous band. Closed clusters bridge nothing and
        // keep a thin band + fine voxel for maximum detail.
        hole_bridge_mm: if any_open {
            (0.35 * cluster_diag).min(3.0)
        } else {
            0.0
        },
        target_triangles: target,
        feature_angle_deg: 35.0,
        max_active_corners: options.wrap_max_cells_per_cluster,
        // 2.5 voxels: DC vertices roam their cell (~0.87 voxel) and feature
        // corners erode slightly under decimation; genuine missing geometry
        // (a lost shell/post) shows up at tens of voxels.
        fidelity_max_dist: 2.5 * voxel,
    }
}

/// Union tier: batch-union a cluster of closed shells via manifold-csg.
/// Only reachable when the `manifold` feature is enabled; returns `None` on
/// any rejection so the caller escalates to the wrap.
#[cfg(feature = "manifold")]
fn union_cluster(submeshes: &[IndexedMesh], ids: &[u32]) -> Option<IndexedMesh> {
    use crate::core::mesh::Vec3;
    use manifold_csg::Manifold;
    let mut manifolds = Vec::with_capacity(ids.len());
    for &cid in ids {
        let sub = &submeshes[cid as usize];
        let vert_props: Vec<f32> = sub.positions.iter().flat_map(|v| [v.x, v.y, v.z]).collect();
        let idx: Vec<u32> = if sub.signed_volume() < 0.0 {
            sub.triangles.iter().flat_map(|[a, b, c]| [*a, *c, *b]).collect()
        } else {
            sub.triangles.iter().flat_map(|t| *t).collect()
        };
        match Manifold::from_mesh_f32(&vert_props, 3, &idx) {
            Ok(m) if !m.is_empty() && m.num_tri() > 0 => manifolds.push(m),
            _ => return None,
        }
    }
    let unioned = Manifold::batch_union(&manifolds);
    if unioned.is_empty() || unioned.num_tri() < 4 {
        return None;
    }
    let (vp, np, ti) = unioned.to_mesh_f32();
    let out = IndexedMesh {
        positions: vp
            .chunks_exact(np)
            .map(|c| Vec3::new(c[0], c[1], c[2]))
            .collect(),
        triangles: ti.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect(),
    };
    if out.signed_volume() <= 0.0 {
        return None;
    }
    Some(out)
}

#[cfg(not(feature = "manifold"))]
fn union_cluster(_submeshes: &[IndexedMesh], _ids: &[u32]) -> Option<IndexedMesh> {
    None
}

#[cfg(all(test, feature = "manifold"))]
mod manifold_tests {
    use super::*;
    use crate::core::mesh::Vec3;

    fn sphere(center: Vec3, r: f32, rings: usize, segs: usize) -> IndexedMesh {
        let mut positions = vec![Vec3::new(center.x, center.y, center.z + r)];
        for i in 1..rings {
            let theta = std::f32::consts::PI * i as f32 / rings as f32;
            for j in 0..segs {
                let phi = std::f32::consts::TAU * j as f32 / segs as f32;
                positions.push(Vec3::new(
                    center.x + r * theta.sin() * phi.cos(),
                    center.y + r * theta.sin() * phi.sin(),
                    center.z + r * theta.cos(),
                ));
            }
        }
        positions.push(Vec3::new(center.x, center.y, center.z - r));
        let south = positions.len() as u32 - 1;
        let ring = |i: usize, j: usize| (1 + (i - 1) * segs + (j % segs)) as u32;
        let mut triangles = Vec::new();
        for j in 0..segs {
            triangles.push([0, ring(1, j), ring(1, j + 1)]);
        }
        for i in 1..rings - 1 {
            for j in 0..segs {
                let (a, b, c, d) = (ring(i, j), ring(i + 1, j), ring(i + 1, j + 1), ring(i, j + 1));
                triangles.push([a, b, c]);
                triangles.push([a, c, d]);
            }
        }
        for j in 0..segs {
            triangles.push([south, ring(rings - 1, j + 1), ring(rings - 1, j)]);
        }
        IndexedMesh { positions, triangles }
    }

    #[test]
    fn union_cluster_fuses_closed_shells() {
        let a = sphere(Vec3::new(0.0, 0.0, 0.0), 1.0, 12, 16);
        let b = sphere(Vec3::new(1.2, 0.0, 0.0), 1.0, 12, 16);
        let subs = vec![a, b];
        let out = union_cluster(&subs, &[0, 1]).expect("union");
        let analysis = crate::analysis::analyze(&out);
        assert!(analysis.is_watertight);
        assert_eq!(analysis.connected_components, 1);
        assert!(out.signed_volume() > 4.0 / 3.0 * std::f64::consts::PI);
    }

    /// The property the tier-2.5 rescue in `try_solidify_via_manifold_union`
    /// relies on: a wrapped open shell is accepted by manifold3d (so it gets
    /// *unioned* into its group instead of demoted to a convex hull).
    #[test]
    fn wrapped_open_shell_is_manifold_acceptable() {
        use manifold_csg::Manifold;
        let mut open = sphere(Vec3::new(0.0, 0.0, 0.0), 1.0, 16, 24);
        open.triangles.drain(0..40); // rip the north cap off
        let mut wopts = crate::volumetric::WrapOptions::for_diagonal(open.bbox().diag());
        // Open shell: the band must physically span the missing cap for GWN
        // to seal it (a fixed voxel close radius under-seals at fine voxels).
        wopts.hole_bridge_mm = 0.7;
        let (wrapped, _) = crate::volumetric::wrap_cluster(&open, &wopts).expect("wrap");
        let props: Vec<f32> = wrapped.positions.iter().flat_map(|v| [v.x, v.y, v.z]).collect();
        let idx: Vec<u32> = wrapped.triangles.iter().flat_map(|t| *t).collect();
        let m = Manifold::from_mesh_f32(&props, 3, &idx).expect("manifold accepts wrap output");
        assert!(!m.is_empty() && m.num_tri() > 0);
    }
}
