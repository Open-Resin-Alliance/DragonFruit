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
    let mesh = match ext.as_str() {
        "stl" => stl::load(path),
        "obj" => obj::load(path),
        "3mf" => three_mf::load(path),
        "bin" | "positions" => staged::load_positions_file(path),
        other => return Err(MeshRepairError::UnsupportedFormat(other.to_string())),
    }?;
    Ok(refine_coarse_faces(mesh))
}

/// Subdivide faces that are too long for the model's own size.
///
/// A mesh can be valid and still too coarse to carry anything sampled per vertex.
/// A base triangulated as a fan is the usual case: its spokes run an order of
/// magnitude longer than the geometry around them, so ambient occlusion, which is
/// sampled at the vertices, is interpolated across the whole spoke as a straight
/// ramp and renders as a wedge per triangle. Measured on one such base, the
/// longest edge went from 16.8mm to 1.1mm, the base's vertices from 1608 to
/// 10261, and the bake cost 5ms more.
///
/// This runs at load, before anything derives data from the mesh, because
/// triangle ids are what several features index: the overhang scan, the support
/// placement that consumes its regions, and the masks and caches keyed off them.
/// Refining later would move those ids under whoever already holds them. The
/// refinement is skipped entirely when the mesh is already fine enough, which is
/// the common case, and it is skipped for a model whose faces are long but whose
/// size makes that correct.
pub fn refine_coarse_faces(mesh: IndexedMesh) -> IndexedMesh {
    let mut min = crate::Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut max = crate::Vec3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for position in &mesh.positions {
        min = min.min(*position);
        max = max.max(*position);
    }
    let diagonal = max.sub(min).length();
    if !diagonal.is_finite() || diagonal <= 0.0 {
        return mesh;
    }
    let max_edge = diagonal * dragonfruit_mesh_core::refine::MAX_EDGE_DIAGONAL_FRACTION;
    if dragonfruit_mesh_core::refine::longest_edge(&mesh) <= max_edge {
        return mesh;
    }
    // Bounded, and spent on the longest edges first: refining a dense hard-surface
    // part all the way to its own detail scale measured 8.31x the triangles and
    // 11x the bake, which is not a trade a shading term gets to make.
    let budget = (mesh.triangles.len() as f32 * dragonfruit_mesh_core::refine::DEFAULT_GROWTH_LIMIT)
        as usize;
    dragonfruit_mesh_core::refine::refine_long_edges_with_budget(
        &mesh,
        max_edge,
        dragonfruit_mesh_core::refine::MAX_PASSES,
        budget,
    )
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
