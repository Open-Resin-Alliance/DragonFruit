//! Surface to solid: rebuild a surface by making it a solid rather than by resampling it.
//!
//! This is the mechanism behind the reference implementation's shrinkwrap, and it is the hollowing
//! machinery run with the offset turned off: scan for the open edges, close them, take a boolean of
//! the mesh with itself, and drop the shells the boolean leaves behind.
//!
//! A boolean of a mesh with itself regularises it: the result is re-triangulated, coincident and
//! self-intersecting geometry is resolved, and what comes back is a solid. That is the whole
//! difference from [`crate::tet_wrap`], which conforms a decomposition to the input's own triangles
//! and therefore returns the input's surface back. Both are remeshes; only one of them moves the
//! surface.
//!
//! The boolean here is `manifold_csg`, whose construction is the same operation: building a
//! `Manifold` from a mesh resolves it into a valid solid and re-triangulates it, and reading it back
//! out is the rebuilt surface.
//!
//! # This is not repair
//!
//! Like the tetrahedral mode it is a mode a caller names, never a stage of [`crate::repair`]: repair
//! may not invent geometry, and a boolean does nothing else.

use crate::{IndexedMesh, Vec3};
use crate::tet_wrap::PhaseSink;

/// How the rebuild is done and what is done with the result.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SolidRemeshOptions {
    /// Cap the number of edges a boundary loop may have for the hole pass to fill it. Every loop is
    /// the default, which is what a rebuild wants: the boundary is about to be resolved anyway, so a
    /// loop left open only gives the boolean something it cannot resolve. Note that the pass itself
    /// reads zero as "no loop qualifies", not as "no cap".
    pub fill_holes_max_edges: usize,
    /// Drop scrap shells after the rebuild, which is the reference's own last step.
    pub remove_noise_shells: bool,
    /// Taubin smoothing passes over the resolved surface, each a pair of runs.
    ///
    /// **Zero by default, and the default is measured.** Smoothing moves the vertices of the resolve's
    /// own triangulation, and where that triangulation is long and thin the movement drags the
    /// neighbouring curvature inward: on `Gusano_de_Dune_70%.stl` it is the difference between a flat
    /// bottom and one crossed by fold lines, and between pocket rims that read as circles and ones
    /// ringed by starbursts. Rendered, not counted: the surface's median aspect over that bottom is
    /// 4.60 with two passes and 4.78 without, so the numbers say it barely moves while the picture
    /// says it is the whole artefact. It also costs two passes over the mesh, 18.6 s against 16.5 s.
    ///
    /// A caller that wants it can ask. The stair-steps this was written for belong to a lattice-ish
    /// input, which is what [`crate::shrink_wrap`] produces, not to a resolve.
    pub smooth_iterations: usize,
    /// Simplify before resolving, on [`crate::repair::simplify_to_error`]'s scale: 0.001 removes
    /// about a quarter of a dense model, 0.005 removes most of it, and 0.05 leaves 190 triangles of
    /// 170,790. Zero leaves the surface alone.
    ///
    /// **0.0002, not 0.001**, because collapsing the surface *folds* it and the boolean then resolves
    /// a folded surface — which is what reads as "rough" in the result. Measured on
    /// `Gusano_de_Dune_70%.stl`, over the resolved surface:
    ///
    /// | simplify | triangles out | mean dihedral | edges over 30° | triangle size |
    /// | --- | --- | --- | --- | --- |
    /// | the input | 596,293 | 9.4° | 7.4% | 0.344 mm |
    /// | 0.001 | 356,072 | 13.2° | 13.3% | 0.446 mm |
    /// | **0.0002** | 603,782 | **11.0°** | **9.8%** | 0.325 mm |
    /// | 0 | 621,582 | 10.7° | 9.5% | 0.320 mm |
    ///
    /// The volume the resolve adds is unchanged by this (it is the resolve filling the model's own
    /// shells, not the simplify), and the cost is 1.7x the triangles and about 5 s on that model.
    ///
    /// This is the step that makes a shrink-wrap look rebuilt rather than merely resolved: a boolean
    /// of a clean solid with itself is idempotent, so without it the surface comes back exactly as it
    /// went in. It belongs in this mode rather than the tetrahedral one because collapsing a surface
    /// folds it, and a boolean is what resolves a folded one.
    pub tolerance: f32,
}

impl Default for SolidRemeshOptions {
    fn default() -> Self {
        Self {
            fill_holes_max_edges: usize::MAX,
            remove_noise_shells: true,
            smooth_iterations: 0,
            tolerance: 0.0002,
        }
    }
}

/// What the rebuild did.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SolidRemeshReport {
    pub input_triangles: usize,
    pub output_triangles: usize,
    /// Shells before and after. The reference's shrinkwrap is recorded as taking 246 shells to 1, so
    /// this is a number worth reporting rather than a detail.
    pub shells_before: usize,
    pub shells_after: usize,
    /// Boundary loops closed before the boolean ran.
    pub holes_filled: usize,
    /// Vertices the separation split to make the surface manifold enough for the boolean.
    ///
    /// Non-zero means the input shared edges between surfaces, which no local pass here resolves and
    /// which a boolean cannot accept: without this step the rebuild declines on exactly the files
    /// that need it most, and says `NotManifold`.
    pub non_manifold_resolved: usize,
    /// Set when the boolean refused the input. The mesh is then the input unchanged, and this is
    /// the reason: a mesh that is not a solid cannot be resolved into one.
    pub declined: Option<String>,
    pub ms: f64,
    pub cancelled: bool,
}

/// The rebuilt surface and its report.
pub struct SolidRemeshOutcome {
    pub mesh: IndexedMesh,
    pub report: SolidRemeshReport,
}

/// Rebuild `mesh` as a solid. Returns the input unchanged with a zeroed report when the boolean
/// cannot resolve it, rather than an empty mesh.
pub fn solid_remesh(mesh: &IndexedMesh, options: &SolidRemeshOptions) -> SolidRemeshOutcome {
    solid_remesh_with_progress(mesh, options, None)
}

/// Rebuild `mesh`, telling `sink` about each phase as it starts.
///
/// Cancelling stops the run at a phase boundary and returns the input unchanged, so a caller that
/// stops has made no change to the geometry it handed in.
pub fn solid_remesh_with_progress(
    mesh: &IndexedMesh,
    options: &SolidRemeshOptions,
    sink: Option<&mut dyn FnMut(&str, usize) -> bool>,
) -> SolidRemeshOutcome {
    let started = std::time::Instant::now();
    let mut phases = PhaseSink::new(sink);

    let resolved = std::cell::Cell::new(0usize);
    let unchanged = |declined: Option<String>, cancelled: bool| SolidRemeshOutcome {
        mesh: mesh.clone(),
        report: SolidRemeshReport {
            input_triangles: mesh.triangles.len(),
            output_triangles: mesh.triangles.len(),
            shells_before: 0,
            shells_after: 0,
            holes_filled: 0,
            non_manifold_resolved: resolved.get(),
            declined,
            ms: started.elapsed().as_secs_f64() * 1000.0,
            cancelled,
        },
    };

    let shells_of = |m: &IndexedMesh| {
        crate::repair::triangle_components(m)
            .iter()
            .copied()
            .max()
            .map_or(0, |x| x as usize + 1)
    };
    let shells_before = shells_of(mesh);

    // 1. Prepare. The boolean needs consistent winding and one vertex per position, because its
    //    input is a solid and a soup is not one.
    if !phases.phase("prepare") {
        return unchanged(None, true);
    }
    let mut prepared = mesh.clone();
    let envelope = crate::repair::Envelope::of(&mesh);
    prepared.weld_by_position();
    crate::tet_wrap::snap_weld(&mut prepared);
    crate::repair::repair_orientation(&mut prepared);
    crate::topology_passes::split_pinched_vertices(&mut prepared);

    // 2. Simplify, which is where this stops being a no-op on a clean solid: their pipeline does
    //    this before the boolean, and it is what makes the surface come back rebuilt.
    if !phases.phase("simplify") {
        return unchanged(None, true);
    }
    if options.tolerance > 0.0 {
        prepared = crate::repair::simplify_to_error(prepared, options.tolerance);
    }

    // 3. Close what is open, before the boolean sees it: their pipeline does this first too.
    if !phases.phase("fill") {
        return unchanged(None, true);
    }
    let holes_filled = crate::repair::fill_small_holes(&mut prepared, options.fill_holes_max_edges);

    // 4. Resolve it into a solid. Building the manifold is the boolean: it is where coincident,
    //    self-intersecting and non-manifold geometry is reconciled and the surface is retriangulated.
    //
    //    The boolean is tried on the surface as prepared, and only when it refuses because the
    //    surface is not a solid is it prepared harder and tried again. That order matters for cost:
    //    separating shared edges is seconds on a large mesh and buys nothing on a file the boolean
    //    would have accepted, and a mesh with thousands of non-manifold edges is the case this whole
    //    mode exists for, so refusing it outright is worse than the work.
    if !phases.phase("solid") {
        return unchanged(None, true);
    }
    #[cfg(feature = "manifold")]
    {
        let mut attempt = manifold_round_trip(&prepared);
        if let Err(reason) = &attempt {
            eprintln!("[dragonfruit-mesh-repair] solid: the first attempt declined ({reason}); separating shared edges and retrying");
            let split = separate_shared_edges_for_boolean(&mut prepared);
            resolved.set(split);
            if split > 0 {
                attempt = manifold_round_trip(&prepared);
            }
        }
        match attempt {
            Ok(rebuilt) => prepared = rebuilt,
            Err(reason) => {
                let reason = if resolved.get() > 0 {
                    format!(
                        "{reason} (after separating {} shared-edge vertices; the separation stalled with non-manifold edges left, which the boolean will not take)",
                        resolved.get()
                    )
                } else {
                    reason
                };
                return unchanged(Some(reason), false);
            }
        }
    }
    #[cfg(not(feature = "manifold"))]
    {
        return unchanged(
            Some("the manifold backend is not compiled in, so nothing can resolve a surface into a solid".to_string()),
            false,
        );
    }

    // The boolean re-triangulates, and what it produces can disagree with itself about winding along
    // the seams it created. Measured on the 596,293-triangle supported model: the rebuild came out
    // with 0 non-manifold edges, 0 pinches and 0 loops, and 114 inconsistent edges.
    let _ = crate::repair::unify_winding(&mut prepared);

    // 4b. Take the stair-steps off the surface the boolean built.
    if options.smooth_iterations > 0 && !prepared.triangles.is_empty() {
        let edge_scale = median_edge_length(&prepared);
        crate::smoothing::taubin_smooth(
            &mut prepared,
            options.smooth_iterations,
            edge_scale,
            edge_scale * 0.5,
        );
        let _ = crate::repair::unify_winding(&mut prepared);
    }

    let _ = envelope.clamp(&mut prepared);

    // 5. Drop what the rebuild left behind.
    if !phases.phase("shells") {
        return unchanged(None, true);
    }
    if options.remove_noise_shells {
        crate::shells::remove_noise_shells(&mut prepared);
    }

    // 6. Put the detail back at the density the loader would.
    //
    // The resolve triangulates a flat region as one polygon, so the whole underside of a plate comes
    // back as a single fan of needles bridging its pockets, and `as_original` cannot help: on a round
    // trip there is no operand for the provenance to point at, and the construction is what
    // re-triangulated. Measured on `Gusano_de_Dune_70%.stl`, over its underside: the input's own
    // triangulation is even, the resolve's is not, and the app takes the repaired positions straight
    // from the repair rather than re-reading them through the loader, so nothing downstream was going
    // to fix it. This applies the loader's own rule, at its own threshold and budget, so a rebuild
    // hands back a surface at the density a read would have given it.
    let prepared = crate::io::refine_coarse_faces(prepared);

    let shells_after = shells_of(&prepared);
    let output_triangles = prepared.triangles.len();
    SolidRemeshOutcome {
        mesh: prepared,
        report: SolidRemeshReport {
            input_triangles: mesh.triangles.len(),
            output_triangles,
            shells_before,
            shells_after,
            holes_filled,
            non_manifold_resolved: resolved.get(),
            declined: None,
            ms: started.elapsed().as_secs_f64() * 1000.0,
            cancelled: false,
        },
    }
}

/// The middle edge length of a mesh, which is the scale its own features are at.
pub(crate) fn median_edge_length(mesh: &IndexedMesh) -> f32 {
    let mut lengths: Vec<f32> = Vec::with_capacity(mesh.triangles.len() * 3 / 2);
    for t in mesh.triangles.iter() {
        for k in 0..3 {
            let a = mesh.positions[t[k] as usize];
            let b = mesh.positions[t[(k + 1) % 3] as usize];
            lengths.push(a.sub(b).length());
        }
    }
    if lengths.is_empty() {
        return 1.0;
    }
    lengths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    lengths[lengths.len() / 2].max(1e-6)
}

/// Separate the surfaces that share an edge, until the boolean has something it can build from.
///
/// The boolean's input must be a solid, and a manifold is built from a surface where every edge
/// carries two faces. A mesh that arrives with thousands of non-manifold edges is the mesh that most
/// needs rebuilding, so refusing it is refusing the case this mode exists for.
///
/// This is the one place the non-manifold split runs **unconditionally**. In the repair pipeline it
/// is kept only when it leaves the mesh better by the five classes, because pulling two surfaces
/// apart costs parts and moves the volume, and a repair that does that has not repaired anything.
/// Here it does not have to be the repair: it only has to make the mesh manifold enough for the
/// boolean, and the boolean is what judges the result.
///
/// Rounds, because separating one junction exposes rims that meet at pinches of their own. A round is
/// kept only when it reduces the count, and the mesh is left as it was found when one does not.
fn separate_shared_edges_for_boolean(mesh: &mut IndexedMesh) -> usize {
    const MAX_ROUNDS: usize = 6;
    let mut split_total = 0usize;
    // The same offset the repair pipeline's split uses, from the same derived tolerance. A smaller
    // one leaves the separated surfaces close enough to merge back, which is what made an earlier
    // attempt at this report 8,024 vertices split and the mesh still not manifold.
    let epsilon = crate::repair::derive_weld_epsilon(mesh);
    for _ in 0..MAX_ROUNDS {
        let before = crate::evaluate::evaluate(mesh);
        if before.non_manifold_edges == 0 {
            break;
        }
        let mut candidate = mesh.clone();
        let offset = 4.0 * (epsilon * candidate.bbox().diag()).max(1e-7);
        crate::topology_passes::remove_coincident_faces(&mut candidate);
        let split = crate::topology_passes::split_non_manifold_edges(&mut candidate, offset);
        if split == 0 {
            break;
        }
        // The rims a separation exposes are artifacts of the separation, not openings somebody
        // designed, so they are filled whatever their length.
        crate::topology_passes::split_pinched_vertices(&mut candidate);
        crate::holes::holes_all(&mut candidate, usize::MAX);
        let _ = crate::repair::unify_winding(&mut candidate);
        let after = crate::evaluate::evaluate(&candidate);
        eprintln!(
            "[dragonfruit-mesh-repair] separation: non-manifold {} -> {}, pinches {} -> {}, loops {} -> {}, split {split}",
            before.non_manifold_edges, after.non_manifold_edges,
            before.non_manifold_vertices, after.non_manifold_vertices,
            before.holes, after.holes,
        );
        if after.non_manifold_edges >= before.non_manifold_edges {
            break;
        }
        *mesh = candidate;
        split_total += split;
    }

    // The last resort, for the junctions the separation cannot take apart: measured on the supported
    // model, it stalls at 94 non-manifold edges, because the edges left are ones where more than two
    // surfaces meet through a single vertex and no offset separates them. They are cut out and the
    // openings filled.
    //
    // A repair would never keep this: it changes the mesh by more than the class it fixes. Here the
    // boolean is the judge of what comes out, and the alternative is refusing the file at all.
    for _ in 0..3 {
        let before = crate::evaluate::evaluate(mesh);
        if before.non_manifold_edges == 0 {
            break;
        }
        let mut candidate = mesh.clone();
        if crate::topology_passes::excise_tangles(&mut candidate) == 0 {
            break;
        }
        crate::topology_passes::split_pinched_vertices(&mut candidate);
        crate::holes::holes_all(&mut candidate, usize::MAX);
        let _ = crate::repair::unify_winding(&mut candidate);
        let after = crate::evaluate::evaluate(&candidate);
        eprintln!(
            "[dragonfruit-mesh-repair] separation: excising the rest, non-manifold {} -> {}, loops {} -> {}",
            before.non_manifold_edges, after.non_manifold_edges, before.holes, after.holes,
        );
        if after.non_manifold_edges >= before.non_manifold_edges {
            break;
        }
        *mesh = candidate;
        if after.non_manifold_edges == 0 {
            break;
        }
    }
    split_total
}

/// The precision the resolve is allowed to work at, as a distance in model units.
///
/// Manifold's own default is an absolute 1.2e-5 whatever the model is, which on a mesh whose median
/// edge is 0.46 mm asks it to keep geometry two millionths of an edge apart. What it does with that
/// is triangulate the crossing soup at a scale nothing in the model shares, and on
/// `Gusano_de_Dune_70%.stl` that came out as a star of shard shells ringing every pocket in the
/// underside. Measured over that file's underside, sweeping this tolerance:
///
/// | tolerance | triangles out | the underside |
/// | --- | --- | --- |
/// | 1.2e-5 (Manifold's default) | 603,772 | shards around all seven pockets |
/// | 1e-5 | 603,772 | the same |
/// | **1e-4** | **499,168** | **clean, faint rims** |
/// | 1e-3 | 488,086 | clean |
/// | 9.2e-3 | 466,322 | clean |
///
/// So the resolve is asked for a fraction of the mesh's own median edge, which is the scale the rest
/// of this engine works at (see [`crate::repair`]'s weld tolerance for the same reasoning). The
/// fraction is the finest one that measured clean, and 1e-4 is where it was found.
const RESOLVE_TOLERANCE_OF_MEDIAN_EDGE: f64 = 0.0002;

fn resolve_tolerance(mesh: &IndexedMesh) -> f64 {
    let median = median_edge_length(mesh) as f64;
    (median * RESOLVE_TOLERANCE_OF_MEDIAN_EDGE).max(1e-9)
}

/// Build a manifold from the mesh and read it back: the boolean, in one call.
#[cfg(feature = "manifold")]
fn manifold_round_trip(mesh: &IndexedMesh) -> Result<IndexedMesh, String> {
    use manifold_csg::Manifold;

    // Compact the vertices first. A manifold is built from positions and indices, and leaving
    // unreferenced vertices in gives it geometry with nothing attached to it.
    let mut remap: Vec<u32> = vec![u32::MAX; mesh.positions.len()];
    let mut positions: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::with_capacity(mesh.triangles.len() * 3);
    for tri in &mesh.triangles {
        for &v in tri {
            let slot = &mut remap[v as usize];
            if *slot == u32::MAX {
                *slot = (positions.len() / 3) as u32;
                let p = mesh.positions[v as usize];
                positions.extend_from_slice(&[p.x, p.y, p.z]);
            }
            indices.push(*slot);
        }
    }
    if positions.is_empty() || indices.len() < 12 {
        return Err("there is not enough geometry to make a solid of".to_string());
    }

    let solid = Manifold::from_mesh_f32(&positions, 3, &indices)
        .map_err(|err| format!("the surface is not a solid it can resolve: {err:?}"))?;
    if solid.is_empty() || solid.num_tri() == 0 {
        return Err("the surface resolved to nothing".to_string());
    }
    let solid = solid.set_tolerance(resolve_tolerance(mesh));
    let (out_positions, stride, out_indices) = solid.to_mesh_f32();
    if out_positions.is_empty() || out_indices.len() < 12 {
        return Err("the rebuilt surface came back empty".to_string());
    }
    Ok(IndexedMesh {
        positions: out_positions
            .chunks_exact(stride)
            .map(|c| Vec3::new(c[0], c[1], c[2]))
            .collect(),
        triangles: out_indices
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A closed cube, twelve triangles, one shell.
    fn cube() -> IndexedMesh {
        let corners = [
            Vec3::new(0.0, 0.0, 0.0), Vec3::new(1.0, 0.0, 0.0), Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(0.0, 0.0, 1.0), Vec3::new(1.0, 1.0, 0.0), Vec3::new(1.0, 0.0, 1.0),
            Vec3::new(0.0, 1.0, 1.0), Vec3::new(1.0, 1.0, 1.0),
        ];
        let quads: [[u32; 4]; 6] = [
            [0, 2, 4, 1], [0, 1, 5, 3], [0, 3, 6, 2],
            [7, 5, 1, 4], [7, 4, 2, 6], [7, 6, 3, 5],
        ];
        let mut triangles = Vec::new();
        for q in quads {
            triangles.push([q[0], q[1], q[3]]);
            triangles.push([q[1], q[2], q[3]]);
        }
        IndexedMesh { positions: corners.to_vec(), triangles }
    }

    /// A closed solid is already a solid, so resolving it returns it. This is worth pinning: it is
    /// the reason a rebuild is not a resample, and the reason it is the wrong tool for a clean mesh
    /// and the right one for a mesh that is not one solid.
    #[test]
    fn a_closed_solid_comes_back_a_closed_solid() {
        let outcome = solid_remesh(&cube(), &SolidRemeshOptions::default());
        let report = &outcome.report;
        assert!(report.declined.is_none(), "a cube must resolve: {:?}", report.declined);
        assert_eq!(report.shells_before, 1);
        assert_eq!(report.shells_after, 1);
        assert!(report.output_triangles >= 12, "got {}", report.output_triangles);
        assert_eq!(outcome.mesh.triangles.len(), report.output_triangles);
    }

    /// An open surface is closed before the boolean sees it, which is the order the reference uses
    /// too - it fills every hole first for the same reason: a boolean cannot resolve a boundary.
    #[test]
    fn an_open_solid_is_closed_and_then_resolved() {
        let mut open = cube();
        // Remove a face so the surface has a boundary and encloses nothing.
        open.triangles.truncate(open.triangles.len() - 2);
        let outcome = solid_remesh(&open, &SolidRemeshOptions::default());
        let report = &outcome.report;
        assert!(report.holes_filled > 0, "the boundary should have been capped");
        assert!(report.declined.is_none(), "a capped solid must resolve: {:?}", report.declined);
        assert_eq!(report.shells_after, 1);
        assert!(report.output_triangles > open.triangles.len());
    }

    /// A model that cannot be resolved is handed back, not emptied. A caller that gets an empty mesh
    /// has lost the model it asked about.
    #[test]
    fn a_model_that_cannot_be_resolved_comes_back_unchanged() {
        let sliver = IndexedMesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            triangles: vec![[0, 1, 2]],
        };
        let outcome = solid_remesh(&sliver, &SolidRemeshOptions::default());
        assert!(outcome.report.declined.is_some(), "a single triangle is not a solid");
        assert_eq!(outcome.mesh.triangles.len(), sliver.triangles.len());
        assert!(!outcome.report.cancelled);
    }

    /// Stopping returns the input and says so, so a caller that stops has changed nothing.
    #[test]
    fn stopping_returns_the_input_unchanged() {
        let mesh = cube();
        let mut seen: Vec<String> = Vec::new();
        let outcome = solid_remesh_with_progress(&mesh, &SolidRemeshOptions::default(), Some(&mut |name, _| {
            seen.push(name.to_string());
            name != "fill"
        }));
        assert_eq!(seen, vec!["prepare", "simplify", "fill"]);
        assert!(outcome.report.cancelled);
        assert_eq!(outcome.mesh.triangles.len(), mesh.triangles.len());
    }
}
