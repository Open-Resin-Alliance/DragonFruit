//! Scalar geometry preparation for independent binary scanline streams.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::geometry::Triangle;
use crate::raster::{push_segment_for_triangle_at_z, Segment};
use crate::{SliceJobV3, SlicerV3Error};

pub(crate) struct LayerSegments {
    pub(crate) layer_index: u32,
    pub(crate) model_candidates: usize,
    pub(crate) model: Vec<Segment>,
    pub(crate) support: Option<Vec<Segment>>,
}

/// Preserve candidate order and original scalar intersection/preallocation math.
pub(crate) fn prepare_layer(
    job: &SliceJobV3, triangles: &[Triangle], candidates: &[usize], layer_index: u32,
    support_split: Option<usize>, cancel: Option<&AtomicBool>,
) -> Result<LayerSegments, SlicerV3Error> {
    let model_candidates = match support_split {
        Some(split) => candidates.iter().filter(|&&candidate| candidate < split).count(),
        None => candidates.len(),
    };
    let support_candidates = candidates.len() - model_candidates;
    let mut layer = LayerSegments {
        layer_index, model_candidates, model: Vec::with_capacity(model_candidates),
        support: (support_candidates > 0).then(|| Vec::with_capacity(support_candidates)),
    };
    let z_mm = (layer_index as f32 + 0.5) * job.layer_height_mm;
    for chunk in candidates.chunks(256) {
        if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return Err(SlicerV3Error::Cancelled);
        }
        for &candidate in chunk {
            let output = if support_split.is_some_and(|split| candidate >= split) {
                layer.support.as_mut().expect("support candidates reserved")
            } else {
                &mut layer.model
            };
            push_segment_for_triangle_at_z(job, &triangles[candidate], z_mm, output);
        }
    }
    Ok(layer)
}
