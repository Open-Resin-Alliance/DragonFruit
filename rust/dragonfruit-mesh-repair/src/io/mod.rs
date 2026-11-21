//! Mesh IO: parsers for STL (binary + ASCII), OBJ, 3MF, and the raw
//! little-endian `positions.bin` staging format produced by `src-tauri`.

use std::path::Path;

use crate::core::mesh::IndexedMesh;
use crate::MeshRepairError;

pub mod obj;
pub mod staged;
pub mod stl;
pub mod three_mf;

/// Dispatch by extension, and read the file exactly as written. Caller is responsible
/// for pointing at a real mesh file; for in-memory staged buffers, use
/// [`staged::load_positions_le`].
///
/// Nothing is refined on the way in. The mesh a file holds is the model: it is what
/// gets saved, exported, sliced and operated on, and what triangle ids index. A
/// renderer that wants more vertices for its per-vertex shading refines a copy for
/// drawing ([`refine_coarse_faces`], through the app's `refine_mesh_soup`), and the
/// model never grows because it was drawn.
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

/// Load every body a file declares, each as written.
///
/// STL, OBJ and the staged formats describe a single mesh, so this returns one
/// body for them. A 3MF describes one body per `<build><item>` expanded through
/// its components, each with its composed transform baked into the vertices —
/// see [`three_mf::load_bodies`].
pub fn load_mesh_bodies_from_path(path: &Path) -> Result<Vec<IndexedMesh>, MeshRepairError> {
    let is_three_mf = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("3mf"));
    if is_three_mf {
        return three_mf::load_bodies(path);
    }
    Ok(vec![load_mesh_from_path(path)?])
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
/// It makes a *display* mesh: the copy the app draws and bakes its occlusion on
/// (`refine_mesh_soup` in `src-tauri`). It never runs on the mesh a model is, because
/// triangle ids are what several features index — the overhang scan, the support
/// placement that consumes its regions, the masks and caches keyed off them — and
/// because a model that grows on every load is not the file the user opened. The
/// refinement is skipped entirely when the mesh is already fine enough, which is the
/// common case, and it is skipped for a model whose faces are long but whose size
/// makes that correct.
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
    // 11x the bake, which is not a trade a shading term gets to make. The budget
    // is `refinement_budget`'s, not a bare fraction: on a coarse mesh a fraction
    // of a small count is no budget at all.
    let budget = dragonfruit_mesh_core::refine::refinement_budget(mesh.triangles.len());
    dragonfruit_mesh_core::refine::refine_long_edges_with_budget(
        &mesh,
        max_edge,
        dragonfruit_mesh_core::refine::MAX_PASSES,
        budget,
    )
}

/// Default merge epsilon used when reading an unindexed soup. Relative to the bbox diagonal.
///
/// **This constant decides whether a repaired mesh survives being written and read back**, because every
/// export path here produces a soup: an STL carries no vertex indices, and the staged `positions.bin` is
/// nine floats per triangle. So the weld applied here is applied again to the repair's own output the
/// moment a caller saves it, and a weld coarser than the repair's work undoes that work.
///
/// It was `1e-5`, and that was coarser than a dense mesh can take. On the reported 1.02M-triangle model
/// the repair's output is `0/0/0/0` in memory and comes back from an STL with **177 winding edges** at
/// `1e-5`: the weld joins vertices the repair had deliberately kept apart — a separated non-manifold
/// junction, a patch rim — and the defects the repair resolved reappear in the file the user renders. At
/// `1e-6` the same file round-trips as `0/0/0/0`.
///
/// The other side of the trade is that a sloppy export (one that writes the same position twice with
/// different floats) now arrives less welded, so the repair sees more boundaries and does more work.
/// That is the right way round: the repair's own stitch is what welds a mesh, at a tolerance derived from
/// the mesh, and the loader welding coarser than that is the loader doing the repair's job badly. On the
/// corpus this costs one extra component on one 952-part file and nothing else, and several files get
/// faster because they have less to repair.
pub const DEFAULT_MERGE_EPSILON: f32 = 1e-6;

#[cfg(test)]
mod tests {
    use super::*;
    use dragonfruit_mesh_core::refine::{
        longest_edge, refinement_budget, MAX_EDGE_DIAGONAL_FRACTION,
    };

    fn box_soup(min: [f32; 3], max: [f32; 3]) -> Vec<f32> {
        let c = [
            [min[0], min[1], min[2]],
            [max[0], min[1], min[2]],
            [max[0], max[1], min[2]],
            [min[0], max[1], min[2]],
            [min[0], min[1], max[2]],
            [max[0], min[1], max[2]],
            [max[0], max[1], max[2]],
            [min[0], max[1], max[2]],
        ];
        let faces: [[usize; 4]; 6] = [
            [0, 1, 2, 3],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [1, 2, 6, 5],
            [2, 3, 7, 6],
            [3, 0, 4, 7],
        ];
        let mut out = Vec::new();
        for f in faces {
            for tri in [[f[0], f[1], f[2]], [f[0], f[2], f[3]]] {
                for i in tri {
                    out.extend_from_slice(&c[i]);
                }
            }
        }
        out
    }

    /// The loader reads a coarse model as written. Refining it here grew every model on
    /// load, and an export or a save wrote the grown mesh back (a re-exported Benchy went
    /// from 11 to 19 MB); the app refines only the copy it draws.
    #[test]
    fn a_coarse_file_is_read_as_written() {
        let soup = box_soup([0.0; 3], [120.0, 120.0, 40.0]);
        let triangles = soup.len() / 9;
        let mut stl = vec![0u8; 80];
        stl.extend_from_slice(&(triangles as u32).to_le_bytes());
        for triangle in soup.chunks_exact(9) {
            stl.extend_from_slice(&[0u8; 12]);
            for value in triangle {
                stl.extend_from_slice(&value.to_le_bytes());
            }
            stl.extend_from_slice(&[0u8; 2]);
        }
        let path = std::env::temp_dir().join(format!("df-coarse-as-written-{}.stl", std::process::id()));
        std::fs::write(&path, &stl).unwrap();

        let single = load_mesh_from_path(&path).unwrap();
        let bodies = load_mesh_bodies_from_path(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(single.triangles.len(), triangles);
        assert_eq!(bodies.len(), 1);
        assert_eq!(bodies[0].triangles.len(), triangles);
        assert!(
            refine_coarse_faces(single).triangles.len() > triangles,
            "the block is coarse enough that a refining loader would have grown it",
        );
    }

    /// A coarse model is the model refinement exists for, so it has to reach the
    /// target like any other.
    ///
    /// The growth fraction alone refuses: measured before the headroom, this block
    /// came out at 14 triangles with its longest edge untouched at 169.71mm,
    /// 48.7x the 3.49mm target, so every big face still carried its occlusion as
    /// one straight ramp. The faces are planar, so nothing about the shape changes.
    #[test]
    fn a_coarse_block_is_refined_to_the_target() {
        let mesh = IndexedMesh::from_triangle_soup(&box_soup([0.0; 3], [120.0, 120.0, 40.0]), 1e-5);
        let triangles_before = mesh.triangles.len();
        let volume_before = mesh.signed_volume();
        let diagonal = mesh.bbox().diag();
        let target = diagonal * MAX_EDGE_DIAGONAL_FRACTION;

        let refined = refine_coarse_faces(mesh);

        let longest = longest_edge(&refined);
        assert!(
            longest <= target * 1.05,
            "a coarse block should come out at the target: longest {longest}mm against {target}mm",
        );
        assert!(
            refined.triangles.len() <= refinement_budget(triangles_before),
            "and inside the budget: {} triangles against {}",
            refined.triangles.len(),
            refinement_budget(triangles_before),
        );
        let volume_after = refined.signed_volume();
        assert!(
            (volume_after - volume_before).abs() < volume_before.abs() * 1e-4,
            "subdividing planar faces must not change the shape: {volume_before} -> {volume_after}",
        );
    }
}

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
