//! Mesh IO: parsers for STL (binary + ASCII), OBJ, 3MF, and the raw
//! little-endian `positions.bin` staging format produced by `src-tauri`.

use std::path::Path;

use crate::core::mesh::IndexedMesh;
use crate::MeshRepairError;

pub mod stl;
pub mod obj;
pub mod three_mf;
pub mod staged;

/// Dispatch by extension. Caller is responsible for pointing at a real
/// mesh file; for in-memory staged buffers, use [`staged::load_positions_le`].
pub fn load_mesh_from_path(path: &Path) -> Result<IndexedMesh, MeshRepairError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "stl" => stl::load(path),
        "obj" => obj::load(path),
        "3mf" => three_mf::load(path),
        "bin" | "positions" => staged::load_positions_file(path),
        other => Err(MeshRepairError::UnsupportedFormat(other.to_string())),
    }
}

/// Default merge epsilon used when reading unindexed soup (STL). Expressed
/// as a fraction of the mesh bbox diagonal.
pub const DEFAULT_MERGE_EPSILON: f32 = 1e-5;

/// Write a mesh's triangle soup to `path` as raw little-endian f32 positions,
/// matching the staging format used by `src-tauri`.
pub fn write_positions_file(mesh: &IndexedMesh, path: &Path) -> Result<(), MeshRepairError> {
    use std::io::Write;
    let soup = mesh.to_triangle_soup();
    let bytes: &[u8] = bytemuck::cast_slice(&soup);
    let mut file = std::fs::File::create(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    Ok(())
}
