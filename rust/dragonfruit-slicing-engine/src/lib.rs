#![recursion_limit = "256"]

//! DragonFruit Slicer V3 (clean-room crate)
//!
//! This crate is the active native slicer backend for DragonFruit Desktop.
//! It exposes a typed job API plus an end-to-end format-dispatched slicing entrypoint.

pub mod benchmark;
pub mod encode;
pub mod encoders;
pub mod engine;
pub mod geometry;
pub mod index;
pub mod metrics;
pub mod pipeline;
pub mod raster;
pub mod rle;
pub mod types;

pub use engine::{slice_with_progress_v3, SlicerV3Error};
pub use metrics::SlicingPerfV3;
pub use types::{ProgressCallbackV3, SliceArtifactV3, SliceJobV3};
