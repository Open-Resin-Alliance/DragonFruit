//! DragonFruit organic cut.
//!
//! The "cut tool" feature: split a mesh along a user-drawn surface seam. A
//! geodesic loop is traced over the surface ([`geodesic`]), a soap-film membrane
//! is spanned across it and thickened into a razor-thin cutter ([`membrane`]),
//! and the model is differenced into two mating parts ([`organic_cut`]). A flat
//! plane cut is the fallback when the contour membrane can't sever the body.
//!
//! Built on the shared `dragonfruit-mesh-core` primitives. The membrane / contour
//! cut require the `manifold` feature (the `manifold-csg` boolean backend); the
//! geodesic seam and the plane-cut fallback work without it.

pub mod geodesic;
#[cfg(feature = "manifold")]
pub mod key;
#[cfg(feature = "manifold")]
pub mod membrane;
pub mod organic_cut;

pub use crate::geodesic::{surface_loop_from_mesh, surface_loop_positions, GeodesicSolver};
#[cfg(feature = "manifold")]
pub use crate::key::{
    apply_key, build_key_preview_soup, KeyKind, KeyOutcome, KeyShape, DEFAULT_KEY_DEPTH_MM,
    DEFAULT_KEY_TOLERANCE_MM, DEFAULT_KEY_WIDTH_MM,
};
pub use crate::organic_cut::{
    organic_cut, OrganicCutLoopPoint, OrganicCutOptions, OrganicCutOutcome, OrganicCutReport,
    OrganicCutSpec,
};
