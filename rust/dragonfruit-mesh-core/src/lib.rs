//! DragonFruit shared mesh primitives.
//!
//! The dependency-light foundation used by both `dragonfruit-mesh-repair` and
//! `dragonfruit-organic-cut`: the indexed triangle mesh + vector math
//! ([`mesh`]), a BVH for spatial queries ([`bvh`]), and half-edge topology
//! ([`halfedge`]). Kept free of higher-level operations so it can be shared
//! without pulling in repair/cut logic.

pub mod bvh;
pub mod halfedge;
pub mod mesh;
