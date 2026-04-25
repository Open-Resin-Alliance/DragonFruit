//! 3MF parser. 3MF is a ZIP archive with `3D/3dmodel.model` containing
//! XML with `<vertex x= y= z=>` and `<triangle v1= v2= v3=>` elements.
//! We use lightweight byte-level parsing instead of full XML so this stays
//! fast on large meshes.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::core::mesh::{IndexedMesh, Vec3};
use crate::MeshRepairError;

pub fn load(path: &Path) -> Result<IndexedMesh, MeshRepairError> {
    let file = File::open(path)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| MeshRepairError::Parse(format!("3MF zip open: {e}")))?;

    // Find the primary 3dmodel file (may be under 3D/ or elsewhere).
    let mut model_name: Option<String> = None;
    for i in 0..zip.len() {
        let entry = zip
            .by_index(i)
            .map_err(|e| MeshRepairError::Parse(format!("3MF zip entry: {e}")))?;
        let name = entry.name().to_string();
        if name.to_ascii_lowercase().ends_with(".model") {
            model_name = Some(name);
            break;
        }
    }
    let model_name = model_name
        .ok_or_else(|| MeshRepairError::Parse("3MF: no .model entry".into()))?;

    let mut xml = String::new();
    zip.by_name(&model_name)
        .map_err(|e| MeshRepairError::Parse(format!("3MF read model: {e}")))?
        .read_to_string(&mut xml)?;

    // Merge all <object><mesh> blocks we find. 3MF components/build transforms
    // are not applied here — they're rare in single-object slicer input, and
    // the frontend already merges groups via Three.js when needed.
    let mut positions: Vec<Vec3> = Vec::new();
    let mut triangles: Vec<[u32; 3]> = Vec::new();

    let mut cursor = 0usize;
    while let Some(mesh_open) = find_tag(&xml, cursor, "<mesh") {
        let mesh_end = find_tag(&xml, mesh_open, "</mesh>")
            .ok_or_else(|| MeshRepairError::Parse("3MF: unterminated <mesh>".into()))?;
        let block = &xml[mesh_open..mesh_end];

        let start_local_base = positions.len() as u32;
        // Vertices.
        let mut vc = 0usize;
        while let Some(pos) = block[vc..].find("<vertex ") {
            let abs = vc + pos;
            let end = block[abs..]
                .find("/>")
                .or_else(|| block[abs..].find('>'))
                .map(|p| abs + p)
                .ok_or_else(|| MeshRepairError::Parse("3MF: unterminated <vertex>".into()))?;
            let tag = &block[abs..end];
            let x = parse_attr_f32(tag, "x").unwrap_or(0.0);
            let y = parse_attr_f32(tag, "y").unwrap_or(0.0);
            let z = parse_attr_f32(tag, "z").unwrap_or(0.0);
            positions.push(Vec3::new(x, y, z));
            vc = end;
        }
        // Triangles (relative to local vertex base).
        let mut tc = 0usize;
        while let Some(pos) = block[tc..].find("<triangle ") {
            let abs = tc + pos;
            let end = block[abs..]
                .find("/>")
                .or_else(|| block[abs..].find('>'))
                .map(|p| abs + p)
                .ok_or_else(|| MeshRepairError::Parse("3MF: unterminated <triangle>".into()))?;
            let tag = &block[abs..end];
            let v1 = parse_attr_u32(tag, "v1").unwrap_or(0) + start_local_base;
            let v2 = parse_attr_u32(tag, "v2").unwrap_or(0) + start_local_base;
            let v3 = parse_attr_u32(tag, "v3").unwrap_or(0) + start_local_base;
            triangles.push([v1, v2, v3]);
            tc = end;
        }
        // Vertex/triangle indices are mesh-local; we offset by the count of
        // positions captured before this mesh (`start_local_base`).
        cursor = mesh_end + "</mesh>".len();
    }

    if positions.is_empty() || triangles.is_empty() {
        return Err(MeshRepairError::Parse(
            "3MF: no geometry parsed (positions or triangles)".into(),
        ));
    }
    Ok(IndexedMesh { positions, triangles })
}

fn find_tag(xml: &str, from: usize, needle: &str) -> Option<usize> {
    xml[from..].find(needle).map(|p| from + p)
}

fn parse_attr_f32(tag: &str, name: &str) -> Option<f32> {
    let key = format!("{name}=");
    let pos = tag.find(&key)?;
    let rest = &tag[pos + key.len()..];
    let quote = rest.chars().next()?;
    let rest = &rest[1..];
    let end = rest.find(quote)?;
    rest[..end].parse().ok()
}

fn parse_attr_u32(tag: &str, name: &str) -> Option<u32> {
    let key = format!("{name}=");
    let pos = tag.find(&key)?;
    let rest = &tag[pos + key.len()..];
    let quote = rest.chars().next()?;
    let rest = &rest[1..];
    let end = rest.find(quote)?;
    rest[..end].parse().ok()
}
