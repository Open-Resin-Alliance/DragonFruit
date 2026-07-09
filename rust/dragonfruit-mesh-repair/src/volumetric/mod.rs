//! Volumetric repair track ("wrap"): rebuilds a shell (or a cluster of
//! mutually-intersecting shells) as a watertight, manifold surface by
//! extracting the 0.5-isosurface of a generalized-winding-number-signed
//! narrow-band distance field.
//!
//! Formulation principle: never build a *signed* field directly from broken
//! input — "signed" presupposes a consistent inside/outside the input does
//! not have. Instead: unsigned distance (robust to any defect) + a separate
//! GWN sign evaluated only in the narrow band. Never flood-fill the sign,
//! never sign the whole grid.
//!
//! Pipeline (`wrap_cluster`): BVH (built once, reused for band distances,
//! hermite normals, reprojection, fidelity) → narrow-band unsigned distance
//! → GWN sign (Barnes–Hut) → optional morphological close → manifold dual
//! contouring → feature-aware remesh/decimate → invariant + fidelity gates.

pub mod band;
pub mod close;
pub mod dc;
pub mod gwn;
pub mod qef;
pub mod remesh;
pub mod validate;

pub use band::WrapError;

use crate::core::bvh::Bvh;
use crate::core::mesh::IndexedMesh;
use rayon::prelude::*;

#[derive(Clone, Debug)]
pub struct WrapOptions {
    /// Voxel edge length (mm); the caller (routing) derives it from the
    /// cluster bbox and cell budget.
    pub voxel_mm: f32,
    /// Band half-width in voxels; raised automatically to `3 + close` when a
    /// morphological close is requested.
    pub band_halfwidth_voxels: f32,
    /// Morphological close radius (voxels); 0 disables. Seals holes/gaps up
    /// to ~2r voxels wide. Automatically skipped when thin walls are
    /// detected (the close eats gaps thinner than 2r by design). Ignored when
    /// `hole_bridge_mm > 0`, which derives a physically-scaled radius instead.
    pub close_radius_voxels: u8,
    /// Physical gap (mm) the close pass should bridge, 0 = no bridging.
    /// Holes are a fixed physical size but voxels shrink for detail, so a
    /// fixed voxel radius under-seals at fine resolution; deriving the radius
    /// (and band half-width) from this keeps hole-sealing scale-invariant.
    /// Set only for open clusters — closed clusters keep a thin band + fine
    /// voxel for maximum detail.
    pub hole_bridge_mm: f32,
    /// Remesh/decimate budget for the output.
    pub target_triangles: usize,
    /// Dihedral feature-protection threshold for the remesher.
    pub feature_angle_deg: f32,
    /// Hard cap on stored band corners (memory budget).
    pub max_active_corners: usize,
    /// input→output fidelity gate (mm): exterior input surface farther than
    /// this from the output means geometry went missing.
    pub fidelity_max_dist: f32,
}

impl WrapOptions {
    /// Sensible defaults for a cluster of the given bounding-box diagonal.
    /// Fidelity-first: fine voxels (≤ 0.15 mm) with a generous corner budget;
    /// `wrap_cluster` auto-coarsens only if the band would exceed the budget.
    pub fn for_diagonal(diag_mm: f32) -> Self {
        let voxel = (diag_mm / 300.0).clamp(0.03, 0.15);
        Self {
            voxel_mm: voxel,
            band_halfwidth_voxels: 3.0,
            close_radius_voxels: 0,
            hole_bridge_mm: 0.0,
            target_triangles: 400_000,
            // 45°: shallow fillets smooth instead of freezing as serrated
            // feature lines; true sharp edges (~90°) still preserved.
            feature_angle_deg: 45.0,
            max_active_corners: 16_000_000,
            fidelity_max_dist: 2.0 * voxel,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct WrapReport {
    pub voxel_mm: f32,
    pub active_corners: usize,
    pub dc_triangles: usize,
    pub out_triangles: usize,
    pub fidelity_in_to_out_max: f32,
    pub fidelity_in_to_out_mean: f32,
    pub fidelity_out_to_in_max: f32,
    pub thin_wall_fraction: f32,
    pub close_skipped_for_thin_walls: bool,
    /// Remesh output failed the gate and the (denser) DC output shipped
    /// instead.
    pub remesh_rolled_back: bool,
    /// Knife-fold edges left in the shipped output (topological folds that
    /// survived relaxation). Tolerated below a small threshold; reported so a
    /// nonzero value is visible.
    pub residual_fold_edges: usize,
    /// [band, sign, contour, remesh, validate] wall times, ms.
    pub timings_ms: [f64; 5],
}

/// Wrap one shell or one cluster of mutually-intersecting shells (already
/// restricted to a single model/support group — callers must never mix
/// groups, or supports fuse into the model).
///
/// On success the mesh is watertight, 2-manifold, coherently outward-wound.
/// On failure the partial report is returned for diagnostics; the input is
/// untouched (callers fall back down the escalation ladder).
pub fn wrap_cluster(
    mesh: &IndexedMesh,
    opts: &WrapOptions,
) -> Result<(IndexedMesh, WrapReport), (WrapError, WrapReport)> {
    let mut report = WrapReport {
        voxel_mm: opts.voxel_mm,
        ..Default::default()
    };
    if mesh.triangle_count() == 0 {
        return Err((WrapError::EmptyExtraction, report));
    }
    // Shared acceleration structures: one BVH + one winding tree per cluster.
    let bvh = Bvh::build(mesh);
    let tree = gwn::WindingTree::build(mesh);

    // Thin-wall probe: decides whether the close pass is safe and feeds the
    // report (routing may retry at finer voxel on a thin-wall flag).
    //
    // Hole sealing is driven by band *half-width*, not the morphological
    // close: a hole is sealed when the band has corners spanning its opening
    // so GWN can sign them and DC contours the soap-film across it. The close
    // pass only mops up sub-band pixel gaps. A fixed voxel half-width spans a
    // fixed *physical* distance, which shrinks with voxel — so for open
    // clusters we scale the half-width to reach ~the hole radius
    // (`hole_bridge_mm`), keeping the close radius small.
    let mut close_radius = opts.close_radius_voxels;
    let mut band_halfwidth = opts.band_halfwidth_voxels;
    if opts.hole_bridge_mm > 0.0 {
        // Reach the hole *radius* (≈ half the bridge span), plus margin.
        let span_v = (0.5 * opts.hole_bridge_mm / opts.voxel_mm).clamp(1.0, 40.0);
        band_halfwidth = band_halfwidth.max(span_v + 2.0);
        close_radius = close_radius.max(2);
    }
    report.thin_wall_fraction =
        validate::thin_wall_fraction(mesh, &tree, 2.5 * opts.voxel_mm, opts.voxel_mm);
    if close_radius > 0 && report.thin_wall_fraction > 0.10 {
        close_radius = 0;
        report.close_skipped_for_thin_walls = true;
    }
    let halfwidth = band_halfwidth.max(3.0 + close_radius as f32);

    // Area-based voxel auto-rescale. We prefer the finest voxel the caller
    // asked for, but a band whose estimated corner count exceeds the memory
    // budget is *coarsened to fit* rather than aborted — a slightly coarser
    // wrap is always better than falling back to the original (broken) mesh.
    // Estimate: surface_area / voxel² × band thickness (in corner layers).
    let mut voxel = opts.voxel_mm;
    let total_area: f64 = (0..mesh.triangle_count() as u32)
        .into_par_iter()
        .map(|f| mesh.tri_area(f) as f64)
        .sum();
    let band_layers = 2.0 * halfwidth as f64 + 1.0;
    let est_corners = total_area / (voxel as f64 * voxel as f64) * band_layers;
    // Target half the budget for the *final* band so the transient seeded
    // superset (~2× the band) still fits the build's `seeded.len()` guard.
    let budget_target = opts.max_active_corners as f64 * 0.5;
    if est_corners > budget_target {
        // voxel ∝ sqrt(cells): scale up to land under the target.
        let scale = (est_corners / budget_target).sqrt() as f32;
        voxel *= scale;
    }
    report.voxel_mm = voxel;

    // 1. Narrow band.
    let t = std::time::Instant::now();
    let mut band = band::build_narrow_band(
        mesh,
        &bvh,
        &band::BandParams {
            voxel,
            halfwidth_voxels: halfwidth,
            max_corners: opts.max_active_corners,
        },
    )
    .map_err(|e| (e, report.clone()))?;
    report.active_corners = band.len();
    report.timings_ms[0] = t.elapsed().as_secs_f64() * 1000.0;

    // 2. GWN sign.
    let t = std::time::Instant::now();
    band::apply_sign(&mut band, &tree);
    report.timings_ms[1] = t.elapsed().as_secs_f64() * 1000.0;

    // 3. Morphological close (sign-field only).
    if close_radius > 0 {
        close::morphological_close(&mut band, close_radius);
    }

    // 4. Manifold dual contouring with hermite normals from the input.
    let t = std::time::Instant::now();
    let hermite = dc::HermiteSource { mesh, bvh: &bvh };
    let contoured = dc::dual_contour(&band, Some(&hermite), &dc::DcOptions { manifold: true })
        .map_err(|e| (e, report.clone()))?;
    drop(band); // band memory released before remeshing
    report.dc_triangles = contoured.triangle_count();
    report.timings_ms[2] = t.elapsed().as_secs_f64() * 1000.0;

    validate::validate_invariants(&contoured).map_err(|e| (e, report.clone()))?;

    // 5. Feature-aware remesh + decimate to budget, reprojecting onto the
    // input where it is locally trustworthy (sealed gaps stay put).
    let t = std::time::Instant::now();
    let remeshed = remesh::remesh(
        &contoured,
        Some((mesh, &bvh)),
        &remesh::RemeshParams {
            target_triangles: opts.target_triangles,
            feature_angle_deg: opts.feature_angle_deg,
            // Keep edges short so flat regions retain their DC tessellation
            // instead of being coarsened into voxel-scale facets. sizing_max
            // was 8·voxel — the direct cause of the "edges too long" faceting.
            sizing_min: 1.0 * voxel,
            sizing_max: 2.5 * voxel,
            iterations: 3,
            reproject_max_dist: 1.5 * voxel,
            // De-quantize the voxel staircase: feature verts (which dominate a
            // mechanical model and are otherwise left at their DC grid position
            // by smooth_pass) get pinned onto the true crease, and the smooth
            // panels get a Taubin polish. Removes the faceting at the *same*
            // triangle count — no resolution/RAM increase. The fidelity gate
            // still guards the result, so an over-smooth falls back to raw DC.
            reproject_features: true,
            taubin_iterations: 4,
            taubin_lambda: 0.53,
            taubin_mu: -0.55,
            // Straighten the zig-zag DC leaves along rounded feature edges
            // (the residual faceting after the panels are de-quantized).
            feature_smooth_iterations: 3,
        },
    );
    report.timings_ms[3] = t.elapsed().as_secs_f64() * 1000.0;

    // 6. Gates. Two candidates, preferred first: the remeshed output, then
    // the (denser but geometrically tighter) raw DC output. A candidate must
    // pass the invariants, have residual folded quads relaxed away (rare DC
    // artifact the remesher's local guards cannot see), and pass the
    // two-sided fidelity check. The remesh can legitimately fail fidelity
    // that the DC output passes — e.g. corner erosion on sharp thin parts —
    // in which case the DC output ships instead of failing the whole wrap.
    let t = std::time::Instant::now();
    let out_to_in_limit = (halfwidth + 2.0) * voxel * 1.7321;
    // The in→out gate must track the *actual* (possibly rescaled) voxel — a
    // budget-coarsened cluster legitimately deviates more — so scale the
    // caller's gate by the rescale ratio. This preserves a deliberately tight
    // gate (ratio 1 when no rescale) while loosening proportionally when the
    // band was coarsened to fit the budget.
    let fidelity_max = opts.fidelity_max_dist * (voxel / opts.voxel_mm).max(1.0);
    let mut last_err = WrapError::EmptyExtraction;
    for (is_remesh, candidate) in [(true, remeshed), (false, contoured)] {
        let mut candidate = candidate;
        // Relax residual artifacts (self-intersecting pairs + knife folds).
        // Most clear; a few knife folds are *topological* (a folded fin the
        // connectivity encodes) and survive vertex smoothing. Those are
        // tolerated up to a tiny threshold — they do not register as
        // self-intersections and are vastly less harmful than the fallback
        // (which ships the original mesh with ALL its defects). The residual
        // is reported so it is never silent.
        validate::relax_self_intersections(&mut candidate, 12);
        let fold_tol = (candidate.triangle_count() / 2000).max(4);
        let folds = validate::fold_edge_count(&candidate);
        if validate::validate_invariants(&candidate).is_err() || folds > fold_tol {
            last_err = WrapError::InvariantViolation(format!(
                "candidate failed manifold/SI/fold gate ({folds} residual folds)"
            ));
            report.remesh_rolled_back = true;
            continue;
        }
        report.residual_fold_edges = folds;
        match validate::fidelity_check(
            mesh,
            &bvh,
            &tree,
            &candidate,
            0.5 * voxel,
            fidelity_max,
            out_to_in_limit,
        ) {
            Ok(fidelity) => {
                report.fidelity_in_to_out_max = fidelity.in_to_out_max;
                report.fidelity_in_to_out_mean = fidelity.in_to_out_mean;
                report.fidelity_out_to_in_max = fidelity.out_to_in_max;
                report.out_triangles = candidate.triangle_count();
                report.remesh_rolled_back = !is_remesh;
                report.timings_ms[4] = t.elapsed().as_secs_f64() * 1000.0;
                return Ok((candidate, report));
            }
            Err(e) => {
                last_err = e;
                report.remesh_rolled_back = true;
            }
        }
    }
    report.timings_ms[4] = t.elapsed().as_secs_f64() * 1000.0;
    Err((last_err, report))
}
