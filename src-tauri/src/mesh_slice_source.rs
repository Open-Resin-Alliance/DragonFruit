//! Std-only retained import ownership and JS-compatible slice transforms.
//! Mesh storage stays shared with the loader/AO registry; only renderer corner
//! order is new storage. Each entry conservatively charges the full Arc payload.

use std::collections::VecDeque;
use std::sync::Arc;

pub const SOURCE_BYTES: usize = 512 * 1024 * 1024;
pub const SOURCE_ENTRIES: usize = 4096;

pub struct RetainedSource<M> {
    pub mesh: Arc<M>,
    pub corners: usize,
    pub indices: Vec<u32>,
    pub position_offset: [f64; 3],
    charge: usize,
}

pub struct SourceCache<M> {
    budget: usize,
    entry_limit: usize,
    bytes: usize,
    next_id: u64,
    entries: VecDeque<(String, Arc<RetainedSource<M>>)>,
}

impl<M> SourceCache<M> {
    pub fn new(budget: usize, entry_limit: usize) -> Self {
        Self { budget, entry_limit, bytes: 0, next_id: 0, entries: VecDeque::new() }
    }

    pub fn retain(
        &mut self,
        mesh: Arc<M>,
        corners: usize,
        mesh_bytes: usize,
        indices: Vec<u32>,
        position_offset: [f64; 3],
    ) -> Result<Option<String>, String> {
        validate_order(corners, &indices, position_offset)?;
        let charge = indices.capacity().checked_mul(std::mem::size_of::<u32>())
            .and_then(|bytes| bytes.checked_add(mesh_bytes))
            .and_then(|bytes| bytes.checked_add(std::mem::size_of::<RetainedSource<M>>()))
            .ok_or("Retained source size overflow")?;
        if charge > self.budget || self.entry_limit == 0 {
            return Ok(None);
        }
        let next = self.next_id.checked_add(1).ok_or("Retained source IDs exhausted")?;
        let id = format!("mesh-source-{next}");
        while self.bytes > self.budget - charge || self.entries.len() >= self.entry_limit {
            let (_, removed) = self.entries.pop_front().expect("bounded source cache entry");
            self.bytes -= removed.charge;
        }
        self.next_id = next;
        self.bytes += charge;
        self.entries.push_back((id.clone(), Arc::new(RetainedSource {
            mesh, corners, indices, position_offset, charge,
        })));
        Ok(Some(id))
    }

    pub fn get(&self, id: &str) -> Option<Arc<RetainedSource<M>>> {
        self.entries.iter().find(|(key, _)| key == id).map(|(_, source)| Arc::clone(source))
    }
}

pub fn validate_order(corners: usize, indices: &[u32], offset: [f64; 3]) -> Result<(), String> {
    if corners == 0 || corners % 3 != 0 {
        return Err("Retained source must contain whole triangles".into());
    }
    if !offset.iter().all(|value| value.is_finite()) {
        return Err("Retained source position offset must be finite".into());
    }
    if !indices.is_empty() && (indices.len() != corners || indices.iter().any(|&index| index as usize >= corners)) {
        return Err("Retained source order must address exactly its original soup corners".into());
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub enum SourceOrder { Geometry, Soup }

pub struct SourceTransform {
    pub matrix: [f64; 16],
    pub center: [f64; 3],
    pub plate_offset: [f64; 2],
    pub flip_winding: bool,
}

impl SourceTransform {
    /// JSON numbers lose -0. Bits 0..15 address matrix, 16..18 center, and
    /// 19..20 plate_offset; restore their signs before any transform arithmetic.
    pub fn restore_negative_zeros(&mut self, mask: u32) -> Result<(), String> {
        if mask & !((1u32 << 21) - 1) != 0 {
            return Err("Retained source negative-zero mask exceeds 21 bits".into());
        }
        for (bit, value) in self.matrix.iter().chain(self.center.iter()).chain(self.plate_offset.iter()).enumerate() {
            if mask & (1u32 << bit) != 0 && *value != 0.0 {
                return Err("Retained source negative-zero mask targets a nonzero component".into());
            }
        }
        for (bit, value) in self.matrix.iter_mut().chain(self.center.iter_mut()).chain(self.plate_offset.iter_mut()).enumerate() {
            if mask & (1u32 << bit) != 0 { *value = -0.0; }
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.matrix.iter().chain(self.center.iter()).chain(self.plate_offset.iter())
            .all(|value| value.is_finite())
        {
            return Err("Retained source transform values must be finite".into());
        }
        Ok(())
    }

    /// Match BufferGeometry translation's f32 store, exporter center subtraction,
    /// Vector3.applyMatrix4's f64 operation order, then collector plate translation.
    pub fn point(&self, raw: [f32; 3], offset: [f64; 3]) -> [f64; 3] {
        let x = (raw[0] as f64 + offset[0]) as f32 as f64 - self.center[0];
        let y = (raw[1] as f64 + offset[1]) as f32 as f64 - self.center[1];
        let z = (raw[2] as f64 + offset[2]) as f32 as f64 - self.center[2];
        let e = &self.matrix;
        let w = 1.0 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
        [
            (e[0] * x + e[4] * y + e[8] * z + e[12]) * w + -self.plate_offset[0],
            (e[1] * x + e[5] * y + e[9] * z + e[13]) * w + -self.plate_offset[1],
            (e[2] * x + e[6] * y + e[10] * z + e[14]) * w,
        ]
    }
}

#[derive(Debug, PartialEq)]
pub struct SourceBounds {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

impl SourceBounds {
    pub fn empty() -> Self {
        Self { min: [f64::INFINITY; 3], max: [f64::NEG_INFINITY; 3] }
    }

    fn include_triangle(&mut self, points: [[f64; 3]; 3]) {
        // Math.min/max distinguish signed zero, then the collector uses strict
        // comparisons against previous triangles (equal extrema stay unchanged).
        for axis in 0..3 {
            let min = points.iter().map(|point| point[axis]).fold(f64::INFINITY, js_min);
            let max = points.iter().map(|point| point[axis]).fold(f64::NEG_INFINITY, js_max);
            if min < self.min[axis] { self.min[axis] = min; }
            if max > self.max[axis] { self.max[axis] = max; }
        }
    }
}

/// Bounds for read-only classified partition views. Raw soup order is
/// authoritative here, irrespective of the renderer's final BVH index order.
pub fn translated_partition_bounds(
    triangle_count: usize,
    model_triangle_count: usize,
    offset: [f64; 3],
    position: impl Fn(usize) -> [f32; 3],
) -> Result<(SourceBounds, SourceBounds), String> {
    if model_triangle_count == 0 || model_triangle_count >= triangle_count
        || !offset.iter().all(|value| value.is_finite())
    {
        return Err("Retained source model triangle boundary is invalid".into());
    }
    let corners = triangle_count.checked_mul(3).ok_or("Retained source corner count overflow")?;
    let mut model = SourceBounds::empty();
    let mut support = SourceBounds::empty();
    for corner in 0..corners {
        let raw = position(corner);
        let bounds = if corner / 3 < model_triangle_count { &mut model } else { &mut support };
        for axis in 0..3 {
            let value = (raw[axis] as f64 + offset[axis]) as f32 as f64;
            bounds.min[axis] = js_min(bounds.min[axis], value);
            bounds.max[axis] = js_max(bounds.max[axis], value);
        }
    }
    Ok((model, support))
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { return f64::NAN; }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() || b.is_sign_negative() { -0.0 } else { 0.0 };
    }
    if a < b { a } else { b }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { return f64::NAN; }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_positive() || b.is_sign_positive() { 0.0 } else { -0.0 };
    }
    if a > b { a } else { b }
}

impl<M> RetainedSource<M> {
    pub fn validate_range(&self, expected: usize, start: usize, end: usize) -> Result<usize, String> {
        if expected != self.corners {
            return Err("Retained source original corner count mismatch".into());
        }
        if start >= end || end > self.corners / 3 {
            return Err("Retained source triangle range is invalid".into());
        }
        (end - start).checked_mul(36).ok_or_else(|| "Retained source byte size overflow".into())
    }

    /// The caller validates the complete range before any upload mutation. This
    /// writes only a bounded chunk, never an intermediate whole-world mesh.
    pub fn write_triangles(
        &self,
        start: usize,
        end: usize,
        order: SourceOrder,
        transform: &SourceTransform,
        position: impl Fn(&M, usize) -> [f32; 3],
        bytes: &mut Vec<u8>,
        bounds: &mut SourceBounds,
    ) {
        bytes.clear();
        let winding = if transform.flip_winding { [0, 2, 1] } else { [0, 1, 2] };
        for triangle in start..end {
            let mut points = [[0.0; 3]; 3];
            for (output, corner) in winding.into_iter().enumerate() {
                let mut index = triangle * 3 + corner;
                if matches!(order, SourceOrder::Geometry) && !self.indices.is_empty() {
                    index = self.indices[index] as usize;
                }
                let point = transform.point(position(&self.mesh, index), self.position_offset);
                points[output] = point;
                for value in point { bytes.extend_from_slice(&(value as f32).to_le_bytes()); }
            }
            bounds.include_triangle(points);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transform() -> SourceTransform {
        SourceTransform {
            matrix: [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.],
            center: [0.; 3], plate_offset: [0.; 2], flip_winding: false,
        }
    }

    fn mesh() -> Arc<Vec<[f32; 3]>> {
        Arc::new(vec![[0., 1., 2.], [3., 4., 5.], [6., 7., 8.],
            [9., 10., 11.], [12., 13., 14.], [15., 16., 17.]])
    }

    fn floats(bytes: &[u8]) -> Vec<f32> {
        bytes.chunks_exact(4).map(|part| f32::from_le_bytes(part.try_into().unwrap())).collect()
    }

    #[test]
    fn mirrored_origin_signed_bits_survive_json_zero_normalization_and_restore() {
        let original = SourceTransform {
            matrix: [-1., -0., -0., 0., -0., -1., -0., 0., -0., -0., -1., 0., -0., -0., -0., 1.],
            center: [0.; 3], plate_offset: [0.; 2], flip_winding: true,
        };
        let mask = original.matrix.iter().chain(original.center.iter()).chain(original.plate_offset.iter())
            .enumerate().fold(0u32, |mask, (bit, value)| {
                if *value == 0.0 && value.is_sign_negative() { mask | (1u32 << bit) } else { mask }
            });
        // JSON.stringify serializes either sign of zero as the same number 0.
        let json_number = |value: f64| if value == 0.0 { 0.0 } else { value };
        let mut normalized = SourceTransform {
            matrix: original.matrix.map(json_number),
            center: original.center.map(json_number),
            plate_offset: original.plate_offset.map(json_number),
            flip_winding: original.flip_winding,
        };
        let expected = original.point([0.; 3], [0.; 3]);
        assert_eq!((expected[0] as f32).to_bits(), 0x80000000);
        assert_eq!((normalized.point([0.; 3], [0.; 3])[0] as f32).to_bits(), 0);
        normalized.restore_negative_zeros(mask).unwrap();
        normalized.validate().unwrap();
        let restored = normalized.point([0.; 3], [0.; 3]);
        for axis in 0..3 {
            assert_eq!((restored[axis] as f32).to_le_bytes(), (expected[axis] as f32).to_le_bytes());
            assert_eq!(restored[axis].to_bits(), expected[axis].to_bits());
        }
    }

    #[test]
    fn negative_zero_mask_covers_center_and_plate_and_rejects_invalid_targets() {
        let mut transform = transform();
        assert!(transform.restore_negative_zeros(1u32 << 21).is_err());
        assert!(transform.restore_negative_zeros((1u32 << 16) | 1).is_err());
        assert_eq!(transform.center[0].to_bits(), 0);
        transform.restore_negative_zeros((1u32 << 16) | (1u32 << 18) | (1u32 << 19) | (1u32 << 20)).unwrap();
        assert_eq!(transform.center[0].to_bits(), (-0.0f64).to_bits());
        assert_eq!(transform.center[2].to_bits(), (-0.0f64).to_bits());
        assert_eq!(transform.plate_offset[0].to_bits(), (-0.0f64).to_bits());
        assert_eq!(transform.plate_offset[1].to_bits(), (-0.0f64).to_bits());
    }

    #[test]
    fn final_geometry_order_and_classified_soup_ranges_are_distinct() {
        let mut cache = SourceCache::new(4096, 8);
        let mesh = mesh();
        let id = cache.retain(mesh.clone(), 6, 72, vec![3, 5, 4, 0, 2, 1], [0.; 3]).unwrap().unwrap();
        let source = cache.get(&id).unwrap();
        assert!(Arc::ptr_eq(&mesh, &source.mesh));
        let mut bytes = Vec::new();
        let mut bounds = SourceBounds::empty();
        source.write_triangles(0, 1, SourceOrder::Geometry, &transform(), |m, i| m[i], &mut bytes, &mut bounds);
        assert_eq!(floats(&bytes), vec![9., 10., 11., 15., 16., 17., 12., 13., 14.]);
        source.write_triangles(0, 1, SourceOrder::Soup, &transform(), |m, i| m[i], &mut bytes, &mut SourceBounds::empty());
        assert_eq!(floats(&bytes), vec![0., 1., 2., 3., 4., 5., 6., 7., 8.]);
    }

    #[test]
    fn mirrors_swap_only_last_two_corners_and_bounds_precede_f32_store() {
        let mut cache = SourceCache::new(4096, 8);
        let id = cache.retain(mesh(), 6, 72, vec![], [0.; 3]).unwrap().unwrap();
        let source = cache.get(&id).unwrap();
        let mut transform = transform();
        transform.matrix[0] = -1.;
        transform.matrix[12] = 0.1;
        transform.plate_offset = [0.2, 0.3];
        transform.flip_winding = true;
        let mut bounds = SourceBounds::empty();
        let mut bytes = Vec::new();
        source.write_triangles(0, 1, SourceOrder::Geometry, &transform, |m, i| m[i], &mut bytes, &mut bounds);
        assert_eq!(floats(&bytes), vec![-0.1f32, 0.7, 2., -6.1, 6.7, 8., -3.1, 3.7, 5.]);
        assert_eq!(bounds.min, [(-6.0 + 0.1) + -0.2, 1.0 + -0.3, 2.]);
        assert_eq!(bounds.max, [0.1 + -0.2, 7.0 + -0.3, 8.]);
        assert_ne!(bounds.min[0], floats(&bytes)[3] as f64);
    }

    #[test]
    fn centering_rounds_before_subtraction_and_column_major_projective_transform() {
        let mut transform = transform();
        transform.center = [0.25, 0.5, 0.75];
        transform.matrix = [2., 3., 4., 0.125, 5., 6., 7., 0., 8., 9., 10., 0., 11., 12., 13., 1.];
        transform.plate_offset = [0.125, -0.25];
        let raw = [16_777_216., 2., 3.];
        let offset = [1., -0.25, -0.5];
        let x = 16_777_216. - 0.25; // +1 is lost in the frontend's f32 translation.
        let y = 1.75 - 0.5;
        let z = 2.5 - 0.75;
        let w = 1. / (0.125 * x + 1.);
        let expected = [(2. * x + 5. * y + 8. * z + 11.) * w - 0.125,
            (3. * x + 6. * y + 9. * z + 12.) * w + 0.25,
            (4. * x + 7. * y + 10. * z + 13.) * w];
        assert_eq!(transform.point(raw, offset), expected);
        assert!(transform.validate().is_ok());
        transform.matrix[0] = f64::NAN;
        assert!(transform.validate().is_err());
    }

    #[test]
    fn eviction_accounts_capacities_and_never_substitutes_another_source() {
        let mut cache = SourceCache::new(4096, 1);
        let first = cache.retain(mesh(), 6, 72, vec![], [0.; 3]).unwrap().unwrap();
        let pinned = cache.get(&first).unwrap();
        let second = cache.retain(mesh(), 6, 72, vec![], [0.; 3]).unwrap().unwrap();
        assert!(cache.get(&first).is_none());
        assert!(cache.get(&second).is_some());
        assert_eq!(pinned.corners, 6);
        assert!(cache.retain(mesh(), 6, 4097, vec![], [0.; 3]).unwrap().is_none());
        assert!(cache.get(&second).is_some());
        let mut order = Vec::with_capacity(1000);
        order.extend(0..6);
        assert!(cache.retain(mesh(), 6, 72, order, [0.; 3]).unwrap().is_none());
    }

    #[test]
    fn partition_bounds_use_raw_soup_and_import_translation_f32_rounding() {
        let mesh = vec![[16_777_216.0, 1.0, -3.0], [16_777_220.0, -2.0, 4.0],
            [16_777_218.0, 0.0, 2.0], [-4.0, 10.0, 5.0], [-8.0, 12.0, 6.0], [-6.0, 11.0, 7.0]];
        let offset = [1.0, -0.25, 0.5];
        let (model, support) = translated_partition_bounds(2, 1, offset, |corner| mesh[corner]).unwrap();
        assert_eq!(model.min, [16_777_216.0, -2.25, -2.5]);
        assert_eq!(model.max, [16_777_220.0, 0.75, 4.5]);
        assert_eq!(support.min, [-7.0, 9.75, 5.5]);
        assert_eq!(support.max, [-3.0, 11.75, 7.5]);
        for split in [0, 2, usize::MAX] {
            assert!(translated_partition_bounds(2, split, offset, |_| panic!("invalid split must not scan positions")).is_err());
        }
    }

    #[test]
    fn byte_budget_evicts_even_when_entry_limit_has_room() {
        let mut cache = SourceCache::new(4096, 8);
        cache.retain(mesh(), 6, 72, vec![], [0.; 3]).unwrap();
        let charge = cache.bytes;
        let mut cache = SourceCache::new(charge * 2 - 1, 8);
        let old = cache.retain(mesh(), 6, 72, vec![], [0.; 3]).unwrap().unwrap();
        let new = cache.retain(mesh(), 6, 72, vec![], [0.; 3]).unwrap().unwrap();
        assert!(cache.get(&old).is_none());
        assert!(cache.get(&new).is_some());
        assert_eq!(cache.entries.len(), 1);
        assert!(cache.bytes <= cache.budget);
    }

    #[test]
    fn bounded_chunks_preserve_exact_bytes_and_bounds_including_duplicate_triangles() {
        let mut cache = SourceCache::new(4096, 8);
        let id = cache.retain(mesh(), 6, 72, vec![3, 4, 5, 3, 4, 5], [0.125, -0.25, 0.5]).unwrap().unwrap();
        let source = cache.get(&id).unwrap();
        let mut transform = transform();
        transform.center = [0.25, 0.5, 0.75];
        transform.matrix[0] = 1.25;
        transform.matrix[5] = 0.75;
        transform.matrix[10] = 1.5;
        transform.matrix[12] = 0.1;
        transform.plate_offset = [0.2, 0.3];
        let mut complete = Vec::new();
        let mut complete_bounds = SourceBounds::empty();
        source.write_triangles(0, 2, SourceOrder::Geometry, &transform, |m, i| m[i], &mut complete, &mut complete_bounds);
        let mut parts = Vec::new();
        let mut chunk = Vec::new();
        let mut chunk_bounds = SourceBounds::empty();
        for start in 0..2 {
            source.write_triangles(start, start + 1, SourceOrder::Geometry, &transform, |m, i| m[i], &mut chunk, &mut chunk_bounds);
            parts.extend_from_slice(&chunk);
        }
        let mut expected = Vec::new();
        for _ in 0..2 {
            for raw in [[9.0, 10.0, 11.0], [12.0, 13.0, 14.0], [15.0, 16.0, 17.0]] {
                let x = (raw[0] + 0.125) as f32 as f64 - 0.25;
                let y = (raw[1] - 0.25) as f32 as f64 - 0.5;
                let z = (raw[2] + 0.5) as f32 as f64 - 0.75;
                for value in [(1.25 * x + 0.1) - 0.2, 0.75 * y - 0.3, 1.5 * z] {
                    expected.extend_from_slice(&(value as f32).to_le_bytes());
                }
            }
        }
        assert_eq!(complete, expected);
        assert_eq!(parts, expected);
        assert_eq!(complete_bounds, chunk_bounds);
    }

    #[test]
    fn bounds_match_js_signed_zero_and_strict_cross_triangle_updates() {
        let mut bounds = SourceBounds::empty();
        bounds.include_triangle([[0.0, -0.0, 1.0], [-0.0, 0.0, 2.0], [1.0, 1.0, 3.0]]);
        assert_eq!(bounds.min[0].to_bits(), (-0.0f64).to_bits());
        assert_eq!(bounds.min[1].to_bits(), (-0.0f64).to_bits());
        bounds.include_triangle([[0.0, 0.0, 2.0]; 3]);
        assert_eq!(bounds.min[0].to_bits(), (-0.0f64).to_bits());
        assert_eq!(bounds.max, [1.0, 1.0, 3.0]);
    }

    #[test]
    fn invalid_order_ranges_and_counts_are_rejected_before_rendering() {
        let mut cache = SourceCache::new(4096, 8);
        for indices in [vec![0, 1, 2], vec![0, 1, 2, 3, 4, 6]] {
            assert!(cache.retain(mesh(), 6, 72, indices, [0.; 3]).is_err());
        }
        let id = cache.retain(mesh(), 6, 72, vec![], [0.; 3]).unwrap().unwrap();
        let source = cache.get(&id).unwrap();
        for (expected, start, end) in [(3, 0, 1), (6, 1, 1), (6, 2, 1), (6, 0, 3), (6, 0, usize::MAX)] {
            assert!(source.validate_range(expected, start, end).is_err());
        }
        assert_eq!(source.validate_range(6, 1, 2).unwrap(), 36);
    }
}
