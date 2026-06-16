//! Sparse signed distance field grid.
//!
//! Stores pre-computed signed distances in a spatial hash map keyed by
//! quantised cell coordinates.  The grid is model-local: query points must
//! be transformed into model space before lookup.
//!
//! ## Serialisation Format (binary, little-endian)
//!
//! ```text
//! Header (20 bytes):
//!   magic:     u32  = 0x46445344  ("DSDF")
//!   version:   u32  = 1
//!   cell_size: f32
//!   reserved:  u64  = 0
//!
//! Body:
//!   cell_count: u32
//!   for each cell:
//!     qx:  i16   quantised X cell coordinate
//!     qy:  i16   quantised Y cell coordinate
//!     qz:  i16   quantised Z cell coordinate
//!     pad: u8    = 0
//!     dist: f32  signed distance in mm (+ve = outside, -ve = inside)
//!     // 12 bytes per cell
//! ```

use std::collections::HashMap;

// ---------------------------------------------------------------------------
// SdfCell
// ---------------------------------------------------------------------------

/// A single pre-computed SDF sample.
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C)]
pub struct SdfCell {
    /// Quantised cell coordinate (model-space mm / cell_size, rounded).
    pub qx: i32,
    pub qy: i32,
    pub qz: i32,
    /// Signed distance in mm.  +ve = outside mesh, -ve = inside.
    pub distance: f32,
}

// ---------------------------------------------------------------------------
// SparseSdfGrid
// ---------------------------------------------------------------------------

/// Spatial-hash-backed sparse signed distance field.
///
/// Uses the same Cantor-style 3D integer hash as the frontend `SDFCache`
/// so that cell keys match between Rust and TypeScript.
#[derive(Debug, Clone)]
pub struct SparseSdfGrid {
    /// Grid cell size in model-space mm.
    pub cell_size: f32,
    /// Sparse storage: `cell_key(qx, qy, qz) → signed_distance_mm`.
    cells: HashMap<u64, f32, ahash::RandomState>,
}

impl SparseSdfGrid {
    pub fn new(cell_size: f32, capacity: usize) -> Self {
        Self {
            cell_size,
            cells: HashMap::with_capacity_and_hasher(capacity, ahash::RandomState::default()),
        }
    }

    pub fn len(&self) -> usize {
        self.cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// Insert a pre-computed distance sample.
    #[inline]
    pub fn insert(&mut self, qx: i32, qy: i32, qz: i32, distance: f32) {
        let key = cell_key(qx, qy, qz);
        self.cells.insert(key, distance);
    }

    /// Look up the signed distance at a quantised cell coordinate.
    /// Returns `None` if the cell was not pre-computed (implicitly far from
    /// the surface).
    #[inline]
    pub fn get(&self, qx: i32, qy: i32, qz: i32) -> Option<f32> {
        let key = cell_key(qx, qy, qz);
        self.cells.get(&key).copied()
    }

    /// Iterate over all stored cells.
    pub fn iter(&self) -> impl Iterator<Item = SdfCell> + '_ {
        self.cells.iter().map(|(&key, &distance)| {
            let (qx, qy, qz) = cell_key_inverse(key);
            SdfCell {
                qx,
                qy,
                qz,
                distance,
            }
        })
    }

    // ---- Serialisation ----

    const MAGIC: u32 = 0x46445344; // "DSDF"
    const VERSION: u32 = 1;
    const HEADER_BYTES: usize = 20;
    const CELL_BYTES: usize = 11; // i16×3 (6) + u8 pad (1) + f32 (4)

    /// Serialise to a compact binary blob (little-endian).
    pub fn to_bytes(&self) -> Vec<u8> {
        let cell_count = self.cells.len() as u32;
        let mut buf =
            Vec::with_capacity(Self::HEADER_BYTES + cell_count as usize * Self::CELL_BYTES);

        // Header
        buf.extend_from_slice(&Self::MAGIC.to_le_bytes());
        buf.extend_from_slice(&Self::VERSION.to_le_bytes());
        buf.extend_from_slice(&self.cell_size.to_le_bytes());
        buf.extend_from_slice(&0u64.to_le_bytes()); // reserved

        // Body
        buf.extend_from_slice(&cell_count.to_le_bytes());
        for cell in self.iter() {
            buf.extend_from_slice(&(cell.qx as i16).to_le_bytes());
            buf.extend_from_slice(&(cell.qy as i16).to_le_bytes());
            buf.extend_from_slice(&(cell.qz as i16).to_le_bytes());
            buf.push(0u8); // padding for 4-byte alignment
            buf.extend_from_slice(&cell.distance.to_le_bytes());
        }

        buf
    }

    /// Deserialise from a binary blob.  Returns `None` on invalid header.
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < Self::HEADER_BYTES + 4 {
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

        let cell_size = f32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
        // bytes 12..20: reserved (skip)

        let cell_count = u32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]) as usize;

        let expected_len = Self::HEADER_BYTES + 4 + cell_count * Self::CELL_BYTES;
        if bytes.len() < expected_len {
            return None;
        }

        let mut grid = Self::new(cell_size, cell_count);
        let mut offset = 24; // after header + cell_count

        for _ in 0..cell_count {
            let qx = i16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as i32;
            let qy = i16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]]) as i32;
            let qz = i16::from_le_bytes([bytes[offset + 4], bytes[offset + 5]]) as i32;
            // offset + 6: padding byte
            let distance = f32::from_le_bytes([
                bytes[offset + 7],
                bytes[offset + 8],
                bytes[offset + 9],
                bytes[offset + 10],
            ]);
            grid.insert(qx, qy, qz, distance);
            offset += Self::CELL_BYTES;
        }

        Some(grid)
    }
}

// ---------------------------------------------------------------------------
// Cell key hash (matches frontend SDFCache::cellKey)
// ---------------------------------------------------------------------------

/// Cantor-style 3D integer hash — identical to the frontend `SDFCache.cellKey()`.
///
/// Frontend equivalent:
/// ```ts
/// function cellKey(qx: number, qy: number, qz: number): number {
///     const ux = (qx + 0x4000) | 0;
///     const uy = (qy + 0x4000) | 0;
///     const uz = (qz + 0x4000) | 0;
///     return (ux * 0x8000 + uy) * 0x8000 + uz;
/// }
/// ```
#[inline]
pub fn cell_key(qx: i32, qy: i32, qz: i32) -> u64 {
    let ux = (qx + 0x4000) as u64;
    let uy = (qy + 0x4000) as u64;
    let uz = (qz + 0x4000) as u64;
    (ux * 0x8000 + uy) * 0x8000 + uz
}

/// Inverse of `cell_key` — recovers (qx, qy, qz) from a key.
#[inline]
pub fn cell_key_inverse(key: u64) -> (i32, i32, i32) {
    let uz = key % 0x8000;
    let rest = key / 0x8000;
    let uy = rest % 0x8000;
    let ux = rest / 0x8000;
    (ux as i32 - 0x4000, uy as i32 - 0x4000, uz as i32 - 0x4000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_key_roundtrip() {
        for (qx, qy, qz) in [(0, 0, 0), (-100, 50, 200), (500, -300, -1)] {
            let key = cell_key(qx, qy, qz);
            let (rx, ry, rz) = cell_key_inverse(key);
            assert_eq!((qx, qy, qz), (rx, ry, rz), "roundtrip failed");
        }
    }

    #[test]
    fn serialise_roundtrip() {
        let mut grid = SparseSdfGrid::new(0.5, 4);
        grid.insert(0, 0, 0, 1.5);
        grid.insert(1, 0, 0, -0.3);
        grid.insert(0, 1, 0, 2.0);
        grid.insert(0, 0, 1, 0.0);

        let bytes = grid.to_bytes();
        let restored = SparseSdfGrid::from_bytes(&bytes).expect("deserialise");

        assert_eq!(restored.cell_size, 0.5);
        assert_eq!(restored.len(), 4);
        assert_eq!(restored.get(0, 0, 0), Some(1.5));
        assert_eq!(restored.get(1, 0, 0), Some(-0.3));
        assert_eq!(restored.get(0, 1, 0), Some(2.0));
        assert_eq!(restored.get(0, 0, 1), Some(0.0));
        assert_eq!(restored.get(99, 99, 99), None);
    }
}
