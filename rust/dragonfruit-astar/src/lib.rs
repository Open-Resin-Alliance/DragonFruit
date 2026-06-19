//! Rust-native 26-connected grid A* pathfinder for support shaft routing.
//!
//! Uses the pre-computed sparse signed distance field from `dragonfruit-sdf`
//! for O(1) collision queries.  The SDF grid must already be loaded into
//! memory (see `dragonfruit_sdf::SparseSdfGrid`).
//!
//! ## Architecture
//!
//! - `types`  — shared data types (Vec3, AStarOptions, AStarResult)
//! - `indexed_heap` — indexed binary min-heap for the A* open set
//! - `grid_astar` — the core A* loop

pub mod grid_astar;
pub mod indexed_heap;
pub mod types;

pub use grid_astar::run_astar;
pub use types::*;
