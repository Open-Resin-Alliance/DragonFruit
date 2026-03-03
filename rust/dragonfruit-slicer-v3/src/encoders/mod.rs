//! Output container encoders for V3.
//!
//! The slicer core produces per-layer PNG bytes and metadata; concrete
//! file/container formats are encoded through this trait.

#[path = "../../../../plugins/athena/slicing/rust/encoder_impl.rs"]
pub mod athena_plugin;
pub mod registry;

use crate::engine::SlicerV3Error;
use crate::types::SliceJobV3;

/// Trait implemented by concrete output format encoders.
pub trait FormatEncoder: Send + Sync {
    /// Canonical output extension handled by this encoder.
    fn output_format(&self) -> &'static str;

    /// Encode final archive/container bytes from rendered layer PNGs.
    fn encode_container(
        &self,
        job: &SliceJobV3,
        layer_pngs: &[Vec<u8>],
    ) -> Result<Vec<u8>, SlicerV3Error>;
}
