//! OBJ parser (positions + faces only; materials/UVs ignored for repair).

use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::core::mesh::{IndexedMesh, Vec3};
use crate::MeshRepairError;

pub fn load(path: &Path) -> Result<IndexedMesh, MeshRepairError> {
    let mut file = File::open(path)?;
    let mut buf = String::new();
    file.read_to_string(&mut buf)?;
    parse_str(&buf)
}

pub fn parse_str(text: &str) -> Result<IndexedMesh, MeshRepairError> {
    let mut positions: Vec<Vec3> = Vec::new();
    let mut triangles: Vec<[u32; 3]> = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_ascii_whitespace();
        let tag = match parts.next() {
            Some(t) => t,
            None => continue,
        };
        match tag {
            "v" => {
                let coords: Vec<f32> = parts
                    .take(3)
                    .map(|s| s.parse::<f32>().unwrap_or(0.0))
                    .collect();
                if coords.len() == 3 {
                    positions.push(Vec3::new(coords[0], coords[1], coords[2]));
                }
            }
            "f" => {
                let idxs: Vec<u32> = parts
                    .map(|token| {
                        // Tokens may be "v", "v/vt", "v//vn", "v/vt/vn".
                        let first = token.split('/').next().unwrap_or("");
                        let parsed: i64 = first.parse().unwrap_or(0);
                        if parsed > 0 {
                            (parsed as u32).saturating_sub(1)
                        } else if parsed < 0 {
                            // Negative indices are relative to current vertex count.
                            let n = positions.len() as i64 + parsed;
                            if n < 0 { 0 } else { n as u32 }
                        } else {
                            0
                        }
                    })
                    .collect();
                // Fan-triangulate polygons.
                if idxs.len() >= 3 {
                    for i in 1..idxs.len() - 1 {
                        triangles.push([idxs[0], idxs[i], idxs[i + 1]]);
                    }
                }
            }
            _ => {}
        }
    }

    if positions.is_empty() || triangles.is_empty() {
        return Err(MeshRepairError::Parse(
            "OBJ: no geometry (positions or faces)".into(),
        ));
    }
    Ok(IndexedMesh { positions, triangles })
}
