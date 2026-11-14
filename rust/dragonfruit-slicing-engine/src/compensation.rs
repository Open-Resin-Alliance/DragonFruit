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
//! The layer is never expanded to pixels. Each row is a list of spans read from the RLE:
//!
//! 1. Spans are joined into regions across rows with a union-find (solid connects 8-ways,
//!    background 4-ways), and a breadth-first walk over the regions gives each its depth.
//!    When both distances are equal every edge moves the same way, so this step is
//!    skipped.
//! 2. "Within `d` mm of set S" is S dilated by an ellipse of radius `d` (a circle in mm):
//!    for each row offset `dy` the spans of row `y + dy` widen by the largest whole number
//!    of pixels `k` with `(k·px)² + (dy·py)² <= d²`, and the widened spans are merged.
//! 3. Intersecting that with the spans of the regions it applies to gives the pixels to
//!    clear or fill, and the row is written back as runs.
//!
//! Step 1 is linear in the number of spans; steps 2 and 3 run row by row in parallel.
//! Spans are kept in flat arrays indexed by row, so memory is a few bytes per span.

use rayon::prelude::*;

use crate::rle::{RleAccum, RleRun};

/// Pixels at or above this value count as solid when finding contours.
const SOLID_THRESHOLD: u8 = 128;

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
}

/// Half-open pixel span `[start, end)` within a row.
type Span = (u32, u32);

/// Non-zero pixels `[start, end)` of one value within a row.
type ValueRun = (u32, u32, u8);

/// Items grouped by row in one flat array: row `y` is `items[start[y]..start[y + 1]]`.
struct Rows<T> {
    items: Vec<T>,
    start: Vec<u32>,
}

impl<T> Rows<T> {
    fn with_capacity(rows: usize, items: usize) -> Self {
        let mut start = Vec::with_capacity(rows + 1);
        start.push(0);
        Self {
            items: Vec::with_capacity(items),
            start,
        }
    }

    /// Close the current row.
    fn end_row(&mut self) {
        self.start.push(self.items.len() as u32);
    }

    fn len(&self) -> usize {
        self.start.len() - 1
    }

    fn row(&self, y: usize) -> &[T] {
        &self.items[self.start[y] as usize..self.start[y + 1] as usize]
    }
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
    let rows = rows_from_rle(runs, width, height);
    let Some(changes) = compensate_rows(&rows, width as u32, comp) else {
        return runs.to_vec();
    };
    let mut rle = RleAccum::new();
    for y in 0..height {
        emit_row(rows.row(y), changes.row(y), width as u32, &mut rle);
    }
    rle.finish()
}

/// Compensate a full-frame, row-major 8-bit mask in place.
pub fn compensate_mask(mask: &mut [u8], width: usize, height: usize, comp: &ContourCompensation) {
    if comp.is_noop() || width == 0 || height == 0 {
        return;
    }
    let mut rows = Rows::with_capacity(height, height * 4);
    for row in mask[..width * height].chunks(width) {
        let mut x = 0u32;
        for run in row.chunk_by(|a, b| a == b) {
            let n = run.len() as u32;
            if run[0] != 0 {
                rows.items.push((x, x + n, run[0]));
            }
            x += n;
        }
        rows.end_row();
    }
    let Some(changes) = compensate_rows(&rows, width as u32, comp) else {
        return;
    };
    for y in 0..height {
        for &(s, e, v) in changes.row(y) {
            mask[y * width + s as usize..y * width + e as usize].fill(v);
        }
    }
}

fn rows_from_rle(runs: &[RleRun], width: usize, height: usize) -> Rows<ValueRun> {
    let total = width * height;
    let mut rows = Rows::with_capacity(height, runs.len());
    let mut pos = 0usize;
    for run in runs {
        let len = run.length as usize;
        let end = (pos + len).min(total);
        if run.value != 0 {
            let mut p = pos;
            while p < end {
                let y = p / width;
                while rows.len() < y {
                    rows.end_row();
                }
                let row_end = ((y + 1) * width).min(end);
                rows.items
                    .push(((p - y * width) as u32, (row_end - y * width) as u32, run.value));
                p = row_end;
            }
        }
        pos = end;
        if pos >= total {
            break;
        }
    }
    while rows.len() < height {
        rows.end_row();
    }
    rows
}

/// The spans to clear (value 0) and fill (value 255) in every row, sorted and disjoint
/// within each row, or `None` when nothing changes.
fn compensate_rows(
    rows: &Rows<ValueRun>,
    width: u32,
    comp: &ContourCompensation,
) -> Option<Rows<ValueRun>> {
    let height = rows.len();
    let solid = solid_spans(rows);
    if solid.items.is_empty() {
        return None;
    }
    let (px, py) = (comp.pitch_x_mm as f64, comp.pitch_y_mm as f64);
    let outline = Ellipse::new(comp.outline_mm, px, py);
    let hole = Ellipse::new(comp.hole_mm, px, py);

    // Equal distances move every edge the same way: removal is the solid within the
    // distance of any background, addition the background within it of any solid. That
    // is the classified result with every case merged, so the depths are not needed.
    let uniform = comp.outline_mm == comp.hole_mm;
    let background = if uniform { Some(background_spans(&solid, width)) } else { None };
    let sets = if uniform { None } else { Some(DepthSets::new(&solid, width)) };

    let per_row: Vec<Vec<ValueRun>> = (0..height)
        .into_par_iter()
        .with_min_len(32)
        .map_init(Scratch::default, |scratch, y| {
            scratch.remove.clear();
            scratch.add.clear();
            if let Some(bg) = &background {
                let mm = comp.outline_mm;
                if mm < 0.0 && !solid.row(y).is_empty() {
                    outline.dilate(bg, y, width, &mut scratch.dilated);
                    intersect_into(solid.row(y), &scratch.dilated, &mut scratch.remove);
                } else if mm > 0.0 {
                    outline.dilate(&solid, y, width, &mut scratch.dilated);
                    intersect_into(bg.row(y), &scratch.dilated, &mut scratch.add);
                }
            } else if let Some(sets) = &sets {
                for (mm, disc, is_outline) in
                    [(comp.outline_mm, &outline, true), (comp.hole_mm, &hole, false)]
                {
                    if mm < 0.0 {
                        // A solid pixel at depth 1 (mod 4) has its outline against
                        // background at depth 0 (mod 4) and its holes against depth 2
                        // (mod 4); a solid at depth 3 (mod 4) the other way round.
                        let (near_sa, near_sb) = if is_outline {
                            (&sets.bg_a, &sets.bg_b)
                        } else {
                            (&sets.bg_b, &sets.bg_a)
                        };
                        for (target, near) in [(&sets.solid_a, near_sa), (&sets.solid_b, near_sb)] {
                            if !target.row(y).is_empty() {
                                disc.dilate(near, y, width, &mut scratch.dilated);
                                intersect_into(target.row(y), &scratch.dilated, &mut scratch.remove);
                            }
                        }
                    } else if mm > 0.0 {
                        // Background at depth 0 (mod 4) is outside the depth-1 solids
                        // (their outline) and is a hole of the depth-3 (mod 4) solids.
                        let (near_a, near_b) = if is_outline {
                            (&sets.solid_a, &sets.solid_b)
                        } else {
                            (&sets.solid_b, &sets.solid_a)
                        };
                        for (target, near) in [(&sets.bg_a, near_a), (&sets.bg_b, near_b)] {
                            if !target.row(y).is_empty() {
                                disc.dilate(near, y, width, &mut scratch.dilated);
                                intersect_into(target.row(y), &scratch.dilated, &mut scratch.add);
                            }
                        }
                    }
                }
            }
            if scratch.remove.is_empty() && scratch.add.is_empty() {
                return Vec::new();
            }
            // Removals only touch solid pixels and additions only background, so the two
            // lists never overlap.
            merge_in_place(&mut scratch.remove);
            merge_in_place(&mut scratch.add);
            let mut change: Vec<ValueRun> = Vec::with_capacity(scratch.remove.len() + scratch.add.len());
            change.extend(scratch.remove.iter().map(|&(s, e)| (s, e, 0)));
            change.extend(scratch.add.iter().map(|&(s, e)| (s, e, 255)));
            change.sort_unstable_by_key(|c| c.0);
            change
        })
        .collect();

    let total: usize = per_row.iter().map(Vec::len).sum();
    if total == 0 {
        return None;
    }
    let mut changes = Rows::with_capacity(height, total);
    for row in per_row {
        changes.items.extend(row);
        changes.end_row();
    }
    Some(changes)
}

/// Buffers reused across the rows one worker thread handles.
#[derive(Default)]
struct Scratch {
    dilated: Vec<Span>,
    remove: Vec<Span>,
    add: Vec<Span>,
}

fn solid_spans(rows: &Rows<ValueRun>) -> Rows<Span> {
    let mut out: Rows<Span> = Rows::with_capacity(rows.len(), rows.items.len());
    for y in 0..rows.len() {
        let first = out.items.len();
        for &(s, e, v) in rows.row(y) {
            if v < SOLID_THRESHOLD {
                continue;
            }
            // Join a run to the previous one only within the same row.
            let joins = out.items.len() > first && out.items.last().is_some_and(|l| l.1 == s);
            if joins {
                if let Some(last) = out.items.last_mut() {
                    last.1 = e;
                }
            } else {
                out.items.push((s, e));
            }
        }
        out.end_row();
    }
    out
}

/// The background of every row: the gaps between its solid spans.
fn background_spans(solid: &Rows<Span>, width: u32) -> Rows<Span> {
    let mut out = Rows::with_capacity(solid.len(), solid.items.len() + solid.len());
    for y in 0..solid.len() {
        let mut x = 0u32;
        for &(s, e) in solid.row(y) {
            if s > x {
                out.items.push((x, s));
            }
            x = e;
        }
        if x < width {
            out.items.push((x, width));
        }
        out.end_row();
    }
    out
}

/// Sort spans and merge the ones that overlap or touch, in place.
fn merge_in_place(spans: &mut Vec<Span>) {
    if spans.len() < 2 {
        return;
    }
    spans.sort_unstable_by_key(|s| s.0);
    let mut w = 0usize;
    for r in 1..spans.len() {
        let (s, e) = spans[r];
        if s <= spans[w].1 {
            spans[w].1 = spans[w].1.max(e);
        } else {
            w += 1;
            spans[w] = (s, e);
        }
    }
    spans.truncate(w + 1);
}

/// Append the pixels in both sorted, disjoint span lists to `out`.
fn intersect_into(a: &[Span], b: &[Span], out: &mut Vec<Span>) {
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let s = a[i].0.max(b[j].0);
        let e = a[i].1.min(b[j].1);
        if s < e {
            out.push((s, e));
        }
        if a[i].1 < b[j].1 {
            i += 1;
        } else {
            j += 1;
        }
    }
}

/// Write one row: the original runs, with `change` (sorted, disjoint) painted over them.
fn emit_row(orig: &[ValueRun], change: &[ValueRun], width: u32, rle: &mut RleAccum) {
    let mut oi = 0usize;
    let mut x = 0u32;
    for &(s, e, v) in change {
        emit_original(orig, &mut oi, x, s, rle);
        rle.push_run(e - s, v);
        x = e;
    }
    emit_original(orig, &mut oi, x, width, rle);
}

/// Write the original pixels `[from, to)` of a row; `oi` walks `orig` forward.
fn emit_original(orig: &[ValueRun], oi: &mut usize, from: u32, to: u32, rle: &mut RleAccum) {
    let mut p = from;
    while p < to {
        while *oi < orig.len() && orig[*oi].1 <= p {
            *oi += 1;
        }
        match orig.get(*oi) {
            Some(&(s, e, v)) if s < to => {
                if s > p {
                    rle.push_run(s - p, 0);
                    p = s;
                }
                let end = e.min(to);
                rle.push_run(end - p, v);
                p = end;
            }
            _ => {
                rle.push_run(to - p, 0);
                p = to;
            }
        }
    }
}

/// An ellipse in pixels that is a circle of `mm` radius in millimetres: for each row
/// offset, how far a span widens.
struct Ellipse {
    /// `(dy, k)`: spans of row `y + dy` widen by `k` pixels on each side.
    offsets: Vec<(i64, u32)>,
}

impl Ellipse {
    fn new(mm: f32, px: f64, py: f64) -> Self {
        let mut offsets = Vec::new();
        if mm != 0.0 && px > 0.0 && py > 0.0 {
            // A pixel is reached when its centre is within the distance; the small
            // allowance keeps pixels lying exactly on the circle.
            let r2 = (mm * mm * (1.0 + 1e-4)) as f64;
            let reach = |rem: f64| {
                let mut k = (rem.max(0.0).sqrt() / px).floor() as u32;
                while ((k + 1) as f64 * px).powi(2) <= rem {
                    k += 1;
                }
                while k > 0 && (k as f64 * px).powi(2) > rem {
                    k -= 1;
                }
                k
            };
            let max_dy = (r2.sqrt() / py).floor() as i64 + 1;
            for dy in -max_dy..=max_dy {
                let rem = r2 - (dy as f64 * py).powi(2);
                if rem >= 0.0 {
                    offsets.push((dy, reach(rem)));
                }
            }
        }
        Self { offsets }
    }

    /// Row `y` of `set` dilated by the ellipse, into `out` (sorted, disjoint spans).
    fn dilate(&self, set: &Rows<Span>, y: usize, width: u32, out: &mut Vec<Span>) {
        out.clear();
        for &(dy, k) in &self.offsets {
            let yy = y as i64 + dy;
            if yy < 0 || yy >= set.len() as i64 {
                continue;
            }
            for &(s, e) in set.row(yy as usize) {
                out.push((s.saturating_sub(k), e.saturating_add(k).min(width)));
            }
        }
        merge_in_place(out);
    }
}

/// One row segment: a maximal solid or background span. The segments of a row cover it.
#[derive(Clone, Copy)]
struct Segment {
    start: u32,
    end: u32,
    solid: bool,
}

/// The spans of each row split by nesting depth (mod 4): background at depth 0 and 2,
/// solid at depth 1 and 3.
struct DepthSets {
    bg_a: Rows<Span>,
    bg_b: Rows<Span>,
    solid_a: Rows<Span>,
    solid_b: Rows<Span>,
}

impl DepthSets {
    fn new(solid: &Rows<Span>, width: u32) -> Self {
        let height = solid.len();
        // Every row as alternating background / solid segments.
        let mut segs: Vec<Segment> = Vec::with_capacity(2 * solid.items.len() + height);
        let mut row_start: Vec<usize> = Vec::with_capacity(height + 1);
        for y in 0..height {
            row_start.push(segs.len());
            let mut x = 0u32;
            for &(s, e) in solid.row(y) {
                if s > x {
                    segs.push(Segment { start: x, end: s, solid: false });
                }
                segs.push(Segment { start: s, end: e, solid: true });
                x = e;
            }
            if x < width {
                segs.push(Segment { start: x, end: width, solid: false });
            }
        }
        row_start.push(segs.len());

        // Regions: union-find over segments. `edges` joins background and solid regions
        // that share a pixel edge.
        let n = segs.len();
        let mut parent: Vec<u32> = (0..n as u32).collect();
        let mut edges: Vec<(u32, u32)> = Vec::with_capacity(2 * n);
        for y in 0..height {
            let row = row_start[y]..row_start[y + 1];
            for i in row.start + 1..row.end {
                edges.push(((i - 1) as u32, i as u32));
            }
            if y == 0 {
                continue;
            }
            let prev = row_start[y - 1]..row_start[y];
            let mut j0 = prev.start;
            for i in row {
                let c = segs[i];
                while j0 < prev.end && segs[j0].end < c.start {
                    j0 += 1;
                }
                let mut j = j0;
                while j < prev.end && segs[j].start <= c.end {
                    let t = segs[j];
                    let shares_edge = t.start < c.end && c.start < t.end;
                    if t.solid == c.solid {
                        // Solid touching at a corner is one region; background is not.
                        if c.solid || shares_edge {
                            union(&mut parent, i as u32, j as u32);
                        }
                    } else if shares_edge {
                        edges.push((i as u32, j as u32));
                    }
                    j += 1;
                }
            }
        }
        for i in 0..n as u32 {
            let r = find(&mut parent, i);
            parent[i as usize] = r;
        }
        let region = parent;

        // Region graph (compressed adjacency), then depth = breadth-first distance from
        // the outside.
        let mut offset = vec![0u32; n + 1];
        for &(a, b) in &edges {
            offset[region[a as usize] as usize + 1] += 1;
            offset[region[b as usize] as usize + 1] += 1;
        }
        for r in 0..n {
            offset[r + 1] += offset[r];
        }
        let mut fill = offset.clone();
        let mut adjacent = vec![0u32; offset[n] as usize];
        for &(a, b) in &edges {
            let (ra, rb) = (region[a as usize], region[b as usize]);
            adjacent[fill[ra as usize] as usize] = rb;
            fill[ra as usize] += 1;
            adjacent[fill[rb as usize] as usize] = ra;
            fill[rb as usize] += 1;
        }
        drop(edges);

        let mut depth = vec![u32::MAX; n];
        let mut queue: Vec<u32> = Vec::new();
        let seed = |seg: usize, d: u32, depth: &mut Vec<u32>, queue: &mut Vec<u32>| {
            let r = region[seg] as usize;
            if depth[r] == u32::MAX {
                depth[r] = d;
                queue.push(r as u32);
            }
        };
        // Background touching the frame edge is the outside.
        for y in 0..height {
            let row = row_start[y]..row_start[y + 1];
            let edge_row = y == 0 || y + 1 == height;
            for i in row.clone() {
                let first_or_last = i == row.start || i + 1 == row.end;
                if !segs[i].solid && (edge_row || first_or_last) {
                    seed(i, 0, &mut depth, &mut queue);
                }
            }
        }
        if queue.is_empty() {
            // Solid on every edge pixel: the solid on the top row and left column is the
            // outermost region.
            for y in 0..height {
                let first = row_start[y];
                for (k, s) in segs[first..row_start[y + 1]].iter().enumerate() {
                    if y == 0 || s.start == 0 {
                        seed(first + k, 1, &mut depth, &mut queue);
                    }
                }
            }
        }
        // Breadth-first: `queue` only grows, `head` walks it.
        let mut head = 0;
        while head < queue.len() {
            let r = queue[head] as usize;
            head += 1;
            let d = depth[r] + 1;
            for &next in &adjacent[offset[r] as usize..offset[r + 1] as usize] {
                if depth[next as usize] == u32::MAX {
                    depth[next as usize] = d;
                    queue.push(next);
                }
            }
        }

        let cap = segs.len();
        let mut sets = Self {
            bg_a: Rows::with_capacity(height, cap / 2),
            bg_b: Rows::with_capacity(height, cap / 8),
            solid_a: Rows::with_capacity(height, cap / 2),
            solid_b: Rows::with_capacity(height, cap / 8),
        };
        for y in 0..height {
            for i in row_start[y]..row_start[y + 1] {
                let s = segs[i];
                let d = match depth[region[i] as usize] {
                    u32::MAX => 0,
                    d => d,
                };
                let target = match (s.solid, d % 4) {
                    (false, 0) => &mut sets.bg_a,
                    (false, _) => &mut sets.bg_b,
                    (true, 1) => &mut sets.solid_a,
                    (true, _) => &mut sets.solid_b,
                };
                target.items.push((s.start, s.end));
            }
            sets.bg_a.end_row();
            sets.bg_b.end_row();
            sets.solid_a.end_row();
            sets.solid_b.end_row();
        }
        sets
    }
}

fn find(parent: &mut [u32], mut i: u32) -> u32 {
    while parent[i as usize] != i {
        let up = parent[parent[i as usize] as usize];
        parent[i as usize] = up;
        i = up;
    }
    i
}

fn union(parent: &mut [u32], a: u32, b: u32) {
    let (ra, rb) = (find(parent, a), find(parent, b));
    if ra != rb {
        parent[ra.max(rb) as usize] = ra.min(rb);
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

    /// Pixel-by-pixel reference: nesting depth by flood fill, distance by checking every
    /// pixel in reach.
    fn reference(mask: &[u8], w: usize, h: usize, c: &ContourCompensation) -> Vec<u8> {
        let solid: Vec<bool> = mask.iter().map(|&v| v >= SOLID_THRESHOLD).collect();
        let mut depth = vec![u32::MAX; w * h];
        let mut queue = std::collections::VecDeque::new();
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if (x == 0 || y == 0 || x + 1 == w || y + 1 == h) && !solid[i] {
                    depth[i] = 0;
                    queue.push_back(i);
                }
            }
        }
        // Flood each region at its depth before stepping into the next one.
        let mut next = std::collections::VecDeque::new();
        let mut level = 0u32;
        while !queue.is_empty() {
            while let Some(i) = queue.pop_front() {
                let (x, y) = ((i % w) as i64, (i / w) as i64);
                for (dx, dy) in [
                    (-1, 0),
                    (1, 0),
                    (0, -1),
                    (0, 1),
                    (-1, -1),
                    (1, -1),
                    (-1, 1),
                    (1, 1),
                ] {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                        continue;
                    }
                    let j = ny as usize * w + nx as usize;
                    let diagonal = dx != 0 && dy != 0;
                    if depth[j] != u32::MAX || (diagonal && !solid[i] && solid[j] == solid[i]) {
                        continue;
                    }
                    if diagonal && solid[i] && !solid[j] {
                        continue;
                    }
                    if solid[j] == solid[i] {
                        depth[j] = level;
                        queue.push_back(j);
                    } else {
                        depth[j] = level + 1;
                        next.push_back(j);
                    }
                }
            }
            std::mem::swap(&mut queue, &mut next);
            level += 1;
        }
        let within = |i: usize, mm: f32, target: &dyn Fn(usize) -> bool| {
            let r2 = (mm * mm * (1.0 + 1e-4)) as f64;
            let (px, py) = (c.pitch_x_mm as f64, c.pitch_y_mm as f64);
            let (x, y) = ((i % w) as i64, (i / w) as i64);
            let (rx, ry) = ((r2.sqrt() / px) as i64 + 1, (r2.sqrt() / py) as i64 + 1);
            for yy in (y - ry).max(0)..=(y + ry).min(h as i64 - 1) {
                for xx in (x - rx).max(0)..=(x + rx).min(w as i64 - 1) {
                    let d2 = ((xx - x) as f64 * px).powi(2) + ((yy - y) as f64 * py).powi(2);
                    if d2 <= r2 && target(yy as usize * w + xx as usize) {
                        return true;
                    }
                }
            }
            false
        };
        let mut out = mask.to_vec();
        for i in 0..w * h {
            let d = depth[i];
            for (mm, outline) in [(c.outline_mm, true), (c.hole_mm, false)] {
                if solid[i] && mm < 0.0 {
                    // the background this pixel's outline (or hole) faces
                    let want = if outline { d - 1 } else { d + 1 };
                    if within(i, mm, &|j| !solid[j] && depth[j] % 4 == want % 4) {
                        out[i] = 0;
                    }
                }
                if !solid[i] && mm > 0.0 && out[i] != 255 {
                    // the solid whose outline (or hole) this background pixel is
                    let want = if outline { d + 1 } else { d.wrapping_sub(1) };
                    if within(i, mm, &|j| solid[j] && depth[j] % 4 == want % 4) {
                        out[i] = 255;
                    }
                }
            }
        }
        out
    }

    /// Small deterministic pseudo-random generator for test shapes.
    fn lcg(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *seed >> 33
    }

    #[test]
    fn matches_pixel_reference_on_random_shapes() {
        let (w, h) = (120usize, 90usize);
        let mut changed = [false; 8];
        for case in 0..32u64 {
            let mut seed = case + 1;
            let mut m = vec![0u8; w * h];
            // Discs and boxes, alternately solid and empty, so regions nest and touch.
            // Groups of a solid, a hole inside it and an island inside the hole (each
            // nudged off centre), plus loose shapes that overlap and cut into them.
            let mut shapes: Vec<(i64, i64, i64, u8)> = Vec::new();
            for _ in 0..3 {
                let cx = (lcg(&mut seed) % w as u64) as i64;
                let cy = (lcg(&mut seed) % h as u64) as i64;
                let r = 18 + (lcg(&mut seed) % 14) as i64;
                let mut nudge = || (lcg(&mut seed) % 5) as i64 - 2;
                shapes.push((cx, cy, r, 255));
                shapes.push((cx + nudge(), cy + nudge(), r * 3 / 5, 0));
                shapes.push((cx + nudge(), cy + nudge(), r / 4, 255));
            }
            for k in 0..4 {
                let cx = (lcg(&mut seed) % w as u64) as i64;
                let cy = (lcg(&mut seed) % h as u64) as i64;
                let r = 3 + (lcg(&mut seed) % 12) as i64;
                shapes.push((cx, cy, r, if k % 2 == 0 { 0 } else { 255 }));
            }
            for (cx, cy, r, v) in shapes {
                let disc = lcg(&mut seed) & 1 == 0;
                for y in 0..h as i64 {
                    for x in 0..w as i64 {
                        let inside = if disc {
                            (x - cx).pow(2) + (y - cy).pow(2) <= r * r
                        } else {
                            (x - cx).abs() <= r && (y - cy).abs() <= r / 2
                        };
                        if inside {
                            m[y as usize * w + x as usize] = v;
                        }
                    }
                }
            }
            let settings = [
                (-0.1, 0.0),
                (0.0, -0.1),
                (-0.08, -0.12),
                (0.1, 0.0),
                (0.0, 0.07),
                (0.06, -0.09),
                // Equal distances take the path that skips the depths.
                (-0.1, -0.1),
                (0.08, 0.08),
            ];
            let (o, hm) = settings[case as usize % settings.len()];
            let c = comp(o, hm);
            let mut got = m.clone();
            compensate_mask(&mut got, w, h, &c);
            if got != m {
                changed[case as usize % settings.len()] = true;
            }
            assert_eq!(got, reference(&m, w, h, &c), "case {case} ({o}, {hm})");
        }
        assert!(
            changed.iter().all(|&c| c),
            "every setting moved something: {changed:?}"
        );
    }
}
