//! DragonFruit organic cut.
//!
//! The "cut tool" feature: split a mesh along a user-drawn surface seam. A geodesic
//! loop is traced over the surface ([`geodesic`]), the skin is cut along it so the
//! seam becomes mesh edges ([`surface_split`]), and each piece the surface falls into
//! is closed with a soap-film lid sewn to those very edges ([`surface_cap`]). No
//! cutter, no kerf: the two halves share their cut face and mate exactly.
//!
//! Behind that stands the older wafer cut — the same membrane ([`membrane`])
//! thickened into a razor-thin slab and differenced out — for the meshes the surface
//! cut cannot take, chiefly ones whose skin has holes a flood fill leaks through.
//! [`organic_cut`] tries them in that order, and [`surface_cut`] explains a seam that
//! neither could use. A flat plane cut is a separate mode, never a fallback: a plane
//! fitted to the same loop is infinite and would slice clean across the body.
//! See `docs/adr/0002-cut-the-surface-not-a-volume.md`.
//!
//! Built on the shared `dragonfruit-mesh-core` primitives. The membrane / contour
//! cut require the `manifold` feature (the `manifold-csg` boolean backend); the
//! geodesic seam and the plane-cut fallback work without it.

pub mod geodesic;
#[cfg(feature = "manifold")]
pub mod tenon;
#[cfg(feature = "manifold")]
pub mod membrane;
/// Ask the surface whether a cut could ever work, to explain one that did not.
#[cfg(feature = "manifold")]
pub mod surface_cut;
/// Cut the surface along the seam so the seam becomes mesh edges.
#[cfg(feature = "manifold")]
pub mod surface_split;
/// Close each piece of a surface cut with the membrane as its lid.
#[cfg(feature = "manifold")]
pub mod surface_cap;
pub mod organic_cut;

pub use crate::geodesic::{surface_loop_from_mesh, surface_loop_positions, GeodesicSolver};
#[cfg(feature = "manifold")]
pub use crate::tenon::{
    apply_tenon, apply_tenon_at_frame, build_tenon_preview_at_frame, build_tenon_preview_soup,
    frame_from_plane, TenonFrame, TenonFrameInfo, TenonKind, TenonAnchor, TenonOutcome, TenonPreview,
    TenonShape,
    TenonTilt,
    DEFAULT_TENON_DEPTH_MM, DEFAULT_TENON_TOLERANCE_MM, DEFAULT_TENON_WIDTH_MM, TENON_MAX_TILT_RAD,
};
pub use crate::organic_cut::{
    organic_cut, OrganicCutLoopPoint, OrganicCutOptions, OrganicCutOutcome, OrganicCutReport,
    OrganicCutSpec,
};
