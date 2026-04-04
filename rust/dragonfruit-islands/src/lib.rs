//! Island detection module — identifies unsupported regions in 3D printed models.
//!
//! ## DDD Structure
//! - `model`    — Core domain types (Value Objects, Entities)
//! - `rle`      — RLE Domain Service (stateless mask algebra)
//! - `scan`     — Per-layer scan Domain Service
//! - `tracker`  — IslandTracker Aggregate Root
//! - `pipeline` — Application Service (orchestration)
//! - `rasterize` — Triangle-to-RLE rasterization

pub mod geometry;
pub mod model;
pub mod pipeline;
pub mod rasterize;
pub mod rle;
pub mod scan;
pub mod tracker;
