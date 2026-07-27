//! Binary + ASCII STL parser. Binary STL is the hot path (slicer-produced
//! meshes), ASCII is included for completeness.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::core::mesh::{IndexedMesh, TriangleSoupStats};
use crate::MeshRepairError;

pub fn load(path: &Path) -> Result<IndexedMesh, MeshRepairError> {
    let mut file = File::open(path)?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    parse_bytes(&buf)
}

/// Ph1 wiring — like [`load`] but ALSO returns the intake stats and the
/// ascending **source-file** indices of triangles dropped for carrying a
/// non-finite coordinate.
///
/// The import run map addresses triangles as the FILE numbers them, and a drop
/// at intake shifts every later welded index by one. Only the drop POSITIONS
/// can undo that shift, so the import path needs this variant rather than the
/// plain [`load`]. Identical parse, identical weld, identical mesh — the extra
/// return values come from [`IndexedMesh::from_triangle_soup_tracked`], which is
/// allocation-free when nothing was dropped (the normal case).
///
/// The returned `source_triangle_count` is the count as PARSED from the file,
/// which is what the run map's index space is defined against.
pub fn load_tracked(
    path: &Path,
) -> Result<(IndexedMesh, TriangleSoupStats, Vec<u32>, usize), MeshRepairError> {
    let mut file = File::open(path)?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    let positions = parse_bytes_positions(&buf)?;
    drop(buf);
    let source_triangle_count = positions.len() / 9;
    let (mesh, stats, dropped) =
        IndexedMesh::from_triangle_soup_tracked(&positions, crate::io::DEFAULT_MERGE_EPSILON);
    Ok((mesh, stats, dropped, source_triangle_count))
}

pub fn parse_bytes(bytes: &[u8]) -> Result<IndexedMesh, MeshRepairError> {
    let positions = parse_bytes_positions(bytes)?;
    Ok(IndexedMesh::from_triangle_soup(
        &positions,
        crate::io::DEFAULT_MERGE_EPSILON,
    ))
}

/// The raw triangle soup exactly as the file spells it — no weld, no drop.
/// Shared by [`parse_bytes`] and [`load_tracked`] so the two cannot diverge on
/// what "source-file triangle index" means.
pub fn parse_bytes_positions(bytes: &[u8]) -> Result<Vec<f32>, MeshRepairError> {
    if looks_binary(bytes) {
        parse_binary_positions(bytes)
    } else {
        parse_ascii_positions(bytes)
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.len() < 84 {
        return false;
    }
    // A binary STL has an 80-byte header, a u32 triangle count, then
    // exactly 50 bytes per triangle.
    let tri_count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
    let expected = 84 + tri_count.saturating_mul(50);
    if expected == bytes.len() {
        return true;
    }
    // Fallback: look at first non-whitespace bytes.
    let head = &bytes[..bytes.len().min(256)];
    let lower = String::from_utf8_lossy(head).to_ascii_lowercase();
    !lower.trim_start().starts_with("solid")
        || !lower.contains("facet")
}

fn parse_binary_positions(bytes: &[u8]) -> Result<Vec<f32>, MeshRepairError> {
    if bytes.len() < 84 {
        return Err(MeshRepairError::Parse("binary STL too short".into()));
    }
    let tri_count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
    let expected = 84 + tri_count.saturating_mul(50);
    if expected != bytes.len() {
        return Err(MeshRepairError::Parse(format!(
            "binary STL size mismatch: expected {expected} bytes for {tri_count} triangles, got {}",
            bytes.len()
        )));
    }
    let mut positions: Vec<f32> = Vec::with_capacity(tri_count * 9);
    let mut cursor = 84usize;
    for _ in 0..tri_count {
        // Skip 12-byte normal, read 3 × 12-byte vertices, skip 2-byte attr.
        cursor += 12;
        for _ in 0..3 {
            for _ in 0..3 {
                let b = &bytes[cursor..cursor + 4];
                positions.push(f32::from_le_bytes([b[0], b[1], b[2], b[3]]));
                cursor += 4;
            }
        }
        cursor += 2;
    }
    Ok(positions)
}

fn parse_ascii_positions(bytes: &[u8]) -> Result<Vec<f32>, MeshRepairError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|e| MeshRepairError::Parse(format!("ASCII STL not UTF-8: {e}")))?;
    let mut positions: Vec<f32> = Vec::new();
    let mut tri_pts: Vec<f32> = Vec::with_capacity(9);
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("vertex ") {
            let mut parts = rest.split_ascii_whitespace();
            for _ in 0..3 {
                let s = parts
                    .next()
                    .ok_or_else(|| MeshRepairError::Parse("ASCII STL: missing coord".into()))?;
                let v: f32 = s
                    .parse()
                    .map_err(|e| MeshRepairError::Parse(format!("ASCII STL: bad coord {s}: {e}")))?;
                tri_pts.push(v);
            }
            if tri_pts.len() == 9 {
                positions.extend_from_slice(&tri_pts);
                tri_pts.clear();
            }
        }
    }
    if positions.is_empty() {
        return Err(MeshRepairError::Parse("ASCII STL: no vertices".into()));
    }
    Ok(positions)
}

/// Write a binary STL from an indexed mesh.
pub fn write_binary<P: AsRef<Path>>(mesh: &IndexedMesh, path: P) -> Result<(), MeshRepairError> {
    use std::io::Write;
    let mut file = File::create(path)?;
    // 80-byte header.
    file.write_all(&[0u8; 80])?;
    let tri_count = mesh.triangles.len() as u32;
    file.write_all(&tri_count.to_le_bytes())?;
    for face in 0..mesh.triangles.len() as u32 {
        let n = mesh.tri_normal(face);
        let [a, b, c] = mesh.tri_positions(face);
        for f in [n.x, n.y, n.z, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z] {
            file.write_all(&f.to_le_bytes())?;
        }
        file.write_all(&0u16.to_le_bytes())?;
    }
    file.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One binary-STL record with the given nine coordinates.
    fn record(coords: [f32; 9]) -> Vec<u8> {
        let mut out = vec![0u8; 50];
        let mut at = 12;
        for c in coords {
            out[at..at + 4].copy_from_slice(&c.to_le_bytes());
            at += 4;
        }
        out
    }

    fn binary_stl(triangles: &[[f32; 9]]) -> Vec<u8> {
        let mut out = vec![0u8; 80];
        out.extend_from_slice(&(triangles.len() as u32).to_le_bytes());
        for t in triangles {
            out.extend_from_slice(&record(*t));
        }
        out
    }

    /// Ph1 wiring — `load_tracked` has to report WHERE the intake dropped a
    /// triangle, not just how many. A count cannot undo the index shift a drop
    /// causes between file and welded space, and the import run map is
    /// expressed in FILE indices.
    #[test]
    fn load_tracked_reports_dropped_source_file_indices() {
        let good_a = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let bad = [0.0, 0.0, 0.0, f32::NAN, 0.0, 0.0, 0.0, 1.0, 0.0];
        let good_b = [0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0];
        let bytes = binary_stl(&[good_a, bad, good_b]);

        let dir = std::env::temp_dir();
        let path = dir.join(format!("dragonfruit-stl-tracked-{}.stl", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();

        let (mesh, stats, dropped, source_triangle_count) = load_tracked(&path).unwrap();
        std::fs::remove_file(&path).ok();

        assert_eq!(source_triangle_count, 3, "the FILE has three triangles");
        assert_eq!(mesh.triangles.len(), 2, "the non-finite one is dropped");
        assert_eq!(stats.dropped_nonfinite_triangles, 1);
        assert_eq!(dropped, vec![1], "the POSITION of the drop, not just a count");

        // Same parse, same weld — `load_tracked` only adds diagnostics.
        let plain = load(&path.with_extension("missing")).err();
        assert!(plain.is_some(), "sanity: a missing path still errors");
        let reparsed = parse_bytes(&bytes).unwrap();
        assert_eq!(reparsed.triangles, mesh.triangles);
        assert_eq!(reparsed.positions.len(), mesh.positions.len());
    }

    /// A clean file allocates no drop vector, which is the hot path.
    #[test]
    fn load_tracked_is_allocation_free_for_a_clean_file() {
        let bytes = binary_stl(&[[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]]);
        let path = std::env::temp_dir()
            .join(format!("dragonfruit-stl-tracked-clean-{}.stl", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();

        let (mesh, stats, dropped, source_triangle_count) = load_tracked(&path).unwrap();
        std::fs::remove_file(&path).ok();

        assert_eq!(source_triangle_count, 1);
        assert_eq!(mesh.triangles.len(), 1);
        assert_eq!(stats.dropped_nonfinite_triangles, 0);
        assert!(dropped.is_empty());
        assert_eq!(dropped.capacity(), 0, "no allocation when nothing was dropped");
    }
}
