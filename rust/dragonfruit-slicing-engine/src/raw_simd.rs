//! Exact binary-RAW geometry, with one independent triangle/layer pair per lane.

use std::mem::MaybeUninit;
use std::sync::atomic::{AtomicBool, Ordering};

use pulp::{Simd, WithSimd};

use crate::geometry::Triangle;
use crate::pulp_simd::Backend;
use crate::raster::{distinct_points_push, push_segment_for_triangle_at_z, Segment};
use crate::{SliceJobV3, SlicerV3Error};

pub(crate) const MAX_RAW_LAYER_BATCH: usize = 8;
// The pinned Pulp backends have at most sixteen f32 lanes (x86 V4).
const MAX_PACKET_LANES: usize = 16;

#[derive(Clone, Copy)]
pub(crate) struct RawLayerRequest<'a> {
    pub(crate) layer_index: u32,
    pub(crate) z_mm: f32,
    pub(crate) candidates: &'a [usize],
}

pub(crate) struct LayerSegments {
    pub(crate) layer_index: u32,
    pub(crate) model_candidates: usize,
    pub(crate) model: Vec<Segment>,
    pub(crate) support: Option<Vec<Segment>>,
}

impl LayerSegments {
    fn empty(layer_index: u32) -> Self {
        Self { layer_index, model_candidates: 0, model: Vec::new(), support: None }
    }
}

#[derive(Clone, Copy)]
struct Work<'a> {
    triangle: &'a Triangle,
    z_mm: f32,
    layer: usize,
    support: bool,
}

type Packet<'a> = [Option<Work<'a>>; MAX_PACKET_LANES];
type PacketSegments = [Option<Segment>; MAX_PACKET_LANES];

/// Clear the contents but retain the caller's allocation, including on empty input.
pub(crate) fn build_segments_into(
    job: &SliceJobV3,
    triangles: &[Triangle],
    candidates: &[usize],
    z_mm: f32,
    output: &mut Vec<Segment>,
    backend: Backend,
) {
    output.clear();
    backend.dispatch(BuildSegments { job, triangles, candidates, z_mm, output });
}

struct BuildSegments<'a> {
    job: &'a SliceJobV3,
    triangles: &'a [Triangle],
    candidates: &'a [usize],
    z_mm: f32,
    output: &'a mut Vec<Segment>,
}

impl WithSimd for BuildSegments<'_> {
    type Output = ();

    #[inline(always)]
    fn with_simd<S: Simd>(self, simd: S) {
        if S::IS_SCALAR {
            for &index in self.candidates {
                push_segment_for_triangle_at_z(self.job, &self.triangles[index], self.z_mm, self.output);
            }
            return;
        }
        assert!(S::F32_LANES <= MAX_PACKET_LANES);
        for candidates in self.candidates.chunks(S::F32_LANES) {
            let mut packet = [None; MAX_PACKET_LANES];
            for (lane, &index) in candidates.iter().enumerate() {
                packet[lane] = Some(Work {
                    triangle: &self.triangles[index], z_mm: self.z_mm, layer: 0, support: false,
                });
            }
            let segments = intersect_packet(simd, self.job, &packet);
            self.output.extend(segments[..candidates.len()].iter().flatten().copied());
        }
    }
}

/// Stream layer-major candidates. Only the current layer has growable segment
/// storage; pairs borrowed from following layers live in one stack packet.
pub(crate) fn for_each_layer_segments(
    job: &SliceJobV3,
    triangles: &[Triangle],
    requests: &[RawLayerRequest<'_>],
    support_split: Option<usize>,
    backend: Backend,
    cancel: Option<&AtomicBool>,
    emit: impl FnMut(LayerSegments) -> Result<(), SlicerV3Error>,
) -> Result<(), SlicerV3Error> {
    assert!(requests.len() <= MAX_RAW_LAYER_BATCH);
    backend.dispatch(StreamLayers { job, triangles, requests, support_split, cancel, emit })
}

struct StreamLayers<'a, F> {
    job: &'a SliceJobV3,
    triangles: &'a [Triangle],
    requests: &'a [RawLayerRequest<'a>],
    support_split: Option<usize>,
    cancel: Option<&'a AtomicBool>,
    emit: F,
}

#[derive(Clone, Copy, Default)]
struct LayerStats {
    model_candidates: usize,
    support_present: bool,
}

fn check_cancel(cancel: Option<&AtomicBool>) -> Result<(), SlicerV3Error> {
    if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        Err(SlicerV3Error::Cancelled)
    } else {
        Ok(())
    }
}

// Taking the layer before invoking the callback prevents retaining its allocation
// while the consumer rasterizes/encodes it. No next-layer Vec is reserved here.
fn emit_finished<F: FnMut(LayerSegments) -> Result<(), SlicerV3Error>>(
    requests: &[RawLayerRequest<'_>],
    stats: &[LayerStats; MAX_RAW_LAYER_BATCH],
    next: &mut usize,
    output: &mut Option<LayerSegments>,
    cancel: Option<&AtomicBool>,
    emit: &mut F,
) -> Result<(), SlicerV3Error> {
    check_cancel(cancel)?;
    let mut layer = output.take().unwrap_or_else(|| LayerSegments::empty(requests[*next].layer_index));
    layer.model_candidates = stats[*next].model_candidates;
    if stats[*next].support_present && layer.support.is_none() {
        layer.support = Some(Vec::new());
    }
    emit(layer)?;
    *next += 1;
    Ok(())
}

fn advance_completed(requests: &[RawLayerRequest<'_>], layer: &mut usize, candidate: &mut usize) {
    while *layer < requests.len() && *candidate == requests[*layer].candidates.len() {
        *layer += 1;
        *candidate = 0;
    }
}

impl<F: FnMut(LayerSegments) -> Result<(), SlicerV3Error>> WithSimd for StreamLayers<'_, F> {
    type Output = Result<(), SlicerV3Error>;

    #[inline(always)]
    fn with_simd<S: Simd>(mut self, simd: S) -> Self::Output {
        check_cancel(self.cancel)?;
        if S::IS_SCALAR {
            for request in self.requests {
                check_cancel(self.cancel)?;
                let mut layer = LayerSegments::empty(request.layer_index);
                // Keep the original scalar branch math, without packing or SIMD
                // emulation. Chunking bounds cancellation polling overhead.
                for candidates in request.candidates.chunks(256) {
                    check_cancel(self.cancel)?;
                    for &index in candidates {
                        if self.support_split.is_some_and(|split| index >= split) {
                            let support = layer.support.get_or_insert_with(Vec::new);
                            push_segment_for_triangle_at_z(self.job, &self.triangles[index], request.z_mm, support);
                        } else {
                            layer.model_candidates += 1;
                            push_segment_for_triangle_at_z(self.job, &self.triangles[index], request.z_mm, &mut layer.model);
                        }
                    }
                }
                check_cancel(self.cancel)?;
                (self.emit)(layer)?;
            }
            return Ok(());
        }

        assert!(S::F32_LANES <= MAX_PACKET_LANES);
        let mut stats = [LayerStats::default(); MAX_RAW_LAYER_BATCH];
        let mut read_layer = 0;
        let mut read_candidate = 0;
        let mut next_output = 0;
        let mut output = None;
        loop {
            advance_completed(self.requests, &mut read_layer, &mut read_candidate);
            // In particular, emit leading/terminal empty layers without waiting
            // for a packet to fill, or reading the next layer's candidates.
            while next_output < read_layer {
                emit_finished(self.requests, &stats, &mut next_output, &mut output, self.cancel, &mut self.emit)?;
            }
            if read_layer == self.requests.len() {
                return Ok(());
            }
            check_cancel(self.cancel)?;
            let mut packet = [None; MAX_PACKET_LANES];
            let mut count = 0;
            while count < S::F32_LANES && read_layer < self.requests.len() {
                let request = &self.requests[read_layer];
                let index = request.candidates[read_candidate];
                let support = self.support_split.is_some_and(|split| index >= split);
                if support {
                    stats[read_layer].support_present = true;
                } else {
                    stats[read_layer].model_candidates += 1;
                }
                packet[count] = Some(Work {
                    triangle: &self.triangles[index], z_mm: request.z_mm, layer: read_layer, support,
                });
                count += 1;
                read_candidate += 1;
                advance_completed(self.requests, &mut read_layer, &mut read_candidate);
            }
            let mut segments = intersect_packet(simd, self.job, &packet);
            for lane in 0..count {
                let work = packet[lane].unwrap();
                while next_output < work.layer {
                    emit_finished(self.requests, &stats, &mut next_output, &mut output, self.cancel, &mut self.emit)?;
                }
                if let Some(segment) = segments[lane].take() {
                    let layer = output.get_or_insert_with(|| LayerSegments::empty(self.requests[work.layer].layer_index));
                    if work.support {
                        layer.support.get_or_insert_with(Vec::new).push(segment);
                    } else {
                        layer.model.push(segment);
                    }
                }
            }
            // The next loop drains every finished layer before filling another
            // packet. All not-yet-drained segments fit in this one packet.
        }
    }
}

#[inline(always)]
fn pack_f32<S: Simd>(mut value: impl FnMut(usize) -> f32) -> S::f32s {
    let mut vector = MaybeUninit::<S::f32s>::uninit();
    // Pulp's f32 vectors are Pod, contiguous f32 lanes without padding. Write
    // every lane directly, avoiding a heap SoA or a triangle copy/staging array.
    unsafe {
        let lanes = vector.as_mut_ptr().cast::<f32>();
        for lane in 0..S::F32_LANES {
            lanes.add(lane).write_unaligned(value(lane));
        }
        vector.assume_init()
    }
}

#[inline(always)]
fn pack_field<S: Simd>(packet: &Packet<'_>, field: impl Fn(&Triangle) -> f32) -> S::f32s {
    pack_f32::<S>(|lane| packet[lane].map_or(0.0, |work| field(work.triangle)))
}

#[inline(always)]
fn f32_lanes<S: Simd>(vector: &S::f32s) -> &[f32] {
    // Same contiguous Pod layout as pack_f32; lifetime is tied to the vector.
    unsafe { std::slice::from_raw_parts((vector as *const S::f32s).cast::<f32>(), S::F32_LANES) }
}

#[inline(always)]
fn f32_lanes_mut<S: Simd>(vector: &mut S::f32s) -> &mut [f32] {
    unsafe { std::slice::from_raw_parts_mut((vector as *mut S::f32s).cast::<f32>(), S::F32_LANES) }
}

#[inline(always)]
fn mask_lane<S: Simd>(mask: &S::u32s, lane: usize) -> bool {
    // Validity is expanded to all-zero/all-one u32 lanes on every backend.
    unsafe { (mask as *const S::u32s).cast::<u32>().add(lane).read_unaligned() != 0 }
}

struct EdgePoints<S: Simd> {
    valid: S::u32s,
    x: S::f32s,
    y: S::f32s,
}

#[inline(always)]
fn intersect_edge<S: Simd>(
    simd: S,
    active: S::m32s,
    z: S::f32s,
    a: (S::f32s, S::f32s, S::f32s),
    b: (S::f32s, S::f32s, S::f32s),
) -> EdgePoints<S> {
    let zero = simd.splat_f32s(0.0);
    let dz1 = simd.sub_f32s(a.0, z);
    let dz2 = simd.sub_f32s(b.0, z);
    let crosses = simd.or_m32s(
        simd.and_m32s(simd.less_than_or_equal_f32s(dz1, zero), simd.greater_than_f32s(dz2, zero)),
        simd.and_m32s(simd.less_than_or_equal_f32s(dz2, zero), simd.greater_than_f32s(dz1, zero)),
    );
    let denominator = simd.sub_f32s(b.0, a.0);
    // Negate the scalar rejection predicate, not >=: NaN must retain the
    // scalar unordered semantics (likewise the triangle bounds predicate).
    let valid = simd.and_m32s(active, simd.and_m32s(crosses,
        simd.not_m32s(simd.less_than_f32s(simd.abs_f32s(denominator), simd.splat_f32s(1e-8)))));
    // Sanitization precedes division, including tails, noncrossing edges and
    // rejected triangles. No reciprocal approximation or fused multiply/add.
    let numerator = simd.select_f32s(valid, simd.sub_f32s(z, a.0), zero);
    let denominator = simd.select_f32s(valid, denominator, simd.splat_f32s(1.0));
    let t = simd.div_f32s(numerator, denominator);
    let ax = simd.select_f32s(valid, a.1, zero);
    let ay = simd.select_f32s(valid, a.2, zero);
    let bx = simd.select_f32s(valid, b.1, zero);
    let by = simd.select_f32s(valid, b.2, zero);
    EdgePoints {
        valid: simd.select_u32s(valid, simd.splat_u32s(u32::MAX), simd.splat_u32s(0)),
        x: simd.add_f32s(ax, simd.mul_f32s(simd.sub_f32s(bx, ax), t)),
        y: simd.add_f32s(ay, simd.mul_f32s(simd.sub_f32s(by, ay), t)),
    }
}

#[inline(always)]
fn intersect_packet<S: Simd>(simd: S, job: &SliceJobV3, packet: &Packet<'_>) -> PacketSegments {
    let z = pack_f32::<S>(|lane| packet[lane].map_or(0.0, |work| work.z_mm));
    let present = simd.greater_than_f32s(
        pack_f32::<S>(|lane| if packet[lane].is_some() { 1.0 } else { 0.0 }), simd.splat_f32s(0.0),
    );
    let rejected = simd.or_m32s(
        simd.less_than_f32s(z, pack_field::<S>(packet, |tri| tri.z_min)),
        simd.greater_than_or_equal_f32s(z, pack_field::<S>(packet, |tri| tri.z_max)),
    );
    let active = simd.and_m32s(present, simd.not_m32s(rejected));
    if simd.first_true_m32s(active) >= S::F32_LANES {
        return [None; MAX_PACKET_LANES];
    }
    let a = (pack_field::<S>(packet, |tri| tri.a.z), pack_field::<S>(packet, |tri| tri.px_ax), pack_field::<S>(packet, |tri| tri.px_ay));
    let b = (pack_field::<S>(packet, |tri| tri.b.z), pack_field::<S>(packet, |tri| tri.px_bx), pack_field::<S>(packet, |tri| tri.px_by));
    let c = (pack_field::<S>(packet, |tri| tri.c.z), pack_field::<S>(packet, |tri| tri.px_cx), pack_field::<S>(packet, |tri| tri.px_cy));
    let edges = [intersect_edge(simd, active, z, a, b), intersect_edge(simd, active, z, b, c), intersect_edge(simd, active, z, c, a)];
    let mut segments = [None; MAX_PACKET_LANES];
    let mut dx = simd.splat_f32s(0.0);
    let mut dy = simd.splat_f32s(1.0);
    for lane in 0..S::F32_LANES {
        let Some(work) = packet[lane] else { continue; };
        let mut points = [(0.0, 0.0); 3];
        let mut count = 0;
        // Scalar dedup preserves edge/candidate order and the existing EPS.
        for edge in &edges {
            if mask_lane::<S>(&edge.valid, lane) {
                distinct_points_push(&mut points, &mut count, (f32_lanes::<S>(&edge.x)[lane], f32_lanes::<S>(&edge.y)[lane]));
            }
        }
        if count < 2 { continue; }
        let mut p0 = points[0];
        let mut p1 = points[1];
        let tri = work.triangle;
        if tri.dir_x.abs() > 1e-10 || tri.dir_y.abs() > 1e-10 {
            let seg_x = p1.0 - p0.0;
            let seg_y = p1.1 - p0.1;
            if (seg_x * tri.dir_x + seg_y * tri.dir_y) < 0.0 {
                std::mem::swap(&mut p0, &mut p1);
            }
        }
        let delta_y = p1.1 - p0.1;
        if delta_y.abs() < 1e-8 { continue; }
        f32_lanes_mut::<S>(&mut dx)[lane] = p1.0 - p0.0;
        f32_lanes_mut::<S>(&mut dy)[lane] = delta_y;
        segments[lane] = Some(Segment {
            x1: p0.0, y1: p0.1, dx_dy: 0.0,
            // Keep Rust's scalar NaN/signed-zero policy, not ISA min/max.
            y_min: p0.1.min(p1.1), y_max: p0.1.max(p1.1),
            wind: if job.mirror_x { -tri.fill_wind } else { tri.fill_wind },
        });
    }
    // Nonsegments already have safe 0/1 operands. Active lanes use the same
    // exact final division as scalar, after scalar orientation and EPS checks.
    let slope = simd.div_f32s(dx, dy);
    for (lane, segment) in segments[..S::F32_LANES].iter_mut().enumerate() {
        if let Some(segment) = segment {
            segment.dx_dy = f32_lanes::<S>(&slope)[lane];
        }
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{parse_triangles, project_triangles_inplace};

    fn job(mirror_x: bool, mirror_y: bool) -> SliceJobV3 {
        SliceJobV3 {
            source_width_px: 65, source_height_px: 49, width_px: 65, height_px: 49,
            build_width_mm: 64.0, build_depth_mm: 48.0, layer_height_mm: 0.5,
            anti_aliasing_level: "Off".into(), anti_aliasing_mode: "Coverage".into(),
            mirror_x, mirror_y, ..Default::default()
        }
    }

    fn geometry(job: &SliceJobV3) -> Vec<Triangle> {
        let mut triangles = parse_triangles(&[
            // Endpoint crossings, reversed orientation and a half-pixel tie.
            -8.5, -5.5, 0.0, 9.5, 6.5, 1.0, -8.5, 12.5, 0.0,
            -8.5, 12.5, 0.0, 9.5, 6.5, 1.0, -8.5, -5.5, 0.0,
            // A genuine extremely thin diagonal and an almost horizontal edge.
            0.5, -9.5, -1.0, 0.50002, 9.5, 2.0, 0.50004, 11.5, -1.0,
            -9.0, 0.0, -1.0, 9.0, 0.000000001, 1.0, 8.0, 0.000000002, -1.0,
            // Coplanar, duplicate vertices, and very small Z denominators.
            -4.0, -4.0, 0.5, 4.0, 4.0, 0.5, -4.0, 4.0, 0.5,
            -4.0, -4.0, 0.0, -4.0, -4.0, 0.0, 4.0, 4.0, 1.0,
            -7.0, -7.0, 0.0, 7.0, 7.0, 0.000000005, -7.0, 7.0, 0.0,
            -7.0, -7.0, 0.0, 7.0, 7.0, 0.00000002, -7.0, 7.0, 0.0,
            // Disjoint real layers: these triangles need not overlap in Z.
            -12.0, -12.0, 2.0, -5.0, -4.0, 3.0, -12.0, -4.0, 2.0,
            5.0, 4.0, 4.0, 12.0, 12.0, 5.0, 5.0, 12.0, 4.0,
        ]);
        project_triangles_inplace(&mut triangles, job);
        triangles
    }

    fn scalar(job: &SliceJobV3, triangles: &[Triangle], candidates: &[usize], z: f32) -> Vec<Segment> {
        let mut output = Vec::new();
        for &index in candidates {
            push_segment_for_triangle_at_z(job, &triangles[index], z, &mut output);
        }
        output
    }

    fn assert_segments(actual: &[Segment], expected: &[Segment]) {
        assert_eq!(actual.len(), expected.len(), "segment count");
        for (actual, expected) in actual.iter().zip(expected) {
            assert_eq!(actual.wind, expected.wind);
            for (a, b) in [
                (actual.x1, expected.x1), (actual.y1, expected.y1),
                (actual.dx_dy, expected.dx_dy), (actual.y_min, expected.y_min), (actual.y_max, expected.y_max),
            ] {
                if b.is_nan() { assert!(a.is_nan()); } else { assert_eq!(a.to_bits(), b.to_bits(), "{actual:?} != {expected:?}"); }
            }
        }
    }

    #[test]
    fn raw_geometry_boundaries_and_candidate_tails_match_all_backends() {
        for mirror_x in [false, true] {
            for mirror_y in [false, true] {
                let job = job(mirror_x, mirror_y);
                let triangles = geometry(&job);
                let order = [9, 0, 7, 1, 0, 5, 3, 6, 4, 2, 8, 1, 0, 9, 2, 7, 8, 0, 5];
                for z in [-1.0, -0.0, 0.0000000025, 0.00000001, 0.25, 0.5, 1.0, 2.5, 4.5, 5.0, f32::NAN] {
                    for count in 0..=order.len() {
                        let candidates = &order[..count];
                        let expected = scalar(&job, &triangles, candidates, z);
                        for backend in Backend::supported_for_tests() {
                            let mut actual = Vec::new();
                            build_segments_into(&job, &triangles, candidates, z, &mut actual, backend);
                            assert_segments(&actual, &expected);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn raw_unordered_coordinates_and_signed_zero_match_scalar() {
        let job = job(false, false);
        let mut triangles = geometry(&job);
        let mut triangle = triangles[0];
        triangle.px_ax = f32::NAN;
        triangles.push(triangle);
        triangle = triangles[0];
        triangle.px_ay = f32::INFINITY;
        triangles.push(triangle);
        triangle = triangles[0];
        triangle.z_min = f32::NAN;
        triangle.z_max = f32::NAN;
        triangles.push(triangle);
        triangle = triangles[0];
        triangle.a.z = f32::NEG_INFINITY;
        triangle.b.z = f32::INFINITY;
        triangle.z_min = f32::NEG_INFINITY;
        triangle.z_max = f32::INFINITY;
        triangles.push(triangle);
        triangle = triangles[0];
        triangle.px_ax = -0.0;
        triangle.px_bx = 0.0;
        triangle.px_cx = -0.0;
        triangles.push(triangle);
        let candidates: Vec<_> = (0..triangles.len()).rev().chain([10, 12, 14, 0, 11]).collect();
        for z in [-0.0, 0.5, f32::INFINITY, f32::NAN] {
            let expected = scalar(&job, &triangles, &candidates, z);
            for backend in Backend::supported_for_tests() {
                let mut actual = Vec::new();
                build_segments_into(&job, &triangles, &candidates, z, &mut actual, backend);
                assert_segments(&actual, &expected);
            }
        }
    }

    #[test]
    fn raw_build_segments_replaces_previous_layer_contents() {
        let job = job(false, false);
        let triangles = geometry(&job);
        for backend in Backend::supported_for_tests() {
            let mut output = Vec::new();
            build_segments_into(&job, &triangles, &[0, 1, 0], 0.5, &mut output, backend);
            assert_segments(&output, &scalar(&job, &triangles, &[0, 1, 0], 0.5));
            build_segments_into(&job, &triangles, &[], 0.5, &mut output, backend);
            assert!(output.is_empty());
            build_segments_into(&job, &triangles, &[8], 2.5, &mut output, backend);
            assert_segments(&output, &scalar(&job, &triangles, &[8], 2.5));
        }
    }

    #[test]
    fn raw_streams_real_layers_with_support_presence_order_and_batch_tails() {
        for mirror_x in [false, true] {
            let job = job(mirror_x, true);
            let triangles = geometry(&job);
            let candidates: [&[usize]; MAX_RAW_LAYER_BATCH] = [
                &[], &[0], &[9, 8, 4, 9], &[1, 0, 1, 5, 2, 0, 7],
                &[], &[8, 8, 0], &[9, 1, 9], &[],
            ];
            let zs = [0.0, 0.25, 0.5, 0.75, 1.0, 2.5, 4.5, 5.0];
            let requests: Vec<_> = candidates.iter().enumerate().map(|(i, candidates)| RawLayerRequest {
                layer_index: 17 + i as u32, z_mm: zs[i], candidates,
            }).collect();
            for count in 0..=MAX_RAW_LAYER_BATCH {
                for split in [None, Some(0), Some(5), Some(triangles.len())] {
                    for backend in Backend::supported_for_tests() {
                        let mut emitted = 0;
                        for_each_layer_segments(&job, &triangles, &requests[..count], split, backend, None, |layer| {
                            let request = &requests[emitted];
                            assert_eq!(layer.layer_index, request.layer_index);
                            let (model, support): (Vec<_>, Vec<_>) = request.candidates.iter().copied()
                                .partition(|&index| !split.is_some_and(|split| index >= split));
                            assert_eq!(layer.model_candidates, model.len());
                            assert_eq!(layer.support.is_some(), !support.is_empty());
                            assert_segments(&layer.model, &scalar(&job, &triangles, &model, request.z_mm));
                            if let Some(actual) = &layer.support {
                                assert_segments(actual, &scalar(&job, &triangles, &support, request.z_mm));
                            }
                            emitted += 1;
                            Ok(())
                        }).unwrap();
                        assert_eq!(emitted, count);
                    }
                }
            }
        }
    }

    #[test]
    fn raw_finished_packet_drains_before_reading_later_candidates() {
        let job = job(false, false);
        let triangles = geometry(&job);
        let full_packet = [0; MAX_PACKET_LANES];
        let requests = [
            RawLayerRequest { layer_index: 0, z_mm: 0.5, candidates: &full_packet },
            // A future request must not be read after the sink rejects layer 0.
            RawLayerRequest { layer_index: 1, z_mm: 0.5, candidates: &[usize::MAX] },
        ];
        for backend in Backend::supported_for_tests() {
            let mut emitted = 0;
            let result = for_each_layer_segments(&job, &triangles, &requests, None, backend, None, |layer| {
                assert_eq!(layer.layer_index, 0);
                assert_eq!(layer.model_candidates, MAX_PACKET_LANES);
                emitted += 1;
                Err(SlicerV3Error::Png("sink failure".into()))
            });
            assert!(matches!(result, Err(SlicerV3Error::Png(ref message)) if message == "sink failure"));
            assert_eq!(emitted, 1);
        }
    }

    #[test]
    fn raw_empty_layer_sink_error_does_not_read_following_geometry() {
        let job = job(false, false);
        let requests = [
            RawLayerRequest { layer_index: 7, z_mm: 0.5, candidates: &[] },
            RawLayerRequest { layer_index: 8, z_mm: 0.5, candidates: &[usize::MAX] },
        ];
        for backend in Backend::supported_for_tests() {
            let mut emitted = 0;
            let result = for_each_layer_segments(&job, &[], &requests, None, backend, None, |layer| {
                assert_eq!(layer.layer_index, 7);
                assert!(layer.model.is_empty());
                emitted += 1;
                Err(SlicerV3Error::Png("empty sink failure".into()))
            });
            assert!(matches!(result, Err(SlicerV3Error::Png(_))));
            assert_eq!(emitted, 1);
        }
    }

    #[test]
    fn raw_cancellation_stops_packet_spill_emission() {
        let job = job(false, false);
        let triangles = geometry(&job);
        let requests: Vec<_> = (0..MAX_RAW_LAYER_BATCH).map(|i| RawLayerRequest {
            layer_index: i as u32, z_mm: 0.5, candidates: &[0],
        }).collect();
        for backend in Backend::supported_for_tests() {
            let cancel = AtomicBool::new(true);
            let mut emitted = 0;
            let result = for_each_layer_segments(&job, &triangles, &requests, None, backend, Some(&cancel), |_| {
                emitted += 1;
                Ok(())
            });
            assert!(matches!(result, Err(SlicerV3Error::Cancelled)));
            assert_eq!(emitted, 0);
            cancel.store(false, Ordering::Relaxed);
            let result = for_each_layer_segments(&job, &triangles, &requests, None, backend, Some(&cancel), |layer| {
                assert_eq!(layer.layer_index, 0);
                emitted += 1;
                cancel.store(true, Ordering::Relaxed);
                Ok(())
            });
            assert!(matches!(result, Err(SlicerV3Error::Cancelled)));
            assert_eq!(emitted, 1);
        }
    }
}
