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
    /// detected (the close eats gaps thinner than 2r by design).
    pub close_radius_voxels: u8,
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
    pub fn for_diagonal(diag_mm: f32) -> Self {
        let voxel = (diag_mm / 220.0).clamp(0.04, 0.8);
        Self {
            voxel_mm: voxel,
            band_halfwidth_voxels: 3.0,
            close_radius_voxels: 0,
            target_triangles: 200_000,
            feature_angle_deg: 35.0,
            max_active_corners: 3_000_000,
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
    let voxel = opts.voxel_mm;

    // Shared acceleration structures: one BVH + one winding tree per cluster.
    let bvh = Bvh::build(mesh);
    let tree = gwn::WindingTree::build(mesh);

    // Thin-wall probe: decides whether the close pass is safe and feeds the
    // report (routing may retry at finer voxel on a thin-wall flag).
    let mut close_radius = opts.close_radius_voxels;
    report.thin_wall_fraction =
        validate::thin_wall_fraction(mesh, &tree, 2.5 * voxel, voxel);
    if close_radius > 0 && report.thin_wall_fraction > 0.10 {
        close_radius = 0;
        report.close_skipped_for_thin_walls = true;
    }
    let halfwidth = opts
        .band_halfwidth_voxels
        .max(3.0 + close_radius as f32);

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
            sizing_min: 1.5 * voxel,
            sizing_max: 8.0 * voxel,
            iterations: 3,
            reproject_max_dist: 1.5 * voxel,
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
    let mut last_err = WrapError::EmptyExtraction;
    for (is_remesh, candidate) in [(true, remeshed), (false, contoured)] {
        let mut candidate = candidate;
        if validate::validate_invariants(&candidate).is_err()
            || !validate::relax_self_intersections(&mut candidate, 4)
        {
            last_err =
                WrapError::InvariantViolation("candidate failed manifold/SI gate".into());
            report.remesh_rolled_back = true;
            continue;
        }
        match validate::fidelity_check(
            mesh,
            &bvh,
            &tree,
            &candidate,
            0.5 * voxel,
            opts.fidelity_max_dist,
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
