//! Repair pipeline. Fixed-order passes over an [`IndexedMesh`].
//!
//! Each pass mutates the mesh in-place and appends a [`RepairStepReport`].
//! The passes are:
//!
//!   1. Dedup / weld vertices (epsilon quantization).
//!   2. Strip degenerate + duplicate triangles.
//!   3. Fill small boundary loops via ear-clipping triangulation on a best-fit plane.
//!   4. Resolve per-component winding by majority outward-normal vote (BVH ray cast).
//!   5. Optionally drop small disconnected components (keep top-N by signed volume).
//!   6. Recompute analysis for the post-report.
//!
//! Co-refinement-based self-intersection retriangulation is available as an
//! opt-in path; full arrangement classification/extraction is still WIP.
//! Residual counts flow into [`MeshHealthReport::residual_issues`].

use ahash::{AHashMap, AHashSet};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::analysis::{analyze, MeshAnalysis};
use crate::arrangement::corefine_self_intersections;
use crate::core::bvh::Bvh;
use crate::core::halfedge::{edge_key, Topology};
use crate::core::mesh::{IndexedMesh, Vec3};
use crate::report::{MeshHealthReport, RepairStepReport};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairOptions {
    /// Relative to bbox diagonal. Vertices within this distance are welded.
    pub weld_epsilon: f32,
    /// Maximum boundary loop length (in vertices) that will be auto-filled.
    /// Loops larger than this are left alone — they usually indicate intentional
    /// open shells rather than holes.
    pub fill_holes_max_edges: usize,
    /// Keep the top-N components ranked by |signed volume|. `None` = keep all.
    pub keep_largest_n_components: Option<usize>,
    /// Attempt orientation repair (per-component outward vote).
    pub repair_orientation: bool,
    /// Attempt self-intersection resolution.
    ///
    /// Current sequence when enabled:
    /// 1) Co-refine intersecting triangles (split along intersection segments),
    /// 2) Run a best-effort winding cull to drop faces likely interior to other
    ///    shells.
    ///
    /// This is a stepping stone toward full arrangement+classification repair.
    pub resolve_self_intersections: bool,
    /// If true, automatically enable the self-intersection solidify path for
    /// heavily fragmented meshes (typical of broken support STLs), even when
    /// `resolve_self_intersections` is false.
    pub solidify_fragmented_components: bool,
    /// Minimum connected-component count in the *pre* analysis required for
    /// `solidify_fragmented_components` to auto-trigger.
    pub solidify_component_threshold: usize,
    /// Minimum self-intersection-triangle count in the *pre* analysis required
    /// for `solidify_fragmented_components` to auto-trigger.
    pub solidify_self_intersection_threshold: usize,
}

impl Default for RepairOptions {
    fn default() -> Self {
        Self {
            weld_epsilon: 1e-5,
            fill_holes_max_edges: 64,
            keep_largest_n_components: None,
            repair_orientation: true,
            // Off by default: the current winding-number cull is a best-effort
            // partial solution; proper repair requires co-refinement (WIP in
            // `arrangement` module). Callers can opt in explicitly.
            resolve_self_intersections: false,
            // On by default for highly fragmented support-style meshes; guarded
            // by high pre-analysis thresholds to avoid impacting normal models.
            solidify_fragmented_components: true,
            solidify_component_threshold: 256,
            solidify_self_intersection_threshold: 128,
        }
    }
}

#[derive(Debug)]
pub struct RepairOutcome {
    pub mesh: IndexedMesh,
    pub report: MeshHealthReport,
}

pub fn repair(mut mesh: IndexedMesh, options: &RepairOptions) -> RepairOutcome {
    let t_start = std::time::Instant::now();

    let pre = analyze(&mesh);
    let auto_fragmented_solidify = options.solidify_fragmented_components
        && pre.connected_components >= options.solidify_component_threshold
        && pre.self_intersection_triangles >= options.solidify_self_intersection_threshold;
    let run_self_intersection_path = options.resolve_self_intersections || auto_fragmented_solidify;
    let mut applied_self_intersection_path = false;
    let mut solidify_rollback_reason: Option<String> = None;
    let mut report = MeshHealthReport::new(pre);

    if auto_fragmented_solidify {
        report.steps.push(RepairStepReport {
            name: "auto_enable_solidify".into(),
            changed: 0,
            notes: Some(format!(
                "auto-triggered: components={} (>= {}), self_intersections={} (>= {})",
                report.pre.connected_components,
                options.solidify_component_threshold,
                report.pre.self_intersection_triangles,
                options.solidify_self_intersection_threshold,
            )),
            elapsed_ms: 0.0,
        });
    }

    // 1. Weld.
    let t = std::time::Instant::now();
    let welded = weld_vertices(&mut mesh, options.weld_epsilon);
    report.steps.push(RepairStepReport {
        name: "weld".into(),
        changed: welded as u32,
        notes: None,
        elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
    });

    // 2. Cull degenerate + duplicate triangles.
    let t = std::time::Instant::now();
    let culled = cull_degenerate_and_duplicate(&mut mesh);
    report.steps.push(RepairStepReport {
        name: "cull_degenerate_duplicate".into(),
        changed: culled as u32,
        notes: None,
        elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
    });

    // 3. Fill small holes.
    let t = std::time::Instant::now();
    let filled = fill_small_holes(&mut mesh, options.fill_holes_max_edges);
    report.steps.push(RepairStepReport {
        name: "fill_holes".into(),
        changed: filled as u32,
        notes: None,
        elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
    });

    // 4. Optional co-refinement + interior-face cull (self-intersection path).
    if run_self_intersection_path {
        let mesh_before_solidify = mesh.clone();
        let analysis_before_solidify = analyze(&mesh);

        let t = std::time::Instant::now();
        let stats = corefine_self_intersections(&mut mesh);
        report.steps.push(RepairStepReport {
            name: "corefine_self_intersections".into(),
            changed: stats.refined_faces as u32,
            notes: Some(format!(
                "pairs={} refined_faces={} skipped_faces={} new_vertices={} tris:{}->{}",
                stats.intersecting_pairs,
                stats.refined_faces,
                stats.skipped_faces,
                stats.new_vertices,
                stats.tri_count_before,
                stats.tri_count_after
            )),
            elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
        });

        let t = std::time::Instant::now();
        let culled = cull_interior_faces_by_winding(&mut mesh);
        report.steps.push(RepairStepReport {
            name: "cull_interior_faces".into(),
            changed: culled as u32,
            notes: Some(format!(
                "{culled} interior-facing triangles removed (winding-number test, partial)"
            )),
            elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
        });

        let t = std::time::Instant::now();
        let analysis_after_solidify = analyze(&mesh);
        if let Some(reason) =
            solidify_regression_reason(&analysis_before_solidify, &analysis_after_solidify)
        {
            mesh = mesh_before_solidify;
            solidify_rollback_reason = Some(reason.clone());
            report.steps.push(RepairStepReport {
                name: "rollback_solidify".into(),
                changed: 0,
                notes: Some(format!("rolled back co-refinement/cull output: {reason}")),
                elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
            });
        } else {
            applied_self_intersection_path = true;
        }
    }

    // 5. Orient components.
    if options.repair_orientation {
        let t = std::time::Instant::now();
        let flipped = repair_orientation(&mut mesh);
        report.steps.push(RepairStepReport {
            name: "orient_components".into(),
            changed: flipped as u32,
            notes: None,
            elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
        });
    }

    // 6. Component filter.
    if let Some(keep_n) = options.keep_largest_n_components {
        let t = std::time::Instant::now();
        let dropped_tris = keep_largest_components(&mut mesh, keep_n);
        report.steps.push(RepairStepReport {
            name: "filter_components".into(),
            changed: dropped_tris as u32,
            notes: Some(format!("kept top {keep_n} components by |volume|")),
            elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
        });
    }

    // 7-8. Iterative topology repair loop.
    //
    // Non-manifold face cleanup and micro-topology heal are alternated in a
    // convergence loop. A single pass often leaves 1-2 residual NMEs because
    // the hole-fill after face removal can itself introduce a new NME; the
    // second pass catches those artifacts. The loop stops when the mesh is
    // watertight, no pass made progress, or `MAX_TOPOLOGY_ITERS` is reached.
    const MAX_TOPOLOGY_ITERS: usize = 5;
    'topology_loop: for _iter in 0..MAX_TOPOLOGY_ITERS {
        let iter_state = analyze(&mesh);
        if iter_state.is_watertight {
            break 'topology_loop;
        }
        if iter_state.non_manifold_edges == 0 && iter_state.boundary_edges == 0 {
            break 'topology_loop;
        }

        let mut progress_this_iter = false;

        // 7. Targeted non-manifold face cleanup (VCGlib-inspired), rollback-safe.
        let t = std::time::Instant::now();
        match attempt_non_manifold_face_cleanup(&mut mesh, options.fill_holes_max_edges) {
            NonManifoldFaceCleanupOutcome::Skipped => {}
            NonManifoldFaceCleanupOutcome::Applied { changed, notes } => {
                progress_this_iter = true;
                report.steps.push(RepairStepReport {
                    name: "remove_non_manifold_faces".into(),
                    changed: changed as u32,
                    notes: Some(notes),
                    elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
                });

                // Re-orient after topology edits so winding coherence has a
                // chance to recover before the micro-heal pass.
                if options.repair_orientation {
                    let t = std::time::Instant::now();
                    let flipped = repair_orientation(&mut mesh);
                    report.steps.push(RepairStepReport {
                        name: "orient_components_post_non_manifold_cleanup".into(),
                        changed: flipped as u32,
                        notes: None,
                        elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
                    });
                }
            }
            NonManifoldFaceCleanupOutcome::RolledBack { notes } => {
                report.steps.push(RepairStepReport {
                    name: "rollback_non_manifold_cleanup".into(),
                    changed: 0,
                    notes: Some(notes),
                    elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
                });
            }
        }

        // 8. Last-mile micro topology heal for tiny residual defects.
        //
        // This targets cases like support-heavy imported meshes where we end
        // up with a handful of non-manifold/boundary edges after the main
        // passes. It is tightly gated and internally rollback-protected.
        let t = std::time::Instant::now();
        match attempt_micro_topology_heal(&mut mesh, options.fill_holes_max_edges) {
            MicroHealOutcome::Skipped => {}
            MicroHealOutcome::Applied { changed, notes } => {
                progress_this_iter = true;
                report.steps.push(RepairStepReport {
                    name: "micro_topology_heal".into(),
                    changed: changed as u32,
                    notes: Some(notes),
                    elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
                });

                // Re-run orientation after local topology surgery.
                if options.repair_orientation {
                    let t = std::time::Instant::now();
                    let flipped = repair_orientation(&mut mesh);
                    report.steps.push(RepairStepReport {
                        name: "orient_components_post_micro_heal".into(),
                        changed: flipped as u32,
                        notes: None,
                        elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
                    });
                }
            }
            MicroHealOutcome::RolledBack { notes } => {
                report.steps.push(RepairStepReport {
                    name: "rollback_micro_topology_heal".into(),
                    changed: 0,
                    notes: Some(notes),
                    elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
                });
            }
        }

        if !progress_this_iter {
            // Neither pass made progress; further iterations won't help.
            break 'topology_loop;
        }
    }

    // 9. Drop unused vertices (post-cull cleanup).
    let t = std::time::Instant::now();
    let pruned = prune_unused_vertices(&mut mesh);
    report.steps.push(RepairStepReport {
        name: "prune_unused_vertices".into(),
        changed: pruned as u32,
        notes: None,
        elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
    });

    // Post-analysis.
    report.post = analyze(&mesh);

    // Surface residual issues.
    let mut residuals: Vec<String> = Vec::new();
    if report.post.non_manifold_edges > 0 {
        residuals.push(format!(
            "{} non-manifold edges remain",
            report.post.non_manifold_edges
        ));
    }
    if report.post.boundary_edges > 0 {
        residuals.push(format!(
            "{} boundary edges remain across {} loop(s)",
            report.post.boundary_edges, report.post.boundary_loops
        ));
    }
    if report.post.self_intersection_triangles > 0 && !applied_self_intersection_path {
        if let Some(reason) = &solidify_rollback_reason {
            residuals.push(format!(
                "{} self-intersecting triangles detected (solidify attempt was rolled back: {reason})",
                report.post.self_intersection_triangles
            ));
        } else {
            residuals.push(format!(
                "{} self-intersecting triangles detected (pass resolve_self_intersections=true or enable solidify_fragmented_components=true to attempt repair)",
                report.post.self_intersection_triangles
            ));
        }
    }
    if applied_self_intersection_path && report.post.self_intersection_triangles > 0 {
        residuals.push(format!(
            "{} self-intersecting triangles remain after co-refinement+cull",
            report.post.self_intersection_triangles
        ));
    }
    if report.post.inconsistent_winding_edges > 0 {
        residuals.push(format!(
            "{} inconsistently wound edges remain",
            report.post.inconsistent_winding_edges
        ));
    }

    report.fully_repaired = residuals.is_empty();
    report.residual_issues = residuals;
    report.total_ms = t_start.elapsed().as_secs_f64() * 1000.0;

    RepairOutcome { mesh, report }
}

fn solidify_regression_reason(before: &MeshAnalysis, after: &MeshAnalysis) -> Option<String> {
    fn is_explosive_increase(
        before: usize,
        after: usize,
        min_delta: usize,
        min_ratio: usize,
    ) -> bool {
        if after <= before {
            return false;
        }
        let delta = after - before;
        if delta < min_delta {
            return false;
        }
        if before == 0 {
            return after >= min_delta;
        }
        after >= before.saturating_mul(min_ratio)
    }

    if is_explosive_increase(before.boundary_edges, after.boundary_edges, 2048, 8) {
        return Some(format!(
            "boundary edges exploded {} -> {}",
            before.boundary_edges, after.boundary_edges
        ));
    }

    if is_explosive_increase(before.non_manifold_edges, after.non_manifold_edges, 512, 4) {
        return Some(format!(
            "non-manifold edges regressed {} -> {}",
            before.non_manifold_edges, after.non_manifold_edges
        ));
    }

    if is_explosive_increase(
        before.connected_components,
        after.connected_components,
        512,
        2,
    ) {
        return Some(format!(
            "component count exploded {} -> {}",
            before.connected_components, after.connected_components
        ));
    }

    if after.self_intersection_triangles >= before.self_intersection_triangles
        && (after.boundary_edges > before.boundary_edges.saturating_add(256)
            || after.non_manifold_edges > before.non_manifold_edges.saturating_add(128))
    {
        return Some(format!(
            "self-intersections did not improve ({} -> {}) while topology worsened",
            before.self_intersection_triangles, after.self_intersection_triangles
        ));
    }

    None
}

#[derive(Debug)]
enum MicroHealOutcome {
    Skipped,
    Applied { changed: usize, notes: String },
    RolledBack { notes: String },
}

#[derive(Debug)]
enum NonManifoldFaceCleanupOutcome {
    Skipped,
    Applied { changed: usize, notes: String },
    RolledBack { notes: String },
}

fn attempt_non_manifold_face_cleanup(
    mesh: &mut IndexedMesh,
    fill_holes_max_edges: usize,
) -> NonManifoldFaceCleanupOutcome {
    if mesh.triangles.is_empty() {
        return NonManifoldFaceCleanupOutcome::Skipped;
    }

    let topo = Topology::build(mesh);
    let non_manifold_edges = topo.non_manifold_edges();
    if non_manifold_edges.is_empty() {
        return NonManifoldFaceCleanupOutcome::Skipped;
    }

    // Keep this pass bounded. We use it as a targeted cleanup step, not a full
    // remeshing strategy.
    const MAX_NON_MANIFOLD_EDGES: usize = 4096;
    if non_manifold_edges.len() > MAX_NON_MANIFOLD_EDGES {
        return NonManifoldFaceCleanupOutcome::Skipped;
    }

    let before = analyze(mesh);
    let mesh_before = mesh.clone();

    let mut faces_to_remove: AHashSet<u32> = AHashSet::new();

    for edge in &non_manifold_edges {
        let Some(info) = topo.edges.get(edge) else {
            continue;
        };

        // Keep at most one face for each direction across this edge (if
        // possible), preferring larger-area faces. This approximates manifold
        // pairing and avoids random sliver retention.
        let mut best_forward: Option<(u32, f32)> = None;
        let mut best_backward: Option<(u32, f32)> = None;
        let mut ranked_all: Vec<(u32, f32)> = Vec::new();

        for &(from, to, fi) in &info.directed {
            let area = mesh.tri_area(fi);
            ranked_all.push((fi, area));

            if from == edge.0 && to == edge.1 {
                match best_forward {
                    Some((_, best_area)) if best_area >= area => {}
                    _ => best_forward = Some((fi, area)),
                }
            } else {
                match best_backward {
                    Some((_, best_area)) if best_area >= area => {}
                    _ => best_backward = Some((fi, area)),
                }
            }
        }

        let mut keep: AHashSet<u32> = AHashSet::new();
        if let Some((fi, _)) = best_forward {
            keep.insert(fi);
        }
        if let Some((fi, _)) = best_backward {
            keep.insert(fi);
        }

        // If all faces happen to share one direction, keep the two largest.
        if keep.len() < 2 {
            ranked_all.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            for (fi, _) in ranked_all.into_iter().take(2) {
                keep.insert(fi);
            }
        }

        for &fi in &info.faces {
            if !keep.contains(&fi) {
                faces_to_remove.insert(fi);
            }
        }
    }

    if faces_to_remove.is_empty() {
        return NonManifoldFaceCleanupOutcome::Skipped;
    }

    let tri_before = mesh.triangles.len();
    mesh.triangles = mesh
        .triangles
        .iter()
        .enumerate()
        .filter_map(|(fi, tri)| {
            if faces_to_remove.contains(&(fi as u32)) {
                None
            } else {
                Some(*tri)
            }
        })
        .collect();

    let removed = tri_before - mesh.triangles.len();
    let culled_pre = cull_degenerate_and_duplicate(mesh);
    let filled = fill_small_holes(mesh, fill_holes_max_edges.clamp(8, 96));
    let culled_post = cull_degenerate_and_duplicate(mesh);

    let after = analyze(mesh);
    let improved = non_manifold_cleanup_is_improvement(&before, &after);
    let hard_regression = non_manifold_cleanup_is_hard_regression(&before, &after);

    if !improved || hard_regression {
        *mesh = mesh_before;
        return NonManifoldFaceCleanupOutcome::RolledBack {
            notes: format!(
                "rolled back non-manifold cleanup: nme {} -> {}, boundary {} -> {}, inconsistent {} -> {}, self_int {} -> {}, degenerate {} -> {}, duplicate {} -> {}",
                before.non_manifold_edges,
                after.non_manifold_edges,
                before.boundary_edges,
                after.boundary_edges,
                before.inconsistent_winding_edges,
                after.inconsistent_winding_edges,
                before.self_intersection_triangles,
                after.self_intersection_triangles,
                before.degenerate_triangles,
                after.degenerate_triangles,
                before.duplicate_triangles,
                after.duplicate_triangles,
            ),
        };
    }

    NonManifoldFaceCleanupOutcome::Applied {
        changed: removed + culled_pre + filled + culled_post,
        notes: format!(
            "nme {} -> {}, boundary {} -> {}, inconsistent {} -> {}, self_int {} -> {} (removed={}, culled_pre={}, filled={}, culled_post={})",
            before.non_manifold_edges,
            after.non_manifold_edges,
            before.boundary_edges,
            after.boundary_edges,
            before.inconsistent_winding_edges,
            after.inconsistent_winding_edges,
            before.self_intersection_triangles,
            after.self_intersection_triangles,
            removed,
            culled_pre,
            filled,
            culled_post,
        ),
    }
}

fn non_manifold_cleanup_is_improvement(before: &MeshAnalysis, after: &MeshAnalysis) -> bool {
    if after.is_watertight {
        return true;
    }

    // Primary target is reducing non-manifold edges without damaging other
    // critical quality indicators.
    after.non_manifold_edges < before.non_manifold_edges
        && after.self_intersection_triangles <= before.self_intersection_triangles
        && after.degenerate_triangles <= before.degenerate_triangles
        && after.duplicate_triangles <= before.duplicate_triangles
}

fn non_manifold_cleanup_is_hard_regression(before: &MeshAnalysis, after: &MeshAnalysis) -> bool {
    after.boundary_edges > before.boundary_edges.saturating_add(256)
        || after.inconsistent_winding_edges > before.inconsistent_winding_edges.saturating_add(64)
        || after.self_intersection_triangles > before.self_intersection_triangles.saturating_add(64)
        || after.connected_components > before.connected_components.saturating_add(512)
}

fn attempt_micro_topology_heal(
    mesh: &mut IndexedMesh,
    fill_holes_max_edges: usize,
) -> MicroHealOutcome {
    if mesh.triangles.is_empty() {
        return MicroHealOutcome::Skipped;
    }

    let topo = Topology::build(mesh);
    let non_manifold_edges = topo.non_manifold_edges();
    let boundary_edges = topo.boundary_edges();

    if non_manifold_edges.is_empty() && boundary_edges.is_empty() {
        return MicroHealOutcome::Skipped;
    }

    // Keep this as a targeted "last mile" fixer only.
    const MAX_NON_MANIFOLD_EDGES: usize = 32;
    const MAX_BOUNDARY_EDGES: usize = 16;
    if non_manifold_edges.len() > MAX_NON_MANIFOLD_EDGES
        || boundary_edges.len() > MAX_BOUNDARY_EDGES
    {
        return MicroHealOutcome::Skipped;
    }

    let before = analyze(mesh);
    let mesh_before = mesh.clone();

    let mut faces_to_remove: ahash::AHashSet<u32> = ahash::AHashSet::new();

    // Always remove faces touching non-manifold edges.
    for edge in &non_manifold_edges {
        if let Some(info) = topo.edges.get(edge) {
            for &fi in &info.faces {
                faces_to_remove.insert(fi);
            }
        }
    }

    // For tiny residual boundary slits, remove incident faces as well, then
    // close the resulting micro-hole deterministically.
    if boundary_edges.len() <= 8 {
        for edge in &boundary_edges {
            if let Some(info) = topo.edges.get(edge) {
                for &fi in &info.faces {
                    faces_to_remove.insert(fi);
                }
            }
        }
    }

    if faces_to_remove.is_empty() {
        return MicroHealOutcome::Skipped;
    }

    let tri_before = mesh.triangles.len();
    mesh.triangles = mesh
        .triangles
        .iter()
        .enumerate()
        .filter_map(|(fi, tri)| {
            if faces_to_remove.contains(&(fi as u32)) {
                None
            } else {
                Some(*tri)
            }
        })
        .collect();
    let removed = tri_before - mesh.triangles.len();

    let culled_before_fill = cull_degenerate_and_duplicate(mesh);
    let filled = fill_small_holes(mesh, fill_holes_max_edges.clamp(8, 128));
    let culled_after_fill = cull_degenerate_and_duplicate(mesh);

    let after = analyze(mesh);
    let before_score =
        before.non_manifold_edges + before.boundary_edges + before.inconsistent_winding_edges;
    let after_score =
        after.non_manifold_edges + after.boundary_edges + after.inconsistent_winding_edges;

    let improved = micro_heal_is_improvement(&before, &after, before_score, after_score);
    let hard_regression = micro_heal_is_hard_regression(&before, &after);

    if !improved || hard_regression {
        *mesh = mesh_before;
        return MicroHealOutcome::RolledBack {
            notes: format!(
                "rolled back micro topology heal: score {} -> {}, nme {} -> {}, boundary {} -> {}, inconsistent {} -> {}, self_int {} -> {}, degenerate {} -> {}, duplicate {} -> {}",
                before_score,
                after_score,
                before.non_manifold_edges,
                after.non_manifold_edges,
                before.boundary_edges,
                after.boundary_edges,
                before.inconsistent_winding_edges,
                after.inconsistent_winding_edges,
                before.self_intersection_triangles,
                after.self_intersection_triangles,
                before.degenerate_triangles,
                after.degenerate_triangles,
                before.duplicate_triangles,
                after.duplicate_triangles,
            ),
        };
    }

    MicroHealOutcome::Applied {
        changed: removed + culled_before_fill + culled_after_fill + filled,
        notes: format!(
            "nme {} -> {}, boundary {} -> {}, inconsistent {} -> {}, self_int {} -> {}, degenerate {} -> {}, duplicate {} -> {} (removed={}, culled_pre={}, filled={}, culled_post={})",
            before.non_manifold_edges,
            after.non_manifold_edges,
            before.boundary_edges,
            after.boundary_edges,
            before.inconsistent_winding_edges,
            after.inconsistent_winding_edges,
            before.self_intersection_triangles,
            after.self_intersection_triangles,
            before.degenerate_triangles,
            after.degenerate_triangles,
            before.duplicate_triangles,
            after.duplicate_triangles,
            removed,
            culled_before_fill,
            filled,
            culled_after_fill,
        ),
    }
}

fn micro_heal_is_improvement(
    before: &MeshAnalysis,
    after: &MeshAnalysis,
    before_score: usize,
    after_score: usize,
) -> bool {
    if after.is_watertight {
        return true;
    }

    // Strict acceptance: only keep if the primary edge-defect score improves
    // and we don't regress other critical defect classes.
    after_score < before_score
        && after.self_intersection_triangles <= before.self_intersection_triangles
        && after.degenerate_triangles <= before.degenerate_triangles
        && after.duplicate_triangles <= before.duplicate_triangles
}

fn micro_heal_is_hard_regression(before: &MeshAnalysis, after: &MeshAnalysis) -> bool {
    after.boundary_edges > before.boundary_edges.saturating_add(64)
        || after.non_manifold_edges > before.non_manifold_edges.saturating_add(32)
        || after.inconsistent_winding_edges > before.inconsistent_winding_edges.saturating_add(8)
        || after.self_intersection_triangles > before.self_intersection_triangles.saturating_add(16)
        || after.degenerate_triangles > before.degenerate_triangles
        || after.duplicate_triangles > before.duplicate_triangles
        || after.connected_components > before.connected_components.saturating_add(128)
}

// --- individual passes ---------------------------------------------------

fn weld_vertices(mesh: &mut IndexedMesh, epsilon: f32) -> usize {
    let bbox = mesh.bbox();
    let diag = bbox.diag().max(1e-6);
    let step = (epsilon * diag).max(1e-7);
    let inv_step = 1.0 / step;

    let mut map: AHashMap<(i32, i32, i32), u32> = AHashMap::with_capacity(mesh.positions.len());
    let mut new_positions: Vec<Vec3> = Vec::with_capacity(mesh.positions.len());
    let mut remap: Vec<u32> = Vec::with_capacity(mesh.positions.len());

    for p in &mesh.positions {
        let key = (
            (p.x * inv_step).round() as i32,
            (p.y * inv_step).round() as i32,
            (p.z * inv_step).round() as i32,
        );
        let new_idx = *map.entry(key).or_insert_with(|| {
            let i = new_positions.len() as u32;
            new_positions.push(*p);
            i
        });
        remap.push(new_idx);
    }
    let merged = mesh.positions.len() - new_positions.len();
    if merged == 0 {
        return 0;
    }
    for tri in mesh.triangles.iter_mut() {
        for v in tri.iter_mut() {
            *v = remap[*v as usize];
        }
    }
    mesh.positions = new_positions;
    merged
}

fn cull_degenerate_and_duplicate(mesh: &mut IndexedMesh) -> usize {
    let before = mesh.triangles.len();
    let mut seen: ahash::AHashSet<(u32, u32, u32)> = ahash::AHashSet::with_capacity(before);
    mesh.triangles.retain(|tri| {
        if tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2] {
            return false;
        }
        let mut s = *tri;
        s.sort();
        let key = (s[0], s[1], s[2]);
        if !seen.insert(key) {
            return false;
        }
        true
    });
    // Zero-area filter (positional).
    let positions = &mesh.positions;
    mesh.triangles.retain(|tri| {
        let a = positions[tri[0] as usize];
        let b = positions[tri[1] as usize];
        let c = positions[tri[2] as usize];
        let area = b.sub(a).cross(c.sub(a)).length() * 0.5;
        area > 1e-16
    });
    before - mesh.triangles.len()
}

fn prune_unused_vertices(mesh: &mut IndexedMesh) -> usize {
    let before = mesh.positions.len();
    if before == 0 {
        return 0;
    }
    let mut used = vec![false; before];
    for tri in &mesh.triangles {
        used[tri[0] as usize] = true;
        used[tri[1] as usize] = true;
        used[tri[2] as usize] = true;
    }
    let mut remap = vec![u32::MAX; before];
    let mut new_positions: Vec<Vec3> = Vec::with_capacity(before);
    for i in 0..before {
        if used[i] {
            remap[i] = new_positions.len() as u32;
            new_positions.push(mesh.positions[i]);
        }
    }
    if new_positions.len() == before {
        return 0;
    }
    for tri in mesh.triangles.iter_mut() {
        for v in tri.iter_mut() {
            *v = remap[*v as usize];
        }
    }
    mesh.positions = new_positions;
    before - mesh.positions.len()
}

/// Ear-clipping hole filler. For each boundary loop of size <= `max_edges`,
/// project loop vertices onto a best-fit plane (via normal averaging) and
/// triangulate 2D. Convex-first greedy — does not handle self-intersecting
/// polygons but handles the common case of small planar/near-planar holes.
fn fill_small_holes(mesh: &mut IndexedMesh, max_edges: usize) -> usize {
    let topo = Topology::build(mesh);
    let loops = topo.boundary_loops();
    let mut added = 0usize;

    for loop_verts in loops
        .into_iter()
        .filter(|l| l.len() <= max_edges && l.len() >= 3)
    {
        // Compute average normal of one-ring faces along the loop to orient
        // the fill (so ear clipping produces outward-facing triangles).
        let avg_normal = {
            let mut sum = Vec3::ZERO;
            for &v in &loop_verts {
                for &face in &topo.vertex_faces[v as usize] {
                    sum = sum.add(mesh.tri_normal(face));
                }
            }
            let len = sum.length();
            if len > 1e-8 {
                sum.scale(1.0 / len)
            } else {
                Vec3::new(0.0, 0.0, 1.0)
            }
        };

        // Build a local 2D frame perpendicular to `avg_normal`.
        let up = if avg_normal.z.abs() < 0.9 {
            Vec3::new(0.0, 0.0, 1.0)
        } else {
            Vec3::new(1.0, 0.0, 0.0)
        };
        let u_axis = {
            let n = avg_normal.cross(up);
            let len = n.length();
            if len > 1e-8 {
                n.scale(1.0 / len)
            } else {
                Vec3::new(1.0, 0.0, 0.0)
            }
        };
        let v_axis = avg_normal.cross(u_axis);

        let pts2d: Vec<(f32, f32)> = loop_verts
            .iter()
            .map(|&v| {
                let p = mesh.positions[v as usize];
                (p.dot(u_axis), p.dot(v_axis))
            })
            .collect();

        // Orient loop counter-clockwise in the 2D frame for consistent winding.
        let mut verts_ordered: Vec<u32> = loop_verts.clone();
        let mut pts_ordered = pts2d.clone();
        if polygon_signed_area(&pts_ordered) < 0.0 {
            verts_ordered.reverse();
            pts_ordered.reverse();
        }

        // Ear clipping.
        let tris = ear_clip(&pts_ordered);
        for [i, j, k] in tris {
            mesh.triangles
                .push([verts_ordered[i], verts_ordered[j], verts_ordered[k]]);
            added += 1;
        }
    }
    added
}

fn polygon_signed_area(pts: &[(f32, f32)]) -> f32 {
    let mut s = 0.0f32;
    let n = pts.len();
    for i in 0..n {
        let (x0, y0) = pts[i];
        let (x1, y1) = pts[(i + 1) % n];
        s += x0 * y1 - x1 * y0;
    }
    s * 0.5
}

fn ear_clip(pts: &[(f32, f32)]) -> Vec<[usize; 3]> {
    let n = pts.len();
    if n < 3 {
        return Vec::new();
    }
    let mut remaining: Vec<usize> = (0..n).collect();
    let mut tris: Vec<[usize; 3]> = Vec::with_capacity(n - 2);
    let mut guard = 0usize;
    while remaining.len() > 3 && guard < n * n {
        guard += 1;
        let m = remaining.len();
        let mut ear_found = false;
        for i in 0..m {
            let ia = remaining[(i + m - 1) % m];
            let ib = remaining[i];
            let ic = remaining[(i + 1) % m];
            if !is_convex(pts[ia], pts[ib], pts[ic]) {
                continue;
            }
            let mut contains_other = false;
            for (j, &idx) in remaining.iter().enumerate() {
                if j == (i + m - 1) % m || j == i || j == (i + 1) % m {
                    continue;
                }
                if point_in_tri(pts[idx], pts[ia], pts[ib], pts[ic]) {
                    contains_other = true;
                    break;
                }
            }
            if !contains_other {
                tris.push([ia, ib, ic]);
                remaining.remove(i);
                ear_found = true;
                break;
            }
        }
        if !ear_found {
            // Fallback: centroid fan (robust but may produce skinny tris).
            break;
        }
    }
    if remaining.len() == 3 {
        tris.push([remaining[0], remaining[1], remaining[2]]);
    } else if remaining.len() > 3 {
        // Fan-fallback when ear clipping cannot progress.
        let anchor = remaining[0];
        for i in 1..remaining.len() - 1 {
            tris.push([anchor, remaining[i], remaining[i + 1]]);
        }
    }
    tris
}

fn is_convex(a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> bool {
    let ux = b.0 - a.0;
    let uy = b.1 - a.1;
    let vx = c.0 - b.0;
    let vy = c.1 - b.1;
    (ux * vy - uy * vx) > 0.0
}

fn point_in_tri(p: (f32, f32), a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> bool {
    fn sign(p: (f32, f32), a: (f32, f32), b: (f32, f32)) -> f32 {
        (p.0 - b.0) * (a.1 - b.1) - (a.0 - b.0) * (p.1 - b.1)
    }
    let d1 = sign(p, a, b);
    let d2 = sign(p, b, c);
    let d3 = sign(p, c, a);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Remove triangles that are on the interior of another shell by shooting a
/// ray from each face's centroid along its outward normal. If the ray hits an
/// odd number of OTHER triangles, the face is inside another shell and is
/// culled. Runs in parallel via rayon.
///
/// After culling, the intersection seam becomes an open boundary; call
/// [`fill_small_holes`] to close it.
fn cull_interior_faces_by_winding(mesh: &mut IndexedMesh) -> usize {
    if mesh.triangles.is_empty() {
        return 0;
    }

    let bvh = Bvh::build(mesh);

    // Offset origin along the outward normal to avoid self-intersecting the
    // source triangle via numerical noise.
    const OFFSET: f32 = 1e-4;

    // Determine which faces are interior by parallel ray casting.
    let n = mesh.triangles.len();
    let interior: Vec<bool> = {
        let mesh_ref: &IndexedMesh = mesh;
        (0..n)
            .into_par_iter()
            .map(|fi| {
                let [a, b, c] = mesh_ref.tri_positions(fi as u32);
                let e1 = b.sub(a);
                let e2 = c.sub(a);
                let raw_n = e1.cross(e2);
                let len = raw_n.length();
                if len < 1e-8 {
                    // Degenerate — leave it; cull_degenerate pass handles it.
                    return false;
                }
                let normal = raw_n.scale(1.0 / len);
                let centroid = a.add(b).add(c).scale(1.0 / 3.0);
                let origin = centroid.add(normal.scale(OFFSET));
                let hits = bvh.ray_hit_count_excluding(mesh_ref, origin, normal, fi as u32);
                // Odd hit count → face is inside another shell.
                hits % 2 == 1
            })
            .collect()
    };

    let before = mesh.triangles.len();
    let mut kept = Vec::with_capacity(before);
    for (fi, &is_interior) in interior.iter().enumerate() {
        if !is_interior {
            kept.push(mesh.triangles[fi]);
        }
    }
    mesh.triangles = kept;
    before - mesh.triangles.len()
}

/// Assign a component id to each triangle via union-find over shared edges;
/// for each component, cast a ray from a point well outside the bbox along a
/// random direction and count hits. If the count is even when the component
/// is supposed to contain the origin, or if the signed volume disagrees with
/// the majority-normal direction, flip every triangle's winding.
fn repair_orientation(mesh: &mut IndexedMesh) -> usize {
    if mesh.triangles.is_empty() {
        return 0;
    }
    let components = triangle_components(mesh);
    let n_components = components.iter().max().copied().unwrap_or(0) + 1;
    let mut flipped_faces = 0usize;

    // Per-component signed volume gives us the simplest orientation check —
    // if a component is watertight and signed volume is negative, flip it.
    // For non-watertight components we fall back to a ray-cast vote using the
    // overall BVH.
    let bvh = Bvh::build(mesh);

    for comp_id in 0..n_components {
        let face_indices: Vec<u32> = components
            .iter()
            .enumerate()
            .filter_map(|(i, &c)| if c == comp_id { Some(i as u32) } else { None })
            .collect();
        if face_indices.is_empty() {
            continue;
        }

        // Component signed volume.
        let mut vol = 0.0f64;
        for &fi in &face_indices {
            let t = mesh.triangles[fi as usize];
            let a = mesh.positions[t[0] as usize];
            let b = mesh.positions[t[1] as usize];
            let c = mesh.positions[t[2] as usize];
            vol += (a.x as f64) * ((b.y as f64) * (c.z as f64) - (b.z as f64) * (c.y as f64))
                - (a.y as f64) * ((b.x as f64) * (c.z as f64) - (b.z as f64) * (c.x as f64))
                + (a.z as f64) * ((b.x as f64) * (c.y as f64) - (b.y as f64) * (c.x as f64));
        }
        vol /= 6.0;

        let flip_by_volume = vol < -1e-6;

        let should_flip = if flip_by_volume {
            true
        } else if vol.abs() < 1e-6 {
            // Likely not watertight — ray-cast vote using triangle centroids.
            let votes: usize = face_indices
                .par_iter()
                .map(|&fi| {
                    let [a, b, c] = mesh.tri_positions(fi);
                    let n = mesh.tri_normal(fi);
                    if n.length() < 1e-8 {
                        return 0;
                    }
                    let centroid = a.add(b).add(c).scale(1.0 / 3.0);
                    let offset = centroid.add(n.scale(1e-3));
                    let hits = bvh.ray_hit_count(mesh, offset, n);
                    // Subtract our own forward face if detected.
                    if hits % 2 == 0 {
                        0
                    } else {
                        1
                    }
                })
                .sum();
            votes * 2 > face_indices.len()
        } else {
            false
        };

        if should_flip {
            for fi in face_indices {
                let t = &mut mesh.triangles[fi as usize];
                t.swap(1, 2);
                flipped_faces += 1;
            }
        }
    }
    flipped_faces
}

/// Assign each triangle to a connected-component id (edge-shared).
fn triangle_components(mesh: &IndexedMesh) -> Vec<u32> {
    let n = mesh.triangles.len();
    let mut edge_to_face: AHashMap<(u32, u32), u32> = AHashMap::with_capacity(n * 3);
    let mut parent: Vec<u32> = (0..n as u32).collect();
    fn find(p: &mut [u32], i: u32) -> u32 {
        let mut r = i;
        while p[r as usize] != r {
            r = p[r as usize];
        }
        let mut cur = i;
        while p[cur as usize] != r {
            let next = p[cur as usize];
            p[cur as usize] = r;
            cur = next;
        }
        r
    }
    for (fi, tri) in mesh.triangles.iter().enumerate() {
        let fi = fi as u32;
        let edges = [
            edge_key(tri[0], tri[1]),
            edge_key(tri[1], tri[2]),
            edge_key(tri[2], tri[0]),
        ];
        for e in edges {
            if let Some(&other) = edge_to_face.get(&e) {
                let ri = find(&mut parent, fi);
                let rj = find(&mut parent, other);
                if ri != rj {
                    parent[ri as usize] = rj;
                }
            } else {
                edge_to_face.insert(e, fi);
            }
        }
    }
    let mut comp_id_map: AHashMap<u32, u32> = AHashMap::new();
    let mut next_id: u32 = 0;
    let mut result = vec![0u32; n];
    for i in 0..n {
        let r = find(&mut parent, i as u32);
        let id = *comp_id_map.entry(r).or_insert_with(|| {
            let id = next_id;
            next_id += 1;
            id
        });
        result[i] = id;
    }
    result
}

fn keep_largest_components(mesh: &mut IndexedMesh, keep_n: usize) -> usize {
    if keep_n == 0 {
        let before = mesh.triangles.len();
        mesh.triangles.clear();
        return before;
    }
    let components = triangle_components(mesh);
    let n_components = components.iter().max().copied().unwrap_or(0) + 1;
    if (n_components as usize) <= keep_n {
        return 0;
    }

    // Rank components by |signed volume|.
    let mut vols = vec![0.0f64; n_components as usize];
    for (fi, tri) in mesh.triangles.iter().enumerate() {
        let a = mesh.positions[tri[0] as usize];
        let b = mesh.positions[tri[1] as usize];
        let c = mesh.positions[tri[2] as usize];
        let v = (a.x as f64) * ((b.y as f64) * (c.z as f64) - (b.z as f64) * (c.y as f64))
            - (a.y as f64) * ((b.x as f64) * (c.z as f64) - (b.z as f64) * (c.x as f64))
            + (a.z as f64) * ((b.x as f64) * (c.y as f64) - (b.y as f64) * (c.x as f64));
        vols[components[fi] as usize] += v / 6.0;
    }
    let mut ranked: Vec<(u32, f64)> = vols
        .iter()
        .enumerate()
        .map(|(i, v)| (i as u32, v.abs()))
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let keep: ahash::AHashSet<u32> = ranked.into_iter().take(keep_n).map(|(i, _)| i).collect();

    let before = mesh.triangles.len();
    let mut kept: Vec<[u32; 3]> = Vec::with_capacity(before);
    for (fi, tri) in mesh.triangles.iter().enumerate() {
        if keep.contains(&components[fi]) {
            kept.push(*tri);
        }
    }
    mesh.triangles = kept;
    before - mesh.triangles.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analysis(
        boundary_edges: usize,
        non_manifold_edges: usize,
        components: usize,
        self_intersections: usize,
    ) -> MeshAnalysis {
        MeshAnalysis {
            vertex_count: 0,
            triangle_count: 0,
            bbox_min: [0.0, 0.0, 0.0],
            bbox_max: [0.0, 0.0, 0.0],
            signed_volume: 0.0,
            duplicate_vertices: 0,
            degenerate_triangles: 0,
            duplicate_triangles: 0,
            non_manifold_edges,
            non_manifold_vertices: 0,
            boundary_edges,
            boundary_loops: 0,
            largest_boundary_loop: 0,
            inconsistent_winding_edges: 0,
            self_intersection_triangles: self_intersections,
            connected_components: components,
            is_watertight: false,
            is_oriented: false,
            timings_ms: crate::analysis::AnalysisTimings::default(),
        }
    }

    #[test]
    fn solidify_guard_flags_boundary_explosion() {
        let before = analysis(0, 20, 2173, 99_060);
        let after = analysis(455_630, 4_295, 4_052, 99_307);
        let reason = solidify_regression_reason(&before, &after);
        assert!(reason.is_some(), "expected regression guard to trip");
        assert!(
            reason.unwrap().contains("boundary edges exploded"),
            "expected boundary explosion reason"
        );
    }

    #[test]
    fn solidify_guard_accepts_non_explosive_progress() {
        let before = analysis(512, 300, 64, 5_000);
        let after = analysis(480, 240, 64, 4_100);
        assert!(solidify_regression_reason(&before, &after).is_none());
    }

    #[test]
    fn micro_heal_accepts_defect_score_improvement() {
        let before = analysis(2, 20, 2173, 99_059);
        let mut after = analysis(0, 0, 2173, 99_059);
        after.inconsistent_winding_edges = 0;
        let before_score =
            before.non_manifold_edges + before.boundary_edges + before.inconsistent_winding_edges;
        let after_score =
            after.non_manifold_edges + after.boundary_edges + after.inconsistent_winding_edges;
        assert!(micro_heal_is_improvement(
            &before,
            &after,
            before_score,
            after_score
        ));
        assert!(!micro_heal_is_hard_regression(&before, &after));
    }

    #[test]
    fn micro_heal_rejects_hard_boundary_regression() {
        let before = analysis(2, 20, 2173, 99_059);
        let mut after = analysis(500, 22, 2350, 99_059);
        after.inconsistent_winding_edges = 30;
        let before_score =
            before.non_manifold_edges + before.boundary_edges + before.inconsistent_winding_edges;
        let after_score =
            after.non_manifold_edges + after.boundary_edges + after.inconsistent_winding_edges;
        assert!(!micro_heal_is_improvement(
            &before,
            &after,
            before_score,
            after_score
        ));
        assert!(micro_heal_is_hard_regression(&before, &after));
    }

    #[test]
    fn micro_heal_rejects_boundary_fix_that_worsens_winding_and_self_intersections() {
        let mut before = analysis(1, 20, 2173, 99_059);
        before.inconsistent_winding_edges = 22;

        let mut after = analysis(0, 21, 2173, 99_085);
        after.inconsistent_winding_edges = 57;
        after.degenerate_triangles = 6;
        after.duplicate_triangles = 4;

        let before_score =
            before.non_manifold_edges + before.boundary_edges + before.inconsistent_winding_edges;
        let after_score =
            after.non_manifold_edges + after.boundary_edges + after.inconsistent_winding_edges;

        assert!(!micro_heal_is_improvement(
            &before,
            &after,
            before_score,
            after_score
        ));
        assert!(micro_heal_is_hard_regression(&before, &after));
    }

    #[test]
    fn non_manifold_cleanup_accepts_non_manifold_reduction_without_regression() {
        let mut before = analysis(1, 20, 2173, 99_059);
        before.inconsistent_winding_edges = 22;

        let mut after = analysis(1, 10, 2173, 99_050);
        after.inconsistent_winding_edges = 18;

        assert!(non_manifold_cleanup_is_improvement(&before, &after));
        assert!(!non_manifold_cleanup_is_hard_regression(&before, &after));
    }

    #[test]
    fn non_manifold_cleanup_rejects_if_self_intersections_get_worse() {
        let mut before = analysis(1, 20, 2173, 99_059);
        before.inconsistent_winding_edges = 22;

        let mut after = analysis(1, 10, 2173, 99_300);
        after.inconsistent_winding_edges = 18;

        assert!(!non_manifold_cleanup_is_improvement(&before, &after));
        assert!(non_manifold_cleanup_is_hard_regression(&before, &after));
    }
}
