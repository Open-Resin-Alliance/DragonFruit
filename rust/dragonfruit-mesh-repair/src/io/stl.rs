//! Binary + ASCII STL parser. Binary STL is the hot path (slicer-produced
//! meshes), ASCII is included for completeness.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::core::mesh::IndexedMesh;
use crate::MeshRepairError;

pub fn load(path: &Path) -> Result<IndexedMesh, MeshRepairError> {
    let mut file = File::open(path)?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    parse_bytes(&buf)
}

pub fn parse_bytes(bytes: &[u8]) -> Result<IndexedMesh, MeshRepairError> {
    if looks_binary(bytes) {
        parse_binary(bytes)
    } else {
        parse_ascii(bytes)
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
    !lower.trim_start().starts_with("solid") || !lower.contains("facet")
}

fn parse_binary(bytes: &[u8]) -> Result<IndexedMesh, MeshRepairError> {
    if bytes.len() < 84 {
        return Err(MeshRepairError::Parse("binary STL too short".into()));
    }
    let tri_count = binary_tri_count(bytes)?;
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
    Ok(IndexedMesh::from_triangle_soup(
        &positions,
        crate::io::DEFAULT_MERGE_EPSILON,
    ))
}

/// Triangle count to read from a binary STL. Exporters get the header
/// count wrong in the wild (e.g. 499996 in the header, 500000 records in
/// the body), so like admesh we trust the body when it holds at least the
/// header's count in whole records, and otherwise read the header's count
/// and ignore trailing bytes. Both are warnings: the mesh is all there. A
/// body too short for the header's count is missing triangles, an error.
fn binary_tri_count(bytes: &[u8]) -> Result<usize, MeshRepairError> {
    let header_count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
    let body = bytes.len() - 84;
    if body % 50 == 0 && body / 50 >= header_count {
        if body / 50 > header_count {
            log::warn!(
                "binary STL header claims {header_count} triangles but the body holds {}; reading them all",
                body / 50
            );
        }
        return Ok(body / 50);
    }
    if header_count.saturating_mul(50) <= body {
        log::warn!(
            "binary STL has {} trailing bytes after its {header_count} triangles; ignoring them",
            body - header_count * 50
        );
        return Ok(header_count);
    }
    Err(MeshRepairError::Parse(format!(
        "binary STL truncated: header claims {header_count} triangles ({} bytes), got {}",
        84 + header_count.saturating_mul(50),
        bytes.len()
    )))
}

fn parse_ascii(bytes: &[u8]) -> Result<IndexedMesh, MeshRepairError> {
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
                let v: f32 = s.parse().map_err(|e| {
                    MeshRepairError::Parse(format!("ASCII STL: bad coord {s}: {e}"))
                })?;
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
    Ok(IndexedMesh::from_triangle_soup(
        &positions,
        crate::io::DEFAULT_MERGE_EPSILON,
    ))
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

    fn binary_stl(header_count: u32, records: usize, trailing: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; 80];
        bytes.extend_from_slice(&header_count.to_le_bytes());
        for i in 0..records {
            let o = i as f32 * 10.0;
            bytes.extend_from_slice(&[0u8; 12]);
            for f in [o, 0.0, 0.0, o + 1.0, 0.0, 0.0, o, 1.0, 0.0] {
                bytes.extend_from_slice(&f32::to_le_bytes(f));
            }
            bytes.extend_from_slice(&[0u8; 2]);
        }
        bytes.extend(std::iter::repeat_n(0u8, trailing));
        bytes
    }

    #[test]
    fn header_undercount_reads_every_record() {
        let mesh = parse_binary(&binary_stl(2, 3, 0)).unwrap();
        assert_eq!(mesh.triangles.len(), 3);
    }

    #[test]
    fn trailing_garbage_uses_header_count() {
        let mesh = parse_binary(&binary_stl(3, 3, 7)).unwrap();
        assert_eq!(mesh.triangles.len(), 3);
    }

    #[test]
    fn missing_whole_records_is_an_error() {
        assert!(parse_binary(&binary_stl(3, 2, 0)).is_err());
    }

    #[test]
    fn truncated_body_is_an_error() {
        let mut bytes = binary_stl(3, 3, 0);
        bytes.truncate(bytes.len() - 7);
        assert!(parse_binary(&bytes).is_err());
    }
}
