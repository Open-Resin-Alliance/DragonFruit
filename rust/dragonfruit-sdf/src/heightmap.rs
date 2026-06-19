//! Clearance heightmap — 2D grid of per-XY highest-blocked Z.
//!
//! For each XY grid cell, scans vertically through the SDF to find the
//! highest Z where `sdf.distanceAt(x, y, z) < clearance`.  Cells above this
//! Z can drop straight down to the build plate without hitting geometry.
//!
//! Used by the A* pathfinder as a tight admissible heuristic and for O(1)
//! straight-descent viability checks.
//!
//! ## Serialisation Format (binary, little-endian)
//!
//! ```text
//! Header (24 bytes):
//!   magic:       u32  = 0x484D4150  ("HMAP")
//!   version:     u32  = 1
//!   width:       u32
//!   height:      u32
//!   cell_size:   f32
//!   clearance:   f32
//!
//! Body:
//!   width × height f32 LE values (row-major, Y-major)
//!   Each value is the highest blocked Z in model-local mm.
//!   A value of -inf (f32::NEG_INFINITY) means the column is entirely clear.
//! ```

use crate::grid::SparseSdfGrid;

// ---------------------------------------------------------------------------
// ClearanceHeightmap
// ---------------------------------------------------------------------------

/// Pre-computed 2D clearance heightmap.
#[derive(Debug, Clone)]
pub struct ClearanceHeightmap {
    /// Grid cell size in model-space mm (matches SDF cell_size).
    pub cell_size: f32,
    /// Clearance margin used during computation (matches shaft radius + safety).
    pub clearance: f32,
    /// Grid width in cells.
    pub width: u32,
    /// Grid height in cells.
    pub height: u32,
    /// Grid origin in model-local space (min X, min Y).
    pub origin_x: f32,
    pub origin_y: f32,
    /// Row-major f32 values: `data[y * width + x]` = highest blocked Z.
    data: Vec<f32>,
}

impl ClearanceHeightmap {
    /// Look up the highest blocked Z at a model-local XY position.
    /// Returns f32::NEG_INFINITY if the column is entirely clear
    /// (or the position is outside the grid bounds).
    #[inline]
    pub fn get(&self, wx: f32, wy: f32) -> f32 {
        let cx = ((wx - self.origin_x) / self.cell_size).floor() as i32;
        let cy = ((wy - self.origin_y) / self.cell_size).floor() as i32;
        if cx < 0 || cy < 0 || cx as u32 >= self.width || cy as u32 >= self.height {
            return f32::NEG_INFINITY;
        }
        self.data[cy as usize * self.width as usize + cx as usize]
    }

    /// Returns true if a straight-down column from (wx, wy, z) to the plate
    /// (Z=0) is clear of geometry, given the shaft clearance margin.
    #[inline]
    pub fn column_is_clear(&self, wx: f32, wy: f32, z: f32) -> bool {
        let blocked_z = self.get(wx, wy);
        z > blocked_z
    }

    /// Number of cells in the grid.
    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    // ---- Serialisation ----

    const MAGIC: u32 = 0x484D4150; // "HMAP"
    const VERSION: u32 = 1;
    const HEADER_BYTES: usize = 24;

    /// Serialise to a compact binary blob (little-endian).
    pub fn to_bytes(&self) -> Vec<u8> {
        let cell_count = self.width as usize * self.height as usize;
        let mut buf = Vec::with_capacity(Self::HEADER_BYTES + cell_count * 4);

        // Header
        buf.extend_from_slice(&Self::MAGIC.to_le_bytes());
        buf.extend_from_slice(&Self::VERSION.to_le_bytes());
        buf.extend_from_slice(&self.width.to_le_bytes());
        buf.extend_from_slice(&self.height.to_le_bytes());
        buf.extend_from_slice(&self.cell_size.to_le_bytes());
        buf.extend_from_slice(&self.clearance.to_le_bytes());

        // Body: f32 LE, row-major
        for &z in &self.data {
            buf.extend_from_slice(&z.to_le_bytes());
        }

        buf
    }

    /// Deserialise from a binary blob. Returns `None` on invalid header.
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < Self::HEADER_BYTES {
            return None;
        }

        let magic = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        if magic != Self::MAGIC {
            return None;
        }

        let version = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        if version != Self::VERSION {
            return None;
        }

        let width = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
        let height = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]);
        let cell_size = f32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let clearance = f32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);

        let cell_count = width as usize * height as usize;
        let expected_len = Self::HEADER_BYTES + cell_count * 4;
        if bytes.len() < expected_len {
            return None;
        }

        let mut data = Vec::with_capacity(cell_count);
        let mut offset = Self::HEADER_BYTES;
        for _ in 0..cell_count {
            let z = f32::from_le_bytes([
                bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
            ]);
            data.push(z);
            offset += 4;
        }

        Some(Self {
            cell_size,
            clearance,
            width,
            height,
            origin_x: 0.0,
            origin_y: 0.0,
            data,
        })
    }
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

use rayon::prelude::*;

/// Compute a clearance heightmap from an existing sparse SDF grid.
///
/// For each XY cell in the grid's bounding box, scans vertically through
/// the SDF to find the highest Z where the signed distance is less than
/// `clearance`.  Cells entirely above the model bounding box are skipped
/// (recorded as NEG_INFINITY).
///
/// `cell_size` should match the SDF cell size for direct indexing.
/// `z_step` controls vertical scan resolution (default: cell_size).
pub fn compute_heightmap(
    sdf: &SparseSdfGrid,
    clearance: f32,
    z_step: Option<f32>,
) -> ClearanceHeightmap {
    let cs = sdf.cell_size;
    let z_step = z_step.unwrap_or(cs);

    // Find the XY extent from the SDF cells
    let mut min_qx = i32::MAX;
    let mut max_qx = i32::MIN;
    let mut min_qy = i32::MAX;
    let mut max_qy = i32::MIN;
    let mut max_qz = i32::MIN;

    for cell in sdf.iter() {
        min_qx = min_qx.min(cell.qx);
        max_qx = max_qx.max(cell.qx);
        min_qy = min_qy.min(cell.qy);
        max_qy = max_qy.max(cell.qy);
        max_qz = max_qz.max(cell.qz);
    }

    if min_qx > max_qx || min_qy > max_qy {
        return ClearanceHeightmap {
            cell_size: cs,
            clearance,
            width: 0,
            height: 0,
            origin_x: 0.0,
            origin_y: 0.0,
            data: Vec::new(),
        };
    }

    let width = (max_qx - min_qx + 1) as u32;
    let height = (max_qy - min_qy + 1) as u32;
    let origin_x = min_qx as f32 * cs;
    let origin_y = min_qy as f32 * cs;

    let max_wz = max_qz as f32 * cs;
    let min_wz = 0.0f32;
    let z_steps = ((max_wz - min_wz) / z_step).ceil() as u32 + 1;

    // Parallel: each XY column is independent
    let data: Vec<f32> = (0..height)
        .into_par_iter()
        .flat_map(|row| {
            let qy = min_qy + row as i32;
            let wy = qy as f32 * cs;
            (0..width)
                .map(|col| {
                    let qx = min_qx + col as i32;
                    let wx = qx as f32 * cs;

                    // Scan from top down, find highest blocked Z
                    let mut highest_blocked = f32::NEG_INFINITY;
                    for zi in (0..=z_steps).rev() {
                        let wz = min_wz + zi as f32 * z_step;
                        let dist = sdf.get(
                            (wx / cs).round() as i32,
                            (wy / cs).round() as i32,
                            (wz / cs).round() as i32,
                        );
                        if let Some(d) = dist {
                            if d < clearance {
                                highest_blocked = wz;
                                break;
                            }
                        }
                    }
                    highest_blocked
                })
                .collect::<Vec<f32>>()
        })
        .collect();

    ClearanceHeightmap {
        cell_size: cs,
        clearance,
        width,
        height,
        origin_x,
        origin_y,
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::SparseSdfGrid;

    #[test]
    fn test_empty_grid() {
        let sdf = SparseSdfGrid::new(0.5, 0);
        let hm = compute_heightmap(&sdf, 0.48, None);
        assert!(hm.is_empty());
    }

    #[test]
    fn test_basic_heightmap() {
        let mut sdf = SparseSdfGrid::new(0.5, 16);
        // Simulate a block at Z=5.0 at XY origin
        for qz in 0..=10 {
            sdf.insert(0, 0, qz, if qz <= 10 { -0.1 } else { 5.0 });
        }
        // Cell at (1,0) is clear
        sdf.insert(1, 0, 0, 10.0);

        let hm = compute_heightmap(&sdf, 0.48, None);

        // (0,0) should be blocked up to Z ≈ 5.0
        let bz = hm.get(0.0, 0.0);
        assert!(bz > 4.0, "expected blocked Z > 4.0, got {}", bz);

        // (1,0) should be clear (NEG_INFINITY)
        let cz = hm.get(0.5, 0.0);
        assert!(cz.is_infinite() && cz.is_sign_negative(), "expected -inf, got {}", cz);

        // column_is_clear
        assert!(!hm.column_is_clear(0.0, 0.0, 4.0));
        assert!(hm.column_is_clear(0.0, 0.0, 6.0));
    }

    #[test]
    fn test_serialise_roundtrip() {
        let mut sdf = SparseSdfGrid::new(0.5, 4);
        sdf.insert(0, 0, 10, -0.2);
        sdf.insert(0, 1, 0, 20.0);

        let hm = compute_heightmap(&sdf, 0.48, None);
        let bytes = hm.to_bytes();
        let restored = ClearanceHeightmap::from_bytes(&bytes).expect("deserialise");

        assert_eq!(restored.width, hm.width);
        assert_eq!(restored.height, hm.height);
        assert_eq!(restored.cell_size, hm.cell_size);
        assert_eq!(restored.clearance, hm.clearance);
        assert_eq!(restored.len(), hm.len());
    }
}
