use std::sync::Arc;

pub type MaskBounds = (usize, usize, usize, usize);

/// Compact binary mask stored only inside its non-empty global bounds.
///
/// Pixels outside `bounds` are implicitly zero.
#[derive(Clone, Debug, Default)]
pub struct BoundedBinaryMask {
    bounds: Option<MaskBounds>,
    row_width: usize,
    pixels: Arc<Vec<u8>>,
}

impl BoundedBinaryMask {
    pub fn empty() -> Self {
        Self {
            bounds: None,
            row_width: 0,
            pixels: Arc::new(Vec::new()),
        }
    }

    pub fn from_rows(bounds: MaskBounds, pixels: Vec<u8>) -> Self {
        let (min_x, max_x, min_y, max_y) = bounds;
        let row_width = max_x - min_x + 1;
        let expected_len = row_width * (max_y - min_y + 1);
        assert_eq!(
            pixels.len(),
            expected_len,
            "bounded binary mask pixels must match bounds area"
        );
        Self {
            bounds: Some(bounds),
            row_width,
            pixels: Arc::new(pixels),
        }
    }

    pub fn from_full_frame(pixels: Vec<u8>, width: usize, height: usize) -> Self {
        if width == 0 || height == 0 || pixels.is_empty() {
            return Self::empty();
        }
        assert_eq!(
            pixels.len(),
            width.saturating_mul(height),
            "full-frame binary mask pixels must match image dimensions"
        );
        Self {
            bounds: Some((0, width - 1, 0, height - 1)),
            row_width: width,
            pixels: Arc::new(pixels),
        }
    }

    pub fn bounds(&self) -> Option<MaskBounds> {
        self.bounds
    }

    pub fn resident_bytes(&self) -> usize {
        self.pixels.capacity() * std::mem::size_of::<u8>()
    }

    pub fn as_view(&self) -> BoundedBinaryMaskRef<'_> {
        BoundedBinaryMaskRef {
            bounds: self.bounds,
            row_width: self.row_width,
            pixels: self.pixels.as_slice(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BoundedBinaryMaskRef<'a> {
    bounds: Option<MaskBounds>,
    row_width: usize,
    pixels: &'a [u8],
}

impl<'a> BoundedBinaryMaskRef<'a> {
    pub const fn empty() -> Self {
        Self {
            bounds: None,
            row_width: 0,
            pixels: &[],
        }
    }

    pub fn from_full_frame(pixels: &'a [u8], width: usize, height: usize) -> Self {
        if width == 0 || height == 0 || pixels.is_empty() {
            return Self::empty();
        }
        assert_eq!(
            pixels.len(),
            width.saturating_mul(height),
            "full-frame binary mask view must match image dimensions"
        );
        Self {
            bounds: Some((0, width - 1, 0, height - 1)),
            row_width: width,
            pixels,
        }
    }

    pub fn bounds(&self) -> Option<MaskBounds> {
        self.bounds
    }

    pub fn row_width(&self) -> usize {
        self.row_width
    }

    pub fn row(&self, y: usize) -> Option<&'a [u8]> {
        let (min_x, max_x, min_y, max_y) = self.bounds?;
        if y < min_y || y > max_y {
            return None;
        }
        let row_start = (y - min_y) * self.row_width;
        let row_end = row_start + (max_x - min_x + 1);
        Some(&self.pixels[row_start..row_end])
    }

    pub fn row_span(&self, y: usize, min_x: usize, max_x: usize) -> Option<(&'a [u8], usize)> {
        let (row_min_x, row_max_x, _, _) = self.bounds?;
        let row = self.row(y)?;
        let span_min_x = min_x.max(row_min_x);
        let span_max_x = max_x.min(row_max_x);
        if span_min_x > span_max_x {
            return None;
        }
        let local_start = span_min_x - row_min_x;
        let local_end = local_start + (span_max_x - span_min_x + 1);
        Some((&row[local_start..local_end], span_min_x))
    }

    #[inline]
    pub fn sample(&self, x: usize, y: usize) -> u8 {
        let Some((min_x, max_x, min_y, max_y)) = self.bounds else {
            return 0;
        };
        if x < min_x || x > max_x || y < min_y || y > max_y {
            return 0;
        }
        let local_x = x - min_x;
        let local_y = y - min_y;
        self.pixels[local_y * self.row_width + local_x]
    }

    #[inline]
    pub fn is_set(&self, x: usize, y: usize, threshold: u8) -> bool {
        self.sample(x, y) > threshold
    }
}

/// Compact grayscale mask stored only inside its non-empty global bounds.
///
/// Pixels outside `bounds` are implicitly zero.
#[derive(Debug, Default)]
pub struct BoundedGrayMask {
    bounds: Option<MaskBounds>,
    row_width: usize,
    pixels: Vec<u8>,
}

impl BoundedGrayMask {
    pub fn empty() -> Self {
        Self {
            bounds: None,
            row_width: 0,
            pixels: Vec::new(),
        }
    }

    pub fn from_rows(bounds: MaskBounds, pixels: Vec<u8>) -> Self {
        let (min_x, max_x, min_y, max_y) = bounds;
        let row_width = max_x - min_x + 1;
        let expected_len = row_width * (max_y - min_y + 1);
        assert_eq!(
            pixels.len(),
            expected_len,
            "bounded grayscale mask pixels must match bounds area"
        );
        Self {
            bounds: Some(bounds),
            row_width,
            pixels,
        }
    }

    pub fn bounds(&self) -> Option<MaskBounds> {
        self.bounds
    }

    pub fn resident_bytes(&self) -> usize {
        self.pixels.capacity() * std::mem::size_of::<u8>()
    }

    pub fn as_view(&self) -> BoundedGrayMaskRef<'_> {
        BoundedGrayMaskRef {
            bounds: self.bounds,
            row_width: self.row_width,
            pixels: self.pixels.as_slice(),
        }
    }

    pub fn from_full_frame_in_bounds(
        full_frame: Vec<u8>,
        width: usize,
        height: usize,
        bounds: Option<MaskBounds>,
    ) -> Self {
        let Some((min_x, max_x, min_y, max_y)) = bounds else {
            crate::pipeline::return_mask_to_pool(full_frame);
            return Self::empty();
        };
        if width == 0 || height == 0 || full_frame.is_empty() {
            return Self::empty();
        }
        assert_eq!(
            full_frame.len(),
            width.saturating_mul(height),
            "full-frame grayscale mask must match image dimensions"
        );
        let row_width = max_x - min_x + 1;
        let row_count = max_y - min_y + 1;

        if min_x == 0 && row_width == width && min_y == 0 && row_count == height {
            return Self {
                bounds: Some((min_x, max_x, min_y, max_y)),
                row_width,
                pixels: full_frame,
            };
        }

        let mut compact = Vec::with_capacity(row_width.saturating_mul(row_count));
        for y in min_y..=max_y {
            let row_start = y * width + min_x;
            compact.extend_from_slice(&full_frame[row_start..row_start + row_width]);
        }
        crate::pipeline::return_mask_to_pool(full_frame);
        Self {
            bounds: Some((min_x, max_x, min_y, max_y)),
            row_width,
            pixels: compact,
        }
    }

    pub fn into_full_frame(self, width: usize, height: usize) -> Vec<u8> {
        if width == 0 || height == 0 {
            return Vec::new();
        }
        let Some((min_x, max_x, min_y, max_y)) = self.bounds else {
            return crate::pipeline::get_recycled_mask(width.saturating_mul(height));
        };

        if min_x == 0 && max_x + 1 == width && min_y == 0 && max_y + 1 == height {
            return self.pixels;
        }

        let mut full = crate::pipeline::get_recycled_mask(width.saturating_mul(height));
        let row_width = self.row_width;
        for (local_y, compact_row) in self.pixels.chunks(row_width).enumerate() {
            let y = min_y + local_y;
            let row_start = y * width + min_x;
            full[row_start..row_start + row_width].copy_from_slice(compact_row);
        }
        full
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BoundedGrayMaskRef<'a> {
    bounds: Option<MaskBounds>,
    row_width: usize,
    pixels: &'a [u8],
}

impl<'a> BoundedGrayMaskRef<'a> {
    pub const fn empty() -> Self {
        Self {
            bounds: None,
            row_width: 0,
            pixels: &[],
        }
    }

    pub fn bounds(&self) -> Option<MaskBounds> {
        self.bounds
    }

    pub fn row_width(&self) -> usize {
        self.row_width
    }

    pub fn row(&self, y: usize) -> Option<&'a [u8]> {
        let (min_x, max_x, min_y, max_y) = self.bounds?;
        if y < min_y || y > max_y {
            return None;
        }
        let row_start = (y - min_y) * self.row_width;
        let row_end = row_start + (max_x - min_x + 1);
        Some(&self.pixels[row_start..row_end])
    }

    pub fn row_span(&self, y: usize, min_x: usize, max_x: usize) -> Option<(&'a [u8], usize)> {
        let (row_min_x, row_max_x, _, _) = self.bounds?;
        let row = self.row(y)?;
        let span_min_x = min_x.max(row_min_x);
        let span_max_x = max_x.min(row_max_x);
        if span_min_x > span_max_x {
            return None;
        }
        let local_start = span_min_x - row_min_x;
        let local_end = local_start + (span_max_x - span_min_x + 1);
        Some((&row[local_start..local_end], span_min_x))
    }

    #[inline]
    pub fn sample(&self, x: usize, y: usize) -> u8 {
        let Some((min_x, max_x, min_y, max_y)) = self.bounds else {
            return 0;
        };
        if x < min_x || x > max_x || y < min_y || y > max_y {
            return 0;
        }
        let local_x = x - min_x;
        let local_y = y - min_y;
        self.pixels[local_y * self.row_width + local_x]
    }
}

#[cfg(test)]
mod tests {
    use super::{BoundedBinaryMask, BoundedBinaryMaskRef, BoundedGrayMask, BoundedGrayMaskRef};

    #[test]
    fn bounded_binary_mask_samples_inside_and_outside_bounds() {
        let mask = BoundedBinaryMask::from_rows((2, 4, 1, 2), vec![1, 2, 3, 4, 5, 6]);
        let view = mask.as_view();

        assert_eq!(view.sample(2, 1), 1);
        assert_eq!(view.sample(4, 2), 6);
        assert_eq!(view.sample(1, 1), 0);
        assert_eq!(view.sample(5, 2), 0);
        assert_eq!(view.sample(3, 0), 0);
        assert_eq!(view.sample(3, 3), 0);
    }

    #[test]
    fn full_frame_view_exposes_expected_row_spans() {
        let pixels = vec![0u8, 1, 2, 3, 4, 5, 6, 7, 8];
        let view = BoundedBinaryMaskRef::from_full_frame(&pixels, 3, 3);
        let (span, start_x) = view.row_span(1, 1, 2).expect("span should intersect row");
        assert_eq!(start_x, 1);
        assert_eq!(span, &[4, 5]);
    }

    #[test]
    fn bounded_gray_mask_round_trips_through_full_frame() {
        let full = vec![0u8, 1, 2, 3, 4, 5, 6, 7, 8];
        let bounded = BoundedGrayMask::from_full_frame_in_bounds(full, 3, 3, Some((1, 2, 1, 2)));
        let expanded = bounded.into_full_frame(3, 3);
        assert_eq!(expanded, vec![0, 0, 0, 0, 4, 5, 0, 7, 8]);
    }

    #[test]
    fn bounded_gray_view_exposes_expected_row_spans() {
        let full = vec![0u8, 1, 2, 3, 4, 5, 6, 7, 8];
        let bounded = BoundedGrayMask::from_full_frame_in_bounds(full, 3, 3, Some((1, 2, 1, 2)));
        let view: BoundedGrayMaskRef<'_> = bounded.as_view();
        let (span, start_x) = view.row_span(2, 1, 2).expect("span should intersect row");
        assert_eq!(start_x, 1);
        assert_eq!(span, &[7, 8]);
        assert_eq!(view.sample(0, 0), 0);
        assert_eq!(view.sample(1, 1), 4);
    }
}
