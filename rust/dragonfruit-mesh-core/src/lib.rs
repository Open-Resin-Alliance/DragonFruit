//! DragonFruit shared mesh primitives.
//!
//! The dependency-light foundation used by both `dragonfruit-mesh-repair` and
//! `dragonfruit-organic-cut`: the indexed triangle mesh + vector math
//! ([`mesh`]), a BVH for spatial queries ([`bvh`]), half-edge topology
//! ([`halfedge`]), and the per-vertex ambient-occlusion bake
//! ([`vertex_occlusion`]). Kept free of higher-level operations so it can be shared
//! without pulling in repair/cut logic.

pub mod vertex_occlusion;
pub mod bvh;
pub mod halfedge;
pub mod normals;
pub mod refine;
pub mod mesh;
