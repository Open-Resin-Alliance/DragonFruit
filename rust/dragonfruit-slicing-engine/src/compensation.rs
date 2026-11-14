//! Bottom-layer contour compensation ("elephant's foot" compensation).
//!
//! The long bottom exposures flare every edge that touches the build plate: outlines
//! print wider and holes print smaller. This pass moves the edges of the bottom and
//! transition layers by a set distance in millimetres before the layer is encoded, with
//! one distance for **outer outlines** and one for **holes**:
//!
//! - a negative distance removes material at that kind of contour (outlines shrink,
//!   holes open), a positive one adds material;
//! - an island standing inside a hole is an outer outline (it moves with the outline
//!   setting, not the hole setting);
//! - the two settings are independent of each other;
//! - the distance is exact on each axis for non-square pixels (each pixel is moved when
//!   its centre lies within the distance of the contour, measured in millimetres).
//!
//! Contours are told apart by nesting depth: background connected to the frame edge is
//! depth 0, solid regions touching it are depth 1, the holes inside those are depth 2,
//! islands inside the holes depth 3, and so on. A solid pixel at depth `d` meets its
//! outer outline where it borders background at depth `d - 1`, and a hole where it
//! borders background at depth `d + 1`.
//!
//! Work is confined to the layer's lit bounding box (plus the compensation distance),
//! and at most one layer is compensated at a time, which bounds memory to a few bytes
//! per pixel of that box.

use std::collections::VecDeque;
use std::sync::Mutex;

use crate::rle::{RleAccum, RleRun};

/// Pixels at or above this value count as solid when finding contours.
const SOLID_THRESHOLD: u8 = 128;

/// Serializes compensation so only one layer's working buffers exist at a time.
static COMPENSATION_LOCK: Mutex<()> = Mutex::new(());

/// Distances and pixel pitch for one layer's compensation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContourCompensation {
    /// Outer outlines: negative shrinks, positive grows (mm).
    pub outline_mm: f32,
    /// Holes: negative opens, positive closes (mm).
    pub hole_mm: f32,
    /// Size of one raster pixel on X and Y (mm).
    pub pitch_x_mm: f32,
    pub pitch_y_mm: f32,
}

impl ContourCompensation {
    pub fn is_noop(&self) -> bool {
        self.outline_mm == 0.0 && self.hole_mm == 0.0
    }

    fn margin_px(&self) -> (usize, usize) {
        let reach = self.outline_mm.abs().max(self.hole_mm.abs());
        (
            (reach / self.pitch_x_mm.max(1e-6)).ceil() as usize + 2,
            (reach / self.pitch_y_mm.max(1e-6)).ceil() as usize + 2,
        )
    }
}

/// A rectangular window of the frame.
#[derive(Debug, Clone, Copy)]
struct Window {
    x0: usize,
    y0: usize,
    w: usize,
    h: usize,
}

/// Compensate a full-frame, row-major RLE layer. Returns the input unchanged when there
/// is nothing to do.
pub fn compensate_rle(
    runs: &[RleRun],
    width: usize,
    height: usize,
    comp: &ContourCompensation,
) -> Vec<RleRun> {
    if comp.is_noop() || width == 0 || height == 0 {
        return runs.to_vec();
    }
    let Some(window) = lit_window_from_rle(runs, width, height, comp) else {
        return runs.to_vec();
    };
    let mut values = vec![0u8; window.w * window.h];
    fill_window_from_rle(runs, width, &window, &mut values);
    compensate_window(&mut values, &window, comp);
    encode_window_to_rle(&values, &window, width, height)
}

/// Compensate a full-frame, row-major 8-bit mask in place.
pub fn compensate_mask(mask: &mut [u8], width: usize, height: usize, comp: &ContourCompensation) {
    if comp.is_noop() || width == 0 || height == 0 {
        return;
    }
    let Some(window) = lit_window_from_mask(mask, width, height, comp) else {
        return;
    };
    let mut values = vec![0u8; window.w * window.h];
    for row in 0..window.h {
        let src = (window.y0 + row) * width + window.x0;
        values[row * window.w..(row + 1) * window.w].copy_from_slice(&mask[src..src + window.w]);
    }
    compensate_window(&mut values, &window, comp);
    for row in 0..window.h {
        let dst = (window.y0 + row) * width + window.x0;
        mask[dst..dst + window.w].copy_from_slice(&values[row * window.w..(row + 1) * window.w]);
    }
}

fn padded_window(
    (min_x, min_y, max_x, max_y): (usize, usize, usize, usize),
    width: usize,
    height: usize,
    comp: &ContourCompensation,
) -> Window {
    let (mx, my) = comp.margin_px();
    let x0 = min_x.saturating_sub(mx);
    let y0 = min_y.saturating_sub(my);
    let x1 = (max_x + mx + 1).min(width);
    let y1 = (max_y + my + 1).min(height);
    Window {
        x0,
        y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

fn lit_window_from_rle(
    runs: &[RleRun],
    width: usize,
    height: usize,
    comp: &ContourCompensation,
) -> Option<Window> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (usize::MAX, usize::MAX, 0, 0);
    let mut pos = 0usize;
    for run in runs {
        let len = run.length as usize;
        if run.value >= SOLID_THRESHOLD && len > 0 {
            let (first, last) = (pos, pos + len - 1);
            let (fy, ly) = (first / width, last / width);
            min_y = min_y.min(fy);
            max_y = max_y.max(ly);
            if fy == ly {
                min_x = min_x.min(first % width);
                max_x = max_x.max(last % width);
            } else {
                min_x = 0;
                max_x = width - 1;
            }
        }
        pos += len;
    }
    (min_y != usize::MAX).then(|| padded_window((min_x, min_y, max_x, max_y), width, height, comp))
}

fn lit_window_from_mask(
    mask: &[u8],
    width: usize,
    height: usize,
    comp: &ContourCompensation,
) -> Option<Window> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (usize::MAX, usize::MAX, 0, 0);
    for y in 0..height {
        let row = &mask[y * width..(y + 1) * width];
        if let Some(first) = row.iter().position(|&v| v >= SOLID_THRESHOLD) {
            let last = row
                .iter()
                .rposition(|&v| v >= SOLID_THRESHOLD)
                .unwrap_or(first);
            min_x = min_x.min(first);
            max_x = max_x.max(last);
            min_y = min_y.min(y);
            max_y = y;
        }
    }
    (min_y != usize::MAX).then(|| padded_window((min_x, min_y, max_x, max_y), width, height, comp))
}

fn fill_window_from_rle(runs: &[RleRun], width: usize, window: &Window, values: &mut [u8]) {
    let mut pos = 0usize;
    for run in runs {
        let len = run.length as usize;
        if run.value != 0 {
            let mut p = pos;
            let end = pos + len;
            while p < end {
                let y = p / width;
                let row_end = ((y + 1) * width).min(end);
                if y >= window.y0 && y < window.y0 + window.h {
                    let a = (p % width).max(window.x0);
                    let b = (row_end - y * width).min(window.x0 + window.w);
                    if a < b {
                        let base = (y - window.y0) * window.w;
                        values[base + a - window.x0..base + b - window.x0].fill(run.value);
                    }
                }
                p = row_end;
            }
        }
        pos += len;
    }
}

fn encode_window_to_rle(
    values: &[u8],
    window: &Window,
    width: usize,
    height: usize,
) -> Vec<RleRun> {
    let mut rle = RleAccum::new();
    rle.push_run((window.y0 * width) as u32, 0);
    for row in 0..window.h {
        rle.push_run(window.x0 as u32, 0);
        for run in values[row * window.w..(row + 1) * window.w].chunk_by(|a, b| a == b) {
            rle.push_run(run.len() as u32, run[0]);
        }
        rle.push_run((width - window.x0 - window.w) as u32, 0);
    }
    rle.push_run(((height - window.y0 - window.h) * width) as u32, 0);
    rle.finish()
}

/// Nesting depth of every pixel in the window: even depths are background (0 = connected
/// to the window edge), odd depths are solid. Solid regions connect 8-ways and background
/// 4-ways, so the two never cross each other.
fn nesting_depths(solid: &[bool], w: usize, h: usize) -> Vec<u8> {
    const UNSET: u8 = u8::MAX;
    let mut depth = vec![UNSET; w * h];
    let mut current: VecDeque<usize> = VecDeque::new();
    let mut next: VecDeque<usize> = VecDeque::new();
    for x in 0..w {
        current.push_back(x);
        current.push_back((h - 1) * w + x);
    }
    for y in 0..h {
        current.push_back(y * w);
        current.push_back(y * w + w - 1);
    }
    current.retain(|&i| !solid[i]);
    for &i in &current {
        depth[i] = 0;
    }
    if current.is_empty() {
        // Solid touches every window edge: treat the whole edge as the outside.
        for &i in &(0..w).chain((0..h).map(|y| y * w)).collect::<Vec<_>>() {
            if depth[i] == UNSET {
                depth[i] = 1;
                current.push_back(i);
            }
        }
    }
    let mut level = if current.iter().all(|&i| !solid[i]) {
        0u8
    } else {
        1u8
    };
    while !current.is_empty() {
        let region_is_solid = level % 2 == 1;
        while let Some(i) = current.pop_front() {
            let (x, y) = (i % w, i / w);
            let mut visit = |nx: usize, ny: usize, diagonal: bool| {
                let j = ny * w + nx;
                if depth[j] != UNSET {
                    return;
                }
                if solid[j] == region_is_solid {
                    if diagonal && !region_is_solid {
                        return; // background only connects 4-ways
                    }
                    depth[j] = level;
                    current.push_back(j);
                } else if !diagonal || !region_is_solid {
                    // first contact with the next region inward
                    depth[j] = level.saturating_add(1);
                    next.push_back(j);
                } else {
                    // a solid region touching background only diagonally is not a contact
                }
            };
            for (dx, dy, diag) in [
                (-1i32, 0i32, false),
                (1, 0, false),
                (0, -1, false),
                (0, 1, false),
                (-1, -1, true),
                (1, -1, true),
                (-1, 1, true),
                (1, 1, true),
            ] {
                let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
                    visit(nx as usize, ny as usize, diag);
                }
            }
        }
        std::mem::swap(&mut current, &mut next);
        level = level.saturating_add(1);
    }
    // Anything never reached (cannot happen for a connected window) stays background.
    for d in depth.iter_mut() {
        if *d == UNSET {
            *d = 0;
        }
    }
    depth
}

/// Squared distance (mm^2) from every pixel centre to the nearest pixel in `set`, by the
/// separable exact Euclidean distance transform (Felzenszwalb & Huttenlocher), with the
/// real pixel pitch on each axis.
fn squared_distance_to(set: &[bool], w: usize, h: usize, px: f32, py: f32) -> Vec<f32> {
    let inf = f32::INFINITY;
    let mut out = vec![inf; w * h];
    let n = w.max(h);
    let (mut f, mut d, mut v, mut z) = (
        vec![0f32; n],
        vec![0f32; n],
        vec![0usize; n],
        vec![0f32; n + 1],
    );
    for y in 0..h {
        for x in 0..w {
            f[x] = if set[y * w + x] { 0.0 } else { inf };
        }
        distance_1d(&f[..w], px, &mut d[..w], &mut v, &mut z);
        out[y * w..(y + 1) * w].copy_from_slice(&d[..w]);
    }
    for x in 0..w {
        for y in 0..h {
            f[y] = out[y * w + x];
        }
        distance_1d(&f[..h], py, &mut d[..h], &mut v, &mut z);
        for y in 0..h {
            out[y * w + x] = d[y];
        }
    }
    out
}

/// One-dimensional squared distance transform of `f` with sample spacing `s`.
fn distance_1d(f: &[f32], s: f32, d: &mut [f32], v: &mut [usize], z: &mut [f32]) {
    let n = f.len();
    let first = match f.iter().position(|x| x.is_finite()) {
        Some(i) => i,
        None => {
            d.fill(f32::INFINITY);
            return;
        }
    };
    let pos = |i: usize| i as f32 * s;
    let mut k = 0usize;
    v[0] = first;
    z[0] = f32::NEG_INFINITY;
    z[1] = f32::INFINITY;
    for q in first + 1..n {
        if !f[q].is_finite() {
            continue;
        }
        loop {
            let p = v[k];
            let sq =
                ((f[q] + pos(q) * pos(q)) - (f[p] + pos(p) * pos(p))) / (2.0 * (pos(q) - pos(p)));
            if sq <= z[k] && k > 0 {
                k -= 1;
                continue;
            }
            if sq <= z[k] {
                // k == 0: q replaces the first parabola
                v[0] = q;
                z[0] = f32::NEG_INFINITY;
                z[1] = f32::INFINITY;
                break;
            }
            k += 1;
            v[k] = q;
            z[k] = sq;
            z[k + 1] = f32::INFINITY;
            break;
        }
    }
    k = 0;
    for q in 0..n {
        while z[k + 1] < pos(q) {
            k += 1;
        }
        let dq = pos(q) - pos(v[k]);
        d[q] = dq * dq + f[v[k]];
    }
}

fn compensate_window(values: &mut [u8], window: &Window, comp: &ContourCompensation) {
    let _guard = COMPENSATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (w, h) = (window.w, window.h);
    let solid: Vec<bool> = values.iter().map(|&v| v >= SOLID_THRESHOLD).collect();
    let depth = nesting_depths(&solid, w, h);
    let (px, py) = (comp.pitch_x_mm, comp.pitch_y_mm);

    // Background at depth 0, 4, 8, ... is "set A", at 2, 6, 10, ... "set B". A solid pixel
    // at depth 1 (mod 4) has its outline against A and its holes against B; at depth 3
    // (mod 4) the other way round. Likewise for solid sets when adding material.
    let background_a: Vec<bool> = (0..w * h).map(|i| !solid[i] && depth[i] % 4 == 0).collect();
    let background_b: Vec<bool> = (0..w * h).map(|i| !solid[i] && depth[i] % 4 == 2).collect();
    let solid_a: Vec<bool> = (0..w * h).map(|i| solid[i] && depth[i] % 4 == 1).collect();
    let solid_b: Vec<bool> = (0..w * h).map(|i| solid[i] && depth[i] % 4 == 3).collect();

    let removes = |mm: f32| mm < 0.0;
    let reach2 = |mm: f32| mm * mm * (1.0 + 1e-4);

    // Removal: solid pixels within the distance of their own outline / hole background.
    let mut remove = vec![false; w * h];
    for (mm, outline) in [(comp.outline_mm, true), (comp.hole_mm, false)] {
        if !removes(mm) {
            continue;
        }
        let (r2, da, db) = (
            reach2(mm),
            squared_distance_to(&background_a, w, h, px, py),
            squared_distance_to(&background_b, w, h, px, py),
        );
        for i in 0..w * h {
            if !solid[i] {
                continue;
            }
            let in_a_side = depth[i] % 4 == 1;
            let dist = if in_a_side == outline { da[i] } else { db[i] };
            if dist <= r2 {
                remove[i] = true;
            }
        }
    }

    // Addition: background pixels within the distance of the solid region whose outline /
    // hole they belong to.
    let mut add = vec![false; w * h];
    for (mm, outline) in [(comp.outline_mm, true), (comp.hole_mm, false)] {
        if mm <= 0.0 {
            continue;
        }
        let (r2, sa, sb) = (
            reach2(mm),
            squared_distance_to(&solid_a, w, h, px, py),
            squared_distance_to(&solid_b, w, h, px, py),
        );
        for i in 0..w * h {
            if solid[i] {
                continue;
            }
            // Background at depth 0 (mod 4) is outside the depth-1 solids (their outline)
            // and is a hole of the depth-3 (mod 4) solids.
            let a_depth = depth[i] % 4 == 0;
            let dist = if a_depth == outline { sa[i] } else { sb[i] };
            if dist <= r2 {
                add[i] = true;
            }
        }
    }

    for i in 0..w * h {
        if remove[i] {
            values[i] = 0;
        } else if add[i] {
            values[i] = 255;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 400;
    const H: usize = 300;

    /// A plate with a square hole, and an island post inside a larger square hole.
    fn test_mask() -> Vec<u8> {
        let mut m = vec![0u8; W * H];
        let mut fill = |x0: usize, y0: usize, x1: usize, y1: usize, v: u8| {
            for y in y0..y1 {
                m[y * W + x0..y * W + x1].fill(v);
            }
        };
        fill(50, 50, 350, 250, 255); // plate 300 x 200 px
        fill(100, 100, 140, 140, 0); // hole 40 x 40
        fill(200, 100, 300, 200, 0); // hole 100 x 100
        fill(230, 130, 270, 170, 255); // island 40 x 40 inside it
        m
    }

    /// Width and height (px) of the solid or empty rectangle containing (x, y).
    fn extent(mask: &[u8], x: usize, y: usize) -> (usize, usize) {
        let want = mask[y * W + x] >= SOLID_THRESHOLD;
        let same = |xx: usize, yy: usize| (mask[yy * W + xx] >= SOLID_THRESHOLD) == want;
        let (mut l, mut r, mut t, mut b) = (x, x, y, y);
        while l > 0 && same(l - 1, y) {
            l -= 1;
        }
        while r + 1 < W && same(r + 1, y) {
            r += 1;
        }
        while t > 0 && same(x, t - 1) {
            t -= 1;
        }
        while b + 1 < H && same(x, b + 1) {
            b += 1;
        }
        (r - l + 1, b - t + 1)
    }

    fn comp(outline_mm: f32, hole_mm: f32) -> ContourCompensation {
        // non-square pixels: 0.014 x 0.019 mm, as on a Saturn 4 Ultra 16K
        ContourCompensation {
            outline_mm,
            hole_mm,
            pitch_x_mm: 0.014,
            pitch_y_mm: 0.019,
        }
    }

    fn run(c: ContourCompensation) -> Vec<u8> {
        let mut m = test_mask();
        compensate_mask(&mut m, W, H, &c);
        m
    }

    #[test]
    fn negative_outline_shrinks_plate_and_island_only() {
        // 0.14mm = 10 px on X, 7 px on Y (0.133mm; 8 px would be 0.152mm)
        let m = run(comp(-0.14, 0.0));
        assert_eq!(extent(&m, 60, 240), (300 - 20, 200 - 14), "plate outline");
        assert_eq!(
            extent(&m, 250, 150),
            (40 - 20, 40 - 14),
            "island is an outline"
        );
        assert_eq!(extent(&m, 120, 120), (40, 40), "small hole untouched");
        assert_eq!(extent(&m, 210, 110), (100, 100), "large hole untouched");
    }

    #[test]
    fn negative_hole_opens_holes_only() {
        let m = run(comp(0.0, -0.14));
        assert_eq!(extent(&m, 120, 120), (40 + 20, 40 + 14), "small hole");
        assert_eq!(extent(&m, 210, 110), (100 + 20, 100 + 14), "large hole");
        assert_eq!(extent(&m, 250, 150), (40, 40), "island untouched");
        assert_eq!(extent(&m, 60, 240), (300, 200), "plate untouched");
    }

    #[test]
    fn positive_values_add_material() {
        let m = run(comp(0.14, 0.14));
        assert_eq!(extent(&m, 60, 240).0, 300 + 20, "plate grows");
        assert_eq!(extent(&m, 120, 120), (40 - 20, 40 - 14), "hole closes");
        assert_eq!(extent(&m, 250, 150), (40 + 20, 40 + 14), "island grows");
    }

    #[test]
    fn settings_are_independent() {
        let both = run(comp(-0.14, -0.14));
        let outline = run(comp(-0.14, 0.0));
        let hole = run(comp(0.0, -0.14));
        assert_eq!(extent(&both, 60, 240), extent(&outline, 60, 240));
        assert_eq!(extent(&both, 250, 150), extent(&outline, 250, 150));
        assert_eq!(extent(&both, 120, 120), extent(&hole, 120, 120));
    }

    #[test]
    fn rle_and_mask_paths_agree() {
        let c = comp(-0.1, -0.05);
        let mut mask = test_mask();
        let runs = crate::raster::encode_mask_to_rle(&mask, W, H);
        compensate_mask(&mut mask, W, H, &c);
        let from_rle = crate::rle::expand_rle_to_mask(&compensate_rle(&runs, W, H, &c), W * H);
        assert_eq!(from_rle, mask);
    }

    #[test]
    fn zero_is_a_no_op_and_empty_layers_pass_through() {
        assert_eq!(run(comp(0.0, 0.0)), test_mask());
        let empty = vec![RleRun {
            length: (W * H) as u32,
            value: 0,
        }];
        assert_eq!(compensate_rle(&empty, W, H, &comp(-0.2, -0.2)), empty);
    }
}
