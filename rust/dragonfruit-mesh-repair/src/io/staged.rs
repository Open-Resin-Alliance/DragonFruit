//! Staged raw-positions IO. Compatible with `src-tauri`'s
//! `stage_mesh_binary_*` commands: little-endian f32, 9 values per triangle.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::core::mesh::IndexedMesh;
use crate::MeshRepairError;

pub fn load_positions_le(bytes: &[u8]) -> Result<IndexedMesh, MeshRepairError> {
    if bytes.len() % 4 != 0 {
        return Err(MeshRepairError::Parse(format!(
            "staged positions not f32-aligned: {} bytes",
            bytes.len()
        )));
    }
    let floats: &[f32] = bytemuck::try_cast_slice(bytes)
        .map_err(|e| MeshRepairError::Parse(format!("staged positions cast: {e}")))?;
    if floats.len() % 9 != 0 {
        return Err(MeshRepairError::Parse(format!(
            "staged positions not a multiple of 9 floats: {}",
            floats.len()
        )));
    }
    Ok(IndexedMesh::from_triangle_soup(
        floats,
        crate::io::DEFAULT_MERGE_EPSILON,
    ))
}

pub fn load_positions_file(path: &Path) -> Result<IndexedMesh, MeshRepairError> {
    let mut file = File::open(path)?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    load_positions_le(&buf)
}
