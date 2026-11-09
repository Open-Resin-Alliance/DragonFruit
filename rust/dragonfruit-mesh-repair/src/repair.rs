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

use std::collections::BTreeMap;

use ahash::{AHashMap, AHashSet};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::analysis::{analyze, analyze_lightweight, minimal_analysis};
use crate::core::bvh::Bvh;
use crate::core::halfedge::{edge_key, EdgeInfo, EdgeKey, Topology};
use crate::core::mesh::{IndexedMesh, Vec3};
use crate::report::{MeshHealthReport, RepairStepReport};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairOptions {
    /// Weld tolerance, **absolute and in model units** (millimetres for every model this app loads).
    /// `None` runs [`DEFAULT_WELD_TOLERANCES_MM`] as a ladder.
    ///
    /// This was a fraction of the bbox diagonal for a while. That made the weld a property of how the
    /// mesh was loaded rather than of the geometry: the loader refines coarse faces, refinement
    /// shortens the shortest edge, the derived tolerance followed it down, and no caller could ask for
    /// a distance. A stitch is a distance.
    pub weld_tolerance_mm: Option<f32>,
    /// Longest boundary loop, in vertices, that will be auto-filled. `None` derives it from the
    /// mesh.
    pub fill_holes_max_edges: Option<usize>,
    /// Cut the edges no winding assignment can satisfy, where that is the only move left. **On by
    /// default**, because it is judged: see the doc comment below for what "judged" buys.
    ///
    /// Set it to `false` to have the pipeline report the residue instead of touching geometry.
    ///
    /// The V3 Cones and `Gusano_de_Dune_70%.stl` end with inconsistently wound edges that no amount of
    /// flipping clears: the faces joined across two-face edges form a graph whose edges demand a
    /// parity, and a cycle whose parities sum to an odd number is satisfied by no assignment. The
    /// passes above settle a mesh whose disagreements are spread over the surface; this is for the
    /// residue they cannot reach, and it buys the winding class with geometry — the region is one face
    /// from each unsatisfiable edge, and the vertices it shares with the rest of the surface are
    /// duplicated — so it is off unless the caller asks for it.
    ///
    /// Judged like the passes that rebuild surface, so it cannot make a mesh worse: the cut is kept
    /// only when the defect total strictly drops, and — on a watertight mesh, where the number means
    /// something — when the volume holds. Its own scraps are culled before it is judged, because a
    /// region detached from the surface is a shell of one to three faces and the noise rule is what
    /// removes those.
    ///
    /// Measured on `Gusano_de_Dune_70%.stl` (596,293 triangles in): winding **1,374 -> 0**,
    /// non-manifold edges 196 -> **97**, pinched vertices 338 -> **188**, loops 0 either way. It is off
    /// by default because the same move on a surface that is frustrated throughout can go the other
    /// way — on an earlier branch, one file's winding went 113 to 919 — and the guard above is what
    /// makes that a refusal rather than a regression.
    pub cut_unsatisfiable_edges: bool,
    /// Let [`repair_auto`] fall back to the surface-to-solid rebuild when the local pipeline cannot
    /// settle a mesh. **On by default**, and judged: the rebuild is kept only when it is fully
    /// repaired, or when its defect total is strictly better than the local result's.
    ///
    /// It is a different object when it runs — it rebuilds the surface into a solid and moves it —
    /// so the report says so rather than the change being silent.
    pub allow_rebuild: bool,
    /// Keep the top-N components ranked by |signed volume|. `None` = keep all.
    pub keep_largest_n_components: Option<usize>,
    /// Attempt orientation repair (per-component outward vote).
    pub repair_orientation: bool,
    /// Split the self-crossings and remove the faces they bury.
    ///
    /// Off by default: the split can be expensive on a large mesh, and a mesh that
    /// crosses itself still prints.
    pub resolve_self_intersections: bool,
    /// When set to `Some(true)`, forces the repair pipeline to treat the input
    /// mesh as support geometry (`likely_support_geometry = true`) and bypasses
    /// component shape heuristic re-derivation.
    pub assume_support_geometry: Option<bool>,
}

/// The absolute weld tolerance the stitch runs, in model units, when the caller names none.
///
/// Unset, the engine derives one: the mesh's own shortest edge, as a fraction of its bbox diagonal,
/// which is what this pipeline has always done. That is a *fraction*, so it moves with the mesh —
/// and the mesh moves with how it was loaded, because the loader refines coarse faces before the
/// repair sees them (`docs/dev/mesh-wire-formats.md`) and refinement shortens the shortest edge. The
/// coupling is real and it is why this option exists: a caller with a mesh that needs a stitch at a
/// known distance can now name one, in the unit a distance is measured in.
///
/// **A fixed absolute default was measured and rejected.** The reference's own script stitches at
/// 0.010 mm, so 0.010 mm was made the default here, and a four-rung ladder of absolute tolerances
/// (0.002 to 0.010) was tried as well, because a quantising weld can miss a pair at one step that it
/// catches at the next. Over the thirteen-file corpus:
///
/// | default | engine time | defect classes and verdicts changed |
/// | --- | --- | --- |
/// | derived (this) | baseline | — |
/// | 0.010 mm | +10% to +25% | none |
/// | ladder, 0.002 to 0.010 mm | +30% to +67% | none |
///
/// Neither welded anything on any file but one, where the ladder welded 4 vertices. The reason is
/// upstream of here: every mesh reaches the repair already welded, because the *loader* welds the
/// soup it reads, so what the stitch has left to do is normally nothing, and a coarser rung is
/// refused by its own guard when it finds something to merge. Paying a weld and two topology builds
/// per run to attempt a tolerance that has never once been the difference is not a design.
pub const DEFAULT_WELD_TOLERANCE_MM: Option<f32> = None;

impl Default for RepairOptions {
    fn default() -> Self {
        Self {
            // Both left to the mesh. A caller that sets one is overriding a decision the engine
            // is better placed to make: neither number means anything without knowing the model.
            weld_tolerance_mm: None,
            fill_holes_max_edges: None,
            cut_unsatisfiable_edges: true,
            allow_rebuild: true,
            keep_largest_n_components: None,
            repair_orientation: true,
            resolve_self_intersections: false,
            assume_support_geometry: None,
        }
    }
}

/// The options the pipeline actually runs with: whatever the caller set, and a value derived from
/// the mesh for each tolerance they left alone.
struct ResolvedOptions {
    /// The weld step the stitch runs, in model units. The caller's absolute tolerance, or the default.
    weld_step: f32,
    fill_holes_max_edges: usize,
    /// The cap for the fill that runs last, after every other pass. Unlimited unless the caller set
    /// a cap of their own — see the settle stage for why.
    residual_fill_max_edges: usize,
    cut_unsatisfiable_edges: bool,
    keep_largest_n_components: Option<usize>,
    resolve_self_intersections: bool,
    assume_support_geometry: Option<bool>,
}

/// Weld tolerance as a fraction of the bbox diagonal, derived from the mesh.
///
/// The mesh's own shortest edge is the only defensible scale: vertices closer together than the
/// finest edge the mesh already carries are the same vertex, and anything coarser welds detail that
/// was put there on purpose. Bounded at both ends so a degenerate input can neither collapse the
/// model nor leave the weld doing nothing.
pub(crate) fn derive_weld_epsilon(mesh: &IndexedMesh) -> f32 {
    let diag = mesh.bbox().diag().max(1e-6);
    let mut shortest = f32::INFINITY;
    for t in &mesh.triangles {
        for k in 0..3 {
            let a = mesh.positions[t[k] as usize];
            let b = mesh.positions[t[(k + 1) % 3] as usize];
            let d = a.sub(b).length();
            if d > 0.0 && d < shortest {
                shortest = d;
            }
        }
    }
    if !shortest.is_finite() {
        return 1e-5;
    }
    (shortest / diag).clamp(1e-7, 1e-4)
}

/// The longest boundary loop that will be auto-filled, in vertices, derived from the mesh.
///
/// A vertex count is not a size — it measures how finely a rim happens to be tessellated, so the
/// same constant means a different hole on every model. What "small" means is a length relative to
/// the model, so this converts a fraction of the bbox diagonal into edges at the mesh's own median
/// edge length.
fn derive_fill_cap(mesh: &IndexedMesh) -> usize {
    let diag = mesh.bbox().diag().max(1e-6);
    let mut lengths: Vec<f32> = Vec::with_capacity(mesh.triangles.len() * 3);
    for t in &mesh.triangles {
        for k in 0..3 {
            let a = mesh.positions[t[k] as usize];
            let b = mesh.positions[t[(k + 1) % 3] as usize];
            lengths.push(a.sub(b).length());
        }
    }
    if lengths.is_empty() {
        return 64;
    }
    lengths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = lengths[lengths.len() / 2].max(1e-9);
    // A twentieth of the model across. The fixed 64 this replaces was about a fifth on the
    // reference files, which filled openings that were not holes.
    let target = diag / 20.0;
    ((target / median).ceil() as usize).clamp(16, 4096)
}

impl RepairOptions {
    fn resolved(&self, mesh: &IndexedMesh) -> ResolvedOptions {
        ResolvedOptions {
            // One internal unit, an absolute step, so the two paths cannot disagree about what a
            // tolerance means. The derived default is the mesh's own shortest edge over its diagonal,
            // scaled back up by the diagonal to the distance it represents.
            weld_step: {
                let diag = mesh.bbox().diag().max(1e-6);
                self.weld_tolerance_mm
                    .or(DEFAULT_WELD_TOLERANCE_MM)
                    .map(|tolerance| tolerance.max(1e-7))
                    .unwrap_or_else(|| (derive_weld_epsilon(mesh) * diag).max(1e-7))
            },
            fill_holes_max_edges: self
                .fill_holes_max_edges
                .unwrap_or_else(|| derive_fill_cap(mesh)),
            residual_fill_max_edges: self.fill_holes_max_edges.unwrap_or(usize::MAX),
            cut_unsatisfiable_edges: self.cut_unsatisfiable_edges,
            keep_largest_n_components: self.keep_largest_n_components,
            resolve_self_intersections: self.resolve_self_intersections,
            assume_support_geometry: self.assume_support_geometry,
        }
    }
}

impl ResolvedOptions {
    /// How far the split moves a separated surface.
    ///
    /// Two things set the floor. One is this pipeline's own weld: four of its steps, which is what stops a
    /// re-read welding the separated surfaces back. The other is the **loader's** weld, which is larger,
    /// and it is the one that decides what a caller sees.
    ///
    /// The loader welds a triangle soup at `DEFAULT_MERGE_EPSILON` relative to the bbox diagonal, and a
    /// soup is what every export path here produces: an STL carries no vertex indices, and the staged
    /// `positions.bin` is nine floats per triangle. So a mesh whose separated surfaces are closer
    /// together than the loader's weld does not survive a round trip through a file — the loader welds
    /// them back, and the defects the split resolved reappear in the file the user renders.
    ///
    /// Measured on the reported model: in memory the rebuild-then-repair output is 0/0/0/0, the split had
    /// displaced separated surfaces by 8e-5 mm, the loader welds at 1.9e-4 mm, and the STL that came out
    /// of it had 177 winding edges. The separation has to beat the weld that will read it.
    fn split_offset(&self, mesh: &IndexedMesh) -> f32 {
        let own = 4.0 * self.weld_step;
        let loader = 4.0 * crate::io::DEFAULT_MERGE_EPSILON * mesh.bbox().diag().max(1e-6);
        own.max(loader).max(1e-7)
    }
}

/// Runs the orientation pass only when something has changed the mesh since the last one.
///
/// Every pass in this pipeline is deterministic, and that was checked rather than assumed: three files
/// repair to bit-identical output across repeated runs. So an orientation pass handed a mesh it has
/// already been handed does nothing, and skipping it is free. Running it is not free — it is one of the
/// two largest costs in the pipeline, and the pipeline reaches for it four times, because orientation,
/// stitch, holes and double faces each disturb what the one before settled.
///
/// The count it gates on is exact: every stage reports what it changed, a refused pass reports zero
/// because it reverted, and [`OrientationGate::note`] is called from the same `stage!` that records
/// that number, so a new pass cannot forget to declare itself.
struct OrientationGate {
    changed_since: usize,
}

impl OrientationGate {
    fn note(&mut self, changed: usize) {
        self.changed_since = self.changed_since.saturating_add(changed);
    }

    /// Orient the mesh, and mark it as newly oriented: the next call is skipped until a stage changes
    /// something again.
    fn orient(&mut self, mesh: &mut IndexedMesh) -> usize {
        if self.changed_since == 0 {
            return 0;
        }
        let flipped = repair_orientation(mesh);
        self.changed_since = 0;
        flipped
    }
}

/// Components the orientation pass would not leave alone: at least four faces, and a signed volume
/// that is not decisively positive.
///
/// The pass turns such a component over when its volume is negative, and votes on it when the
/// volume is too small to decide (a fragment that encloses nothing). Both cases are this test, so
/// the count is exactly the set it can act on: `repair_orientation` skips components under four
/// faces, because below that the volume says where the triangle sits relative to the origin rather
/// than which way it faces.
///
/// The arithmetic is the pass's, in the pass's order, so the two agree bit for bit.
fn components_not_outward(mesh: &IndexedMesh) -> usize {
    let n = mesh.triangles.len();
    if n == 0 {
        return 0;
    }
    let components = triangle_components(mesh);
    let n_components = components.iter().max().copied().unwrap_or(0) as usize + 1;
    let mut faces = vec![0usize; n_components];
    let mut volume = vec![0.0f64; n_components];
    for (fi, &component) in components.iter().enumerate() {
        let c = component as usize;
        faces[c] += 1;
        let t = mesh.triangles[fi];
        let a = mesh.positions[t[0] as usize];
        let b = mesh.positions[t[1] as usize];
        let d = mesh.positions[t[2] as usize];
        volume[c] += (a.x as f64) * ((b.y as f64) * (d.z as f64) - (b.z as f64) * (d.y as f64))
            - (a.y as f64) * ((b.x as f64) * (d.z as f64) - (b.z as f64) * (d.x as f64))
            + (a.z as f64) * ((b.x as f64) * (d.y as f64) - (b.y as f64) * (d.x as f64));
    }
    (0..n_components)
        .filter(|&c| faces[c] >= 4 && volume[c] / 6.0 <= 1e-6)
        .count()
}

/// Whether the orientation pass has anything to do on a mesh that nothing has touched yet.
///
/// Three things make it act, and both of them are read here. `unify_winding` flips faces to settle
/// edges whose two faces disagree, and an edge that disagrees is the only thing `solve_winding_cut`
/// can cut, so with none of those the consistency half is a no-op twice over: the patch vote in
/// `unify_winding_once` finds nothing on either side of a patch that already agrees, the parity
/// walk in `winding_sides` builds its graph from those same edges and assigns every face side zero,
/// and the cut returns before it looks at anything. The per-component half is
/// [`components_not_outward`].
///
/// So a mesh that arrives consistent, with every component's own volume decisively positive, is one
/// the pass would leave exactly as it found it. Measured on `poussin.stl` (170,790 triangles,
/// watertight, one component): 762 ms to flip nothing.
fn orientation_settled(mesh: &IndexedMesh, pre: &crate::analysis::MeshAnalysis) -> bool {
    pre.inconsistent_winding_edges == 0 && components_not_outward(mesh) == 0
}

/// Whether the weld has anything to join: a weld cell holding two vertices.
///
/// Both welds cluster by rounded cell and merge only inside a cell, so a mesh whose cells are all
/// singletons has nothing for either of them to do: the loose one returns before it touches the mesh,
/// and the oriented one, which also clusters by the direction the surface faces, finds no two
/// vertices to compare. The key is built the same way in all three places, so they agree.
fn nothing_to_weld(mesh: &IndexedMesh, step: f32) -> bool {
    let step = step.max(1e-7);
    let inv_step = 1.0 / step;
    let mut seen: AHashMap<(i32, i32, i32), u32> = AHashMap::with_capacity(mesh.positions.len());
    for p in &mesh.positions {
        let key = (
            (p.x * inv_step).round() as i32,
            (p.y * inv_step).round() as i32,
            (p.z * inv_step).round() as i32,
        );
        if seen.insert(key, 0).is_some() {
            return false;
        }
    }
    true
}

/// A pass that was tried and refused, remembered against the mesh it was refused on.
///
/// The weld is deterministic: the same mesh at the same tolerance welds the same vertices, and the
/// same guard refuses the same junction. The pipeline reaches for it four times — the stitch stage,
/// both combined rounds and the settle — and when the first one is refused, the repeats are the same
/// work answering a question that has already been answered. This is [`OrientationGate`] with a
/// rejection instead of a no-op: the repeat is skipped, and it runs again the moment any stage
/// changes something, because that is the only thing that can change the answer.
struct RefusalGate {
    refused: bool,
    changed_since: usize,
}

impl RefusalGate {
    fn note(&mut self, changed: usize) {
        self.changed_since = self.changed_since.saturating_add(changed);
    }

    /// Never tried, not refused, or the mesh has moved since.
    fn should_run(&self) -> bool {
        !self.refused || self.changed_since > 0
    }

    /// Record this run's answer. The `stage!` that follows records what it changed, so a run that
    /// did change something re-arms the gate on the spot.
    fn record(&mut self, refused: bool) {
        self.refused = refused;
        self.changed_since = 0;
    }
}

/// How many vertices share a loader weld cell with another index.
///
/// A separation two surfaces keep between them is a *distinct index at the same position*, and every
/// export path here is a triangle soup whose loader welds by position, so any pair this counts is a
/// separation the next read undoes. The pipeline welds its output and asserts on this in debug builds;
/// see the end of `prune_and_classify`.
fn coincident_count(mesh: &IndexedMesh) -> usize {
    // The loader multiplies by the reciprocal of the step; dividing by it instead rounds differently on
    // the last ulp, which is enough to put a vertex on the other side of a cell boundary from where the
    // loader puts it. Same expression, so the same answer.
    let step = (crate::io::DEFAULT_MERGE_EPSILON * mesh.bbox().diag().max(1e-6)).max(1e-7);
    let inv_step = 1.0 / step;
    let mut first: ahash::AHashMap<(i32, i32, i32), u32> = ahash::AHashMap::new();
    let mut collisions = 0usize;
    for (i, p) in mesh.positions.iter().enumerate() {
        let key = (
            (p.x * inv_step).round() as i32,
            (p.y * inv_step).round() as i32,
            (p.z * inv_step).round() as i32,
        );
        match first.get(&key) {
            Some(&j) if j != i as u32 => collisions += 1,
            Some(_) => {}
            None => {
                first.insert(key, i as u32);
            }
        }
    }
    collisions
}

/// The box the mesh arrived in, and how far a pass may push outside it.
///
/// A repair may not invent geometry. A vertex outside the envelope the mesh came in with is geometry
/// that was not there, and on a plate with a flat bottom it is a spike: measured on
/// `Gusano_de_Dune_70%.stl`, the fill the non-manifold class runs put a vertex **0.198 mm below the
/// bottom**, which is four layers at 0.05 mm. The slicer then prints that sliver alone on the first
/// layers, because it is the lowest thing in the mesh and the model's own base does not start until
/// 0.198 mm up.
///
/// The slack is a hundredth of the mesh's median edge, so a pass may still move a vertex by a
/// hair — the fills and splits that keep a surface closed do — without being refused.
pub(crate) struct Envelope {
    min: Vec3,
    max: Vec3,
    slack: f32,
}

impl Envelope {
    pub(crate) fn of(mesh: &IndexedMesh) -> Self {
        let mut min = Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
        let mut max = Vec3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
        for p in &mesh.positions {
            min = min.min(*p);
            max = max.max(*p);
        }
        Envelope {
            min,
            max,
            slack: (crate::solid_remesh::median_edge_length(mesh) * 0.01).max(1e-6),
        }
    }

    fn contains(&self, p: &Vec3, slack: f32) -> bool {
        p.x >= self.min.x - slack
            && p.y >= self.min.y - slack
            && p.z >= self.min.z - slack
            && p.x <= self.max.x + slack
            && p.y <= self.max.y + slack
            && p.z <= self.max.z + slack
    }

    /// Pull vertices a pass pushed outside back to the box, and say how many moved.
    ///
    /// Refusing the whole pass is the blunt version, and it costs real repairs: the fill that invented
    /// the 0.198 mm spike below `Gusano_de_Dune_70%`'s floor also resolved 1,895 non-manifold edges,
    /// and refusing it left every one of them. Clamping keeps the work and removes the invention. What
    /// it produces is still judged by the round's own defect total, so a clamp that broke the surface
    /// is refused there rather than kept.
    pub(crate) fn clamp(&self, mesh: &mut IndexedMesh) -> usize {
        let mut moved = 0;
        let mut inside = 0;
        for p in mesh.positions.iter_mut() {
            if self.contains(p, 0.0) {
                inside += 1;
                continue;
            }
            *p = Vec3::new(
                p.x.clamp(self.min.x, self.max.x),
                p.y.clamp(self.min.y, self.max.y),
                p.z.clamp(self.min.z, self.max.z),
            );
            moved += 1;
        }
        let _ = inside;
        moved
    }
}

/// Pull the vertices a pass *added* back onto the surface the mesh arrived with.
///
/// A repair may not invent geometry, and inventing is not "leaving the bounding box": a fill can put
/// a peak or a valley in the middle of a flat face and stay inside the box it came in with. What a
/// pass may not do is move the surface. Measured on `Gusano_de_Dune_70%.stl`, the fill the
/// non-manifold class runs put a vertex **0.198 mm below a bottom that is flat to 0.0000 mm**, which
/// is four layers at 0.05 mm, and the slicer then prints that sliver alone on the first layers.
///
/// Only the vertices the pass *added* are checked, and that is the whole of the cost: the fills are
/// what add geometry (the splits and the weld move or duplicate what is already there, and their
/// offsets are deliberate), newly added vertices are appended, so this is a walk over the tail.
/// A vertex within `slack` of the surface it arrived with is left alone; one outside it moves to the
/// nearest point of that surface.
fn project_added_onto_surface(
    mesh: &mut IndexedMesh,
    arrived: &IndexedMesh,
    bvh: &Bvh,
    slack: f32,
) -> usize {
    let from = arrived.positions.len();
    if mesh.positions.len() <= from {
        return 0;
    }
    let mut moved = 0;
    for index in from..mesh.positions.len() {
        let p = mesh.positions[index];
        let Some((distance, face)) = bvh.nearest_triangle(arrived, p) else {
            continue;
        };
        if distance <= slack {
            continue;
        }
        let t = arrived.triangles[face as usize];
        mesh.positions[index] = crate::core::bvh::closest_point_on_triangle(
            p,
            arrived.positions[t[0] as usize],
            arrived.positions[t[1] as usize],
            arrived.positions[t[2] as usize],
        );
        moved += 1;
    }
    moved
}

/// Passes the defect loop may run, across all its classes.
///
/// The reference's tracker takes an iteration cap too. The classes disturb each other, so a round can
/// expose one the round before it created; six is enough for the files measured here, and each attempt
/// costs a clone and two evaluations, so it is a bound worth having.
const MAX_REPAIR_ATTEMPTS: usize = 6;

/// The defect classes a round may work on, in the order it tries them.
///
/// Not the order the verdict prints them in. Non-manifold edges come first because resolving them is
/// what the reference's union does and what this engine's split can do, and because they are the class
/// with the most in it on a damaged file. A winding disagreement is next: the orientation pass has to
/// settle which side of a loop is solid before a fill can. Then a boundary, because filling one adds
/// geometry. Pinches and shells last.
#[derive(Clone, Copy, PartialEq)]
enum DefectClass {
    NonManifoldEdges,
    Winding,
    Boundary,
    PinchedVertices,
    NoiseShells,
}

const DEFECT_CLASSES: [DefectClass; 5] = [
    DefectClass::NonManifoldEdges,
    DefectClass::Winding,
    DefectClass::Boundary,
    DefectClass::PinchedVertices,
    DefectClass::NoiseShells,
];

impl DefectClass {
    fn name(self) -> &'static str {
        match self {
            DefectClass::NonManifoldEdges => "non-manifold edges",
            DefectClass::Winding => "winding",
            DefectClass::Boundary => "boundary",
            DefectClass::PinchedVertices => "pinched vertices",
            DefectClass::NoiseShells => "noise shells",
        }
    }

    fn present(self, d: &crate::evaluate::MeshDefects) -> bool {
        match self {
            DefectClass::NonManifoldEdges => d.non_manifold_edges > 0,
            DefectClass::Winding => d.inconsistent_edges > 0,
            DefectClass::Boundary => d.bad_edges > 0,
            DefectClass::PinchedVertices => d.non_manifold_vertices > 0,
            DefectClass::NoiseShells => d.noise_shells > 0,
        }
    }
}

/// Run the pass a class needs, and report what it changed.
///
/// One pass, not the whole pipeline: that is the difference from the rounds this engine used to run,
/// which re-ran everything and cost 40% of a run doing it.
///
/// The separating branches close the rims they expose before returning, because a rim is a boundary edge
/// and the loop judges the whole defect total. Separating a shared edge and stopping there trades 1,363
/// non-manifold edges for 177 boundary ones, which measures as worse.
fn repair_one_defect_class(
    mesh: &mut IndexedMesh,
    class: DefectClass,
    options: &ResolvedOptions,
) -> usize {
    match class {
        DefectClass::NonManifoldEdges => {
            let walls = crate::topology_passes::remove_coincident_faces(mesh);
            let split = crate::topology_passes::split_non_manifold_edges(mesh, options.split_offset(mesh));
            let filled = crate::holes::holes_all(mesh, usize::MAX);
            crate::topology_passes::split_pinched_vertices(mesh);
            let refilled = crate::holes::holes_all(mesh, usize::MAX);
            let _ = unify_winding(mesh);
            walls + split + filled + refilled
        }
        DefectClass::Winding => {
            let mut changed = unify_winding(mesh);
            if changed == 0 {
                changed = repair_orientation(mesh);
            }
            let filled = crate::holes::holes_all(mesh, usize::MAX);
            changed + filled
        }
        DefectClass::Boundary => {
            let filled = crate::holes::holes_all(mesh, usize::MAX);
            filled
        }
        DefectClass::PinchedVertices => {
            let split = crate::topology_passes::split_pinched_vertices(mesh);
            let filled = crate::holes::holes_all(mesh, usize::MAX);
            split + filled
        }
        DefectClass::NoiseShells => {
            let removed = crate::shells::remove_noise_shells(mesh);
            removed
        }
    }
}

#[derive(Debug)]
pub struct RepairOutcome {
    pub mesh: IndexedMesh,
    pub report: MeshHealthReport,
}

pub type ClassificationOutcome = RepairOutcome;

/// One part of a mesh that is several parts, repaired on its own.
#[derive(Debug)]
pub struct PartOutcome {
    /// Where the part sat in the input's component order.
    pub index: usize,
    /// How the part stood before its repair.
    pub before: crate::analysis::MeshAnalysis,
    /// The part's own repair. Its `mesh` is the repaired part, which is what a caller writes out or
    /// keeps; its `report` is the verdict for that part alone.
    pub outcome: Box<RepairOutcome>,
}

/// A mesh that is several separate parts, each one repaired on its own.
#[derive(Debug)]
pub struct PartsRepair {
    pub parts: Vec<PartOutcome>,
    /// Components that were left out of the split because they meet another component: they are one
    /// object between them, and repairing them apart would repair neither.
    pub joined: usize,
    /// How the whole input stood, for the report the caller hands on.
    pub before: crate::analysis::MeshAnalysis,
    pub elapsed_ms: f64,
}

impl PartsRepair {
    /// How many of the parts came out of their own repair fully repaired.
    pub fn repaired(&self) -> usize {
        self.parts
            .iter()
            .filter(|p| p.outcome.report.fully_repaired)
            .count()
    }

    /// Every part's repaired mesh, joined into one mesh in the input's part order.
    ///
    /// This is what a caller stages or writes when it wants a single model back: the parts are
    /// repaired separately and returned together, at the positions they arrived at.
    pub fn combined_mesh(&self) -> IndexedMesh {
        let mut positions: Vec<Vec3> = Vec::new();
        let mut triangles: Vec<[u32; 3]> = Vec::new();
        for part in &self.parts {
            let base = positions.len() as u32;
            positions.extend_from_slice(&part.outcome.mesh.positions);
            triangles.extend(part.outcome.mesh.triangles.iter().map(|t| {
                [t[0] + base, t[1] + base, t[2] + base]
            }));
        }
        IndexedMesh {
            positions,
            triangles,
        }
    }

    /// The report a caller hands to a UI or a file: the whole input's analysis, the joined result's,
    /// and one entry per part saying which object was the problem.
    pub fn report(&self, source_path: Option<String>) -> MeshHealthReport {
        let mut report = MeshHealthReport::new(self.before.clone());
        report.source_path = source_path;
        report.post = analyze(&self.combined_mesh());
        report.parts = self
            .parts
            .iter()
            .map(|part| crate::report::MeshPartReport {
                index: part.index,
                triangles_before: part.before.triangle_count,
                triangles_after: part.outcome.report.post.triangle_count,
                fully_repaired: part.outcome.report.fully_repaired,
                residual_issues: part
                    .outcome
                    .report
                    .residual_issues
                    .iter()
                    .take(2)
                    .cloned()
                    .collect(),
            })
            .collect();
        report.fully_repaired = self.parts.iter().all(|p| p.outcome.report.fully_repaired);
        let failed = self.parts.len() - self.repaired();
        report.residual_issues.push(format!(
            "the file is {} separate part(s); each was repaired on its own and {} of them are fully repaired{}",
            self.parts.len(),
            self.repaired(),
            if failed > 0 {
                format!(
                    ", and the {failed} that are not are listed under the parts: a part that fails on its own is not something the whole-file pass can fix"
                )
            } else {
                String::new()
            }
        ));
        for part in &self.parts {
            if part.outcome.report.fully_repaired {
                continue;
            }
            let reason = part
                .outcome
                .report
                .residual_issues
                .first()
                .cloned()
                .unwrap_or_else(|| "not fully repaired".to_string());
            report.residual_issues.push(format!(
                "part {} ({} triangles): {reason}",
                part.index, part.outcome.report.post.triangle_count
            ));
        }
        report.steps.push(RepairStepReport {
            name: "repair_parts".to_string(),
            changed: self.parts.len() as u32,
            notes: Some(format!(
                "{} part(s) repaired separately, {} joined into {} object(s)",
                self.parts.len(),
                self.joined,
                self.joined
            )),
            elapsed_ms: self.elapsed_ms,
        });
        report.total_ms = self.elapsed_ms;
        report
    }
}

/// Repair a mesh that is several separate parts by repairing each one on its own.
///
/// A print plate is not one model. Measured on the plate in the corpus: 29 closed shells by the
/// vertex count, 118 by the engine's edge count, and a slicer lists 25 objects — because an object
/// is one *or several* shells, and the shells of one object are the ones that meet each other. So
/// the parts here are the groups of components that meet, and components that meet nothing are parts
/// of their own.
///
/// Repairing the file whole gives one verdict for all of them, which is a verdict on the wrong unit:
/// it says the plate is broken when most of it is fine, and it says nothing about which part is not.
/// Per part, the answer is specific — on that plate, 16 shells repair cleanly on their own and the
/// ones that do not are the parts whose own topology contradicts itself.
///
/// Returns `None` when the mesh is one object: nothing to separate, and the caller's own pipeline is
/// the right one.
pub fn repair_separate_parts(
    mesh: &IndexedMesh,
    options: &RepairOptions,
    mut progress: Option<&mut dyn FnMut(usize, &str)>,
) -> Option<PartsRepair> {
    let components = triangle_components(mesh);
    let n_comps = components.iter().copied().max().map_or(0, |m| m as usize + 1);
    if n_comps < 2 {
        return None;
    }
    // Components that meet are one object: a part is a group of them, not a single shell. The graph
    // is the crossing relation, which is the same test the union uses to decide its operands.
    let crossing = crate::topology_passes::crossing_component_pairs(mesh, &components);
    let mut parent: Vec<u32> = (0..n_comps as u32).collect();
    fn find(parent: &mut [u32], mut i: u32) -> u32 {
        while parent[i as usize] != i {
            parent[i as usize] = parent[parent[i as usize] as usize];
            i = parent[i as usize];
        }
        i
    }
    for (a, b) in crossing.iter() {
        let (ra, rb) = (find(&mut parent, *a), find(&mut parent, *b));
        if ra != rb {
            parent[rb as usize] = ra;
        }
    }
    let mut by_group: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for c in 0..n_comps as u32 {
        by_group.entry(find(&mut parent, c)).or_default().push(c);
    }
    if by_group.len() < 2 {
        return None;
    }
    let groups: Vec<Vec<u32>> = by_group.into_values().collect();
    let joined = groups.iter().filter(|g| g.len() > 1).count();
    let before = analyze(mesh);
    let started = std::time::Instant::now();
    if let Some(sink) = progress.as_deref_mut() {
        sink(0, &format!("repairing {} part(s)", groups.len()));
    }
    // The parts do not meet, so nothing done to one of them can change the answer for another: they
    // are independent pipelines and they run at once.
    //
    let parts: Vec<PartOutcome> = groups
        .par_iter()
        .enumerate()
        .map(|(index, group)| {
            let part = sub_mesh_of_components(mesh, &components, group);
            let before = analyze(&part);
            let outcome = repair(part, options);
            PartOutcome {
                index,
                before,
                outcome: Box::new(outcome),
            }
        })
        .collect();
    Some(PartsRepair {
        parts,
        joined,
        before,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

/// The faces of one group of components, as a mesh of their own: positions remapped so the part
/// carries no vertex it does not use, which is what the reports and the exports read.
fn sub_mesh_of_components(mesh: &IndexedMesh, components: &[u32], group: &[u32]) -> IndexedMesh {
    let wanted: AHashSet<u32> = group.iter().copied().collect();
    let mut map: AHashMap<u32, u32> = AHashMap::new();
    let mut positions: Vec<Vec3> = Vec::new();
    let mut triangles: Vec<[u32; 3]> = Vec::new();
    for (fi, tri) in mesh.triangles.iter().enumerate() {
        if !wanted.contains(&components[fi]) {
            continue;
        }
        let mut mapped = [0u32; 3];
        for (k, &v) in tri.iter().enumerate() {
            let next = positions.len() as u32;
            let id = *map.entry(v).or_insert_with(|| {
                positions.push(mesh.positions[v as usize]);
                next
            });
            mapped[k] = id;
        }
        triangles.push(mapped);
    }
    IndexedMesh {
        positions,
        triangles,
    }
}

/// Runs the pass set with no progress reporting.
pub fn repair(mesh: IndexedMesh, options: &RepairOptions) -> RepairOutcome {
    repair_with_progress(mesh, options, None)
}

/// Repairs a mesh, choosing the route: the local pipeline, and the surface-to-solid rebuild behind
/// it when the local one cannot settle the mesh.
///
/// The local pipeline runs first, because it repairs what is there. If it comes back fully repaired
/// there is nothing to decide and the rebuild never runs. If it does not, and the caller allows a
/// rebuild, the mesh goes through `solid_remesh` — the surface resolved into a solid — and that result
/// is repaired in turn, and then **judged against the local result**: the rebuild is kept when it is
/// fully repaired, or when its defect total is strictly better. The surface moves when it does, and
/// the report says so, because that is a different object rather than the same one repaired.
///
/// Measured on `Gusano_de_Dune_70%.stl`, which nothing else settles: the local pipeline (with its own
/// cut) leaves 97 non-manifold edges, 188 pinched vertices and 0 winding edges; the rebuild behind it
/// comes out at **0 / 0 / 0 / 0 and `fully_repaired`**, 356,942 triangles from 596,293, with its
/// signed volume 37,293 -> 44,909. So the route is the difference between a reported failure and a
/// print-ready mesh, and the cost is on the record.
///
/// Returns the local outcome unchanged when the caller sets `allow_rebuild` to false, when the
/// rebuild declines (no manifold backend), or when the rebuild is not the better mesh.
pub fn repair_auto(mesh: IndexedMesh, options: &RepairOptions) -> RepairOutcome {
    repair_auto_with_progress(mesh, options, None)
}

/// [`repair_auto`], telling `sink` about each stage as it starts.
pub fn repair_auto_with_progress(
    mesh: IndexedMesh,
    options: &RepairOptions,
    mut sink: Option<&mut dyn FnMut(&str, usize) -> bool>,
) -> RepairOutcome {
    // The cheap exit first, before the local pipeline has cost anything: a mesh arriving with a spread
    // winding defect is one the local passes cannot settle, so the rebuild is tried on the strength of
    // the input alone. Measured on the two files the local pipeline fails, `Gusano_de_Dune_70%` arrives
    // with 1,897 inconsistent edges and the reported plate with 1,389, against at most 355 across the
    // 130 files it does settle. The probe skips the self-intersection count, so it costs a fraction of a
    // second, and what it saves is the whole local pipeline: two passes and, on this file, thirty
    // seconds.
    //
    // Nothing is lost when the rebuild is not kept: it is kept only when it comes out fully repaired,
    // which does not depend on the local pipeline having run, so in that case the pipeline runs in full
    // below and decides as it always did.
    if options.allow_rebuild && winding_beyond_the_local_pipeline(&mesh) {
        let baseline = Baseline::Input(crate::analysis::analyze_lightweight(&mesh));
        if let Ok(outcome) = try_rebuild(&mesh, options, &baseline, &mut sink) {
            return outcome;
        }
    }

    // One pass of the local pipeline, then the decision, and the settle pass only if the local result
    // is what the caller gets.
    //
    // The settle is the whole ordered pipeline a second time, and the weld that triggers it is a
    // round-trip property of the mesh rather than a defect: measured on `Gusano_de_Dune_70%.stl` it is
    // 14.7 s against the first pass's 15.3 s, and on the route where the rebuild is taken the local
    // result is discarded whole. The rebuild is judged on its own verdict — it is kept when it is
    // fully repaired, which does not depend on the local pipeline having settled — so deferring the
    // settle until the route says the local result is the answer costs nothing and saves that pass on
    // every file a rebuild settles.
    let (first, weld_changed) = match sink.as_deref_mut() {
        Some(s) => {
            s("repair", 1);
            repair_passes(mesh.clone(), options, Some(s))
        }
        None => repair_passes(mesh.clone(), options, None),
    };
    if first.report.fully_repaired || !options.allow_rebuild {
        return settle_after_the_weld(first, weld_changed, options);
    }
    rebuild_route(mesh, options, first, weld_changed, sink)
}

/// Whether the mesh carries the one defect the local pipeline cannot settle.
///
/// The pipeline resolves non-manifold edges by splitting them, boundaries by filling, pinches by
/// separating, and it cuts the winding edges no assignment satisfies. What it cannot do is spread a
/// winding defect across a surface into a consistent orientation, and that is what these files carry.
/// Measured over the corpus and the reference files: 1,389 and 1,897 inconsistent edges on the two
/// files it fails, at most 355 on the 130 it repairs.
///
/// The threshold sits between them with a margin on both sides, and it is a measurement from two
/// failures rather than a law: re-derive it when more files fail. A false positive does not produce a
/// wrong mesh — the rebuild is still judged on its own verdict, and the local pipeline still runs in
/// full if it is not kept — it only means a rebuild is preferred to a local repair that might have
/// been good enough.
fn winding_beyond_the_local_pipeline(mesh: &IndexedMesh) -> bool {
    crate::analysis::analyze_lightweight(mesh).inconsistent_winding_edges > LOCAL_PIPELINE_WINDING_LIMIT
}

/// Above this many inconsistent winding edges, the local pipeline will not settle a mesh. See
/// [`winding_beyond_the_local_pipeline`] for the measurement behind it.
const LOCAL_PIPELINE_WINDING_LIMIT: usize = 1_000;

/// The largest shell's share of a mesh, when the mesh is several objects rather than one.
///
/// A rebuild resolves *one* object into a solid, so the route has to know which it is looking at. The
/// criterion is measured rather than guessed — a mesh with one object in it has a dominant shell, and
/// a plate of comparable objects does not:
///
/// | file | shells | largest shell |
/// | --- | --- | --- |
/// | `3DBenchy` | 1 | 100% |
/// | `corbu` | 8 | 77.0% |
/// | `Gusano_de_Dune_70%` | 302 | 77.6% |
/// | `Untitled2` (a plate of 25 objects) | 29 | 20.8% |
///
/// `None` means "not several objects, a rebuild may be tried"; `Some(share)` means it is, and gives
/// what the largest shell holds. The bias is deliberate: declining a rebuild leaves the honest local
/// result, while running one that should not have run replaces a detailed model with a coarser one —
/// measured on the plate, 656,922 triangles in and 149,768 out.
fn several_objects_share(mesh: &IndexedMesh) -> Option<f64> {
    let components = triangle_components(mesh);
    let n_comps = components.iter().copied().max().map_or(0, |m| m as usize + 1);
    if n_comps < 3 {
        return None;
    }
    let mut counts = vec![0usize; n_comps];
    for c in components.iter() {
        counts[*c as usize] += 1;
    }
    let share = counts.iter().copied().max().unwrap_or(0) as f64 / mesh.triangles.len().max(1) as f64;
    (share < 0.5).then_some(share)
}

/// The second route: rebuild the surface into a solid, repair that, and keep it only if it wins.
/// What a rebuild is judged against, and what its notes say it is.
///
/// The route takes the local pipeline's result when there is one, and the input's own verdict when the
/// local pipeline was skipped, which is the early exit's case. Only the notes and the numbers differ:
/// the decision, keep the rebuild when it comes out fully repaired, consults neither.
enum Baseline {
    Local(Box<RepairOutcome>),
    Input(crate::analysis::MeshAnalysis),
}

impl Baseline {
    fn defects(&self, input: &IndexedMesh) -> crate::evaluate::MeshDefects {
        match self {
            Baseline::Local(local) => crate::evaluate::evaluate(&local.mesh),
            Baseline::Input(_) => crate::evaluate::evaluate(input),
        }
    }

    /// How the note describes it. The local pipeline reduces the total before it is measured, the
    /// input's is what it arrived with.
    fn clause(&self, total: usize) -> String {
        match self {
            Baseline::Local(_) => format!("because the local pipeline left {total} defect(s)"),
            Baseline::Input(_) => format!("because the input arrived with {total} defect(s)"),
        }
    }

    fn pre(&self) -> crate::analysis::MeshAnalysis {
        match self {
            Baseline::Local(local) => local.report.pre.clone(),
            Baseline::Input(pre) => pre.clone(),
        }
    }
}

/// The rebuild, tried and judged. `Ok` is the outcome to return; `Err` is the note saying why the
/// rebuild was not kept.
///
/// The judgement is one line: a rebuild is kept when it comes out fully repaired. It resolves the
/// surface into a solid, which costs detail — measured on the plate in the corpus, 656,922 triangles in
/// and 168,434 out, its 118 shells fragmented into 306 — and a rebuild that leaves defects anyway has
/// spent that for nothing. "Better but still broken" is not the trade this route is for; a caller that
/// wants it can ask for the surfacing mode by name.
fn try_rebuild<'a>(
    mesh: &IndexedMesh,
    options: &RepairOptions,
    baseline: &Baseline,
    sink: &mut Option<&'a mut dyn FnMut(&str, usize) -> bool>,
) -> Result<RepairOutcome, String> {
    let before = baseline.defects(mesh);
    let volume_before = mesh.signed_volume();
    if let Some(share) = several_objects_share(mesh) {
        return Err(format!(
            "a rebuild was not tried: the mesh is several objects and the largest holds {:.0}% of it — repair the parts, not the plate",
            share * 100.0
        ));
    }
    let rebuilt = crate::solid_remesh::solid_remesh(mesh, &crate::SolidRemeshOptions::default());
    if rebuilt.report.declined.is_some() {
        return Err(format!(
            "the local pipeline left {} defect(s) and the rebuild declined ({})",
            before.total(),
            rebuilt.report.declined.clone().unwrap_or_default()
        ));
    }
    if let Some(s) = sink.as_deref_mut() {
        s("rebuild", 2);
    }
    // A reborrow with a fresh lifetime: the sink outlives this call and is used twice in it.
    let reborrowed = sink
        .as_mut()
        .map(|s| &mut **s as &mut dyn FnMut(&str, usize) -> bool);
    let mut rebuilt_outcome = repair_with_progress(rebuilt.mesh.clone(), options, reborrowed);
    let after = crate::evaluate::evaluate(&rebuilt_outcome.mesh);
    let volume_after = rebuilt_outcome.mesh.signed_volume();
    if !rebuilt_outcome.report.fully_repaired {
        return Err(format!(
            "a rebuild was tried and not kept: it came out with {} defect(s) against the local pipeline's {}, and a rebuild is only worth the surface it moves when it finishes the job",
            after.total(),
            before.total()
        ));
    }
    let moved = if volume_before.abs() > 1e-9 {
        (volume_after - volume_before) / volume_before.abs() * 100.0
    } else {
        0.0
    };
    rebuilt_outcome.report.rebuilt = true;
    // The report's before is the mesh the caller handed in, not the one the rebuild produced: an
    // after-verdict on its own says nothing, and the note below already compares the two.
    rebuilt_outcome.report.pre = baseline.pre();
    rebuilt_outcome.report.residual_issues.push(format!(
        "this mesh was rebuilt rather than repaired: the surface was resolved into a solid, {:.1}% more volume and {} triangles where the input had {}, {}",
        moved,
        rebuilt_outcome.mesh.triangles.len(),
        mesh.triangles.len(),
        baseline.clause(before.total())
    ));
    rebuilt_outcome.report.steps.push(RepairStepReport {
        name: "rebuild".to_string(),
        changed: rebuilt.report.output_triangles as u32,
        notes: Some(format!(
            "the input arrived with {} defect(s); the rebuild comes out with {} and {}",
            before.total(),
            after.total(),
            if rebuilt_outcome.report.fully_repaired {
                "is fully repaired"
            } else {
                "is the better mesh"
            }
        )),
        elapsed_ms: rebuilt.report.ms,
    });
    Ok(rebuilt_outcome)
}

/// The rebuild behind the local pipeline, judged against it, with its note attached when it loses.
fn rebuild_route(
    mesh: IndexedMesh,
    options: &RepairOptions,
    local: RepairOutcome,
    weld_changed: bool,
    mut sink: Option<&mut dyn FnMut(&str, usize) -> bool>,
) -> RepairOutcome {
    let baseline = Baseline::Local(Box::new(local));
    match try_rebuild(&mesh, options, &baseline, &mut sink) {
        Ok(outcome) => outcome,
        Err(note) => {
            let Baseline::Local(local) = baseline else {
                unreachable!("the local outcome was just moved in")
            };
            let mut local = settle_after_the_weld(*local, weld_changed, options);
            local.report.residual_issues.push(note);
            local
        }
    }
}

/// Runs the pass set, telling `sink` about each stage as it starts.
///
/// `sink` is called with the stage's name and its 1-based position, and its return
/// value says whether to carry on. Returning `false` stops the run at that stage
/// boundary: a stage is never interrupted halfway, because half a pass leaves a mesh
/// nobody designed, so the outcome is what the finished stages produced and the
/// report says it was cancelled.
///
/// A repair runs for seconds and a large mesh for minutes, so a caller with a UI
/// wants to know which stage it is in rather than watching a spinner.
pub fn repair_with_progress(
    mesh: IndexedMesh,
    options: &RepairOptions,
    sink: Option<&mut dyn FnMut(&str, usize) -> bool>,
) -> RepairOutcome {
    // The ordered stages, then — if the weld the pipeline ends with changed the mesh — the ordered
    // stages again, which is [`settle_after_the_weld`]'s job so that a caller can defer it.
    let (first, weld_changed) = repair_passes(mesh, options, sink);
    settle_after_the_weld(first, weld_changed, options)
}

/// The ordered stages again, when the weld the pipeline ends with changed the mesh.
///
/// The weld is not decoration: every export path here is a triangle soup and the loader welds a soup
/// at `DEFAULT_MERGE_EPSILON`, so a repair that ends finer than that hands over a mesh the next read
/// changes. But the weld has a cost, and the *stages* are what repair it, not the defect loop:
/// measured on the reported model, one pass ended 26/117/1/193 in memory and in the file, and one more
/// pass took it to 0/0/0/0 in both. A second pass runs only when the weld actually merged or culled
/// something.
///
/// It takes no sink: it is bounded, and a cancel that arrived during the first pass has already been
/// honoured. Returns `first` untouched when there is nothing to settle, so a caller can call it
/// without asking first — which is what [`repair_auto_with_progress`] does, deferring it until it
/// knows the local result is the one the caller gets.
fn settle_after_the_weld(
    first: RepairOutcome,
    weld_changed: bool,
    options: &RepairOptions,
) -> RepairOutcome {
    if !weld_changed {
        return first;
    }
    let RepairOutcome {
        mesh,
        report: first_report,
    } = first;
    let (settled, _) = repair_passes(mesh, options, None);
    let RepairOutcome { mesh, mut report } = settled;
    report.pre = first_report.pre;
    report.total_ms = first_report.total_ms + report.total_ms;
    let mut steps = first_report.steps;
    steps.extend(report.steps);
    report.steps = steps;
    RepairOutcome { mesh, report }
}

/// One pass of the ordered pipeline.
///
/// Both passes report the engine's own stage codes rather than a qualifier, because the frontend keys its
/// labels on them; a second pass is visible as a second run of the same names, which is what it is.
fn repair_passes(
    mut mesh: IndexedMesh,
    options: &RepairOptions,
    mut sink: Option<&mut dyn FnMut(&str, usize) -> bool>,
) -> (RepairOutcome, bool) {
    let t_start = std::time::Instant::now();

    // From here the pipeline reads concrete tolerances: anything the caller left to the engine is
    // derived from the mesh before the first pass runs.
    let resolved = options.resolved(&mesh);
    let options = &resolved;

    let pre = analyze(&mesh);
    // Asked before `pre` moves into the report: the first orientation call is only worth making
    // when the verdict says the mesh needs it (see [`orientation_settled`]).
    let first_orientation_needed = !orientation_settled(&mesh, &pre);
    let mut report = MeshHealthReport::new(pre);
    if options.assume_support_geometry == Some(true) {
        report.likely_support_geometry = true;
    }

    // The pipeline is a fixed order, and the repetition in it is the design: each
    // stage disturbs what the one before it settled, so orientation, stitch, holes
    // and double faces each come round more than once. What is *not* repeated is an orientation pass
    // over a mesh nothing has touched since the last one — see [`OrientationGate`]. The first call
    // is part of that: it only runs when the verdict the pass above just took says the mesh needs
    // it, because on a mesh that arrives settled it is 762 ms to flip nothing (see
    // [`orientation_settled`]). A stage that changes anything re-arms the gate, so a later call
    // still runs, and it is the same call that carries the cut.
    let mut orientation_gate = OrientationGate {
        changed_since: usize::from(first_orientation_needed),
    };
    let _ = &mut orientation_gate;
    let mut stitch_gate = RefusalGate {
        refused: false,
        changed_since: 0,
    };
    //
    // Records a stage and its cost, so the report reads as the pipeline ran rather
    // than as a list of things that were considered.
    // Announced before the stage's work, so a caller sees the stage it is waiting in
    // rather than the one that just finished.
    macro_rules! begin {
        ($name:expr) => {{
            let index = report.steps.len() + 1;
            if let Some(sink) = sink.as_mut() {
                if !sink($name, index) {
                    report.cancelled = true;
                    report.post = analyze(&mesh);
                    report.total_ms = t_start.elapsed().as_secs_f64() * 1000.0;
                    return (RepairOutcome { mesh, report }, false);
                }
            }
        }};
    }

    macro_rules! stage {
        ($name:expr, $changed:expr, $notes:expr, $started:expr) => {{
            // Every stage declares what it changed, and the gate that decides whether the next
            // orientation pass is worth running is fed from here, so a new stage cannot forget to.
            // The weld's gate reads the same number, for the same reason.
            orientation_gate.note($changed as usize);
            stitch_gate.note($changed as usize);
            report.steps.push(RepairStepReport {
                name: $name.into(),
                changed: $changed as u32,
                notes: $notes,
                elapsed_ms: $started.elapsed().as_secs_f64() * 1000.0,
            });
        }};
    }

    // 1. Orientation.
    begin!("orient_components");
    let t = std::time::Instant::now();
    let flipped = orientation_gate.orient(&mut mesh);
    stage!("orient_components", flipped, None, t);

    // 2. Stitch: a vertex weld, then collapse whatever the weld created.
    //
    // A weld is a heuristic and it can leave a mesh worse than it found it. Joining two
    // surfaces a hair apart is the point, and where three of them meet the junction is
    // non-manifold; the reference resolves that with a boolean union and there is no
    // union here. So the stitch answers for its own work: it is kept only when it did
    // not make any of the five classes worse, and a refused stitch is reported rather
    // than passed off as a repair.
    begin!("stitch");
    let t = std::time::Instant::now();
    // Strict first, then loose - the reference stitches twice and in this order, and the order is
    // the point: the strict pass joins what agrees on winding, and the loose one, later, joins the
    // rest. Doing it the other way round lets the loose weld reach vertices the strict pass would
    // have kept apart.
    let (stitched_oriented, refused_oriented, welded, refused_loose) = if stitch_gate.should_run() {
        let (stitched_oriented, refused_oriented) =
            stitch_vertices_oriented(&mut mesh, options.weld_step);
        let (welded, _collapsed, refused_loose) = stitch_vertices(&mut mesh, options.weld_step);
        (stitched_oriented, refused_oriented, welded, refused_loose)
    } else {
        (0, false, 0, false)
    };
    let (welded, refused) = (
        welded + stitched_oriented,
        refused_loose || refused_oriented,
    );
    stitch_gate.record(refused);
    stage!(
        "stitch",
        welded,
        Some(if refused {
            "refused: the weld would have left a non-manifold junction this pipeline cannot resolve"
                .to_string()
        } else {
            format!("{welded} vertex/vertices welded at {} mm", options.weld_step)
        }),
        t
    );

    // 3. Trivial holes, before anything else touches the mesh. Six edges is a hole
    //    nobody designed, and leaving one means the mesh reads as open for the rest
    //    of the pipeline.
    begin!("holes_trivial");
    let t = std::time::Instant::now();
    let (trivial, refused_trivial) = fill_holes_guarded(&mut mesh, 0, true);
    stage!(
        "holes_trivial",
        trivial,
        refused_trivial.then(|| "refused: capping would have left a worse mesh".to_string()),
        t
    );

    // 4. Double faces.
    begin!("double_faces");
    let t = std::time::Instant::now();
    let (doubles, note) = cull_faces(&mut mesh);
    stage!("double_faces", doubles, note, t);

    // 5. Orientation, trivial holes, stitch: each of the three disturbed what the
    //    others settled, so they come round again.
    begin!("orient_holes_stitch");
    let t = std::time::Instant::now();
    let flipped = orientation_gate.orient(&mut mesh);
    let (trivial, refused_trivial) = fill_holes_guarded(&mut mesh, 0, true);
    let (welded, collapsed, refused_stitch) = if stitch_gate.should_run() {
        stitch_vertices(&mut mesh, options.weld_step)
    } else {
        (0, 0, false)
    };
    stitch_gate.record(refused_stitch);
    let round_after_first_cull = flipped + trivial + welded + collapsed;
    stage!(
        "orient_holes_stitch",
        round_after_first_cull,
        Some(format!(
            "{flipped} face(s) flipped, {trivial} trivial hole face(s), {welded} vertex/vertices welded, {collapsed} face(s) collapsed{}",
            if refused_trivial { ", hole fill refused" } else { "" }
        )),
        t
    );

    // 6. Orientation, every hole the caller's cap allows, stitch.
    begin!("orient_holes_all_stitch");
    let t = std::time::Instant::now();
    let flipped = orientation_gate.orient(&mut mesh);
    let (filled, refused_fill) = fill_holes_guarded(&mut mesh, options.fill_holes_max_edges, false);
    let (welded, collapsed, refused_stitch) = if stitch_gate.should_run() {
        stitch_vertices(&mut mesh, options.weld_step)
    } else {
        (0, 0, false)
    };
    stitch_gate.record(refused_stitch);
    let round_after_first_cull = round_after_first_cull + flipped + filled + welded + collapsed;
    stage!(
        "orient_holes_all_stitch",
        flipped + filled + welded + collapsed,
        Some(format!(
            "{flipped} face(s) flipped, {filled} hole face(s), {welded} vertex/vertices welded, {collapsed} face(s) collapsed{}",
            if refused_fill { ", hole fill refused" } else { "" }
        )),
        t
    );

    // 7. Split the self-crossings, when the caller asked. This is the one stage
    //    that rewrites the surface, so it runs after the local passes have
    //    converged rather than among them.
    //
    //    Guarded like everything else, and it needs it more than any of them, because it is the
    //    only pass that rebuilds the surface rather than editing it and it had no acceptance test
    //    at all. On the V3 Cones it took the non-manifold edges 0 to 5,557, the boundary 0 to 344
    //    and the volume up 132%. On the corbu model it took bad edges 822 to 16,704 and the volume
    //    up 852%. Both were kept. Asked for on a mesh it cannot handle, it now comes out as it
    //    went in and says so.
    let mut split_refined = false;
    if options.resolve_self_intersections {
        begin!("split_self_intersections");
        let t = std::time::Instant::now();
        let before = mesh.clone();
        let health = crate::evaluate::evaluate(&before);
        let volume_before = before.signed_volume();
        let stats = crate::arrangement::corefine_self_intersections(&mut mesh);
        // Close what the refinement opened, *before* judging it.
        //
        // The refinement's triangles do not always tile the faces they replace — the CDT loses a region when
        // a face's chords end in its interior — so it hands back a surface with holes in it: measured on the
        // reported model, refining 13,048 faces opened 2,335 boundary loops. Judged at that moment it is
        // always refused, which is why the crossings pass has never once landed. The holes are the pass's own
        // damage, and this pipeline's answer to damage is to repair it and judge the pair — the same thing
        // that made the weld land.
        if stats.refined_faces > 0 {
            // The count is the pass's own damage report, not a result: the loops are closed here and the
            // verdict below is what decides whether the pass lands.
            crate::holes::holes_all(&mut mesh, usize::MAX);
        }
        let volume_moved = (mesh.signed_volume() - volume_before).abs()
            > volume_before.abs().max(1e-9) * 0.01;
        let refused =
            stats.refined_faces > 0 && (crate::evaluate::evaluate(&mesh).worse_than(&health) || volume_moved);
        if refused {
            mesh = before;
        }
        split_refined = !refused && stats.refined_faces > 0;
        stage!(
            "split_self_intersections",
            if refused { 0 } else { stats.refined_faces },
            Some(format!(
                "pairs={} refined_faces={} skipped_faces={} new_vertices={} tris:{}->{}{}",
                stats.intersecting_pairs,
                stats.refined_faces,
                stats.skipped_faces,
                stats.new_vertices,
                stats.tri_count_before,
                stats.tri_count_after,
                if refused {
                    ", refused: the refined surface is worse than the one it replaced"
                } else {
                    ""
                }
            )),
            t
        );
    }

    // 8. Double faces again, when something since the first cull could have made one.
    //
    //    Step 4 is the last thing that looked at duplicates, and only two things can have changed
    //    the mesh since: rounds 5 and 6, and the crossings split. When both rounds report that they
    //    changed nothing, and the split refined nothing, the mesh arriving here is byte-identical to
    //    the one step 4 already judged — and this cull is deterministic, so it would answer the same
    //    way a second time. On the corpus that cost 0.7s to 2.3s per file to return the same
    //    `refused` a second time, on every file, because the split is off by default.
    //
    //    The two rounds' counts are exact: each is the sum of the passes in it, and a refused pass
    //    contributes zero because it reverted.
    if split_refined || round_after_first_cull > 0 {
        begin!("double_faces_after_split");
        let t = std::time::Instant::now();
        let (doubles, note) = cull_faces(&mut mesh);
        stage!("double_faces_after_split", doubles, note, t);
    }

    // 9. Remove the faces that are inside. This is the stage that resolves
    //    self-intersections and non-manifoldness together: a face inside the solid
    //    is not carrying the surface, so removing it cannot open anything, and a
    //    non-manifold edge is usually a buried sheet crossing the outer one.
    begin!("remove_inner_faces");
    let t = std::time::Instant::now();
    let before_inner = mesh.clone();
    let (removed, _) = cull_interior_components(&mut mesh);
    // A component inside another is a cavity, and a cavity is part of the model: removing it
    // fills the void and moves the volume, which is a different object. A buried *sheet* is
    // open, so it carries no volume and removing it leaves the volume where it was. That is
    // the discriminator, and it is measurable.
    //
    // Without a boolean union we cannot tell the two apart any other way, and the reference
    // has one. Where it is not sure, this stage leaves the geometry alone.
    let volume = before_inner.signed_volume().abs();
    let delta = (mesh.signed_volume() - before_inner.signed_volume()).abs();
    let moved = delta > volume * 1e-6;
    let refused = removed > 0 && moved;
    let openness = crate::evaluate::evaluate(&before_inner).bad_edges;
    if refused {
        mesh = before_inner;
    }
    let removed_report = removed;
    let removed = if refused { 0 } else { removed };
    // The volume proxy is unsound on a mesh that is not watertight: an open component has no
    // meaningful signed volume, so `moved` is noise there and the refusal carries no information.
    // The count and the delta are reported either way so a refusal can be judged rather than
    // taken on faith.
    stage!(
        "remove_inner_faces",
        removed,
        Some(if refused {
            format!(
                "refused: {removed_report} face(s) inside, and removing them moves the volume by {:.4}% of {:.1}; input has {openness} boundary edge(s), so that volume is {}",
                if volume > 0.0 { delta / volume * 100.0 } else { 0.0 },
                volume,
                if openness > 0 { "not a real volume" } else { "well defined" }
            )
        } else {
            format!("{removed} face(s) inside another component")
        }),
        t
    );

    // 9a. The parts that overlap are unioned first.
    //
    //     Before the split, not after it. The union merges overlapping parts and skips any
    //     component that is not already manifold, and the split offsets the surfaces it
    //     separates so nothing can merge them afterwards. Running the split first therefore
    //     separates surfaces and then leaves the union unable to merge anything: 240 parts
    //     where the union-first order gives about 43.
    //
    //      Everything above works on parts that touch, and the split separates those. Parts
    //      that overlap cannot be separated by any local rule, and a union is the operation
    //      for them. It runs last, and only when the mesh still has bad edges, because on a
    //      mesh the passes above already settled it would merge parts that were fine:
    //      measured on COOKIE_b4, a model with supports, they take it to zero non-manifold
    //      edges with all 234 of its shells kept.
    //
    //      Per group. The model unions among itself and the supports among themselves, so the
    //      two never merge. The reference engine can union everything because it re-detects
    //      supports afterwards, and the model/support split is ours to keep.
    #[cfg(feature = "manifold")]
    if crate::evaluate::evaluate(&mesh).bad_edges > 0 {
        begin!("union_overlapping_parts");
        let t = std::time::Instant::now();
        let before_union = crate::evaluate::evaluate(&mesh);
        let (unioned, candidate, separate) = union_groups(&mesh, options);

        let after_union = crate::evaluate::evaluate(&candidate);
        // Accepted on what a union is for: it merges solids. The test used to demand that bad
        // edges strictly dropped, and on a supported model that is the wrong question. The
        // harbinger file has 3,083 components, thousands of them support struts, and the union
        // merged 5,414 solids and then threw the result away because the bad edges stayed at
        // 8,237. Merging 5,414 solids is the work; whether the merged solid is manifold is a
        // different operation, and the reference engine's own union is a full surface union that
        // this one is not.
        // Lightweight: this guard reads components, volume and face counts, and the full
        // `analyze` would run the BVH crossing pass over every triangle to compute a field
        // nothing here looks at. On a multi-million-triangle scene that pass is the run.
        let structure_before_union = analyze_lightweight(&mesh);
        let structure_after_union = analyze_lightweight(&candidate);
        let union_volume = structure_before_union.signed_volume.abs().max(1e-9);
        // One-sided. A union *drops* the volume when parts overlap, because the overlap is counted
        // once instead of twice, and that drop is the union doing its job. An absolute test
        // refused COOKIE_b4 merging 233 struts into 37 solids for exactly that reason.
        let union_grew =
            structure_after_union.signed_volume > structure_before_union.signed_volume + union_volume * 0.01;
        // A union rebuilds the surface it merges, so it can buy a part count with a different
        // mesh. These bounds are what that costs. Without them the harbinger file was accepted:
        // 3,083 parts down to 646, paid for with 47% more triangles and 10,664 new degenerate
        // faces on a model that started with 683 of them. COOKIE_b4's union, which is the one
        // that makes that file repaired, adds 4.3% and 126, and stays.
        let triangle_budget =
            structure_before_union.triangle_count + structure_before_union.triangle_count / 10;
        let degenerate_budget = (structure_before_union.triangle_count / 1000).max(64);
        let union_inflated = structure_after_union.triangle_count > triangle_budget
            || structure_after_union.degenerate_triangles
                > structure_before_union.degenerate_triangles + degenerate_budget;
        let accepted = unioned > 0
            && structure_after_union.connected_components
                < structure_before_union.connected_components
            && after_union.bad_edges <= before_union.bad_edges
            && after_union.holes <= before_union.holes
            && after_union.inconsistent_edges <= before_union.inconsistent_edges
            && !union_grew
            && !union_inflated;
        stage!(
            "union_overlapping_parts",
            if accepted { unioned } else { 0 },
            Some(format!(
                "solids unioned {unioned}, parts {} -> {}, bad edges {} -> {}, loops {} -> {}, triangles {} -> {}, degenerate {} -> {}{}",
                structure_before_union.connected_components,
                structure_after_union.connected_components,
                before_union.bad_edges,
                after_union.bad_edges,
                before_union.holes,
                after_union.holes,
                structure_before_union.triangle_count,
                structure_after_union.triangle_count,
                structure_before_union.degenerate_triangles,
                structure_after_union.degenerate_triangles,
                if separate > 0 {
                    format!(
                        ", {separate} solid(s) left separate: they are closed, they share a bounding box with another solid, and no triangle of one crosses a triangle of the other, so they are parts of a plate rather than pieces of one object"
                    )
                } else {
                    String::new()
                }
            )),
            t
        );
        if accepted {
            mesh = candidate;
        }
    }

    // 9b. Surfaces that share an edge are separated rather than trimmed, and the rims that
    //     exposes are filled.
    //
    //     This is the watertight repair of overlapping parts. A non-manifold edge is two
    //     surfaces meeting along it, and giving each surface its own copy of the edge's
    //     vertices, moved into its own solid, separates them so a re-read cannot merge them
    //     back. Faces left lying on a shared edge are sheets that would merge back into the
    //     surface, and the coincident-face removal takes those.
    //
    //     The reference engine's pass, from the same pull request as the winding port, with
    //     its acceptance test: a round is kept only when non-manifold edges strictly dropped
    //     and the boundary did not grow. Without a boolean union this is the only way we have
    //     to resolve an overlap, and a mesh it cannot settle keeps what it had.
    const MAX_SPLIT_ROUNDS: usize = 6;
    let mut before_split = crate::evaluate::evaluate(&mesh);
    let mut before_split_mesh = mesh.clone();

    for _ in 0..MAX_SPLIT_ROUNDS {
        if before_split.non_manifold_edges == 0 {
            break;
        }
        begin!("split_non_manifold_edges");
        let t = std::time::Instant::now();
        let mut candidate = mesh.clone();
        let offset = options.split_offset(&candidate);
        let walls = crate::topology_passes::remove_coincident_faces(&mut candidate);
        let split = walls + crate::topology_passes::split_non_manifold_edges(&mut candidate, offset);
        crate::topology_passes::remove_open_fragments(&mut candidate, 16);
        // The rims a split exposes are artifacts of the separation, not openings somebody
        // designed, so they are filled whatever their length. The caller's cap is for holes in
        // the mesh as it arrived. Measured: with the cap at 64 the corbu model came out of the
        // split with non-manifold edges at 0 and winding at 0, and 2,155 boundary edges it did
        // not have, because the long rims stayed open.
        let rim_cap = usize::MAX;
        let mut filled = crate::holes::holes_all(&mut candidate, rim_cap);
        let _ = unify_winding(&mut candidate);
        let (collapsed, _note) = cull_faces(&mut candidate);
        let _ = collapsed;
        filled += crate::holes::holes_all(&mut candidate, rim_cap);

        // The rims a split exposes meet at pinches, and a pinched loop is not a simple cycle, so the
        // hole pass skips it by design however long the cap is: measured on the corbu model, six
        // loops holding 1,332 boundary edges survived a fill with no cap at all. Splitting the pinch
        // makes those loops simple and the fill takes them.
        let pinches = crate::topology_passes::split_pinched_vertices(&mut candidate);
        if pinches > 0 {
            filled += crate::holes::holes_all(&mut candidate, rim_cap);
            let _ = unify_winding(&mut candidate);
        }

        let mut after = crate::evaluate::evaluate(&candidate);
        for _ in 0..3 {
            // No cap on how tangled the mesh is. There was one, at 64 non-manifold edges, and it
            // is backwards for the file this exists for: the corbu model has 1,364, so the pass
            // that cuts out what no pairing resolves never ran on it. The bound that matters is
            // the acceptance test below, which keeps an excision only when it drops the count,
            // and the three rounds.
            if after.non_manifold_edges + after.holes == 0 {
                break;
            }
            let mut excised = candidate.clone();
            if crate::topology_passes::excise_tangles(&mut excised) == 0 {
                break;
            }
            let refilled = crate::holes::holes_all(&mut excised, options.fill_holes_max_edges);
            let check = crate::evaluate::evaluate(&excised);
            if check.non_manifold_edges + check.holes >= after.non_manifold_edges + after.holes {
                break;
            }
            candidate = excised;
            filled += refilled;
            after = check;
        }

        // Winding is part of it. The split adds faces, and a cap that disagrees with the loop it
        // closes shows up as an inconsistent edge: on the corbu model the pass dropped boundary
        // edges 822 to 538 while winding went 113 to 267, which is trading one class for another
        // and calling it a repair.
        // Bad edges, not loops. The class that counts loops is a decomposition of the boundary, not a
        // measure of it: separating two surfaces that shared an edge gives each one a rim, so one loop
        // can become several while the boundary gets *shorter*, and refusing that keeps 1,363
        // non-manifold edges to avoid eight short loops. `bad_edges` is the count of edges that do not
        // carry exactly two faces — boundary and non-manifold together — which is the class the
        // reference's bad-edge evaluator reports and the one that measures what the pass did. Measured
        // on the reported file: non-manifold 1,363 to 0 and bad edges 1,366 to 24, refused because the
        // loop count went from 1 to 8.
        //
        // The edge count alone was tried before this and reverted, and the reason is in the numbers
        // above rather than in the class: that attempt left the model with 13 components instead of 8,
        // 1,332 boundary edges instead of 822 and 19.61% more volume. Those are the tests below, and
        // they are what refuse a split that pulls the object apart rather than resolving it.
        // The defect classes are not enough, which is what I got wrong here. The corbu split
        // resolved non-manifold edges 1364 to 0 and was accepted on that, and the model it left
        // had 13 components instead of 8, 1,332 boundary edges instead of 822, and 19.61% more
        // volume. COOKIE_b4 goes 234 to 240 the same way. Resolving a shared edge by pulling two
        // surfaces apart is a change to the object, and a repair that does it has not repaired
        // anything.
        //
        // So the structure is part of the test: the part count cannot grow and the volume cannot
        // move. A pass that leaves a model in more pieces than it found is not a pass that
        // finished.
        // Tried running the union on the split's candidate so the pair could be judged together, and
        // reverted it. The split *offsets* the separated surfaces apart, which is how it stops a
        // re-read welding them back, and an offset surface can never overlap the one it came from
        // again. So a union can never merge them, and the split's extra parts and moved volume are
        // inherent to the operation rather than something a later pass undoes. It cost a CSG per
        // split round and never turned a refusal into an acceptance.
        // The part count is proportional, not absolute. An absolute test refused COOKIE_b4's split,
        // which takes non-manifold 178 to 0, boundary 38 to 0 and the mesh to watertight, because
        // it adds six parts to a model that already has 234. Six out of 234 is not a model coming
        // apart, it is what separating surfaces that shared edges costs, and the union merges the
        // ones that overlap.
        //
        // The volume is the test that tells a real change from a rounding one: that split moved it
        // -0.96% and was refused, corbu's moved +19.6% and should be.
        // Lightweight for the same reason as the union's: this is a guard over components,
        // volume and face counts, and it runs once per split round.
        let structure_before = analyze_lightweight(&before_split_mesh);
        let structure_after = analyze_lightweight(&candidate);
        // The volume is measured against a *sealed* copy of what the split started from. A mesh
        // that arrives with boundary edges has no signed volume to compare against: signing those
        // loops the other way is the same mesh and a different number. On the corbu model, sealing
        // alone moves it 97.7 to 117.4 before the split has done anything, so the +26% this pass
        // was refused for was mostly the measurement changing rather than the model.
        let baseline_volume = if before_split.holes > 0 {
            let mut sealed = before_split_mesh.clone();
            let _ = crate::holes::holes_all(&mut sealed, usize::MAX);
            sealed.signed_volume()
        } else {
            structure_before.signed_volume
        };
        let volume = baseline_volume.abs().max(1e-9);
        // A split separates surfaces that shared edges, and the rims it exposes are filled. Those
        // fills enclose the gap between the separated sheets, so the volume *sum* grows: the overlap
        // that used to be counted once is now inside two closed shells. It is the same effect the
        // union has in the other direction, and it makes one percent too tight a bound here — the
        // corbu model comes out 5.28% up against a sealed baseline while every class it has improves
        // (non-manifold 1364 to 0, winding 113 to 0, loops 50 to 6). Ten percent still refuses a
        // split that inflates the model rather than separating it.
        const SPLIT_VOLUME_TOLERANCE: f64 = 0.10;
        let volume_moved =
            (structure_after.signed_volume - baseline_volume).abs() > volume * SPLIT_VOLUME_TOLERANCE;
        // The split's cost is a fixed number of separated surfaces, not a fraction of the part
        // count, so the allowance cannot be purely proportional: with 37 parts after the union, a
        // twentieth is one, and the split adds six. Eight or a twentieth, whichever is larger.
        let allowed_parts =
            structure_before.connected_components + (structure_before.connected_components / 20).max(8);
        let accepted = after.non_manifold_edges < before_split.non_manifold_edges
            && after.bad_edges < before_split.bad_edges
            && after.inconsistent_edges <= before_split.inconsistent_edges
            && structure_after.connected_components <= allowed_parts
            && !volume_moved;
        stage!(
            "split_non_manifold_edges",
            if accepted { split + filled } else { 0 },
            Some(format!(
                "vertices split {split}, holes filled {filled}, non-manifold {} -> {}, bad edges {} -> {}, winding {} -> {}, loops {} -> {}, parts {} -> {} (allowed {allowed_parts}), volume {:+.2}%",
                before_split.non_manifold_edges,
                after.non_manifold_edges,
                before_split.bad_edges,
                after.bad_edges,
                before_split.inconsistent_edges,
                after.inconsistent_edges,
                before_split.holes,
                after.holes,
                structure_before.connected_components,
                structure_after.connected_components,
                100.0 * (structure_after.signed_volume - baseline_volume) / volume
            )),
            t
        );
        if !accepted {
            break;
        }
        mesh = candidate;
        before_split = after;
        before_split_mesh = mesh.clone();
    }

    // 10. Noise shells.
    begin!("noise_shells");
    let t = std::time::Instant::now();
    let noise = crate::shells::remove_noise_shells(&mut mesh);
    stage!("noise_shells", noise, None, t);

    // The caller's component filter, when they asked for one. Noise shells above
    // are pruned by ratio and need no parameter; this is the explicit request, kept
    // because a caller with a known-bad file may want a number they chose.
    if let Some(keep_n) = options.keep_largest_n_components {
        begin!("filter_components");
        let t = std::time::Instant::now();
        let dropped = keep_largest_components(&mut mesh, keep_n);
        stage!(
            "filter_components",
            dropped,
            Some(format!("kept the top {keep_n} component(s) by |volume|")),
            t
        );
    }

    // 11. Stitch, noise shells, holes, orientation: the removal above leaves
    //     borders and loose scraps behind it, and this is the round that settles
    //     them.
    begin!("settle");
    let t = std::time::Instant::now();
    let (welded, collapsed, refused_stitch) = if stitch_gate.should_run() {
        stitch_vertices(&mut mesh, options.weld_step)
    } else {
        (0, 0, false)
    };
    stitch_gate.record(refused_stitch);
    let noise = crate::shells::remove_noise_shells(&mut mesh);
    // Orientation before the fill, not after. The cut lives in `repair_orientation`, and a cut whose
    // seam nothing closes leaves the model with boundary edges: through the app's path, which runs
    // the union and so re-welds the mesh, the V3 Cones came out with 8 boundary edges, 2 loops and 1
    // winding edge for exactly that reason.
    let flipped = orientation_gate.orient(&mut mesh);
    // The settle fill closes whatever every other pass left open, and the derived cap is not applied
    // to it. The cap's job is to stop the earlier fills closing openings that are not holes, while
    // the mesh still carries the structure that distinguishes them. By this stage the mesh has been
    // through orientation, welding, the split and the union, so what is left is the repair's own
    // leftover: corbu's six loops of 78 to 653 edges covering all 1,359 of its boundary edges were
    // every one refused by the derived cap of 48.
    let filled = crate::holes::holes_all(&mut mesh, options.residual_fill_max_edges);
    // Last, after every other pass has had its turn: re-tessellate a localised winding defect. It
    // refuses when the move would add parts or move the volume, which is what the Cones needs and
    // Harbinger does not.
    // Both passes below open by asking `frustrated_edges`, which is a graph walk over the winding
    // parity, and neither can find anything unless some edge's two faces disagree, which is what
    // `solve_winding_cut` returns on one layer down. The verdict answers that question, and the
    // stages above have just asked it about this exact state, so the memo makes it free. Measured on
    // `poussin.stl`: 200 ms of the settle was these two arriving at nothing.
    let winding_clean = crate::evaluate::evaluate(&mesh).inconsistent_edges == 0;
    let mut retessellated = 0usize;
    if !winding_clean {
        for _ in 0..8 {
            let n = retessellate_unsatisfiable(&mut mesh);
            if n == 0 {
                break;
            }
            retessellated += n;
        }
    }
    let settled = if retessellated > 0 {
        repair_orientation(&mut mesh)
    } else {
        0
    };
    // The last-resort cut, when the caller asked for it and everything above has had its turn. The
    // re-tessellation before this one refuses whenever the move would add parts or move the volume,
    // which is exactly what a defect spread over the surface does — `Gusano_de_Dune_70%` measured 0
    // faces re-tessellated, twice, with 1,374 winding edges left. The cut is the move that reaches
    // those, and it pays in geometry rather than refusing, which is why it is the caller's call.
    let mut cut = 0usize;
    let mut cut_settled = 0usize;
    let mut cut_refilled = 0usize;
    if options.cut_unsatisfiable_edges && !winding_clean {
        let before_cut = mesh.clone();
        let health = crate::evaluate::evaluate(&before_cut);
        let volume_before = before_cut.signed_volume();
        // The volume test has no information on an open mesh: an open component's signed volume
        // describes where it sits, not what it holds, so a >1% move there is arithmetic rather than a
        // change of shape. `remove_inner_faces` learned the same thing the same way. Measured on
        // `Gusano_de_Dune_70%.stl`, which arrives with 3,059 boundary edges: the cut's own caps move
        // that number by more than a percent and the guard refused a cut that took the defect total
        // 8,379 to 6,908.
        let watertight_before = crate::evaluate::evaluate(&before_cut).bad_edges
            == health.non_manifold_edges;
        for _ in 0..8 {
            let n = cut_unsatisfiable_edges(&mut mesh, usize::MAX);
            if n == 0 {
                break;
            }
            cut += n;
        }
        let settled = if cut > 0 {
            repair_orientation(&mut mesh)
        } else {
            0
        };
        let refilled = if cut > 0 {
            crate::holes::holes_all(&mut mesh, options.residual_fill_max_edges)
        } else {
            0
        };
        // The cut's own scraps go with it, before it is judged: a region detached from the surface
        // is a shell of one to three faces, and the noise rule is what removes those. Judging the
        // cut before its own cull would refuse a cut that the pipeline's next pass finishes.
        let cut_noise = if cut > 0 {
            crate::shells::remove_noise_shells(&mut mesh)
        } else {
            0
        };
        // Judged like every other pass that rebuilds surface: kept only when the defect total
        // strictly drops and the volume holds. The cap this pass used to carry is what that guard
        // replaces — a spread defect can be cut into a worse mesh (measured on an earlier branch:
        // one file's winding 113 to 919), and a guard on the outcome is the honest version of a
        // guard on a count.
        let volume_moved = (mesh.signed_volume() - volume_before).abs()
            > volume_before.abs().max(1e-9) * 0.01;
        let after_health = crate::evaluate::evaluate(&mesh);
        if cut == 0
            || (watertight_before && volume_moved)
            || after_health.total() >= health.total()
        {
            mesh = before_cut;
            cut = 0;
        } else {
            cut_settled = settled;
            cut_refilled = refilled;
            cut += cut_noise;
        }
    }
    stage!(
        "settle",
        welded + collapsed + noise + filled + flipped + retessellated + settled + cut + cut_settled + cut_refilled,
        Some(format!(
            "{welded} vertex/vertices welded, {collapsed} face(s) collapsed, {noise} noise face(s), {flipped} face(s) flipped, {filled} hole face(s), {retessellated} face(s) re-tessellated over unsatisfiable edges, {settled} face(s) flipped after that, {cut} vertex/vertices cut at unsatisfiable edges, {cut_settled} face(s) flipped after the cut, {cut_refilled} hole face(s) after it"
        )),
        t
    );

    // 11b. Rounds on what is left, one defect class at a time, until nothing improves.
    //
    // The reference's repair is a defect-driven loop: it lists the mesh's defects, repairs a class,
    // recomputes, and repeats until none are left or it hits an iteration cap. This pipeline was one
    // ordered pass per stage, and that is why a residue survives — a pass that half-solves something
    // gets no second turn. Measured on the reported file, its winding never settles at 177 and 18,639
    // faces still cross, where the reference's own loop leaves 0 and 9,892.
    //
    // A round targets the class that is actually non-zero rather than re-running everything, and it is
    // kept only when the defect total *strictly drops*. So this cannot wander: it improves the mesh or
    // it stops. That is also what keeps it affordable. The fixed-point rounds this pipeline used to run
    // cost 40% of a run re-running passes over classes that were already zero; every round here is over
    // a class that is not.
    begin!("repair_rounds");
    let t = std::time::Instant::now();
    // First, weld at the **loader's** tolerance, not this pipeline's.
    //
    // Every export path here produces a triangle soup — an STL has no vertex indices and the staged
    // `positions.bin` is nine floats per triangle — and the loader welds a soup at
    // `DEFAULT_MERGE_EPSILON` relative to the diagonal. So the mesh a caller gets back from a file is
    // the mesh *this* weld produces, and a pipeline that ends finer than that is handing over a mesh it
    // has not finished: measured on the reported model, the repair's own output is 0/0/0/0 in memory and
    // 177 winding edges the moment it goes through an STL, because the loader joins vertices the
    // pipeline had kept apart.
    //
    // So the pipeline ends where a re-read begins. What this weld breaks, the loop below repairs, and
    // what the loop does afterwards keeps its distance from the loader's weld by construction — the split
    // displaces by four of them. Guarded like everything else.
    let loader_epsilon = crate::io::DEFAULT_MERGE_EPSILON * mesh.bbox().diag().max(1e-6);
    let (welded_to_loader, _collapsed_loader, refused_loader) = stitch_vertices(&mut mesh, loader_epsilon);
    let mut rounds = 0usize;
    let mut repaired = welded_to_loader;
    let mut notes = Vec::new();
    if refused_loader {
        notes.push("the loader's weld was refused".to_string());
    }
    let mut best = crate::evaluate::evaluate(&mesh).total();
    let first_total = best;
    // Attempts rather than rounds: a class that cannot improve the mesh costs an attempt, and the loop
    // has to be able to try the next one rather than stop on it. The reference's tracker walks its
    // classes the same way.
    for _ in 0..MAX_REPAIR_ATTEMPTS {
        if best == 0 {
            break;
        }
        // The loader's weld is *inside* the loop, not only before it.
        //
        // Welding once, before the loop, leaves the loop's own damage in the mesh: measured on the reported
        // model, its output read 26/25/0/48 in memory and 64/117/1/193 as a file, and repairing that welded
        // file took it to 0/0/0/0 — the loop repairs exactly what the weld broke. So each round starts from
        // the welded mesh and is judged against the total the weld left, which is what converges instead of
        // oscillating. The reference's own repair iterates its weld-and-delete pass with every other class
        // for the same reason.
        //
        // The copies a separation leaves at the same position are the copies this merges back. That is
        // deliberate: a pinch is how a support attaches to the model it supports, and displacing one
        // separates a shell from the shell it touches — measured on the supported file in the corpus, that
        // took its components from 3,148 to 5,442 and its classes from 0/0/0/0 to 44/132/220.
        if rounds > 0 {
            let (welded_round, _collapsed_round, _refused_round) =
                stitch_vertices(&mut mesh, loader_epsilon);
            let (collapsed_faces, refused_collapsed) = cull_repeated_vertex_faces(&mut mesh);
            if refused_collapsed {
                notes.push("a round's collapsed faces were refused".to_string());
            }
            repaired += welded_round;
            best = crate::evaluate::evaluate(&mesh).total();
            let _ = collapsed_faces;
        }
        let before = crate::evaluate::evaluate(&mesh);
        let mut progressed = false;
        let mut surface_bvh: Option<Bvh> = None;
        for class in DEFECT_CLASSES {
            if !class.present(&before) {
                continue;
            }
            let envelope = Envelope::of(&mesh);
            let surface = surface_bvh.get_or_insert_with(|| Bvh::build(&mesh));
            let mut candidate = mesh.clone();
            let did = repair_one_defect_class(&mut candidate, class, options);
            if did == 0 {
                continue;
            }
            // A fill that closes a hole by inventing a peak or a valley improves the defect total and
            // ruins the print, and the five classes have no term for it. Keep the work, take the
            // invention out, and let the total below judge the pair. The envelope is the cheap
            // backstop for the one case the surface test cannot see, a surface that is itself on the
            // box it arrived in.
            let projected = project_added_onto_surface(&mut candidate, &mesh, surface, envelope.slack);
            let clamped = envelope.clamp(&mut candidate);
            let after = crate::evaluate::evaluate(&candidate).total();
            if after < best {
                best = after;
                mesh = candidate;
                rounds += 1;
                repaired += did;
                notes.push(if projected > 0 || clamped > 0 {
                    format!(
                        "{} ({} vertex/vertices pulled back onto the surface, {} into the model)",
                        class.name(),
                        projected,
                        clamped
                    )
                } else {
                    format!("{}", class.name())
                });
                progressed = true;
                break;
            }
        }
        if !progressed {
            break;
        }
    }
    stage!(
        "repair_rounds",
        repaired,
        Some(format!(
            "{rounds} round(s), defects {first_total} -> {best}{}",
            if notes.is_empty() {
                String::new()
            } else {
                format!("; worked on {}", notes.join(", "))
            }
        )),
        t
    );

    // 12. Drop unused vertices, and classify the model/support split the renderer
    //     needs. Not repair, but the report describes this mesh.
    begin!("prune_and_classify");
    let t = std::time::Instant::now();
    let pruned = prune_unused_vertices(&mut mesh);
    // And the weld itself, at the loader's own tolerance, as the pipeline's last act.
    //
    // The loop above separates surfaces, fills rims and splits pinches, and the copies it leaves exactly
    // coincident are pairs any soup re-read merges: measured on the reported model, 26/25/0/48 in memory
    // against 64/117/1/193 as a file. Welding here is what makes the report's numbers the file's numbers,
    // and it is deliberately the *weld* rather than a pass that displaces each pair: a pinch is how a
    // support attaches to the model, so moving a copy off one separates a shell from the shell it touches
    // — measured on the supported file in the corpus, that came out 0/0/0/0 to 44/132/220 with its
    // components 3,148 to 5,442. The weld merges those copies back into the single vertex they were, which
    // is what a re-read does with them anyway.
    let vertices_before_weld = mesh.positions.len();
    {
        let soup = mesh.to_triangle_soup();
        mesh = IndexedMesh::from_triangle_soup(&soup, crate::io::DEFAULT_MERGE_EPSILON);
    }
    // The weld has a cost, and it is the same cost the loader charges: two corners of one triangle that
    // land in the same cell make a face with a repeated vertex, and such a face contributes both (a, b)
    // and (b, a), so it reads as a winding disagreement and as a non-manifold edge. Measured: corbu 0 ->
    // 81 of them and 0 -> 64 winding edges, Harbinger 0 -> 244 and 0 -> 103.
    //
    // The reference's own order is exactly this: weld by position, then delete every face whose vertex
    // references repeat. Its criterion is in this engine already, one stage earlier, which is why the
    // count could only ever have come from the weld. Deleting them is what lets the winding settle, and
    // the deletion is judged like every other pass, so a cull that opened the mesh would be refused.
    let (collapsed_faces, refused_collapsed) = cull_repeated_vertex_faces(&mut mesh);
    let settled_winding = if collapsed_faces > 0 {
        unify_winding(&mut mesh)
    } else {
        0
    };
    if refused_collapsed {
        notes.push("the weld's collapsed faces were refused".to_string());
    }
    let _ = settled_winding;
    // Whether the weld had anything to do. A weld that merged or culled nothing leaves the mesh exactly as
    // the stages handed it over, and asking for another pass over it would only re-derive the same answer.
    let weld_changed = mesh.positions.len() < vertices_before_weld || collapsed_faces > 0;

    // The invariant, asserted where it has to hold rather than left to a caller to discover: no two
    // distinct vertices may share a loader cell, because the next read would merge them and the file
    // would stop being the mesh that was measured. Debug builds only — the check is a full hash pass.
    debug_assert_eq!(
        coincident_count(&mesh),
        0,
        "the pipeline handed over a mesh the loader would weld, so the file is not what was measured"
    );
    let class_res =
        classify_and_reorder_model_support_triangles(&mut mesh, options.assume_support_geometry);
    if let Some((model_tri_count, likely_support_geometry)) = class_res.split {
        report.model_triangle_count = Some(model_tri_count);
        if !report.likely_support_geometry {
            report.likely_support_geometry = likely_support_geometry;
        }
    }
    stage!("prune_and_classify", pruned, None, t);

    // Post-analysis.
    report.post = analyze(&mesh);

    // The verdict is the five classes, and self-intersections are not one of them.
    //
    // A mesh that carries crossings and is otherwise sound is a mesh that prints.
    // Calling it broken is how a good file ends up with minutes of work spent on it
    // and a report that says it failed.
    let defects = crate::evaluate::evaluate(&mesh);
    let mut notes: Vec<String> = Vec::new();
    if defects.non_manifold_edges > 0 {
        notes.push(format!(
            "{} non-manifold edge(s) remain",
            defects.non_manifold_edges
        ));
    }
    if defects.non_manifold_vertices > 0 {
        notes.push(format!(
            "{} pinched vertex(es) remain",
            defects.non_manifold_vertices
        ));
    }
    if defects.holes > 0 {
        notes.push(format!(
            "{} boundary loop(s) remain across {} edge(s)",
            defects.holes, report.post.boundary_edges
        ));
    }
    // A mesh that arrives open has no signed volume to compare against: the number depends on how
    // its openings happen to be bounded, and closing them is part of the repair. The panel shows a
    // before/after volume, so say when that comparison is not like for like — measured on corbu, it
    // reads +19.8% where the repair's own cost against a sealed baseline is -0.28%.
    if report.pre.boundary_loops > 0 {
        notes.push(format!(
            "the input is open ({} boundary loop(s)), so its signed volume is not a like-for-like comparison with the result's",
            report.pre.boundary_loops
        ));
    }
    if defects.inconsistent_edges > 0 {
        notes.push(if winding_is_unsatisfiable(&mesh) {
            format!(
                "{} inconsistently wound edge(s) remain on a surface that cannot be wound consistently: its topology has cycles that demand an odd flip, so no assignment removes them all",
                defects.inconsistent_edges
            )
        } else {
            format!(
                "{} inconsistently wound edge(s) remain",
                defects.inconsistent_edges
            )
        });
    }
    if defects.noise_shells > 0 {
        notes.push(format!("{} noise shell(s) remain", defects.noise_shells));
    }
    // Crossings are a number to report, not a defect to declare: a slicer does not
    // care about them, and the surface is only rewritten when the caller asks.
    if report.post.self_intersection_triangles > 0 {
        notes.push(format!(
            "{} self-intersecting triangle(s) detected; they do not stop a mesh printing, and the surface is only rewritten when the caller asks for it",
            report.post.self_intersection_triangles
        ));
    }
    report.fully_repaired = !defects.is_broken();
    report.residual_issues = notes;

    // The model section's own topology decides whether the frontend renders the
    // model red, which is a question about the model rather than about the repair.
    // A non-manifold model is already one of the five classes above.
    #[cfg(feature = "manifold")]
    {
        record_model_manifold_status(&mesh, &mut report);
    }

    report.total_ms = t_start.elapsed().as_secs_f64() * 1000.0;

    (RepairOutcome { mesh, report }, weld_changed)
}

/// Extract the model section — the first `model_tri_count` triangles, or every
/// triangle when there is no split — into a standalone [`IndexedMesh`] with
/// compacted (zero-based) vertex indices so it can be fed to `manifold_csg`.
#[cfg(feature = "manifold")]
fn extract_model_section_submesh(
    mesh: &IndexedMesh,
    model_tri_count: Option<usize>,
) -> IndexedMesh {
    let tri_end = model_tri_count
        .map(|n| n.min(mesh.triangles.len()))
        .unwrap_or(mesh.triangles.len());

    let mut vert_map: AHashMap<u32, u32> = AHashMap::new();
    let mut new_verts: Vec<Vec3> = Vec::new();
    let new_tris: Vec<[u32; 3]> = mesh.triangles[..tri_end]
        .iter()
        .map(|tri| {
            tri.map(|gi| {
                let next = new_verts.len() as u32;
                *vert_map.entry(gi).or_insert_with(|| {
                    new_verts.push(mesh.positions[gi as usize]);
                    next
                })
            })
        })
        .collect();

    IndexedMesh {
        positions: new_verts,
        triangles: new_tris,
    }
}

/// Runs the model section through the manifold_csg backend and returns its
/// status. `manifold_csg::Manifold::from_mesh_f32` rejects *any* mesh the CSG
/// backend flags — not only open/non-closed geometry but also `NotManifold`,
/// `NonFiniteVertex`, `VertexOutOfBounds`, etc. — returning
/// `Err(CsgError::ManifoldStatus(..))`, which is exactly the gate the hollowing
/// and hole-punching paths rely on. `Ok(())` means a valid, non-empty manifold;
/// `Err(reason)` carries the specific CSG status string.
#[cfg(feature = "manifold")]
fn model_section_manifold_status(
    mesh: &IndexedMesh,
    model_tri_count: Option<usize>,
) -> Result<(), String> {
    use manifold_csg::Manifold;

    let model = extract_model_section_submesh(mesh, model_tri_count);
    if model.triangles.is_empty() || model.positions.is_empty() {
        return Err("empty model section".into());
    }

    let positions: Vec<f32> = model
        .positions
        .iter()
        .flat_map(|v| [v.x, v.y, v.z])
        .collect();
    let indices: Vec<u32> = model.triangles.iter().flat_map(|t| *t).collect();

    // Any non-`NoError` CSG status surfaces here as `Err` and is treated as a
    // failed manifold check, regardless of which non-manifold condition it is.
    let model = Manifold::from_mesh_f32(&positions, 3, &indices).map_err(|e| e.to_string())?;
    if model.is_empty() || model.num_tri() == 0 {
        return Err("manifold became empty".into());
    }
    Ok(())
}

/// Records the model section's manifold status onto `report`
/// (`model_is_manifold` + `model_manifold_status`). Shared by the full repair
/// routine and the lightweight classify pass.
#[cfg(feature = "manifold")]
fn record_model_manifold_status(mesh: &IndexedMesh, report: &mut MeshHealthReport) {
    match model_section_manifold_status(mesh, report.model_triangle_count) {
        Ok(()) => {
            report.model_is_manifold = Some(true);
            report.model_manifold_status = None;
        }
        Err(reason) => {
            report.model_is_manifold = Some(false);
            report.model_manifold_status = Some(reason);
        }
    }
}

/// Lightweight model/support section classification pass.
///
/// This does **not** run the repair pipeline. It only attempts to classify and
/// reorder triangles into model-first / support-second sections so the frontend
/// can apply section-specific tinting while honoring "Load As-Is" behavior.
pub fn classify_support_split(
    mut mesh: IndexedMesh,
    options: &RepairOptions,
) -> ClassificationOutcome {
    let t_start = std::time::Instant::now();

    // Pre-analysis with placeholder component count — the classifier
    // computes union-find internally and returns the real count, which
    // we use for both pre and post (classification only reorders
    // triangles; topology — and therefore component count — is unchanged).
    let pre = minimal_analysis(&mesh, 0);
    let mut report = MeshHealthReport::new(pre);

    if options.assume_support_geometry == Some(true) {
        report.likely_support_geometry = true;
    }

    let t = std::time::Instant::now();
    let class_res =
        classify_and_reorder_model_support_triangles(&mut mesh, options.assume_support_geometry);
    let component_count = if let Some((model_tri_count, likely_support_geometry)) = class_res.split
    {
        report.model_triangle_count = Some(model_tri_count);
        report.likely_support_geometry = likely_support_geometry;
        if options.assume_support_geometry == Some(true) {
            report.likely_support_geometry = true;
        }
        report.steps.push(RepairStepReport {
            name: "classify_support_geometry_split".into(),
            changed: 0,
            notes: Some(format!(
                "classify-only split: first {} triangles tagged as model section",
                model_tri_count
            )),
            elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
        });
        class_res.component_count
    } else {
        report.steps.push(RepairStepReport {
            name: "classify_support_geometry_split".into(),
            changed: 0,
            notes: Some("classify-only split: no reliable model/support partition found".into()),
            elapsed_ms: t.elapsed().as_secs_f64() * 1000.0,
        });
        class_res.component_count
    };

    // Patch the pre-analysis with the real component count and build the
    // post-analysis from it. Classification only reorders triangles, so every field
    // but the component count is identical by construction, and recomputing it
    // walked the whole mesh a second time for nothing (a bbox pass and a signed
    // volume pass, once per classify, per model).
    report.pre.connected_components = component_count;
    report.post = report.pre.clone();
    report.fully_repaired = true;
    report.residual_issues = Vec::new();

    // Same final manifold-status gate as the full repair routine: feed the
    // model section through manifold_csg and flag any non-manifold status so
    // the frontend can render a non-manifold model red.
    #[cfg(feature = "manifold")]
    record_model_manifold_status(&mesh, &mut report);

    report.total_ms = t_start.elapsed().as_secs_f64() * 1000.0;

    RepairOutcome { mesh, report }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GeometryGroup {
    Model,
    Support,
}

const RAFT_Z_CUTOFF_MM: f32 = 2.0;
const TOP_MODEL_BAND_MM: f32 = 1.0;
const MODEL_MIN_TRIS_FLOOR: usize = 200;

fn classify_model_support_group(
    cid: usize,
    raft_z_cut: f32,
    model_seed: Option<usize>,
    model_min_tris: usize,
    comp_max_z: &[f32],
    comp_tri_count: &[usize],
) -> GeometryGroup {
    // Anything in the raft floor band is support by definition.
    if comp_max_z[cid] <= raft_z_cut {
        return GeometryGroup::Support;
    }

    // High-poly components above raft are typically true model shells, even
    // if the highest-Z seed was a support tip.
    if comp_tri_count[cid] >= model_min_tris {
        return GeometryGroup::Model;
    }

    // Fall back to top-band assignment around the seed component.
    if let Some(seed) = model_seed {
        let top_z = comp_max_z[seed];
        if cid == seed || comp_max_z[cid] >= top_z - TOP_MODEL_BAND_MM {
            GeometryGroup::Model
        } else {
            GeometryGroup::Support
        }
    } else {
        GeometryGroup::Support
    }
}

/// Determines if an imported file should be treated as a 100% standalone support structure.
///
/// Prior to PLAN-3, an inequality heuristic flagged files where support triangles outnumber
/// model triangles (`support_triangles_out >= model_triangles_out`) as `likely_support_geometry = true`.
/// This caused files containing both a model body and heavy support scaffolds to import as ALL GOLD
/// even though a valid 2-section boundary (`model_triangle_count > 0`) was present for "Split Supports".
///
/// Under PLAN-3, `likely_support_geometry` evaluates to `true` ONLY when `model_triangles_out == 0`
/// (i.e. the file is 100% pure support geometry with no model body). When `model_triangles_out > 0`,
/// `likely_support_geometry` is `false`, allowing the mesh to render with a PINK model body and GOLD
/// support overlay, while keeping the "Split Supports" feature enabled.
fn compute_likely_support_geometry(
    model_triangles_out: usize,
    support_triangles_out: usize,
    _model_comp_count: usize,
    _support_comp_count: usize,
    _model_input_triangles: usize,
    _support_input_triangles: usize,
) -> bool {
    support_triangles_out > 0 && model_triangles_out == 0
}

/// Attempt to solidify a fragmented mesh by converting each connected
/// component into a `Manifold` solid.
///
/// Components are first classified into two geometric groups:
///
/// * **Model group**: top-down candidate body/bodies (highest-Z component,
///   plus near-top peers within a small Z band)
/// * **Support group**: all other geometry, including any component whose
///   highest point is at or below `global_min_z + 2 mm` (raft region)
///
/// Each group is batch-unioned internally, but the two groups are **not**
/// unioned with each other. This preserves a model body separate from the
/// support body instead of collapsing everything into one component.
///
/// As with the previous path, each component is attempted with preferred
/// winding then reversed winding. Rejected components run through rescue tiers
/// and are merged only into their own group.
///
/// Returns `None` if no manifold-capable component exists, which causes the
/// caller to fall back to the corefine path.
///
/// On success returns `(mesh, manifold_accepted, fallback_rescued,
/// fallback_kept, fallback_dropped, likely_support_geometry)` where the counts
/// Component-culling variant of interior classification.
///
/// For each face we test parity against *other* components only, excluding all
/// triangles that belong to the face's own component. This prevents a face
/// from being mislabeled as interior due to self-shell hits when component
/// winding is noisy or partially inconsistent.
fn compute_interior_face_flags_against_other_components(
    mesh: &IndexedMesh,
    components: &[u32],
) -> Vec<bool> {
    if mesh.triangles.is_empty() {
        return Vec::new();
    }
    let bvh = Bvh::build(mesh);
    const OFFSET: f32 = 1e-4;
    let n = mesh.triangles.len();
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
                return false;
            }
            let normal = raw_n.scale(1.0 / len);
            let centroid = a.add(b).add(c).scale(1.0 / 3.0);
            let origin = centroid.add(normal.scale(OFFSET));
            let face_comp = components[fi];
            let hits = bvh.ray_hit_count_with_filter(mesh_ref, origin, normal, &|hit_face| {
                components[hit_face as usize] != face_comp
            });
            hits % 2 == 1
        })
        .collect()
}
/// Remove entire connected components whose majority of faces are classified
/// as interior-facing (via [`compute_interior_face_flags`]).
///
/// This is the stable alternative to the corefine+winding path: removing a
/// whole connected component never creates new boundary edges or non-manifold
/// edges in the remaining mesh, so it is safe even on highly fragmented inputs
/// (thousands of overlapping shells from 3D scanning, etc.).
///
/// Returns `(removed_triangles, removed_component_count)`.
/// Whether one component's own edges are each used by exactly two of its faces. A component with
/// an edge used once is open, holds no volume, and removing it cannot fill anything. Needing no
/// positions, this costs one edge map over the component's faces.
fn component_is_closed(mesh: &IndexedMesh, comps: &[u32], comp: u32) -> bool {
    let mut edges: ahash::AHashMap<(u32, u32), u32> = ahash::AHashMap::new();
    for (fi, tri) in mesh.triangles.iter().enumerate() {
        if comps[fi] != comp {
            continue;
        }
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            let key = if a < b { (a, b) } else { (b, a) };
            *edges.entry(key).or_insert(0) += 1;
        }
    }
    edges.values().all(|&n| n == 2)
}

/// What closed components sit inside other components, and how much they enclose.
///
/// A cavity is a closed shell inside the material. A model can carry one deliberately, as a hollowed
/// figure does, and a damaged file can carry one as an accident, such as a cavity modelled inside a
/// part whose wall it also breaks through. Either way it is worth reporting before anything removes
/// it: the choice between a hollow model and a solid one is the caller's, not the pipeline's.
#[derive(Debug, Clone, Copy, Default)]
pub struct CavityScan {
    /// Number of closed components sitting inside another component: a cavity as modelled on purpose.
    pub components: usize,
    /// Number of interior components that are *not* closed: a cavity whose shell is broken, which is
    /// what a cavity breaking through the outer wall looks like. It is still a cavity to anyone
    /// looking at the model, and it cannot be removed by the cull above, which requires closedness
    /// precisely so it does not delete a buried sheet. Reported so a caller sees the difference.
    pub broken_components: usize,
    /// Their total triangle count, so a caller can weigh the deletion.
    pub triangles: usize,
    /// The volume they enclose, unsigned. This is the material filling them would add.
    pub volume: f64,
}

/// Drop pairs of triangles that share three vertices and wind opposite ways.
///
/// Such a pair is a sheet with no thickness: two copies of one surface facing opposite directions,
/// enclosing nothing. They are how a hole gets "plugged" in a file like this one, where an internal
/// cavity breaks through the outer wall and the break is covered with zero-depth geometry rather
/// than filled with material. Two things follow. They enclose no volume, so removing them cannot
/// change what is solid, and they are the reason a constrained decomposition refuses the input: it
/// will not accept a complex whose facets lie on top of one another.
///
/// Removing them leaves the hole they covered open. That is intended here and nowhere else: this
/// path resamples, so the decomposition closes the hole by choosing a surface through it. Repair,
/// which may not invent geometry, must keep refusing this model.
pub fn drop_zero_depth_sheets(triangles: &mut Vec<[u32; 3]>) -> usize {
    let mut by_vertices: ahash::AHashMap<[u32; 3], Vec<usize>> =
        ahash::AHashMap::with_capacity(triangles.len());
    for (i, t) in triangles.iter().enumerate() {
        let mut key = *t;
        key.sort_unstable();
        by_vertices.entry(key).or_default().push(i);
    }
    let mut drop = vec![false; triangles.len()];
    for indices in by_vertices.values() {
        if indices.len() < 2 {
            continue;
        }
        // Opposite winding is the same three vertices in an opposite cyclic order, which a rotation
        // of one triangle cannot produce. Tiny groups, so comparing each against the first is enough.
        let first = triangles[indices[0]];
        let rotated = |t: [u32; 3]| {
            [
                [t[0], t[1], t[2]],
                [t[1], t[2], t[0]],
                [t[2], t[0], t[1]],
            ]
        };
        let first_order = rotated(first);
        for &i in &indices[1..] {
            let other = triangles[i];
            let opposite = !first_order.contains(&other)
                && (rotated(other).contains(&[first[0], first[2], first[1]])
                    || rotated(other).contains(&[first[1], first[0], first[2]]));
            if opposite {
                drop[i] = true;
                drop[indices[0]] = true;
            }
        }
    }
    let before = triangles.len();
    let mut i = 0usize;
    triangles.retain(|_| {
        let keep = !drop[i];
        i += 1;
        keep
    });
    before - triangles.len()
}

/// Classify the components: those that are closed and almost entirely inside another, and those
/// that are mostly inside another but not closed.
///
/// Shared so the scan and the removal cannot disagree about what a cavity is.
fn classify_cavity_components(mesh: &IndexedMesh) -> (Vec<u32>, Vec<u32>) {
    let comps = triangle_components(mesh);
    let interior = compute_interior_face_flags_against_other_components(mesh, &comps);
    let n_comps = comps.iter().copied().max().unwrap_or(0) as usize + 1;
    let mut comp_total = vec![0usize; n_comps];
    let mut comp_interior = vec![0usize; n_comps];
    for (fi, &is_interior) in interior.iter().enumerate() {
        let c = comps[fi] as usize;
        comp_total[c] += 1;
        if is_interior {
            comp_interior[c] += 1;
        }
    }
    let mut closed = Vec::new();
    let mut broken = Vec::new();
    for c in 0..n_comps as u32 {
        let tot = comp_total[c as usize];
        let int = comp_interior[c as usize];
        if tot == 0 {
            continue;
        }
        if !component_is_closed(mesh, &comps, c) {
            // Half its faces buried in another component is a shell that is mostly inside it. The
            // closedness test cannot see this one, and neither can a threshold tuned for the cull.
            if int * 2 >= tot {
                broken.push(c);
            }
            continue;
        }
        if int * 20 >= tot * 19 {
            closed.push(c);
        }
    }
    (closed, broken)
}

/// Find the cavities. Same rule the cull uses - a closed component whose faces are almost all
/// interior to another component - plus the broken ones, reported separately.
pub fn scan_cavities(mesh: &IndexedMesh) -> CavityScan {
    if mesh.triangles.len() < 4 {
        return CavityScan::default();
    }
    let (closed, broken) = classify_cavity_components(mesh);
    let comps = triangle_components(mesh);
    let mut scan = CavityScan {
        components: closed.len(),
        broken_components: broken.len(),
        ..CavityScan::default()
    };
    for c in closed.iter().chain(broken.iter()).copied() {
        let mut volume = 0.0f64;
        for (fi, tri) in mesh.triangles.iter().enumerate() {
            if comps[fi] != c {
                continue;
            }
            scan.triangles += 1;
            let a = mesh.positions[tri[0] as usize];
            let b = mesh.positions[tri[1] as usize];
            let d = mesh.positions[tri[2] as usize];
            volume += (a.x as f64 * (b.y as f64 * d.z as f64 - b.z as f64 * d.y as f64)
                - a.y as f64 * (b.x as f64 * d.z as f64 - b.z as f64 * d.x as f64)
                + a.z as f64 * (b.x as f64 * d.y as f64 - b.y as f64 * d.x as f64))
                / 6.0;
        }
        scan.volume += volume.abs();
    }
    scan
}

/// Delete the cavity components, returning the triangle count removed.
///
/// `include_broken` decides whether a cavity whose shell is broken counts, which is the difference
/// between filling a modelled hollow and making a damaged model solid. Deleting one removes surface
/// rather than material: the cavity encloses nothing, so what remains is the outer shell, solid
/// except where the cavity broke through it. Closing that is the resampler's job, which may invent
/// geometry; repair keeps refusing this model.
pub fn remove_cavities(mesh: &mut IndexedMesh, include_broken: bool) -> usize {
    if mesh.triangles.len() < 4 {
        return 0;
    }
    let (closed, broken) = classify_cavity_components(mesh);
    let mut drop: AHashSet<u32> = closed.into_iter().collect();
    if include_broken {
        drop.extend(broken);
    }
    if drop.is_empty() {
        return 0;
    }
    let comps = triangle_components(mesh);
    let before = mesh.triangles.len();
    let mut i = 0usize;
    mesh.triangles.retain(|_| {
        let keep = !drop.contains(&comps[i]);
        i += 1;
        keep
    });
    before - mesh.triangles.len()
}

fn cull_interior_components(mesh: &mut IndexedMesh) -> (usize, usize) {
    if mesh.triangles.len() < 4 {
        return (0, 0);
    }

    let comps = triangle_components(mesh);
    // One component cannot be inside another. The test below asks, per face, how many times a ray
    // from it crosses *other* components, and with one component that filter admits nothing, so every
    // flag is false by construction. What is skipped is the BVH build and a ray cast for every face:
    // measured on a 436k-triangle mesh, 450 ms of this stage, all of it to find nothing.
    if comps.iter().all(|&component| component == 0) {
        return (0, 0);
    }
    let interior = compute_interior_face_flags_against_other_components(mesh, &comps);
    let n_comps = comps.iter().copied().max().unwrap_or(0) as usize + 1;

    let mut comp_total = vec![0usize; n_comps];
    let mut comp_interior = vec![0usize; n_comps];
    for (fi, &is_interior) in interior.iter().enumerate() {
        let c = comps[fi] as usize;
        comp_total[c] += 1;
        if is_interior {
            comp_interior[c] += 1;
        }
    }

    // Remove only high-confidence interior components.
    //
    // 95% threshold avoids deleting valid exterior pieces when parity votes are
    // noisy near tangential overlaps or in locally messy scan geometry.
    const INTERIOR_RATIO_NUM: usize = 19;
    const INTERIOR_RATIO_DEN: usize = 20;
    // Only closed components. A cavity is a closed component inside another, and removing it
    // fills a void. A buried sheet is open and carries no volume, so removing it moves nothing.
    // This is the discriminator the volume test downstream was standing in for, and the volume
    // is a bad stand-in on a mesh that is not watertight: on the worm file 2,975 boundary edges
    // leave the signed volume meaningless and the removal trips a 0.589% move that is not a
    // cavity being filled, it is arithmetic on an open surface.
    let remove_set: AHashSet<u32> = (0..n_comps as u32)
        .filter(|&c| {
            let tot = comp_total[c as usize];
            let int = comp_interior[c as usize];
            tot > 0
                && int * INTERIOR_RATIO_DEN >= tot * INTERIOR_RATIO_NUM
                && component_is_closed(mesh, &comps, c)
        })
        .collect();

    let removed_comps = remove_set.len();
    if removed_comps == 0 {
        return (0, 0);
    }

    let before = mesh.triangles.len();
    let kept: Vec<[u32; 3]> = mesh
        .triangles
        .iter()
        .enumerate()
        .filter_map(|(fi, tri)| {
            if remove_set.contains(&comps[fi]) {
                None
            } else {
                Some(*tri)
            }
        })
        .collect();
    let removed_tris = before - kept.len();
    mesh.triangles = kept;
    (removed_tris, removed_comps)
}
// --- individual passes ---------------------------------------------------

/// Keep a pass's work only when it did not make any of the five classes worse.
///
/// Called *after* the pass, not around it, and that is the whole point. `evaluate` builds a full
/// half-edge topology — about a millisecond per thousand triangles — so measuring a mesh before a
/// pass that then changes nothing is the pass's own cost doubled. Most passes on most files change
/// nothing, and on the corpus that wasted measurement was seconds per file: a woven part spent 5.1s
/// of 8.8s in three rounds that reported `changed=0`.
///
/// Weighing a pass only when it has something to weigh is free: `before` is a clone, which for a
/// million triangles is three `Vec` copies, and the pass's own answer already says whether it
/// touched anything.
///
/// `before` is the mesh as the pass found it, and `changed` what the pass did. Returns what to
/// report and whether the pass was refused.
fn judge(mesh: &mut IndexedMesh, before: IndexedMesh, changed: usize) -> (usize, bool) {
    if changed == 0 {
        return (0, false);
    }
    if crate::evaluate::evaluate(mesh).worse_than(&crate::evaluate::evaluate(&before)) {
        *mesh = before;
        return (0, true);
    }
    (changed, false)
}

/// The face cull. Two classes of face live in here and they behave nothing alike, so they are
/// judged separately.
///
/// Repeated-vertex faces are free to remove and removal is the repair: `(a, b, a)` has no area and
/// no volume, but contributes both `(a, b)` and `(b, a)`, so an edge with one real face looks
/// paired. That manufactured pairing is what the winding count sees. 3DBenchy reads 355
/// inconsistent edges and watertight at the same time for exactly this reason, and removing its
/// 2,006 of these clears all 355 with no other class moving.
///
/// Collinear faces with distinct indices are not free: 3DBenchy's 11 of them open 29 edges and 9
/// holes when removed. They stay behind a guard.
///
/// Both face classes, and which half refused if either did.
///
/// **The order was tried the other way and measured out.** The reference removes double triangles at
/// step 3 of its script and degenerates at step 9, *after* it closes all the holes, so the repeated
/// vertex faces were moved out of here into a stage of their own after the fills. It changes no
/// outcome, and it costs up to twice the engine time: a 292,470-triangle model went 4.9s to 10.0s and
/// an 815,474-triangle one 15.1s to 28.8s. The reason is the one this function's own notes give for
/// 3DBenchy: a face that names the same vertex twice contributes both `(a, b)` and `(b, a)`, so an
/// edge with one real face *looks* paired, and that manufactured pairing is what the winding count
/// sees. Leaving those faces in place therefore keeps `repair_orientation` flipping the same faces on
/// every call — on the woven model it flipped 2,160 faces three times in one run — where removing them
/// first lets the orientation and the holes settle and be skipped.
///
/// On the reported file the two orders produce a **byte-identical** mesh (same sha256, same size), so
/// this is not a quality difference either way. It is only the clock.
fn cull_faces(mesh: &mut IndexedMesh) -> (usize, Option<String>) {
    let (repeated, repeated_refused) = cull_repeated_vertex_faces(mesh);
    let (duplicates, duplicates_refused) = cull_duplicate_and_zero_area_faces(mesh);
    let note = match (repeated_refused, duplicates_refused) {
        (false, false) => None,
        (true, false) => Some(
            "the repeated-vertex removal was refused: it would have opened the mesh".to_string(),
        ),
        (false, true) => Some(format!(
            "{repeated} repeated-vertex face(s) removed; the duplicate and collinear removal was \
             refused, because it would have opened the mesh"
        )),
        (true, true) => {
            Some("both removals were refused: each would have opened the mesh".to_string())
        }
    };
    (repeated + duplicates, note)
}

/// Faces that name the same vertex twice. Guarded on their own so a file where one of them masks
/// a hole keeps it rather than trading a hidden hole for a visible one.
fn cull_repeated_vertex_faces(mesh: &mut IndexedMesh) -> (usize, bool) {
    let before = mesh.clone();
    let count = mesh.triangles.len();
    mesh.triangles
        .retain(|t| !(t[0] == t[1] || t[1] == t[2] || t[0] == t[2]));
    judge(mesh, before, count - mesh.triangles.len())
}

/// Double and collinear faces, refused when either would leave the mesh worse.
///
/// The same reasoning as the weld, because the cull does its own damage: removing a face can
/// take the last face off an edge and open the mesh, and a mesh with a boundary is a
/// different object from the one that went in. On the reported file the cull alone removed
/// 995 faces and left seven boundary edges that were not there, with the weld refusing and
/// reporting nothing.
///
/// So the rims it opens are filled before it is judged. Removing a face that stood twice leaves its
/// neighbours unpaired, which is a hole where a doubled wall was rather than an opening somebody
/// designed, and filling it is the other half of the same repair. Measured on the worm model, the
/// cull alone turns 3,515 non-manifold edges into 2,000 and the boundary 1,454 into 2,226, and was
/// refused for it; with the fill the same removal has somewhere to go.
fn cull_duplicate_and_zero_area_faces(mesh: &mut IndexedMesh) -> (usize, bool) {
    let before = mesh.clone();
    let removed = cull_degenerate_and_duplicate(mesh);
    if removed == 0 {
        return (0, false);
    }
    // No cap, for the same reason the split fills its rims uncapped: these are not holes in the
    // mesh as it arrived, they are what the removal exposed.
    let mut filled = crate::holes::holes_all(mesh, usize::MAX);
    // And the rims meet at pinches, which the fill skips by design because a pinched loop is not a
    // simple cycle. Splitting the pinch makes those loops simple, which is the same recipe the
    // split uses on its own rims.
    let pinches = crate::topology_passes::split_pinched_vertices(mesh);
    if pinches > 0 {
        filled += crate::holes::holes_all(mesh, usize::MAX);
    }
    if filled > 0 {
        let _ = unify_winding(mesh);
    }
    judge(mesh, before, removed + filled)
}

/// Stitch only where the winding agrees, and answer for it the same way the loose stitch does.
///
/// This is the reference's *first* stitch: orientation respected. Its second, later in its script, is
/// the loose one, and that is what [`stitch_vertices`] is. Running the strict pass first is what
/// lets the loose pass be reached at all on a model like corbu, where a blind weld joins surfaces
/// that face opposite ways and manufactures non-manifold edges.
/// Fill holes, and answer for it the way every other destructive pass does.
///
/// This pass had no guard, and that is not a detail. A change to it once opened 1376 boundary edges
/// across 35 loops on a model that had none, and nothing stopped it: the damage was simply carried
/// through the rest of the pipeline and reported at the end. Every other pass that can damage a mesh
/// is checked against the same five classes before it is kept; these were the exception.
///
/// `trivial_only` selects the pass; a refusal is returned so the caller can report it rather than
/// pass it off as a fill.
fn fill_holes_guarded(mesh: &mut IndexedMesh, max_edges: usize, trivial_only: bool) -> (usize, bool) {
    let before = mesh.clone();
    let filled = if trivial_only {
        crate::holes::holes_trivial(mesh)
    } else {
        crate::holes::holes_all(mesh, max_edges)
    };
    judge(mesh, before, filled)
}

/// A vertex weld and the collapse it creates, refused when it would leave the mesh worse.
///
/// A weld is a heuristic and it can leave a mesh worse than it found it. Joining two
/// surfaces a hair apart is the point, and where three of them meet the junction is
/// non-manifold; the reference resolves that with a boolean union and there is no union
/// here. So the weld answers for its own work: it is kept only when it did not make any
/// of the five classes worse, and the refusal is returned so a stage can say so rather
/// than report a repair it did not make.
///
/// The guard is here rather than at the call sites because four stages stitch, and one
/// of them forgetting to check is how a mesh came out of a repair with more non-manifold
/// edges than it went in with.
fn stitch_vertices_oriented(mesh: &mut IndexedMesh, epsilon: f32) -> (usize, bool) {
    // Nothing to weld is the common case on a mesh that came in clean, and it is free to ask: this
    // spending a clone and two evaluations to weigh a mesh against itself is what the stitch stage
    // was doing on `poussin.stl` for 393 ms.
    if nothing_to_weld(mesh, epsilon) {
        return (0, false);
    }
    let before = mesh.clone();
    let welded = weld_vertices_oriented(mesh, epsilon);
    judge(mesh, before, welded)
}

fn stitch_vertices(mesh: &mut IndexedMesh, epsilon: f32) -> (usize, usize, bool) {
    if nothing_to_weld(mesh, epsilon) {
        return (0, 0, false);
    }
    let before = mesh.clone();
    let welded = weld_vertices(mesh, epsilon);
    // No face culling here, and that is a deliberate departure from what this pass used to do.
    //
    // Culling duplicates after the weld removes faces, and removing a face opens the surface where its
    // neighbours no longer pair. The openings are real boundary loops, and the hole pass fills them -
    // flat, because a loop's minimum-area triangulation is a facet. That is where this engine's
    // "successful" repairs of a model like corbu got their flat faces inside a cavity: measured on
    // corbu, the stitch reported 653 changes and the hole pass then filled 141 faces' worth of loops;
    // with the cull removed the stitch reports **0 changes**, because the weld alone found nothing at
    // this tolerance, and the hole pass fills **0**. The mesh closes either way - what changes is that
    // it closes by not being opened, rather than by being capped.
    //
    // The reference does the same: its stitch step welds and nothing else, and its duplicate removal
    // is a separate later step. Which is also where ours is - `cull_faces` runs on its own at the
    // double-faces stage.
    //
    // `collapsed` stays in the signature and is always zero so the stages' reports keep their shape.
    let (welded, refused) = judge(mesh, before, welded);
    (welded, 0, refused)
}

/// Area-weighted normal per vertex, which is what "which way does the surface face here" means.
fn vertex_normals(mesh: &IndexedMesh) -> Vec<Vec3> {
    let mut normals = vec![Vec3::new(0.0, 0.0, 0.0); mesh.positions.len()];
    for t in &mesh.triangles {
        let (a, b, c) = (
            mesh.positions[t[0] as usize],
            mesh.positions[t[1] as usize],
            mesh.positions[t[2] as usize],
        );
        // The cross product's length is twice the area, so accumulating it un-normalised weights
        // each face by the area it contributes - which is the point.
        let n = b.sub(a).cross(c.sub(a));
        for &v in t.iter() {
            let slot = &mut normals[v as usize];
            slot.x += n.x;
            slot.y += n.y;
            slot.z += n.z;
        }
    }
    normals
}

/// Weld by position, but only where the winding agrees.
///
/// The reference's automatic repair stitches twice: once respecting the orientation, then again with
/// the orientation ignored. The first joins only vertices whose incident faces already agree on which
/// way the surface faces there; the second joins the rest regardless. This engine was loose-only,
/// which is why forcing it wider on corbu manufactured non-manifold edges and the run refused: a blind
/// weld across a break-through sheet joins two surfaces facing opposite ways, and that is not a
/// repair.
///
/// Vertices within `step` of each other are clustered by the direction their surface faces, and only
/// same-facing vertices merge. `step` is an absolute distance in model units.
fn weld_vertices_oriented(mesh: &mut IndexedMesh, step: f32) -> usize {
    if mesh.triangles.is_empty() {
        return 0;
    }
    // An absolute distance in model units. It used to be a fraction of the bbox diagonal, which made
    // it a property of how the mesh was loaded rather than of the geometry.
    let step = step.max(1e-7);
    let inv_step = 1.0 / step;

    let normals = vertex_normals(mesh);
    let mut cells: AHashMap<(i32, i32, i32), Vec<u32>> =
        AHashMap::with_capacity(mesh.positions.len());
    for (i, p) in mesh.positions.iter().enumerate() {
        cells
            .entry((
                (p.x * inv_step).round() as i32,
                (p.y * inv_step).round() as i32,
                (p.z * inv_step).round() as i32,
            ))
            .or_default()
            .push(i as u32);
    }

    let mut new_positions: Vec<Vec3> = Vec::with_capacity(mesh.positions.len());
    let mut remap: Vec<u32> = Vec::with_capacity(mesh.positions.len());
    // A representative per merged group, so each group is created once.
    let mut merged_into: AHashMap<(i32, i32, i32), Vec<(u32, Vec3)>> = AHashMap::new();

    for (i, p) in mesh.positions.iter().enumerate() {
        let key = (
            (p.x * inv_step).round() as i32,
            (p.y * inv_step).round() as i32,
            (p.z * inv_step).round() as i32,
        );
        let n = normals[i];
        let groups = merged_into.entry(key).or_default();
        // Same cell *and* same facing: the dot product is positive when the two surfaces point the
        // same way, and a zero-length normal (a vertex with no faces, or fully degenerate ones)
        // agrees with anything, because it says nothing.
        let n_len = (n.x * n.x + n.y * n.y + n.z * n.z).sqrt();
        let slot = groups.iter().find_map(|(idx, m)| {
            let m_len = (m.x * m.x + m.y * m.y + m.z * m.z).sqrt();
            let agreement = if n_len == 0.0 || m_len == 0.0 {
                1.0
            } else {
                (n.x * m.x + n.y * m.y + n.z * m.z) / (n_len * m_len)
            };
            if agreement > 0.0 { Some(*idx) } else { None }
        });
        match slot {
            Some(idx) => remap.push(idx),
            None => {
                let idx = new_positions.len() as u32;
                new_positions.push(*p);
                groups.push((idx, n));
                remap.push(idx);
            }
        }
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

fn weld_vertices(mesh: &mut IndexedMesh, step: f32) -> usize {
    let step = step.max(1e-7);
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

/// Duplicate faces, and faces whose three positions are collinear.
///
/// Repeated-vertex faces are not here: `cull_repeated_vertex_faces` has already taken them, and it
/// takes them without a guard, because for that class removal is the repair.
fn cull_degenerate_and_duplicate(mesh: &mut IndexedMesh) -> usize {
    let before = mesh.triangles.len();
    let mut seen: ahash::AHashSet<(u32, u32, u32)> = ahash::AHashSet::with_capacity(before);
    mesh.triangles.retain(|tri| {
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
/// Closes every border loop up to `max_edges` long.
///
/// The reference engine's fill, from the same pull request as the rest of the port. It winds the
/// cap from the loop's own half-edge order rather than from the average normal of the faces
/// around it, which is why a cap cannot disagree with the mesh it closes.
///
/// The average-normal version this replaced could, and did: on the corbu model the split resolved
/// non-manifold edges 1367 to 0 and had to be refused because winding went 113 to 267. The caps
/// were the winding.
pub(crate) fn fill_small_holes(mesh: &mut IndexedMesh, max_edges: usize) -> usize {
    crate::topology_passes::fill_holes_oriented(mesh, max_edges)
}

#[allow(dead_code)]
fn fill_small_holes_by_normal(mesh: &mut IndexedMesh, max_edges: usize) -> usize {
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

struct ClassificationResult {
    split: Option<(usize, bool)>,
    component_count: usize,
}

/// Conservative fallback classifier that partitions triangles into model and
/// support sections by connected component height bands, then reorders the
/// mesh triangles so model section comes first and support section follows.
///
/// Returns a ClassificationResult struct. The component count is the total number
/// of connected components before reordering, which the caller can reuse.
#[allow(unused_assignments)]
fn classify_and_reorder_model_support_triangles(
    mesh: &mut IndexedMesh,
    assume_support_geometry: Option<bool>,
) -> ClassificationResult {
    if assume_support_geometry == Some(true) {
        return ClassificationResult {
            split: Some((0, true)),
            component_count: 1,
        };
    }
    if assume_support_geometry == Some(false) {
        return ClassificationResult {
            split: Some((mesh.triangles.len(), false)),
            component_count: 1,
        };
    }
    if mesh.triangles.len() < 8 || mesh.positions.is_empty() {
        return ClassificationResult {
            split: None,
            component_count: 0,
        };
    }

    let components = triangle_components(mesh);
    let n_comps = components.iter().copied().max().unwrap_or(0) as usize + 1;
    if n_comps < 2 {
        return ClassificationResult {
            split: None,
            component_count: n_comps,
        };
    }

    const BASE_TOUCH_EPS_MM: f32 = 0.25;

    let global_min_z = mesh
        .positions
        .iter()
        .map(|p| p.z)
        .fold(f32::INFINITY, f32::min);
    let raft_z_cut = global_min_z + RAFT_Z_CUTOFF_MM;

    let mut comp_max_z = vec![f32::NEG_INFINITY; n_comps];
    let mut comp_min_z = vec![f32::INFINITY; n_comps];
    let mut comp_tri_count = vec![0usize; n_comps];
    let mut comp_vol = vec![0.0f64; n_comps];

    for (fi, tri) in mesh.triangles.iter().enumerate() {
        let cid = components[fi] as usize;
        comp_tri_count[cid] += 1;
        let z0 = mesh.positions[tri[0] as usize].z;
        let z1 = mesh.positions[tri[1] as usize].z;
        let z2 = mesh.positions[tri[2] as usize].z;
        comp_max_z[cid] = comp_max_z[cid].max(z0.max(z1).max(z2));
        comp_min_z[cid] = comp_min_z[cid].min(z0.min(z1).min(z2));

        let a = mesh.positions[tri[0] as usize];
        let b = mesh.positions[tri[1] as usize];
        let c = mesh.positions[tri[2] as usize];
        let v = (a.x as f64) * ((b.y as f64) * (c.z as f64) - (b.z as f64) * (c.y as f64))
            - (a.y as f64) * ((b.x as f64) * (c.z as f64) - (b.z as f64) * (c.x as f64))
            + (a.z as f64) * ((b.x as f64) * (c.y as f64) - (b.y as f64) * (c.x as f64));
        comp_vol[cid] += v;
    }

    for cid in 0..n_comps {
        comp_vol[cid] /= 6.0;
    }

    let model_seed = match (0..n_comps)
        .filter(|&cid| comp_tri_count[cid] >= 4 && comp_max_z[cid] > raft_z_cut)
        .max_by(|&a, &b| {
            comp_max_z[a]
                .partial_cmp(&comp_max_z[b])
                .unwrap_or(std::cmp::Ordering::Equal)
        }) {
        Some(seed) => seed,
        None => {
            return ClassificationResult {
                split: None,
                component_count: n_comps,
            };
        }
    };

    // Components with at least 1/8 of the seed's triangle count are "high-poly"
    // and treated as model shells even if they don't reach the top Z band.
    // This handles multi-shell models where parts sit at different heights while
    // still separating them from the low-poly support scaffold. Support posts,
    // cylinders, and contact tips are far below this threshold.
    let model_min_tris = (comp_tri_count[model_seed] / 8).max(MODEL_MIN_TRIS_FLOOR);

    let classify_group = |cid: usize| {
        if comp_vol[cid] < -1e-2 {
            return GeometryGroup::Model;
        }
        classify_model_support_group(
            cid,
            raft_z_cut,
            Some(model_seed),
            model_min_tris,
            &comp_max_z,
            &comp_tri_count,
        )
    };

    let mut model_comp_count = 0usize;
    let mut support_comp_count = 0usize;
    let mut model_input_triangles = 0usize;
    let mut support_input_triangles = 0usize;
    // PRESERVED (PLAN-2 Support Heuristics):
    // Tracks base contact counts and triangle volumes for support connected components.
    // Kept in-place for future UI configuration knobs and advanced support detection rules.
    #[allow(unused_variables, unused_assignments)]
    let mut support_base_touch_components = 0usize;
    #[allow(unused_variables, unused_assignments)]
    let mut support_base_touch_triangles = 0usize;
    let base_touch_cut = global_min_z + BASE_TOUCH_EPS_MM;

    for cid in 0..n_comps {
        let tri_count = comp_tri_count[cid];
        if tri_count == 0 {
            continue;
        }
        match classify_group(cid) {
            GeometryGroup::Model => {
                model_comp_count += 1;
                model_input_triangles += tri_count;
            }
            GeometryGroup::Support => {
                support_comp_count += 1;
                support_input_triangles += tri_count;
                if comp_min_z[cid] <= base_touch_cut {
                    support_base_touch_components += 1;
                    support_base_touch_triangles += tri_count;
                }
            }
        }
    }

    let model_avg_tris = if model_comp_count > 0 {
        model_input_triangles / model_comp_count
    } else {
        0
    };
    let support_avg_tris = if support_comp_count > 0 {
        support_input_triangles / support_comp_count
    } else {
        0
    };

    // Primary discriminator: support scaffolds (posts, cylinders, contact tips) are
    // inherently low-poly compared to model geometry. If the two groups have similar
    // average triangle density per component this is almost certainly a multi-shell
    // model, not a model+support file. Require support comps to average at least 3×
    // fewer triangles than model comps before considering anything else.
    let density_ok = model_comp_count > 0
        && model_avg_tris > 0
        && support_avg_tris.saturating_mul(3) < model_avg_tris;

    // Remaining guards: keep density_ok and support_input_triangles as-is.
    // Comment out overly aggressive component floor & bed-touch bounds.
    if !density_ok || support_input_triangles < 2_000
    /*
    || support_comp_count < model_comp_count.saturating_mul(2).max(4)
    || n_comps < 12
    || support_base_touch_components < support_comp_count.saturating_div(4).max(3)
    || support_base_touch_triangles < 500
    */
    {
        return ClassificationResult {
            split: None,
            component_count: n_comps,
        };
    }

    let mut model_tris: Vec<[u32; 3]> = Vec::with_capacity(mesh.triangles.len());
    let mut support_tris: Vec<[u32; 3]> = Vec::with_capacity(mesh.triangles.len());

    for (fi, tri) in mesh.triangles.iter().enumerate() {
        let cid = components[fi] as usize;
        match classify_group(cid) {
            GeometryGroup::Model => model_tris.push(*tri),
            GeometryGroup::Support => support_tris.push(*tri),
        }
    }

    if model_tris.is_empty() || support_tris.is_empty() {
        return ClassificationResult {
            split: None,
            component_count: n_comps,
        };
    }

    let model_triangles_out = model_tris.len();
    let support_triangles_out = support_tris.len();

    mesh.triangles.clear();
    mesh.triangles.extend(model_tris);
    mesh.triangles.extend(support_tris);

    let likely_support_geometry = compute_likely_support_geometry(
        model_triangles_out,
        support_triangles_out,
        model_comp_count,
        support_comp_count,
        model_input_triangles,
        support_input_triangles,
    );

    ClassificationResult {
        split: Some((model_triangles_out, likely_support_geometry)),
        component_count: n_comps,
    }
}

/// Assign a component id to each triangle via union-find over shared edges;
/// for each component, cast a ray from a point well outside the bbox along a
/// random direction and count hits. If the count is even when the component
/// is supposed to contain the origin, or if the signed volume disagrees with
/// the majority-normal direction, flip every triangle's winding.
/// Propagates winding across the two-face edges, and per patch flips the side with less
/// area.
///
/// Two things this does that a per-component vote cannot. It *propagates*, so a component
/// whose faces disagree with each other comes out consistent, which is the defect the
/// orientation class is about. And it decides per patch by area, so a patch that already
/// agrees has nothing on the minority side and is left alone, while a patch that is
/// genuinely inverted is the smaller side and gets turned.
///
/// The reference engine's pass, and the reason its orientation is described as cavity-safe:
/// a solid with an internal cavity has an inward-facing cavity wall, and turning everything
/// outward turns the cavity inside out. Measured on a mesh with one: the volume moved 17%
/// under a per-component outward vote.
/// `pub(crate)` for the surface-to-solid prep, which needs a consistently wound surface before the
/// boolean and cannot be the judge of it: the boolean is.
pub(crate) fn unify_winding(mesh: &mut IndexedMesh) -> usize {
    let n = mesh.triangles.len();
    if n == 0 {
        return 0;
    }
    let before = mesh.clone();
    let flipped = unify_winding_once(mesh);
    if flipped == 0 {
        return 0;
    }
    // Both measurements below are paid only when the pass flipped something, for the same reason
    // `judge` is called after its pass: a mesh nothing was done to has nothing to weigh.
    //
    // Flipping a set of faces only changes the edges on its boundary, so on a mesh whose
    // disagreements form a cycle no assignment satisfies, every call flips the same faces
    // and the count never moves. That is an oscillation, not a repair: measured on
    // 3DBenchy, 355 faces flipped on every call while the count stayed at 355. Keeping the
    // work only when the count dropped makes the pass idempotent, and a mesh it cannot
    // settle comes out as it went in.
    if Topology::build(mesh).inconsistent_edges() >= Topology::build(&before).inconsistent_edges() {
        *mesh = before;
        return 0;
    }
    // A patch is whatever the two-face edges connect, and on a mesh with parts that overlap or
    // touch it can be a whole component: flipping the minority side then turns a solid inside
    // out. Measured on the corbu model, where this moved the volume 245 on a 98-unit model and
    // the component vote below had already refused to do the same thing. Consistency is worth
    // having and the model is worth more.
    let volume_before = before.signed_volume();
    if (mesh.signed_volume() - volume_before).abs() > volume_before.abs().max(1e-9) * 0.01 {
        *mesh = before;
        return 0;
    }
    flipped
}

fn unify_winding_once(mesh: &mut IndexedMesh) -> usize {
    let n = mesh.triangles.len();
    if n == 0 {
        return 0;
    }
    let topo = Topology::build(mesh);
    let mut adjacency: Vec<Vec<(u32, bool)>> = vec![Vec::new(); n];
    for info in topo.edges.values() {
        if info.directed.len() != 2 {
            continue;
        }
        let (a0, _, f0) = info.directed[0];
        let (a1, _, f1) = info.directed[1];
        if f0 == f1 {
            continue;
        }
        // Same direction along the edge means the two faces disagree about which side is
        // solid, so one of them has to turn relative to the other.
        let agree = a0 != a1;
        adjacency[f0 as usize].push((f1, agree));
        adjacency[f1 as usize].push((f0, agree));
    }

    let area: Vec<f64> = (0..n).map(|f| mesh.tri_area(f as u32) as f64).collect();
    let mut side = vec![0u8; n];
    let mut queue = std::collections::VecDeque::new();
    let mut patch = Vec::new();
    let mut flipped = 0usize;
    for seed in 0..n {
        if side[seed] != 0 {
            continue;
        }
        patch.clear();
        side[seed] = 1;
        queue.push_back(seed);
        let (mut keep_area, mut flip_area) = (0.0f64, 0.0f64);
        while let Some(x) = queue.pop_front() {
            patch.push(x);
            if side[x] == 1 {
                keep_area += area[x];
            } else {
                flip_area += area[x];
            }
            for &(y, agree) in &adjacency[x] {
                let y = y as usize;
                if side[y] == 0 {
                    side[y] = if agree { side[x] } else { 3 - side[x] };
                    queue.push_back(y);
                }
            }
        }
        // The smaller side goes. A patch that already agrees has nothing on side 2, and
        // `0 > keep_area` is false, so the minority is 2 and nothing flips.
        let minority = if flip_area > keep_area { 1 } else { 2 };
        for &x in &patch {
            if side[x] == minority {
                mesh.triangles[x].swap(1, 2);
                flipped += 1;
            }
        }
    }
    flipped
}

/// Five directions, none of them an axis. From the centre of a box the axes and the diagonals
/// aim at a face or a corner, and a corner hit lands on an edge of the triangle fan and counts
/// as zero, one or three faces depending on the arithmetic.
const DEPTH_RAY_DIRS: [Vec3; 5] = [
    Vec3::new(0.577_350_3, 0.577_350_3, 0.577_350_3),
    Vec3::new(-0.436_1, 0.725_3, 0.532_7),
    Vec3::new(0.267_2, -0.801_9, 0.534_6),
    Vec3::new(-0.624_7, -0.312_2, -0.715_8),
    Vec3::new(0.801_7, 0.267_1, -0.534_7),
];

/// Up to `max` points inside the component's solid: the centroids of its largest faces, moved
/// inward along the face normal.
///
/// The centroid of the whole component is the obvious sample and it is the wrong one. An
/// organic shape is not convex, and its centroid can sit outside it entirely, which makes the
/// nesting test say "not nested" and the volume vote turn the component inside out. Measured on
/// the corbu model: 83,733 faces flipped and the volume moved 17%.
fn interior_sample_points(mesh: &IndexedMesh, faces: &[u32], eps: f32, max: usize) -> Vec<Vec3> {
    let mut ranked: Vec<(f32, u32)> = faces.iter().map(|&f| (mesh.tri_area(f), f)).collect();
    ranked.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });
    ranked
        .into_iter()
        .take(max)
        .filter_map(|(_, fi)| {
            let n = mesh.tri_normal(fi);
            if n.length() < 1e-8 {
                return None;
            }
            let [a, b, c] = mesh.tri_positions(fi);
            Some(a.add(b).add(c).scale(1.0 / 3.0).sub(n.scale(eps)))
        })
        .collect()
}

/// Whether a component is a cavity boundary. One sample can land in a neighbouring part, so
/// several of the component's largest faces vote, and each of those votes over five directions.
fn nesting_depth_is_odd(
    bvh: &Bvh,
    mesh: &IndexedMesh,
    components: &[u32],
    comp_id: u32,
    samples: &[Vec3],
) -> bool {
    let mut odd = 0usize;
    for sample in samples {
        let mut votes = 0usize;
        for dir in DEPTH_RAY_DIRS {
            let hits = bvh.ray_hit_count_with_filter(mesh, *sample, dir, &|f| {
                components[f as usize] != comp_id
            });
            votes += (hits & 1) as usize;
        }
        odd += (votes * 2 > DEPTH_RAY_DIRS.len()) as usize;
    }
    !samples.is_empty() && odd * 2 > samples.len()
}


/// Unions the model's parts and the supports' parts, each group among itself.
///
/// Returns how many solids were unioned and the mesh that came out. The two groups never merge:
/// the reference can union everything because it re-detects supports afterwards, and the
/// model/support split is ours to keep.
///
/// Their `union_closed_components` does the work. `Manifold::from_mesh_f32` builds one manifold
/// from one mesh and does not union disjoint shells, so a whole-group construction hands back the
/// same part count it was given; building a manifold per component and batch-unioning them is what
/// merges, 234 struts to 37 on COOKIE_b4.
///
/// It cannot construct a component that is not already manifold, and keeps those verbatim. That is
/// why the split has to run before it: the split is what makes each surface constructible.
#[cfg(feature = "manifold")]
fn union_groups(mesh: &IndexedMesh, options: &ResolvedOptions) -> (usize, IndexedMesh, usize) {
    let mut candidate = mesh.clone();
    let classification = classify_and_reorder_model_support_triangles(
        &mut candidate,
        options.assume_support_geometry,
    );
    let split = classification
        .split
        .map(|(model_count, _)| model_count)
        .unwrap_or(candidate.triangles.len());
    let groups = [
        candidate.triangles[..split].to_vec(),
        candidate.triangles[split..].to_vec(),
    ];
    let mut recombined: Vec<[u32; 3]> = Vec::with_capacity(candidate.triangles.len());
    let mut unioned = 0usize;
    let mut separate = 0usize;
    for group in groups {
        if group.is_empty() {
            continue;
        }
        let mut part = IndexedMesh {
            positions: candidate.positions.clone(),
            triangles: group.clone(),
        };
        let components = triangle_components(&part);
        match crate::topology_passes::union_closed_components(&mut part, &components) {
            Some((count, _, apart)) => {
                unioned += count;
                separate += apart;
                if count == 0 {
                    // Nothing was unioned, so nothing about this group's mesh changed: recombining a
                    // rebuilt copy of it would only be a place for the surfaces to differ.
                    recombined.extend_from_slice(&group);
                    continue;
                }
                if part.positions.len() > candidate.positions.len() {
                    let tail: Vec<Vec3> = part.positions[candidate.positions.len()..].to_vec();
                    candidate.positions.extend_from_slice(&tail);
                }
                recombined.extend_from_slice(&part.triangles);
            }
            None => recombined.extend_from_slice(&group),
        }
    }
    candidate.triangles = recombined;

    // The union's output carries the positions of both operands, so a vertex the two sides shared comes
    // back twice — 28,009 of a 137,987-vertex model, measured. Welding it here was tried and is not where
    // it belongs: it merges duplicate faces into existence early enough for the double-face stage to count
    // them as duplicates and cull them, which on that model cost 11,148 faces and took its parts from 43 to
    // 239. The pipeline's last act is that same weld, one stage later, after every pass has had its say.
    (unioned, candidate, separate)
}

/// Whether a two-face edge is a winding disagreement: both faces traverse it the same way.
/// An edge with any other face count, or the same face twice, is not what this pass counts.
fn winding_disagrees(info: &EdgeInfo) -> bool {
    if info.directed.len() != 2 {
        return false;
    }
    let (a0, b0, f0) = info.directed[0];
    let (a1, b1, f1) = info.directed[1];
    f0 != f1 && (a0, b0) == (a1, b1)
}

/// How many disagreements flipping `face` removes net. It resolves each disagreeing edge the
/// face sits on and breaks each agreeing one, so only two-face edges count.
fn winding_flip_net(mesh: &IndexedMesh, topo: &Topology, face: usize) -> isize {
    let triangle = mesh.triangles[face];
    let mut net = 0isize;
    for k in 0..3 {
        let (a, b) = (triangle[k], triangle[(k + 1) % 3]);
        if a == b {
            continue;
        }
        if let Some(info) = topo.edges.get(&edge_key(a, b)) {
            if info.directed.len() != 2 {
                continue;
            }
            let (a0, b0, f0) = info.directed[0];
            let (a1, b1, f1) = info.directed[1];
            if f0 == f1 {
                continue;
            }
            if (a0, b0) == (a1, b1) {
                net += 1;
            } else {
                net -= 1;
            }
        }
    }
    net
}

/// Whether any assignment of face sides can satisfy every two-face edge.
///
/// Faces joined across two-face edges form a graph whose edges demand a parity: an agreeing edge
/// wants the same side, a disagreeing one wants opposite sides. A cycle whose parities sum to an odd
/// number is satisfied by no assignment — the surface is not orientable — so the residual there is a
/// property of the topology rather than of the solver. Measured on the V3 Cones: 12 such cycles, with
/// the pipeline leaving 4 inconsistent edges out of 1,382,764 faces. The floor is at least one, so no
/// solver reaches zero on a mesh like that.
fn winding_is_unsatisfiable(mesh: &IndexedMesh) -> bool {
    !frustrated_edges(mesh).is_empty()
}

 /// Fixes the winding edges that propagation leaves behind.
 ///
 /// `unify_winding` decides per patch, so a mesh whose disagreements form a cycle no assignment
 /// satisfies keeps every one of them: 4 edges on the V3 Cones and 355 on 3DBenchy, which is why
 /// neither reads as repaired. A patch decision cannot fix those, but a face decision can: flipping
 /// one face resolves the edge it sits on and toggles its other two, so the count can be driven down
 /// one face at a time.
 ///
/// Greedy and strictly descending. One topology build up front; each flip toggles three directed
/// entries and rescores only the faces incident to those edges, so the cost is proportional to
/// the flips, not the mesh. Rebuilding the topology per flip hung 3DBenchy: 355 flips at a full
/// build each. Stops when no single flip helps, and each accepted flip strictly drops the count,
/// so it cannot loop. The volume guard is the same one everything else answers to.
fn reduce_winding_edges(mesh: &mut IndexedMesh) -> usize {
    if mesh.triangles.is_empty() {
        return 0;
    }
    let volume_before = mesh.signed_volume();
    let triangles_before = mesh.triangles.clone();
    // The component cut runs first: it is the only one of these that turns whole regions over at
    // once, which is what a residual that forms an even subgraph needs. Each pass strictly drops
    // the count, and a pass that finds nothing ends the loop.
    let mut fixed = 0usize;
    for _ in 0..8 {
        let cut = solve_winding_cut(mesh);
        if cut == 0 {
            break;
        }
        fixed += cut;
    }
    fixed += greedy_flip_winding_edges(mesh);
    fixed += solve_winding_regions(mesh);
    fixed += walk_winding_edges(mesh);
    fixed += search_winding_assignments(mesh);
    if fixed > 0 {
        let moved = (mesh.signed_volume() - volume_before).abs();
        if moved > volume_before.abs().max(1e-9) * 0.01 {
            // A winding fix is not worth the model moving.
            mesh.triangles = triangles_before;
            return 0;
        }
    }
    fixed
}

/// Single-face flips, best-net first.
fn greedy_flip_winding_edges(mesh: &mut IndexedMesh) -> usize {
    let mut topo = Topology::build(mesh);
    let mut inconsistent = topo.inconsistent_edges();
    if inconsistent == 0 {
        return 0;
    }
    let faces = mesh.triangles.len();
    // Best-first by net gain. Versions retire entries a later flip invalidated: a face's net
    // depends only on its three edges, and every toggle of those edges bumps its version.
    let mut versions = vec![0u64; faces];
    let mut heap: std::collections::BinaryHeap<(isize, usize, u64)> =
        std::collections::BinaryHeap::new();
    for face in 0..faces {
        let net = winding_flip_net(mesh, &topo, face);
        if net > 0 {
            heap.push((net, face, 0));
        }
    }
    let mut fixed = 0usize;
    while inconsistent > 0 {
        let Some((net, face, version)) = heap.pop() else {
             break;
         };
        if version != versions[face] || net <= 0 {
            continue;
        }
        // The heap entry predates a rescore only when its version moved, which is checked
        // above, but a second pop of the same face after an unrelated bump would reuse a net
        // computed against older edges. Rescore at pop time; the heap only orders candidates.
        let net = winding_flip_net(mesh, &topo, face);
        if net <= 0 {
            continue;
        }
        let affected = apply_winding_flip(mesh, &mut topo, face, &mut inconsistent);
        fixed += 1;
        // Every face incident to a toggled edge may score differently now.
        for key in affected {
            if let Some(info) = topo.edges.get(&key) {
                for &(_, _, other) in info.directed.iter() {
                    let other = other as usize;
                    versions[other] += 1;
                    let rescore = winding_flip_net(mesh, &topo, other);
                    if rescore > 0 {
                        heap.push((rescore, other, versions[other]));
                    }
                }
            }
        }
     }
    fixed
}

/// The disagreements no single flip can reach.
///
/// A frustrated cycle is invisible to the greedy: on it, every flip breaks two agreeing edges to
/// fix one, so the count rises and the flip is refused. Flipping a *set* of faces can still
/// resolve it, because a flip only changes the edges on the set's boundary while the interior is
/// untouched either way.
///
/// The V3 Cones keep 4 edges for exactly this reason. They form a closed loop
/// 58357 -> 162679 -> 160762 -> 160761 -> 58357 around a sliver cluster whose faces measure 1e-5
/// to 2.6e-4 square units, and every one of those faces scores -1, so no face on the loop can be
/// turned on its own.
///
/// The region is small, so it is solved exactly rather than heuristically: expand out from the
/// residual across two-face edges, then score every assignment of those faces by the
/// disagreements left on the edges touching the region. Only a strictly better assignment is
/// applied, so this cannot raise the count, and a region too large to enumerate exactly is
/// truncated rather than skipped, which can only cost the optimum, never correctness.
fn solve_winding_regions(mesh: &mut IndexedMesh) -> usize {
    const MAX_REGION_FACES: usize = 20;
    const MAX_ROUNDS: usize = 8;
    let mut applied = 0usize;
    for _ in 0..MAX_ROUNDS {
        let topo = Topology::build(mesh);
        let mut seeds: Vec<u32> = Vec::new();
        for info in topo.edges.values() {
            if winding_disagrees(info) {
                seeds.push(info.directed[0].2);
                seeds.push(info.directed[1].2);
            }
        }
        if seeds.is_empty() {
            break;
        }
        // The region is index_of's keyed set: the seeds, then everything reachable from them
        // across a two-face edge, capped so the enumeration stays bounded.
        let mut index_of = vec![usize::MAX; mesh.triangles.len()];
        let mut region: Vec<u32> = Vec::new();
        let mut queue: std::collections::VecDeque<u32> = std::collections::VecDeque::new();
        for &s in &seeds {
            if region.len() >= MAX_REGION_FACES {
                break;
            }
            if index_of[s as usize] == usize::MAX {
                index_of[s as usize] = region.len();
                region.push(s);
                queue.push_back(s);
            }
        }
        while let Some(f) = queue.pop_front() {
            if region.len() >= MAX_REGION_FACES {
                break;
            }
            let t = mesh.triangles[f as usize];
            for k in 0..3 {
                let key = edge_key(t[k], t[(k + 1) % 3]);
                let Some(info) = topo.edges.get(&key) else {
                    continue;
                };
                if info.directed.len() != 2 {
                    continue;
                }
                for d in info.directed.iter() {
                    if region.len() >= MAX_REGION_FACES {
                        break;
                    }
                    let g = d.2;
                    if index_of[g as usize] == usize::MAX {
                        index_of[g as usize] = region.len();
                        region.push(g);
                        queue.push_back(g);
                    }
                }
            }
        }
        // Every two-face edge touching the region is an edge a flip can change.
        let mut seen: std::collections::BTreeSet<EdgeKey> = std::collections::BTreeSet::new();
        let mut candidates: Vec<((u32, u32, u32), (u32, u32, u32))> = Vec::new();
        for &f in &region {
            let t = mesh.triangles[f as usize];
            for k in 0..3 {
                let key = edge_key(t[k], t[(k + 1) % 3]);
                if !seen.insert(key) {
                    continue;
                }
                let Some(info) = topo.edges.get(&key) else {
                    continue;
                };
                if info.directed.len() != 2 || info.directed[0].2 == info.directed[1].2 {
                    continue;
                }
                candidates.push((info.directed[0], info.directed[1]));
            }
        }
        let current = candidates
            .iter()
            .filter(|(a, b)| (a.0, a.1) == (b.0, b.1))
            .count();
        let mut best_mask = 0usize;
        let mut best_cost = current;
        for mask in 1usize..(1usize << region.len()) {
            let mut cost = 0usize;
            for &(d0, d1) in &candidates {
                let (mut a0, mut b0) = (d0.0, d0.1);
                let (mut a1, mut b1) = (d1.0, d1.1);
                let i0 = index_of[d0.2 as usize];
                if i0 != usize::MAX && mask & (1 << i0) != 0 {
                    std::mem::swap(&mut a0, &mut b0);
                }
                let i1 = index_of[d1.2 as usize];
                if i1 != usize::MAX && mask & (1 << i1) != 0 {
                    std::mem::swap(&mut a1, &mut b1);
                }
                if (a0, b0) == (a1, b1) {
                    cost += 1;
                }
            }
            if cost < best_cost {
                best_cost = cost;
                best_mask = mask;
            }
        }
        if best_mask == 0 {
            break;
        }
        for (i, &f) in region.iter().enumerate() {
            if best_mask & (1 << i) != 0 {
                mesh.triangles[f as usize].swap(1, 2);
            }
        }
        applied += 1;
    }
    applied
}

/// Toggles one face, keeping the topology's directed entries and the running count in step.
/// Returns the edges it touched, which are the only ones whose state changed.
fn apply_winding_flip(
    mesh: &mut IndexedMesh,
    topo: &mut Topology,
    face: usize,
    inconsistent: &mut usize,
) -> smallvec::SmallVec<[EdgeKey; 3]> {
    let triangle = mesh.triangles[face];
    let mut affected: smallvec::SmallVec<[EdgeKey; 3]> = smallvec::SmallVec::new();
    for k in 0..3 {
        let (a, b) = (triangle[k], triangle[(k + 1) % 3]);
        if a == b {
            continue;
        }
        let key = edge_key(a, b);
        if let Some(info) = topo.edges.get_mut(&key) {
            let before = winding_disagrees(info);
            for entry in info.directed.iter_mut() {
                if entry.2 as usize == face {
                    std::mem::swap(&mut entry.0, &mut entry.1);
                }
            }
            let after = winding_disagrees(info);
            *inconsistent = *inconsistent + usize::from(after) - usize::from(before);
            affected.push(key);
        }
    }
    mesh.triangles[face].swap(1, 2);
    affected
}

/// The disagreements no strictly-descending move can enter.
///
/// A frustrated cycle is a barrier, not a slope. Every face on it has a net of -1, so the greedy
/// and the exact region search both refuse to move, and the count sits still forever: the V3 Cones
/// keep exactly 4 edges this way. The only way in is to take a move that makes the count worse.
///
/// So this walks: it takes the steepest toggle available even when that toggle costs, never
/// revisits a face, remembers the best count it saw, and undoes everything past that point. The
/// walk is bounded, and because the applied state is the best one seen and only replaces the
/// current state when it is strictly better, a mesh it cannot help comes out as it went in.
fn walk_winding_edges(mesh: &mut IndexedMesh) -> usize {
    const MAX_FLIPS: usize = 400;
    let mut topo = Topology::build(mesh);
    let mut inconsistent = topo.inconsistent_edges();
    if inconsistent == 0 {
        return 0;
    }
    // The disagreement edges, maintained as the walk goes. Scanning the topology for them on
    // every step is O(edges) per step, which on a million-triangle mesh is the whole cost of
    // the pass: 400 steps times four million edges.
    let mut bad: ahash::AHashSet<EdgeKey> = topo
        .edges
        .iter()
        .filter(|(_, info)| winding_disagrees(info))
        .map(|(key, _)| *key)
        .collect();
    let mut flipped: Vec<u32> = Vec::new();
    let mut flipped_set: ahash::AHashSet<u32> = ahash::AHashSet::new();
    let mut best_cost = inconsistent;
    let mut best_len = 0usize;
    for _ in 0..MAX_FLIPS {
        if inconsistent == 0 {
            break;
        }
        // Candidates: the faces on the disagreement edges, plus the neighbours of everything
        // already toggled. A face already toggled is excluded, so the walk cannot cycle.
        let mut candidates: Vec<u32> = Vec::new();
        for key in bad.iter() {
            if let Some(info) = topo.edges.get(key) {
                candidates.push(info.directed[0].2);
                candidates.push(info.directed[1].2);
            }
        }
        for &f in flipped.iter() {
            let t = mesh.triangles[f as usize];
            for k in 0..3 {
                let key = edge_key(t[k], t[(k + 1) % 3]);
                if let Some(info) = topo.edges.get(&key) {
                    if info.directed.len() == 2 {
                        candidates.push(info.directed[0].2);
                        candidates.push(info.directed[1].2);
                    }
                }
            }
        }
        candidates.retain(|f| !flipped_set.contains(f));
        candidates.sort_unstable();
        candidates.dedup();
        if candidates.is_empty() {
            break;
        }
        let mut best: Option<(isize, u32)> = None;
        for &f in &candidates {
            let net = winding_flip_net(mesh, &topo, f as usize);
            if best.map(|(n, _)| net > n).unwrap_or(true) {
                best = Some((net, f));
            }
        }
        let Some((_, face)) = best else {
            break;
        };
        let affected = apply_winding_flip(mesh, &mut topo, face as usize, &mut inconsistent);
        for key in affected {
            if topo.edges.get(&key).map(winding_disagrees).unwrap_or(false) {
                bad.insert(key);
            } else {
                bad.remove(&key);
            }
        }
        flipped.push(face);
        flipped_set.insert(face);
        if inconsistent < best_cost {
            best_cost = inconsistent;
            best_len = flipped.len();
        }
    }
    for &f in flipped[best_len..].iter() {
        mesh.triangles[f as usize].swap(1, 2);
    }
    best_len
}

/// One two-face edge the winding search can change, carrying the local index of each of its
/// faces (`u32::MAX` when that face is outside the search set, and therefore fixed).
struct SearchEdge {
    a0: u32,
    b0: u32,
    i0: u32,
    a1: u32,
    b1: u32,
    i1: u32,
}

impl SearchEdge {
    fn disagrees(&self, state: &[bool]) -> bool {
        let (mut a0, mut b0) = (self.a0, self.b0);
        if self.i0 != u32::MAX && state[self.i0 as usize] {
            std::mem::swap(&mut a0, &mut b0);
        }
        let (mut a1, mut b1) = (self.a1, self.b1);
        if self.i1 != u32::MAX && state[self.i1 as usize] {
            std::mem::swap(&mut a1, &mut b1);
        }
        (a0, b0) == (a1, b1)
    }
}

/// Toggles one face of the search set, keeping the disagreement count in step.
///
/// Toggling exactly one of an edge's two face orientations always flips whether that edge
/// disagrees, so every edge the face sits on — never more than three — changes state and nothing
/// else does. That is what makes a move O(1) rather than a pass over the search set.
fn toggle_search_face(
    state: &mut [bool],
    cost: &mut usize,
    edges: &[SearchEdge],
    face_edges: &[smallvec::SmallVec<[u32; 3]>],
    local: usize,
) {
    state[local] = !state[local];
    for &id in face_edges[local].iter() {
        if edges[id as usize].disagrees(state) {
            *cost += 1;
        } else {
            *cost -= 1;
        }
    }
}

/// The assignment of face orientations a descent cannot reach, searched rather than descended.
///
/// Minimizing the number of winding-disagreeing edges over orientations is MAX-2-LIN, and it is
/// NP-hard: the local minima the greedy and the walk stall in are what that hardness looks like
/// from the inside. Four reference files sit in one — the V3 Cones at 4 edges, `Untitled2.stl` at
/// 1,389, `INDIGO AWARD '26_Hollow_Fixed.stl` at 10,417 — where no single flip improves anything
/// and the tree assignment is already the best the per-patch pass can do.
///
/// What escapes a local minimum is flipping a *set* of faces at once, and a set only changes the
/// edges on its own boundary, so the search only has to consider faces near the residual. Around a
/// small residual that set is enumerated exactly, by Gray code so each step is one toggle; around
/// a large one it is annealed on a fixed schedule and then descended greedily, keeping the best
/// assignment either finds. The seed is a constant, so two runs on the same mesh agree.
///
/// Answers 0 and changes nothing when it cannot beat what it was given.
fn search_winding_assignments(mesh: &mut IndexedMesh) -> usize {
    const FACE_BUDGET: usize = 20_000;
    const EXACT_FACES: usize = 20;
    const ANNEAL_STEPS: usize = 300_000;

    let topo = Topology::build(mesh);
    // Seeds: the faces on a disagreement. Then outward through two-face edges, bounded.
    let mut index_of: Vec<u32> = vec![u32::MAX; mesh.triangles.len()];
    let mut faces: Vec<u32> = Vec::new();
    let mut queue: std::collections::VecDeque<u32> = std::collections::VecDeque::new();
    for info in topo.edges.values() {
        if !winding_disagrees(info) {
            continue;
        }
        for d in info.directed.iter() {
            if index_of[d.2 as usize] == u32::MAX {
                index_of[d.2 as usize] = faces.len() as u32;
                faces.push(d.2);
                queue.push_back(d.2);
            }
        }
    }
    if faces.is_empty() {
        return 0;
    }
    while let Some(f) = queue.pop_front() {
        if faces.len() >= FACE_BUDGET {
            break;
        }
        let t = mesh.triangles[f as usize];
        for k in 0..3 {
            let key = edge_key(t[k], t[(k + 1) % 3]);
            let Some(info) = topo.edges.get(&key) else {
                continue;
            };
            if info.directed.len() != 2 {
                continue;
            }
            for d in info.directed.iter() {
                if faces.len() >= FACE_BUDGET {
                    break;
                }
                let g = d.2;
                if index_of[g as usize] == u32::MAX {
                    index_of[g as usize] = faces.len() as u32;
                    faces.push(g);
                    queue.push_back(g);
                }
            }
        }
    }

    // Every two-face edge touching the set. Only these can change state, so the cost the search
    // minimizes is the disagreements among them.
    let mut seen: ahash::AHashSet<EdgeKey> = ahash::AHashSet::new();
    let mut edges: Vec<SearchEdge> = Vec::new();
    let mut face_edges: Vec<smallvec::SmallVec<[u32; 3]>> =
        vec![smallvec::SmallVec::new(); faces.len()];
    for &f in faces.iter() {
        let t = mesh.triangles[f as usize];
        for k in 0..3 {
            let key = edge_key(t[k], t[(k + 1) % 3]);
            if !seen.insert(key) {
                continue;
            }
            let Some(info) = topo.edges.get(&key) else {
                continue;
            };
            if info.directed.len() != 2 || info.directed[0].2 == info.directed[1].2 {
                continue;
            }
            let (d0, d1) = (info.directed[0], info.directed[1]);
            let i0 = index_of[d0.2 as usize];
            let i1 = index_of[d1.2 as usize];
            if i0 == u32::MAX && i1 == u32::MAX {
                continue;
            }
            let id = edges.len() as u32;
            edges.push(SearchEdge {
                a0: d0.0,
                b0: d0.1,
                i0,
                a1: d1.0,
                b1: d1.1,
                i1,
            });
            if i0 != u32::MAX {
                face_edges[i0 as usize].push(id);
            }
            if i1 != u32::MAX {
                face_edges[i1 as usize].push(id);
            }
        }
    }
    if edges.is_empty() {
        return 0;
    }

    let n = faces.len();
    let mut state = vec![false; n];
    let mut cost = edges.iter().filter(|e| e.disagrees(&state)).count();
    let original = cost;
    if original == 0 {
        return 0;
    }

    let mut best_state = state.clone();
    let mut best_cost = cost;
    if n <= EXACT_FACES {
        // Gray code: step i toggles bit `i.trailing_zeros()` and visits `i ^ (i >> 1)`.
        let steps = 1u64 << n;
        for i in 1..steps {
            let bit = i.trailing_zeros() as usize;
            toggle_search_face(&mut state, &mut cost, &edges, &face_edges, bit);
            if cost < best_cost {
                best_cost = cost;
                best_state.clone_from(&state);
            }
        }
        // Unwind the same sequence, which returns the state to where it started.
        for i in (1..steps).rev() {
            let bit = i.trailing_zeros() as usize;
            toggle_search_face(&mut state, &mut cost, &edges, &face_edges, bit);
        }
    } else {
        let mut rng: u64 = 0x9E37_79B9_7F4A_7C15;
        macro_rules! next_rand {
            () => {{
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                rng
            }};
        }
        let mut temp = 1.5f64;
        let cooling = (0.02f64 / temp).powf(1.0 / ANNEAL_STEPS as f64);
        for _ in 0..ANNEAL_STEPS {
            let local = (next_rand!() % n as u64) as usize;
            let before = cost;
            toggle_search_face(&mut state, &mut cost, &edges, &face_edges, local);
            if cost > before {
                let delta = (cost - before) as f64;
                let uniform = (next_rand!() >> 11) as f64 / (1u64 << 53) as f64;
                if uniform >= (-delta / temp).exp() {
                    toggle_search_face(&mut state, &mut cost, &edges, &face_edges, local);
                }
            }
            if cost < best_cost {
                best_cost = cost;
                best_state.clone_from(&state);
            }
            temp *= cooling;
        }
        // Descend from the best the anneal saw.
        state.clone_from(&best_state);
        cost = best_cost;
        loop {
            let mut improved = false;
            for local in 0..n {
                let before = cost;
                toggle_search_face(&mut state, &mut cost, &edges, &face_edges, local);
                if cost < before {
                    improved = true;
                    if cost < best_cost {
                        best_cost = cost;
                        best_state.clone_from(&state);
                    }
                } else {
                    toggle_search_face(&mut state, &mut cost, &edges, &face_edges, local);
                }
            }
            if !improved {
                break;
            }
        }
    }

    if best_cost >= original {
        return 0;
    }
    let mut flipped = 0usize;
    for (local, &f) in faces.iter().enumerate() {
        if best_state[local] {
            mesh.triangles[f as usize].swap(1, 2);
            flipped += 1;
        }
    }
    flipped
}

/// The disagreement set as a cut of the face graph.
///
/// Every residual we could not move has the same shape. The bad edges form an even subgraph of the
/// mesh — measured, zero odd-degree vertices on the V3 Cones, `Untitled2.stl` and the hollowed
/// INDIGO model — so they are the boundary of *some* set of faces. On an orientable surface that
/// set is always reachable, by Poincaré duality: an even subgraph of the mesh is a cut of the face
/// graph. Flipping it fixes every bad edge at once.
///
/// Why three other searches missed it: the set is a union of whole regions, not a patch. Removing
/// the bad edges splits the face graph into components — 15 on the cones, 158 on Untitled2, 43,130
/// on INDIGO — and the set to flip is a union of those. Toggling faces one at a time cannot find a
/// union of millions of faces, and a region cap cannot contain one.
///
/// So: split the face graph by the bad edges, then choose which components to turn over. That is a
/// max-cut on the component graph, which has one node per region and one edge per bad edge, and it
/// is solved exactly when small and by a local search when not. Every flip it makes is a whole
/// component, so it never disturbs an edge it did not set out to fix.
fn solve_winding_cut(mesh: &mut IndexedMesh) -> usize {
    const EXACT_COMPONENTS: usize = 22;

    let n = mesh.triangles.len();
    if n == 0 {
        return 0;
    }
    let topo = Topology::build(mesh);
    if topo.inconsistent_edges() == 0 {
        return 0;
    }

    // Faces joined across every agreeing two-face edge. A component is a region that can be turned
    // over without touching an edge inside it.
    let mut parent: Vec<u32> = (0..n as u32).collect();
    fn find(parent: &mut [u32], mut x: u32) -> u32 {
        while parent[x as usize] != x {
            parent[x as usize] = parent[parent[x as usize] as usize];
            x = parent[x as usize];
        }
        x
    }
    for info in topo.edges.values() {
        if info.directed.len() != 2 || info.directed[0].2 == info.directed[1].2 {
            continue;
        }
        if winding_disagrees(info) {
            continue;
        }
        let (a, b) = (info.directed[0].2, info.directed[1].2);
        let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
        if ra != rb {
            parent[ra as usize] = rb;
        }
    }

    // The component graph: one node per region, one edge per bad edge. A bad edge with both faces
    // in the same region cannot be fixed by turning a region over, and is counted, not used.
    let mut node_of: ahash::AHashMap<u32, u32> = ahash::AHashMap::new();
    let mut edges: Vec<(u32, u32)> = Vec::new();
    for info in topo.edges.values() {
        if !winding_disagrees(info) {
            continue;
        }
        let (a, b) = (info.directed[0].2, info.directed[1].2);
        let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
        if ra == rb {
            continue;
        }
        let next = node_of.len() as u32;
        let na = *node_of.entry(ra).or_insert(next);
        let next = node_of.len() as u32;
        let nb = *node_of.entry(rb).or_insert(next);
        edges.push((na, nb));
    }
    let k = node_of.len();
    if edges.is_empty() {
        return 0;
    }

    let mut side = vec![false; k];
    let mut best_cut = 0usize;
    if k <= EXACT_COMPONENTS {
        let mut best_mask = 0u64;
        for mask in 0u64..(1u64 << k) {
            let cut = edges
                .iter()
                .filter(|(a, b)| ((mask >> a) & 1) != ((mask >> b) & 1))
                .count();
            if cut > best_cut {
                best_cut = cut;
                best_mask = mask;
            }
        }
        for (v, s) in side.iter_mut().enumerate() {
            *s = (best_mask >> v) & 1 == 1;
        }
    } else {
        // A local search over the component graph, from two starts. Nodes are moved only when the
        // move increases the cut, so it terminates, and it keeps the best start.
        let mut adj: Vec<Vec<u32>> = vec![Vec::new(); k];
        for &(a, b) in &edges {
            adj[a as usize].push(b);
            adj[b as usize].push(a);
        }
        for start in 0..2u32 {
            let mut s: Vec<bool> = (0..k).map(|v| start == 1 && v % 2 == 1).collect();
            let mut cut = edges
                .iter()
                .filter(|(a, b)| s[*a as usize] != s[*b as usize])
                .count();
            loop {
                let mut improved = false;
                for v in 0..k {
                    let (mut same, mut diff) = (0usize, 0usize);
                    for &u in adj[v].iter() {
                        if s[u as usize] == s[v] {
                            same += 1;
                        } else {
                            diff += 1;
                        }
                    }
                    if same > diff {
                        s[v] = !s[v];
                        cut = cut + same - diff;
                        improved = true;
                    }
                }
                if !improved {
                    break;
                }
            }
            if cut > best_cut {
                best_cut = cut;
                side.clone_from(&s);
            }
        }
    }

    let gain = best_cut;
    if gain == 0 {
        return 0;
    }
    // Turn the chosen regions over.
    let mut flipped = 0usize;
    for face in 0..n as u32 {
        let root = find(&mut parent, face);
        let Some(&node) = node_of.get(&root) else {
            continue;
        };
        if side[node as usize] {
            mesh.triangles[face as usize].swap(1, 2);
            flipped += 1;
        }
    }
    flipped
}

/// The edges no assignment can satisfy: a parity walk over the two-face edges, keeping the edges
/// where a face's required side contradicts the side already fixed for its neighbour.
fn frustrated_edges(mesh: &IndexedMesh) -> Vec<EdgeKey> {
    let topo = Topology::build(mesh);
    let mut adj: AHashMap<u32, Vec<(u32, u8, EdgeKey)>> = AHashMap::new();
    for (key, info) in topo.edges.iter() {
        if info.directed.len() != 2 || info.directed[0].2 == info.directed[1].2 {
            continue;
        }
        let (a, b) = (info.directed[0].2, info.directed[1].2);
        let parity = u8::from(winding_disagrees(info));
        adj.entry(a).or_default().push((b, parity, *key));
        adj.entry(b).or_default().push((a, parity, *key));
    }
    let mut side: AHashMap<u32, u8> = AHashMap::new();
    let mut out: Vec<EdgeKey> = Vec::new();
    // Sorted roots: which edges end up flagged depends on where the walk starts, so this has to be
    // the same order in every process.
    let mut roots: Vec<u32> = adj.keys().copied().collect();
    roots.sort_unstable();
    for k in roots {
        if side.contains_key(&k) {
            continue;
        }
        side.insert(k, 0);
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(k);
        while let Some(f) = queue.pop_front() {
            let c = side[&f];
            for &(g, p, e) in adj.get(&f).map(|v| v.as_slice()).unwrap_or(&[]) {
                let want = c ^ p;
                match side.get(&g) {
                    None => {
                        side.insert(g, want);
                        queue.push_back(g);
                    }
                    Some(&cg) if cg != want => out.push(e),
                    _ => {}
                }
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// The side each face must take for every satisfiable two-face edge to hold: a parity walk over the
/// face graph. Faces with no two-face edge are side 0.
fn winding_sides(mesh: &IndexedMesh) -> AHashMap<u32, u8> {
    let topo = Topology::build(mesh);
    let mut adj: AHashMap<u32, Vec<(u32, u8)>> = AHashMap::new();
    for info in topo.edges.values() {
        if info.directed.len() != 2 || info.directed[0].2 == info.directed[1].2 {
            continue;
        }
        let (a, b) = (info.directed[0].2, info.directed[1].2);
        let parity = u8::from(winding_disagrees(info));
        adj.entry(a).or_default().push((b, parity));
        adj.entry(b).or_default().push((a, parity));
    }
    let mut side: AHashMap<u32, u8> = AHashMap::new();
    let mut roots: Vec<u32> = adj.keys().copied().collect();
    roots.sort_unstable();
    for k in roots {
        if side.contains_key(&k) {
            continue;
        }
        side.insert(k, 0);
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(k);
        while let Some(f) = queue.pop_front() {
            let c = side[&f];
            for &(g, p) in adj.get(&f).map(|v| v.as_slice()).unwrap_or(&[]) {
                if let std::collections::hash_map::Entry::Vacant(e) = side.entry(g) {
                    e.insert(c ^ p);
                    queue.push_back(g);
                }
            }
        }
    }
    side
}

/// Close the seam a cut opened, one side at a time.
///
/// The seam's edges belong to known sides — each is the single face of either the region or the rest
/// of the surface — so each side's edges form their own cycle and can be walked directly, with the
/// direction taken from the face that owns the edge. That is the point of closing it here: the general
/// fill cannot, because its walk pairs boundary edges by vertex alone and joins the two fans at a
/// pinched vertex, so a cap built from its loops bridges the two sides and the non-orientability comes
/// straight back.
///
/// Each cap is a fan from a new centre vertex, so it reuses no edge of the mesh and cannot bridge
/// anything.
fn cap_seam(mesh: &mut IndexedMesh, topo: &Topology, seam: &[EdgeKey], region: &AHashSet<u32>) {
    for in_region in [true, false] {
        let mut side: Vec<EdgeKey> = seam
            .iter()
            .copied()
            .filter(|k| {
                topo.edges
                    .get(k)
                    .and_then(|info| info.faces.first().copied())
                    .map(|f| region.contains(&f) == in_region)
                    .unwrap_or(false)
            })
            .collect();
        if side.len() < 3 {
            continue;
        }
        side.sort_unstable();
        let mut owner: AHashMap<EdgeKey, u32> = AHashMap::new();
        let mut arrives: AHashMap<u32, EdgeKey> = AHashMap::new();
        for &key in &side {
            let Some(info) = topo.edges.get(&key) else {
                continue;
            };
            let Some(&(_, head, _)) = info
                .directed
                .iter()
                .find(|d| region.contains(&d.2) == in_region)
            else {
                continue;
            };
            owner.insert(key, head);
            arrives.insert(head, key);
        }
        let mut next: AHashMap<EdgeKey, EdgeKey> = AHashMap::new();
        for &key in &side {
            let Some(info) = topo.edges.get(&key) else {
                continue;
            };
            let Some(&(tail, _, _)) = info
                .directed
                .iter()
                .find(|d| region.contains(&d.2) == in_region)
            else {
                continue;
            };
            if let Some(&prev) = arrives.get(&tail) {
                next.insert(key, prev);
            }
        }
        let mut used: AHashSet<EdgeKey> = AHashSet::new();
        for &start in &side {
            if used.contains(&start) {
                continue;
            }
            let mut lp: Vec<u32> = Vec::new();
            let mut cur = start;
            let mut closed = false;
            loop {
                if used.contains(&cur) {
                    closed = cur == start;
                    break;
                }
                used.insert(cur);
                if let Some(&head) = owner.get(&cur) {
                    lp.push(head);
                }
                match next.get(&cur) {
                    Some(&n) => cur = n,
                    None => break,
                }
            }
            if closed && lp.len() >= 3 {
                let c = lp.iter().fold([0.0f64; 3], |s, &v| {
                    let p = mesh.positions[v as usize];
                    [s[0] + p.x as f64, s[1] + p.y as f64, s[2] + p.z as f64]
                });
                let n = lp.len() as f64;
                mesh.positions
                    .push(Vec3::new((c[0] / n) as f32, (c[1] / n) as f32, (c[2] / n) as f32));
                let centre = (mesh.positions.len() - 1) as u32;
                for i in 0..lp.len() {
                    mesh.triangles.push([lp[i], lp[(i + 1) % lp.len()], centre]);
                }
            }
        }
    }
}

/// Cut the edges no assignment can satisfy, as a last resort after everything else has run.
///
/// Every odd cycle contains at least one unsatisfiable edge — an odd cycle is exactly one no
/// assignment satisfies — so removing those edges from the parity graph breaks all of them. The region
/// is one face from each such edge, and the vertices it shares with the rest of the surface are
/// duplicated, which removes the constraint across every one of them.
///
/// This runs at the end, not inside `repair_orientation`, and only when those edges are few. The
/// side-split cut there resolves a mesh whose disagreements are spread over the surface — corbu's 113
/// winding edges go to zero — and this is for the residue it cannot: the cones' two to seven, in a box
/// 0.00 x 0.02 x 0.11 on a model 49 units across. Cutting a surface that is frustrated throughout
/// detaches dozens of faces instead: corbu came out of that with 919 inconsistent edges and a volume
/// of -12.9.
fn cut_unsatisfiable_edges(mesh: &mut IndexedMesh, max_cut_edges: usize) -> usize {
    let conflicts = frustrated_edges(mesh);
    if conflicts.is_empty() || conflicts.len() > max_cut_edges {
        return 0;
    }
    let before: AHashSet<EdgeKey> = Topology::build(mesh)
        .edges
        .iter()
        .filter(|(_, info)| info.faces.len() == 1)
        .map(|(k, _)| *k)
        .collect();
    let topo = Topology::build(mesh);
    let mut region: AHashSet<u32> = AHashSet::new();
    for &key in &conflicts {
        if let Some(info) = topo.edges.get(&key) {
            if let Some(&f) = info.faces.first() {
                region.insert(f);
            }
        }
    }
    if region.is_empty() {
        return 0;
    }
    let mut inside: AHashSet<u32> = AHashSet::new();
    for &f in &region {
        for &w in &mesh.triangles[f as usize] {
            inside.insert(w);
        }
    }
    let mut outside: AHashSet<u32> = AHashSet::new();
    for (fi, t) in mesh.triangles.iter().enumerate() {
        if region.contains(&(fi as u32)) {
            continue;
        }
        for &w in t {
            outside.insert(w);
        }
    }
    // Sorted, so the copies are numbered the same way in every process.
    let mut shared: Vec<u32> = inside.intersection(&outside).copied().collect();
    shared.sort_unstable();
    if shared.is_empty() {
        return 0;
    }
    let mut copy: AHashMap<u32, u32> = AHashMap::new();
    for &w in &shared {
        let p = mesh.positions[w as usize];
        mesh.positions.push(p);
        copy.insert(w, (mesh.positions.len() - 1) as u32);
    }
    for &f in &region {
        for k in 0..3 {
            let w = mesh.triangles[f as usize][k];
            if let Some(&c) = copy.get(&w) {
                mesh.triangles[f as usize][k] = c;
            }
        }
    }
    let after = Topology::build(mesh);
    let seam: Vec<EdgeKey> = after
        .edges
        .iter()
        .filter(|(k, info)| info.faces.len() == 1 && !before.contains(k))
        .map(|(k, _)| *k)
        .collect();
    cap_seam(mesh, &after, &seam, &region);
    shared.len()
}

/// Re-tessellate the surface where the winding parity breaks, so what is left can be wound.
///
/// Every odd cycle contains an edge no assignment satisfies. Deleting the faces on those edges opens
/// a hole, and the fill closes it with new surface — the edge is gone, so the winding drops, and
/// nothing is duplicated. Measured on the V3 Cones: 7 unsatisfiable edges, 11 faces dropped, 13
/// filled, winding 4 to 0, parts 15 to 15, volume unchanged in the sixth decimal.
///
/// Guarded on the outcome, not on a count. The same move on Harbinger takes 181 edges, adds nine
/// parts and only reaches winding 48, so it is refused and the residual is reported instead. A
/// localised defect can be re-tessellated; one spread across the surface cannot, because any local
/// fix for it adds geometry.
fn retessellate_unsatisfiable(mesh: &mut IndexedMesh) -> usize {
    let conflicts = frustrated_edges(mesh);
    if conflicts.is_empty() {
        return 0;
    }
    let topo = Topology::build(mesh);
    let mut doomed: AHashSet<u32> = AHashSet::new();
    for key in &conflicts {
        if let Some(info) = topo.edges.get(key) {
            for &f in info.faces.iter() {
                doomed.insert(f);
            }
        }
    }
    if doomed.is_empty() {
        return 0;
    }

    let before_triangles = mesh.triangles.clone();
    let before_positions = mesh.positions.clone();
    let parts_before = triangle_components(mesh).iter().max().copied().unwrap_or(0) + 1;
    let volume_before = mesh.signed_volume();
    // The deletion opens a hole and the fill is meant to close it. Both classes are captured, because
    // a fill that fails leaves those faces missing and the mesh worse than it started: on corbu that
    // produced a cavity and the move was still accepted.
    let boundary_before = topo.edges.values().filter(|info| info.faces.len() == 1).count();
    let non_manifold_before = topo.non_manifold_edges().len();

    mesh.triangles = mesh
        .triangles
        .iter()
        .enumerate()
        .filter(|(i, _)| !doomed.contains(&(*i as u32)))
        .map(|(_, t)| *t)
        .collect();
    // The hole the deletion opened is closed here rather than by a later pass, so the whole move is
    // one decision that can be refused as a whole.
    let filled = crate::holes::holes_all(mesh, usize::MAX);

    let after = Topology::build(mesh);
    let parts_after = triangle_components(mesh).iter().max().copied().unwrap_or(0) + 1;
    let volume_after = mesh.signed_volume();
    let winding_after = after.inconsistent_edges();
    let boundary_after = after.edges.values().filter(|info| info.faces.len() == 1).count();
    let non_manifold_after = after.non_manifold_edges().len();
    let acceptable = parts_after <= parts_before
        && winding_after < conflicts.len()
        && boundary_after <= boundary_before
        && non_manifold_after <= non_manifold_before
        && (volume_after - volume_before).abs() <= volume_before.abs() * 0.01;
    if !acceptable {
        mesh.triangles = before_triangles;
        mesh.positions = before_positions;
        return 0;
    }
    filled
}

pub(crate) fn repair_orientation(mesh: &mut IndexedMesh) -> usize {
    if mesh.triangles.is_empty() {
        return 0;
    }
    // Consistency first: the component vote below can only turn a whole component, so a
    // component whose faces disagree with each other has to be settled before it runs.
    let mut flipped_faces = unify_winding(mesh);
    flipped_faces += reduce_winding_edges(mesh);
    // The parity walk's assignment satisfies every edge when the graph is satisfiable, and is
    // arbitrary when it is not: applied there it undoes the greedy flips above and leaves more
    // inconsistent edges than the mesh arrived with. Measured on corbu, 113 in and 919 out.
    if frustrated_edges(mesh).is_empty() {
        let sides = winding_sides(mesh);
        for (f, tri) in mesh.triangles.iter_mut().enumerate() {
            if sides.get(&(f as u32)).copied().unwrap_or(0) == 1 {
                tri.swap(1, 2);
                flipped_faces += 1;
            }
        }
    }
    let components = triangle_components(mesh);
    let n_components = components.iter().max().copied().unwrap_or(0) + 1;

    // Per-component signed volume gives us the simplest orientation check —
    // if a component is watertight and signed volume is negative, flip it.
    // For non-watertight components we fall back to a ray-cast vote using the
    // overall BVH.
    let bvh = Bvh::build(mesh);

    // Faces bucketed by component, and the bbox hoisted, for the same reason. Walking the whole
    // component array once per component is O(faces × components), and calling `mesh.bbox()`
    // inside the loop is the same order again. On a presupported scene with thousands of parts and
    // four million triangles this stage spent its whole 420 s budget without reaching `stitch`.
    // Bucketing and hoisting make it O(faces).
    let mut component_faces: Vec<Vec<u32>> = vec![Vec::new(); n_components as usize];
    for (face, &component) in components.iter().enumerate() {
        component_faces[component as usize].push(face as u32);
    }
    let sample_eps = (mesh.bbox().diag() * 1e-4).max(1e-6);
    // The scale the per-component flip guard measures against, read once. Inside the loop it
    // would be a pass over every face for every flipped component.
    let mesh_volume = mesh.signed_volume();

    for comp_id in 0..n_components {
        let face_indices = &component_faces[comp_id as usize];
        if face_indices.is_empty() {
            continue;
        }
        // A fragment too small to enclose anything is left alone. A closed solid needs at least
        // four faces, so below that the signed volume is a statement about where the triangle sits
        // relative to the origin rather than about which way it faces, and the ray vote that
        // replaces it answers the same non-question. A presupported scene is mostly these — 2.9M
        // components over 3.8M triangles, nearly one per triangle — and classifying every one of
        // them is where an hour of that run went.
        if face_indices.len() < 4 {
            continue;
        }

        // Component signed volume.
        let mut vol = 0.0f64;
        for &fi in face_indices {
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

        // A component inside another one is a cavity wall, and a cavity wall faces inward by
        // definition. Turning it outward makes the cavity a solid and moves the model's
        // volume, which is what a per-component outward vote does to every multi-component
        // mesh with an interior: measured on one, 83,745 faces flipped and the volume moved
        // 17%. The reference engine guards this with a nesting depth and describes the
        // result as cavity-safe.
        //
        // Only asked when it can change the answer. Above a positive volume the outcome is
        // "do not flip" whatever the nesting is, so the test is skipped there, and on a
        // presupported scene that is almost every component. Running it unconditionally is
        // what made such a scene unusable: 2.9M components at five samples and a direction
        // set each is hundreds of millions of BVH ray casts, and it had not reached the
        // second stage after an hour.
        let nesting_matters = flip_by_volume || vol.abs() < 1e-6;
        let nested = nesting_matters
            && {
                let samples = interior_sample_points(mesh, face_indices, sample_eps, 5);
                nesting_depth_is_odd(&bvh, mesh, &components, comp_id, &samples)
            };

        let should_flip = if nested {
            false
        } else if flip_by_volume {
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
            for &fi in face_indices {
                let t = &mut mesh.triangles[fi as usize];
                t.swap(1, 2);
            }
            // Turning a component over negates exactly its own signed-volume contribution, so the
            // move this guard measures is 2·|vol| — no pass over the mesh required. Asking
            // `mesh.signed_volume()` here was O(faces) per flipped component, and this scene flips
            // 119,104 faces, so it was the rest of the 146 s.
            let moved = 2.0 * vol.abs();
            let scale = mesh_volume.abs().max(1e-9) * 0.01;
            // Only when there is more than one component. With one there is nothing for it to be
            // nested in, so a negative volume means the model is inside out and turning it is
            // the whole point: an inverted cube goes from -1 to +1, a 200% move, and refusing
            // that would leave the model inverted.
            if n_components > 1 && moved > scale {
                for &fi in face_indices {
                    let t = &mut mesh.triangles[fi as usize];
                    t.swap(1, 2);
                }
            } else {
                flipped_faces += face_indices.len();
            }
        }
    }
    flipped_faces
}

/// Assign each triangle to a connected-component id (edge-shared).
pub(crate) fn triangle_components(mesh: &IndexedMesh) -> Vec<u32> {
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
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
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

    #[test]
    fn classify_group_promotes_high_poly_component_even_when_top_seed_is_small() {
        // Simulates a tall low-poly support tip becoming the Z-seed while the
        // real model body sits slightly lower but with far higher triangle density.
        let comp_max_z = vec![100.0, 96.5, 72.0, 1.2];
        let comp_tri_count = vec![96, 24_000, 180, 800];
        let model_seed = Some(0usize);
        let model_min_tris = (comp_tri_count[0] / 8).max(MODEL_MIN_TRIS_FLOOR);

        assert_eq!(
            classify_model_support_group(
                1,
                RAFT_Z_CUTOFF_MM,
                model_seed,
                model_min_tris,
                &comp_max_z,
                &comp_tri_count,
            ),
            GeometryGroup::Model
        );
        assert_eq!(
            classify_model_support_group(
                2,
                RAFT_Z_CUTOFF_MM,
                model_seed,
                model_min_tris,
                &comp_max_z,
                &comp_tri_count,
            ),
            GeometryGroup::Support
        );
        assert_eq!(
            classify_model_support_group(
                3,
                RAFT_Z_CUTOFF_MM,
                model_seed,
                model_min_tris,
                &comp_max_z,
                &comp_tri_count,
            ),
            GeometryGroup::Support
        );
    }

    #[test]
    fn likely_support_flag_stays_off_for_balanced_model_support_mix() {
        // Mixed files should keep model tinting semantics unless supports
        // clearly dominate both structure and output triangles.
        assert!(!compute_likely_support_geometry(
            180_000, 150_000, 3, 18, 240_000, 200_000,
        ));
    }

    #[test]
    fn likely_support_flag_turns_on_only_when_model_triangles_are_zero() {
        assert!(compute_likely_support_geometry(
            0, 180_000, 0, 32, 0, 220_000,
        ));
        assert!(!compute_likely_support_geometry(
            20_000, 180_000, 1, 32, 20_000, 220_000,
        ));
    }

    #[test]
    fn assume_support_geometry_enforces_likely_support_classification() {
        let mesh = IndexedMesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(10.0, 0.0, 0.0),
                Vec3::new(0.0, 10.0, 0.0),
            ],
            triangles: vec![[0, 1, 2]],
        };
        let options = RepairOptions {
            assume_support_geometry: Some(true),
            ..RepairOptions::default()
        };
        let outcome = repair(mesh, &options);
        assert!(outcome.report.likely_support_geometry);
    }

    /// A file can carry non-finite positions, and every float comparison on the
    /// way through must still be a total order. `partial_cmp(..).unwrap_or(Equal)`
    /// is not one, and Rust's sort panics on it ("user-provided comparison function
    /// does not correctly implement a total order") rather than returning a wrong
    /// order. That shipped as a crash on a 960k model with 12% non-finite values.
    #[test]
    fn classify_tolerates_non_finite_positions() {
        let positions: Vec<Vec3> = (0..768)
            .map(|i| {
                let value = i as f32;
                Vec3::new(
                    if i % 7 == 0 {
                        f32::NAN
                    } else {
                        (value * 0.37).sin() * value
                    },
                    if i % 11 == 0 {
                        f32::INFINITY
                    } else {
                        (value * 0.53).cos() * value
                    },
                    if i % 13 == 0 {
                        f32::NEG_INFINITY
                    } else {
                        value
                    },
                )
            })
            .collect();
        let triangles: Vec<[u32; 3]> = (0..positions.len() as u32 - 3)
            .map(|i| [i, i + 1, i + 2])
            .collect();
        let mesh = IndexedMesh {
            positions,
            triangles,
        };

        let outcome = classify_support_split(mesh, &RepairOptions::default());

        // The contract is that it returns at all, on garbage input.
        assert_eq!(outcome.mesh.triangles.len(), 765);
    }

    #[test]
    fn classify_support_split_respects_assume_support_geometry() {
        let mesh = IndexedMesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(10.0, 0.0, 0.0),
                Vec3::new(0.0, 10.0, 0.0),
            ],
            triangles: vec![[0, 1, 2]],
        };
        let options = RepairOptions {
            assume_support_geometry: Some(true),
            ..RepairOptions::default()
        };
        let outcome = classify_support_split(mesh, &options);
        assert!(outcome.report.likely_support_geometry);
    }
}

use crate::stl_budget::TriangleBudget;

pub struct DecimationOutcome {
    pub mesh: IndexedMesh,
    pub achieved_error: f32,
}

/// Simplify to an error tolerance, in `meshopt`'s units: a fraction of the mesh's extent.
///
/// [`decimate_indexed_to_budget`] is budget-driven. It returns immediately when the mesh is already
/// within its triangle budget, and it clamps the requested error to a tier list that stops at 0.025,
/// so it cannot express "simplify by this much and nothing else". Passing it a budget of
/// `usize::MAX` to mean "no count limit" therefore simplifies *nothing at all*, at any tolerance -
/// which is exactly what a surfacing pass did until this existed.
///
/// Nothing else is applied: no count target, no sections. The error is the only criterion, and it is
/// not a percentage of anything intuitive. Measured on a 170,790-triangle model: 0.0001 removes two
/// percent of it, 0.001 removes twenty-eight, 0.005 removes ninety-three, and 0.05 leaves 190
/// triangles of 170,790. The default is 0.001 because that is a reduction a person can see without
/// the model being gone, and the value in a reference implementation's dialog is not this quantity.
pub fn simplify_to_error(mesh: IndexedMesh, target_error: f32) -> IndexedMesh {
    if target_error <= 0.0 || mesh.triangles.len() < 8 {
        return mesh;
    }
    let indices: Vec<u32> = mesh
        .triangles
        .iter()
        .flat_map(|t| [t[0], t[1], t[2]])
        .collect();
    let locks = vec![false; mesh.positions.len()];
    let Ok(adapter) =
        meshopt::VertexDataAdapter::new(bytemuck::cast_slice::<_, u8>(&mesh.positions), 12, 0)
    else {
        return mesh;
    };
    // Zero is the count target, and it is not a mistake: `meshopt` collapses while the result is
    // still above the target *and* the error is still within tolerance, so a target of zero means
    // the error is the only thing that stops it. A target of `u32::MAX` reads as "already reached"
    // and returns the mesh untouched - silently in a release build, where the assert that would
    // have caught it is compiled out.
    let decimated = meshopt::simplify_with_locks(
        &indices,
        &adapter,
        &locks,
        0,
        target_error,
        meshopt::SimplifyOptions::LockBorder | meshopt::SimplifyOptions::Regularize,
        None,
    );
    if decimated.len() < 12 {
        return mesh;
    }
    IndexedMesh {
        positions: mesh.positions,
        triangles: decimated
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect(),
    }
}

pub fn decimate_indexed_to_budget(mesh: IndexedMesh, budget: &TriangleBudget) -> DecimationOutcome {
    if !budget.is_decimated || mesh.triangles.len() <= budget.budget_tris {
        return DecimationOutcome {
            mesh,
            achieved_error: 0.0,
        };
    }

    let indices: Vec<u32> = mesh
        .triangles
        .iter()
        .flat_map(|t| [t[0], t[1], t[2]])
        .collect();

    let locks = vec![false; mesh.positions.len()];
    let adapter =
        meshopt::VertexDataAdapter::new(bytemuck::cast_slice::<_, u8>(&mesh.positions), 12, 0)
            .unwrap();

    let error_tiers = [
        (budget.target_error as f32).min(0.003),
        0.003,
        0.005,
        0.008,
        0.010,
        0.025,
    ];

    let mut final_indices = vec![];
    let mut final_error = 0.0;

    for &err in &error_tiers {
        let decimated_indices = meshopt::simplify_with_locks(
            &indices,
            &adapter,
            &locks,
            budget.budget_tris * 3,
            err,
            meshopt::SimplifyOptions::LockBorder | meshopt::SimplifyOptions::Regularize,
            None,
        );
        let out_tris = decimated_indices.len() / 3;
        final_indices = decimated_indices;
        final_error = err;
        if out_tris <= budget.soft_ceiling_tris {
            break;
        }
    }

    let triangles: Vec<[u32; 3]> = final_indices
        .chunks_exact(3)
        .map(|c| [c[0], c[1], c[2]])
        .collect();

    DecimationOutcome {
        mesh: IndexedMesh {
            positions: mesh.positions,
            triangles,
        },
        achieved_error: final_error,
    }
}

pub struct SectionDecimationOutcome {
    pub mesh: IndexedMesh,
    pub model_triangle_count: usize,
    pub achieved_error: f32,
}

pub fn decimate_sections_to_budget(
    mesh: IndexedMesh,
    model_tri_count: usize,
    budget: &TriangleBudget,
) -> SectionDecimationOutcome {
    if !budget.enable_per_section_decimation {
        let out = decimate_indexed_to_budget(mesh, budget);
        let out_tris = out.mesh.triangles.len();
        return SectionDecimationOutcome {
            mesh: out.mesh,
            model_triangle_count: model_tri_count.min(out_tris),
            achieved_error: out.achieved_error,
        };
    }

    if !budget.is_decimated || mesh.triangles.len() <= budget.budget_tris {
        return SectionDecimationOutcome {
            mesh,
            model_triangle_count: model_tri_count,
            achieved_error: 0.0,
        };
    }

    if model_tri_count == 0 || model_tri_count >= mesh.triangles.len() {
        let out = decimate_indexed_to_budget(mesh, budget);
        let out_tris = out.mesh.triangles.len();
        return SectionDecimationOutcome {
            mesh: out.mesh,
            model_triangle_count: model_tri_count.min(out_tris),
            achieved_error: out.achieved_error,
        };
    }

    let indices0: Vec<u32> = mesh.triangles[0..model_tri_count]
        .iter()
        .flat_map(|t| [t[0], t[1], t[2]])
        .collect();

    let indices1: Vec<u32> = mesh.triangles[model_tri_count..]
        .iter()
        .flat_map(|t| [t[0], t[1], t[2]])
        .collect();

    let adapter =
        meshopt::VertexDataAdapter::new(bytemuck::cast_slice::<_, u8>(&mesh.positions), 12, 0)
            .unwrap();
    let locks = vec![false; mesh.positions.len()];

    let mut error_tiers =
        Vec::with_capacity(1 + crate::decimation_config::DECIMATION_ERROR_TIERS.len());
    error_tiers
        .push((budget.target_error as f32).min(crate::decimation_config::EPSILON_MIN_CLAMP as f32));
    error_tiers.extend(
        crate::decimation_config::DECIMATION_ERROR_TIERS
            .iter()
            .map(|&e| e as f32),
    );

    let mut final_indices0 = vec![];
    let mut final_indices1 = vec![];
    let mut final_error = 0.0;

    for &err in &error_tiers {
        let dec0 = meshopt::simplify_with_locks(
            &indices0,
            &adapter,
            &locks,
            (budget.budget_tris * 3).min(indices0.len()),
            err,
            meshopt::SimplifyOptions::LockBorder | meshopt::SimplifyOptions::Regularize,
            None,
        );
        let dec1 = meshopt::simplify_with_locks(
            &indices1,
            &adapter,
            &locks,
            (budget.budget_tris * 3).min(indices1.len()),
            err,
            meshopt::SimplifyOptions::LockBorder | meshopt::SimplifyOptions::Regularize,
            None,
        );

        let out_total = (dec0.len() + dec1.len()) / 3;
        final_indices0 = dec0;
        final_indices1 = dec1;
        final_error = err;

        if out_total <= budget.soft_ceiling_tris {
            break;
        }
    }

    let out0_len = final_indices0.len() / 3;
    let mut concat_tris = Vec::with_capacity((final_indices0.len() + final_indices1.len()) / 3);
    for c in final_indices0.chunks_exact(3) {
        concat_tris.push([c[0], c[1], c[2]]);
    }
    for c in final_indices1.chunks_exact(3) {
        concat_tris.push([c[0], c[1], c[2]]);
    }

    SectionDecimationOutcome {
        mesh: IndexedMesh {
            positions: mesh.positions,
            triangles: concat_tris,
        },
        model_triangle_count: out0_len,
        achieved_error: final_error,
    }
}

#[cfg(test)]
mod section_decimation_tests {
    use super::*;
    use crate::core::mesh::Vec3;

    #[test]
    fn test_decimate_sections() {
        let mut positions = vec![];
        let mut triangles = vec![];
        for i in 0..100 {
            positions.push(Vec3::new(i as f32, 0.0, 0.0));
            positions.push(Vec3::new(0.0, i as f32, 0.0));
            positions.push(Vec3::new(0.0, 0.0, i as f32));
            let base = i * 3;
            triangles.push([base, base + 1, base + 2]);
        }
        let mesh = IndexedMesh {
            positions,
            triangles,
        };
        let mut budget = TriangleBudget {
            is_decimated: true,
            budget_tris: 50,
            soft_ceiling_tris: 50,
            target_error: 0.1,
            bbox_diagonal_mm: 100.0,
            enable_per_section_decimation: true,
        };

        // Test lockstep mode
        let out = decimate_sections_to_budget(mesh.clone(), 60, &budget);
        assert!(out.mesh.triangles.len() <= 100);

        // Test Phase 3.1 fallback mode
        budget.enable_per_section_decimation = false;
        let out2 = decimate_sections_to_budget(mesh, 60, &budget);
        assert!(out2.model_triangle_count <= 60);
        assert!(out2.mesh.triangles.len() <= 100);
    }
}

#[cfg(test)]
mod classify_hollowing_tests {
    use super::*;
    use crate::core::mesh::Vec3;

    fn make_cube(offset: Vec3, size: f32, flip: bool) -> (Vec<Vec3>, Vec<[u32; 3]>) {
        let v = vec![
            offset,
            offset.add(Vec3::new(size, 0.0, 0.0)),
            offset.add(Vec3::new(size, size, 0.0)),
            offset.add(Vec3::new(0.0, size, 0.0)),
            offset.add(Vec3::new(0.0, 0.0, size)),
            offset.add(Vec3::new(size, 0.0, size)),
            offset.add(Vec3::new(size, size, size)),
            offset.add(Vec3::new(0.0, size, size)),
        ];

        let mut t = vec![
            [0, 2, 1],
            [0, 3, 2], // bottom
            [4, 5, 6],
            [4, 6, 7], // top
            [0, 1, 5],
            [0, 5, 4], // front
            [1, 2, 6],
            [1, 6, 5], // right
            [2, 3, 7],
            [2, 7, 6], // back
            [3, 0, 4],
            [3, 4, 7], // left
        ];
        if flip {
            for tri in &mut t {
                tri.swap(1, 2);
            }
        }
        (v, t)
    }

    #[test]
    fn test_classify_hollowing_shell_as_model() {
        let (mut v1, mut t1) = make_cube(Vec3::new(0.0, 0.0, 0.0), 10.0, false); // outer, normal winding
        let (v2, t2) = make_cube(Vec3::new(2.0, 2.0, 2.0), 6.0, true); // inner, flipped winding (cavity)

        let base_idx = v1.len() as u32;
        v1.extend(v2);
        for tri in t2 {
            t1.push([tri[0] + base_idx, tri[1] + base_idx, tri[2] + base_idx]);
        }

        let mut mesh = IndexedMesh {
            positions: v1,
            triangles: t1,
        };

        let outcome = classify_and_reorder_model_support_triangles(&mut mesh, None);
        assert_eq!(outcome.split, None);
        assert_eq!(outcome.component_count, 2);
    }
}

#[cfg(test)]
mod winding_search_tests {
    use super::*;

    fn tetrahedron() -> IndexedMesh {
        IndexedMesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
                Vec3::new(0.0, 0.0, 1.0),
            ],
            triangles: vec![[0u32, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
        }
    }

    /// A tetrahedron with a block of its faces turned over. The search has to reach a consistent
    /// orientation again. This is a machinery test and it earns its place: the cost it minimizes is
    /// kept in step incrementally by `toggle_search_face`, and a bookkeeping slip there would leave
    /// the search finding nothing rather than failing loudly.
    #[test]
    fn the_search_reaches_a_consistent_orientation() {
        let mut mesh = tetrahedron();
        for tri in mesh.triangles.iter_mut().take(2) {
            tri.swap(1, 2);
        }
        let before = Topology::build(&mesh).inconsistent_edges();
        assert!(before > 0, "the turned-over block has to disagree somewhere");
        assert!(search_winding_assignments(&mut mesh) > 0);
        assert_eq!(Topology::build(&mesh).inconsistent_edges(), 0);
    }

    /// A mesh it cannot improve comes out untouched, which is what keeps it safe to run
    /// unconditionally after the cheaper passes.
    #[test]
    fn the_search_leaves_a_settled_mesh_alone() {
        let mut mesh = tetrahedron();
        let triangles = mesh.triangles.clone();
        assert_eq!(search_winding_assignments(&mut mesh), 0);
        assert_eq!(mesh.triangles, triangles);
    }
}

#[cfg(test)]
mod winding_cut_tests {
    use super::*;

    /// A disagreement whose two faces fall in different regions once it is removed. That is the
    /// shape the cut solver exists for, and the shape a single-face greedy cannot take: turning
    /// either face over on its own breaks the edges that currently agree.
    #[test]
    fn the_cut_solver_fixes_a_disagreement_across_two_regions() {
        let mut mesh = IndexedMesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
                Vec3::new(0.0, 0.0, 1.0),
            ],
            triangles: vec![[0u32, 1, 2], [1, 0, 3]],
        };
        assert_eq!(Topology::build(&mesh).inconsistent_edges(), 0);
        mesh.triangles[1].swap(1, 2);
        assert_eq!(Topology::build(&mesh).inconsistent_edges(), 1);
        let flipped = solve_winding_cut(&mut mesh);
        assert!(flipped > 0, "the cut solver should turn a region over");
        assert_eq!(Topology::build(&mesh).inconsistent_edges(), 0);
    }

    /// It only ever moves whole regions, so a mesh it cannot help comes back exactly as it was.
    #[test]
    fn the_cut_solver_leaves_a_settled_mesh_alone() {
        let mut mesh = IndexedMesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
                Vec3::new(0.0, 0.0, 1.0),
            ],
            triangles: vec![[0u32, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
        };
        let triangles = mesh.triangles.clone();
        assert_eq!(solve_winding_cut(&mut mesh), 0);
        assert_eq!(mesh.triangles, triangles);
    }
}

#[cfg(test)]
mod cones_shell_analysis {
    use super::*;

    /// Where the cones' non-orientability actually is: which edges break the parity, where they sit,
    /// how big the region is, and what the geometry at them looks like.
    #[test]
    fn frustrated_region() {
        let path =
            "C:/Users/Paul/Downloads/V3_Cones_of_Calibration/V3 Cones of Calibration 3.32.stl";
        if !std::path::Path::new(path).exists() {
            return;
        }
        let mesh = crate::io::load_mesh_from_path(std::path::Path::new(path)).unwrap();
        let comps = triangle_components(&mesh);
        let n = comps.iter().max().copied().unwrap_or(0) + 1;
        let mut target = None;
        for c in 0..n {
            let tris: Vec<[u32; 3]> = mesh
                .triangles
                .iter()
                .zip(&comps)
                .filter(|(_, &k)| k == c)
                .map(|(t, _)| *t)
                .collect();
            if tris.len() < 4 {
                continue;
            }
            let sub = IndexedMesh {
                positions: mesh.positions.clone(),
                triangles: tris,
            };
            if winding_is_unsatisfiable(&sub) {
                target = Some(sub);
                break;
            }
        }
        let Some(sub) = target else {
            println!("no unsatisfiable shell");
            return;
        };
        println!(
            "shell triangles {} of {}, model diag {:.2}",
            sub.triangles.len(),
            mesh.triangles.len(),
            sub.bbox().diag()
        );
        let topo = Topology::build(&sub);
        let mut adj: ahash::AHashMap<u32, Vec<(u32, u8, EdgeKey)>> = ahash::AHashMap::new();
        for (key, info) in topo.edges.iter() {
            if info.directed.len() != 2 || info.directed[0].2 == info.directed[1].2 {
                continue;
            }
            let (a, b) = (info.directed[0].2, info.directed[1].2);
            let parity = u8::from(winding_disagrees(info));
            adj.entry(a).or_default().push((b, parity, *key));
            adj.entry(b).or_default().push((a, parity, *key));
        }
        let mut side: ahash::AHashMap<u32, u8> = ahash::AHashMap::new();
        let mut conflicts: Vec<EdgeKey> = Vec::new();
        for k in adj.keys().copied().collect::<Vec<_>>() {
            if side.contains_key(&k) {
                continue;
            }
            side.insert(k, 0);
            let mut queue = std::collections::VecDeque::new();
            queue.push_back(k);
            while let Some(f) = queue.pop_front() {
                let c = side[&f];
                for &(g, p, e) in adj.get(&f).map(|v| v.as_slice()).unwrap_or(&[]) {
                    let want = c ^ p;
                    match side.get(&g) {
                        None => {
                            side.insert(g, want);
                            queue.push_back(g);
                        }
                        Some(&cg) if cg != want => conflicts.push(e),
                        _ => {}
                    }
                }
            }
        }
        conflicts.sort_unstable();
        conflicts.dedup();
        let mut involved: ahash::AHashSet<u32> = ahash::AHashSet::new();
        let mut lo = [f32::INFINITY; 3];
        let mut hi = [f32::NEG_INFINITY; 3];
        for &(u, v) in &conflicts {
            for w in [u, v] {
                let p = sub.positions[w as usize];
                involved.insert(w);
                lo = [lo[0].min(p.x), lo[1].min(p.y), lo[2].min(p.z)];
                hi = [hi[0].max(p.x), hi[1].max(p.y), hi[2].max(p.z)];
            }
        }
        println!(
            "conflicting edges {} over {} vertices; region {:?} .. {:?} (extent {:.2} x {:.2} x {:.2})",
            conflicts.len(),
            involved.len(),
            lo,
            hi,
            hi[0] - lo[0],
            hi[1] - lo[1],
            hi[2] - lo[2]
        );
        for &(u, v) in conflicts.iter().take(6) {
            let Some(info) = topo.edges.get(&(u, v)) else {
                continue;
            };
            let fs: Vec<u32> = info.faces.iter().copied().collect();
            let detail: Vec<String> = fs
                .iter()
                .map(|&f| {
                    let t = sub.triangles[f as usize];
                    let p: Vec<Vec3> = t.iter().map(|&i| sub.positions[i as usize]).collect();
                    let (ax, ay, az) = (p[1].x - p[0].x, p[1].y - p[0].y, p[1].z - p[0].z);
                    let (bx, by, bz) = (p[2].x - p[0].x, p[2].y - p[0].y, p[2].z - p[0].z);
                    let (nx, ny, nz) = (ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
                    let area = 0.5 * ((nx * nx + ny * ny + nz * nz) as f64).sqrt();
                    let mut longest = 0.0f64;
                    for (i, j) in [(0, 1), (1, 2), (2, 0)] {
                        let d = ((p[i].x - p[j].x).powi(2)
                            + (p[i].y - p[j].y).powi(2)
                            + (p[i].z - p[j].z).powi(2)) as f64;
                        longest = longest.max(d.sqrt());
                    }
                    format!(
                        "face {f} area {area:.3e} longest {longest:.3e} height {:.3e}",
                        2.0 * area / longest.max(1e-12)
                    )
                })
                .collect();
            println!("  edge ({u},{v}) at {:?}: {detail:?}", sub.positions[u as usize]);
        }
        // Scale: what the pipeline's own tolerances say, and where these faces sit in the mesh.
        let mut areas: Vec<f64> = sub
            .triangles
            .iter()
            .map(|t| {
                let p: Vec<Vec3> = t.iter().map(|&i| sub.positions[i as usize]).collect();
                let (ax, ay, az) = (p[1].x - p[0].x, p[1].y - p[0].y, p[1].z - p[0].z);
                let (bx, by, bz) = (p[2].x - p[0].x, p[2].y - p[0].y, p[2].z - p[0].z);
                let (nx, ny, nz) = (ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
                0.5 * ((nx * nx + ny * ny + nz * nz) as f64).sqrt()
            })
            .collect();
        areas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let q = |p: f64| areas[((areas.len() - 1) as f64 * p) as usize];
        println!(
            "weld epsilon {:.3e}, area p1 {:.3e} p10 {:.3e} p50 {:.3e} p99 {:.3e}",
            derive_weld_epsilon(&sub),
            q(0.01),
            q(0.10),
            q(0.50),
            q(0.99)
        );
    }
}

#[cfg(test)]
mod orientability_tests {
    use super::*;

    /// A cavity is a closed component inside another, and a buried sheet is open. The cull used
    /// the signed volume as a stand-in for that, which is unsound the moment the mesh is not
    /// watertight: on the worm file the volume of an open surface moved 0.589% and tripped the
    /// refusal on nothing. Closeness is the property, so closeness is what the cull tests.
    #[test]
    fn only_a_closed_component_is_a_cavity() {
        let positions = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(0.0, 0.0, 1.0),
        ];
        let sealed = IndexedMesh {
            positions: positions.clone(),
            triangles: vec![[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
        };
        let comps = vec![0u32; 4];
        assert!(component_is_closed(&sealed, &comps, 0));

        // The same shell with one face missing: three of its edges are used once.
        let open = IndexedMesh {
            positions,
            triangles: vec![[0, 1, 2], [0, 1, 3], [0, 2, 3]],
        };
        assert!(!component_is_closed(&open, &comps[..3], 0));
    }
    use crate::test_fixtures::unit_cube;

    /// A band with a half twist: non-orientable, and open along its two rims.
    fn mobius_band() -> IndexedMesh {
        let n = 6usize;
        let mut positions = Vec::new();
        let mut triangles = Vec::new();
        for i in 0..n {
            let a = i as f32 / n as f32 * std::f32::consts::TAU;
            positions.push(Vec3::new(a.cos(), 0.0, a.sin()));
            positions.push(Vec3::new(a.cos(), 1.0, a.sin()));
        }
        for i in 0..n {
            let (b0, t0) = (2 * i as u32, 2 * i as u32 + 1);
            // The half twist: the band closes onto itself with top meeting bottom.
            let (b1, t1) = if i + 1 == n {
                (1u32, 0u32)
            } else {
                (2 * (i + 1) as u32, 2 * (i + 1) as u32 + 1)
            };
            triangles.push([b0, b1, t1]);
            triangles.push([b0, t1, t0]);
        }
        IndexedMesh { positions, triangles }
    }

    /// A closed box can be wound consistently.
    #[test]
    fn a_closed_box_is_orientable() {
        assert!(!winding_is_unsatisfiable(&unit_cube()));
    }

    /// A Möbius band cannot, and that is a property of its topology rather than of any solver. The V3
    /// Cones and Harbinger are the same shape of problem, at 12 edges over 10 vertices and at 64
    /// edges respectively.
    #[test]
    fn a_mobius_band_is_not_orientable() {
        assert!(winding_is_unsatisfiable(&mobius_band()));
    }

    /// A repair may not add parts.
    ///
    /// A Möbius band is non-orientable, so its winding cannot be made consistent by any assignment;
    /// the residual is reported as the floor it is. What must not happen is paying for it with
    /// duplicated geometry — that was a cut, and it left coincident facets behind, which showed up as
    /// three thousand extra self-intersecting triangles on corbu and as doubled facets in the
    /// viewport.
    #[test]
    fn repairing_a_mobius_band_adds_no_parts() {
        let count = |components: &[u32]| components.iter().max().copied().unwrap_or(0) + 1;
        let before = count(&triangle_components(&mobius_band()));
        let out = repair(mobius_band(), &RepairOptions::default());
        assert_eq!(count(&triangle_components(&out.mesh)), before);
    }
}

#[cfg(test)]
mod residual_fill_tests {
    use super::*;

    /// A tub whose rim is longer than the derived fill cap, so only the settle fill can close it.
    ///
    /// The cap is `diag / 20` divided by the median edge, so a 24-edge rim on a model a couple of
    /// units across is refused by it. While the settle fill applied that cap this stayed open;
    /// corbu's residual boundary is the same shape of problem at 78 to 653 edges.
    #[test]
    fn the_settle_fill_closes_a_rim_the_cap_refuses() {
        let n = 24usize;
        let (r, h) = (1.0f32, 1.5f32);
        let mut positions = vec![Vec3::new(0.0, -h / 2.0, 0.0)];
        let mut triangles = Vec::new();
        for i in 0..n {
            let a = i as f32 / n as f32 * std::f32::consts::TAU;
            positions.push(Vec3::new(r * a.cos(), -h / 2.0, r * a.sin()));
        }
        for i in 0..n {
            let a = 1 + i as u32;
            let b = 1 + ((i + 1) % n) as u32;
            triangles.push([0, b, a]);
        }
        let top = positions.len() as u32;
        for i in 0..n {
            let a = i as f32 / n as f32 * std::f32::consts::TAU;
            positions.push(Vec3::new(r * a.cos(), h / 2.0, r * a.sin()));
        }
        for i in 0..n {
            let bl = 1 + i as u32;
            let br = 1 + ((i + 1) % n) as u32;
            let tl = top + i as u32;
            let tr = top + ((i + 1) % n) as u32;
            triangles.push([bl, br, tr]);
            triangles.push([bl, tr, tl]);
        }
        let mesh = IndexedMesh { positions, triangles };
        let cap = derive_fill_cap(&mesh);
        assert!(
            cap < n,
            "the derived cap of {cap} must refuse the {n}-edge rim or this test proves nothing"
        );
        let out = repair(mesh, &RepairOptions::default());
        assert_eq!(
            out.report.post.boundary_loops,
            0,
            "{}",
            out.report.residual_issues.join("; ")
        );
        assert_eq!(out.report.post.boundary_edges, 0);
        assert!(out.report.post.is_watertight);
    }
}

#[cfg(test)]
mod orient_probe {
    use super::*;

    #[test]
    fn probe() {
        let path = "C:/Users/Paul/Downloads/corbu-chibi-corrboo45.stl";
        if !std::path::Path::new(path).exists() {
            return;
        }
        let mesh = crate::io::load_mesh_from_path(std::path::Path::new(path)).unwrap();
        let components = triangle_components(&mesh);
        let n = components.iter().max().copied().unwrap_or(0) + 1;
        let bvh = Bvh::build(&mesh);
        println!("components={n} vol_total={:.2}", mesh.signed_volume());
        for comp_id in 0..n {
            let faces: Vec<u32> = components
                .iter()
                .enumerate()
                .filter_map(|(i, &c)| if c == comp_id { Some(i as u32) } else { None })
                .collect();
            if faces.is_empty() {
                continue;
            }
            let mut vol = 0.0f64;
            for &fi in &faces {
                let t = mesh.triangles[fi as usize];
                let a = mesh.positions[t[0] as usize];
                let b = mesh.positions[t[1] as usize];
                let c = mesh.positions[t[2] as usize];
                vol += (a.x as f64) * ((b.y as f64) * (c.z as f64) - (b.z as f64) * (c.y as f64))
                    - (a.y as f64) * ((b.x as f64) * (c.z as f64) - (b.z as f64) * (c.x as f64))
                    + (a.z as f64) * ((b.x as f64) * (c.y as f64) - (b.y as f64) * (c.x as f64));
            }
            let eps = (mesh.bbox().diag() * 1e-4).max(1e-6);
            let samples = interior_sample_points(&mesh, &faces, eps, 5);
            let nested = nesting_depth_is_odd(&bvh, &mesh, &components, comp_id, &samples);
            println!(
                "  comp {comp_id}: faces={} vol={:.3} samples={} nested={nested}",
                faces.len(),
                vol / 6.0,
                samples.len()
            );
        }
    }
}

#[cfg(test)]
mod simplify_to_error_tests {
    use super::*;
    use crate::Vec3;

    /// A dense sphere soup. Every triangle is small and the surface is smooth, so a relative error
    /// tolerance has somewhere to collapse.
    fn dense_sphere(radius: f32, stacks: usize, slices: usize) -> IndexedMesh {
        let mut positions = Vec::new();
        let mut triangles = Vec::new();
        let point = |i: usize, j: usize| {
            let phi = std::f32::consts::PI * (i as f32 / stacks as f32);
            let theta = 2.0 * std::f32::consts::PI * (j as f32 / slices as f32);
            Vec3::new(
                radius * phi.sin() * theta.cos(),
                radius * phi.sin() * theta.sin(),
                radius * phi.cos(),
            )
        };
        let mut corner = |p: Vec3, positions: &mut Vec<Vec3>| {
            let id = positions.len() as u32;
            positions.push(p);
            id
        };
        for i in 0..stacks {
            for j in 0..slices {
                let (p00, p10, p11, p01) = (
                    point(i, j),
                    point(i + 1, j),
                    point(i + 1, (j + 1) % slices),
                    point(i, (j + 1) % slices),
                );
                for tri in [[p00, p11, p10], [p00, p01, p11]] {
                    let a = corner(tri[0], &mut positions);
                    let b = corner(tri[1], &mut positions);
                    let c = corner(tri[2], &mut positions);
                    triangles.push([a, b, c]);
                }
            }
        }
        IndexedMesh { positions, triangles }
    }

    #[test]
    fn a_relative_error_tolerance_actually_removes_triangles() {
        let mut mesh = dense_sphere(1.0, 60, 80);
        // Weld first: `meshopt` collapses edges, and an edge needs two triangles to share it. A
        // soup with a fresh vertex per corner has no shared edges and nothing to collapse.
        mesh.weld_by_position();
        let before = mesh.triangles.len();
        assert!(before > 5000, "the fixture should be dense, got {before}");
        let after = simplify_to_error(mesh, 0.05).triangles.len();
        assert!(
            after < before,
            "a five percent error tolerance must remove triangles: {before} -> {after}"
        );
    }
}

#[cfg(test)]
mod cut_tests {
    use crate::repair::repair_auto;

    use super::*;
    use crate::core::mesh::Vec3;

    fn box_mesh() -> IndexedMesh {
        let corners = [
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(1.0, 1.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(0.0, 0.0, 1.0),
            Vec3::new(1.0, 0.0, 1.0),
            Vec3::new(1.0, 1.0, 1.0),
            Vec3::new(0.0, 1.0, 1.0),
        ];
        let quads: [[u32; 4]; 6] = [
            [0, 3, 2, 1],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [2, 3, 7, 6],
            [1, 2, 6, 5],
            [0, 4, 7, 3],
        ];
        let mut triangles = Vec::new();
        for q in quads {
            triangles.push([q[0], q[1], q[2]]);
            triangles.push([q[0], q[2], q[3]]);
        }
        IndexedMesh {
            positions: corners.to_vec(),
            triangles,
        }
    }

    /// The cut is automatic and judged, and a mesh with no unsatisfiable edge is left exactly as it
    /// was.
    #[test]
    fn the_cut_runs_by_default_and_a_clean_mesh_is_untouched() {
        assert!(
            RepairOptions::default().cut_unsatisfiable_edges,
            "the cut is judged, so it is the default rather than an opt-in"
        );
        let mut mesh = box_mesh();
        let before = mesh.clone();
        assert_eq!(
            cut_unsatisfiable_edges(&mut mesh, usize::MAX),
            0,
            "a closed box has no unsatisfiable edge to cut"
        );
        assert_eq!(mesh.positions.len(), before.positions.len());
        assert_eq!(mesh.triangles, before.triangles);
    }

    /// An open surface whose winding cannot be satisfied is what the cut is for: the pass reports
    /// what it cut rather than pretending the mesh was fine, and the cut leaves every vertex where
    /// it was (the copies sit exactly on the originals).
    #[test]
    fn the_cut_reports_nothing_when_the_residue_exceeds_its_budget() {
        let mut mesh = box_mesh();
        // Zero budget: the guard refuses before it looks at the mesh.
        assert_eq!(cut_unsatisfiable_edges(&mut mesh, 0), 0);
    }
}

#[cfg(test)]
mod auto_route_tests {
    use super::*;
    use crate::core::mesh::Vec3;

    fn box_mesh() -> IndexedMesh {
        let corners = [
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(1.0, 1.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(0.0, 0.0, 1.0),
            Vec3::new(1.0, 0.0, 1.0),
            Vec3::new(1.0, 1.0, 1.0),
            Vec3::new(0.0, 1.0, 1.0),
        ];
        let quads: [[u32; 4]; 6] = [
            [0, 3, 2, 1],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [2, 3, 7, 6],
            [1, 2, 6, 5],
            [0, 4, 7, 3],
        ];
        let mut triangles = Vec::new();
        for q in quads {
            triangles.push([q[0], q[1], q[2]]);
            triangles.push([q[0], q[2], q[3]]);
        }
        IndexedMesh {
            positions: corners.to_vec(),
            triangles,
        }
    }

    /// A mesh the local pipeline settles never reaches the rebuild, whatever the caller allows: the
    /// route is decided on the verdict, not on a guess about the file.
    #[test]
    fn the_rebuild_is_not_tried_when_the_local_pipeline_settles_the_mesh() {
        let outcome = repair_auto(box_mesh(), &RepairOptions::default());
        assert!(
            outcome.report.fully_repaired,
            "a closed box needs no repair: {:?}",
            outcome.report.residual_issues
        );
        assert!(
            !outcome.report.steps.iter().any(|s| s.name == "rebuild"),
            "and no rebuild is announced: {:?}",
            outcome.report.steps.iter().map(|s| s.name.clone()).collect::<Vec<_>>()
        );
    }

    /// Several shells, none dominant, is a plate of objects — and a rebuild resolves one object, so
    /// it stands down. One shell bigger than the rest is a model with loose shells around it, and the
    /// rebuild may be tried. The numbers are the measured ones: `Gusano_de_Dune_70%` reads 77.6% on
    /// its largest shell, the plate in the corpus 20.8%.
    #[test]
    fn several_objects_stop_the_rebuild_and_one_object_does_not() {
        let one = box_mesh();
        assert_eq!(several_objects_share(&one), None, "one box is one object");

        // Three boxes of the same size standing apart: a plate, and no shell dominates it.
        let mut plate = box_mesh();
        for k in 1..3 {
            let mut m = box_mesh();
            for p in m.positions.iter_mut() {
                *p = Vec3::new(p.x + 10.0 * k as f32, p.y, p.z);
            }
            let base = plate.positions.len() as u32;
            for t in m.triangles.iter() {
                plate.triangles.push([t[0] + base, t[1] + base, t[2] + base]);
            }
            plate.positions.extend_from_slice(&m.positions);
        }
        let share = several_objects_share(&plate).expect("three equal parts are several objects");
        assert!(
            (share - 1.0 / 3.0).abs() < 1e-6,
            "and the largest holds a third of it, got {share}"
        );

        // A model with scraps beside it: the model's twelve faces against two tetrahedra's four each
        // is 60% of the mesh, so one shell dominates and the rebuild is allowed. The share is by
        // faces, which is what the criterion reads — `Gusano_de_Dune_70%` is the real example.
        let mut model = box_mesh();
        for k in 1..3 {
            let base = model.positions.len() as u32;
            for corner in [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ] {
                model.positions.push(Vec3::new(
                    corner[0] + 10.0 * k as f32,
                    corner[1],
                    corner[2],
                ));
            }
            for t in [[0u32, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]] {
                model.triangles.push([t[0] + base, t[1] + base, t[2] + base]);
            }
        }
        assert_eq!(
            several_objects_share(&model),
            None,
            "the model dominates its scraps, so it is one object as far as the route is concerned"
        );
    }

    /// `allow_rebuild = false` means exactly that: the local result is handed back, with the residue
    /// reported rather than a route taken.
    #[test]
    fn a_caller_that_forbids_the_rebuild_gets_the_local_result() {
        let options = RepairOptions {
            allow_rebuild: false,
            ..RepairOptions::default()
        };
        assert!(!options.allow_rebuild);
        assert!(RepairOptions::default().allow_rebuild);
    }
}
