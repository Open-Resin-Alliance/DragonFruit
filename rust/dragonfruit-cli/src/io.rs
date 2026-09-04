//! Shared CLI utilities for DragonFruit pipeline tools.
//!
//! Provides common I/O functions used across all CLI subcommands:
//! STL loading, bounding box computation, JSON/RLE file read/write.

use std::path::Path;

use serde::{de::DeserializeOwned, Serialize};

use dragonfruit_slicing_engine::geometry::Triangle;
#[cfg(test)]
use dragonfruit_slicing_engine::geometry::parse_triangles;
use dragonfruit_islands::model::{RleLabels, RleMask};

// ---------------------------------------------------------------------------
// STL Loading
// ---------------------------------------------------------------------------

/// Load a binary STL file and return flat `[x,y,z,...]` triangle vertex data.
pub fn load_binary_stl(path: &Path) -> Result<Vec<f32>, String> {
    let data = std::fs::read(path).map_err(|e| format!("Failed to read STL: {e}"))?;
    if data.len() < 84 {
        return Err("STL file too small (< 84 bytes)".into());
    }

    let num_triangles = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
    let expected = 84 + num_triangles * 50;
    if data.len() < expected {
        return Err(format!(
            "STL file truncated: expected {} bytes for {} triangles, got {}",
            expected, num_triangles, data.len()
        ));
    }

    let mut flat = Vec::with_capacity(num_triangles * 9);
    let mut offset = 84;
    for _ in 0..num_triangles {
        offset += 12; // skip normal
        for _ in 0..3 {
            flat.push(f32::from_le_bytes([
                data[offset],
                data[offset + 1],
                data[offset + 2],
                data[offset + 3],
            ]));
            flat.push(f32::from_le_bytes([
                data[offset + 4],
                data[offset + 5],
                data[offset + 6],
                data[offset + 7],
            ]));
            flat.push(f32::from_le_bytes([
                data[offset + 8],
                data[offset + 9],
                data[offset + 10],
                data[offset + 11],
            ]));
            offset += 12;
        }
        offset += 2; // attribute byte count
    }
    Ok(flat)
}

/// Write raw f32 positions to a binary file (same format as `stage_mesh_binary`).
pub fn write_positions_bin(path: &Path, flat: &[f32]) -> Result<(), String> {
    let bytes: Vec<u8> = flat.iter().flat_map(|f| f.to_le_bytes()).collect();
    std::fs::write(path, &bytes).map_err(|e| format!("Failed to write positions.bin: {e}"))
}

/// Read raw f32 positions from a binary file.
pub fn read_positions_bin(path: &Path) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read positions.bin: {e}"))?;
    if bytes.len() % 4 != 0 {
        return Err(format!("positions.bin size {} not multiple of 4", bytes.len()));
    }
    let count = bytes.len() / 4;
    let mut floats = vec![0.0f32; count];
    #[cfg(target_endian = "little")]
    {
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), floats.as_mut_ptr() as *mut u8, bytes.len());
        }
    }
    #[cfg(not(target_endian = "little"))]
    {
        for (i, chunk) in bytes.chunks_exact(4).enumerate() {
            floats[i] = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
    }
    Ok(floats)
}

// ---------------------------------------------------------------------------
// Bounding Box
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct BBox {
    pub min_x: f32,
    pub max_x: f32,
    pub min_y: f32,
    pub max_y: f32,
    pub min_z: f32,
    pub max_z: f32,
}

pub fn compute_bbox(triangles: &[Triangle]) -> BBox {
    let mut bb = BBox {
        min_x: f32::MAX,
        max_x: f32::MIN,
        min_y: f32::MAX,
        max_y: f32::MIN,
        min_z: f32::MAX,
        max_z: f32::MIN,
    };
    for tri in triangles {
        for v in &[tri.a, tri.b, tri.c] {
            bb.min_x = bb.min_x.min(v.x);
            bb.max_x = bb.max_x.max(v.x);
            bb.min_y = bb.min_y.min(v.y);
            bb.max_y = bb.max_y.max(v.y);
            bb.min_z = bb.min_z.min(v.z);
            bb.max_z = bb.max_z.max(v.z);
        }
    }
    bb
}

// ---------------------------------------------------------------------------
// JSON I/O
// ---------------------------------------------------------------------------

pub fn write_json<T: Serialize>(path: &Path, data: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| format!("JSON serialize: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("JSON parse {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// RLE Mask JSON I/O
// ---------------------------------------------------------------------------

/// JSON-serializable representation of RleMask (flat i32 arrays per row).
#[derive(Serialize, serde::Deserialize)]
pub struct RleMaskJson {
    pub width: i32,
    pub height: i32,
    pub rows: Vec<Vec<i32>>,
}

impl From<&RleMask> for RleMaskJson {
    fn from(m: &RleMask) -> Self {
        Self {
            width: m.width,
            height: m.height,
            rows: m
                .rows
                .iter()
                .map(|row| {
                    row.iter()
                        .flat_map(|r| vec![r.start, r.length])
                        .collect()
                })
                .collect(),
        }
    }
}

impl RleMaskJson {
    pub fn to_rle_mask(&self) -> RleMask {
        use dragonfruit_islands::model::RleRun;
        RleMask {
            width: self.width,
            height: self.height,
            rows: self
                .rows
                .iter()
                .map(|flat| {
                    flat.chunks(2)
                        .map(|c| RleRun {
                            start: c[0],
                            length: c.get(1).copied().unwrap_or(0),
                        })
                        .collect()
                })
                .collect(),
        }
    }
}

pub fn write_rle_mask_json(path: &Path, mask: &RleMask) -> Result<(), String> {
    write_json(path, &RleMaskJson::from(mask))
}

pub fn read_rle_mask_json(path: &Path) -> Result<RleMask, String> {
    let j: RleMaskJson = read_json(path)?;
    Ok(j.to_rle_mask())
}

// ---------------------------------------------------------------------------
// RLE Labels JSON I/O
// ---------------------------------------------------------------------------

#[derive(Serialize, serde::Deserialize)]
pub struct RleLabelsJson {
    pub width: i32,
    pub height: i32,
    pub rows: Vec<Vec<i32>>,
}

impl From<&RleLabels> for RleLabelsJson {
    fn from(l: &RleLabels) -> Self {
        Self {
            width: l.width,
            height: l.height,
            rows: l
                .rows
                .iter()
                .map(|row| {
                    row.iter()
                        .flat_map(|r| vec![r.start, r.length, r.id])
                        .collect()
                })
                .collect(),
        }
    }
}

impl RleLabelsJson {
    pub fn to_rle_labels(&self) -> RleLabels {
        use dragonfruit_islands::model::RleLabelRun;
        RleLabels {
            width: self.width,
            height: self.height,
            rows: self
                .rows
                .iter()
                .map(|flat| {
                    flat.chunks(3)
                        .map(|c| RleLabelRun {
                            start: c[0],
                            length: c.get(1).copied().unwrap_or(0),
                            id: c.get(2).copied().unwrap_or(0),
                        })
                        .collect()
                })
                .collect(),
        }
    }
}

pub fn write_rle_labels_json(path: &Path, labels: &RleLabels) -> Result<(), String> {
    write_json(path, &RleLabelsJson::from(labels))
}

pub fn read_rle_labels_json(path: &Path) -> Result<RleLabels, String> {
    let j: RleLabelsJson = read_json(path)?;
    Ok(j.to_rle_labels())
}

// ---------------------------------------------------------------------------
// STL Export
// ---------------------------------------------------------------------------

/// Write flat `[x,y,z,...]` f32 positions as a binary STL file.
/// Positions must be a multiple of 9 (3 vertices × 3 coords per triangle).
/// Computes face normals via cross product.
pub fn write_binary_stl(path: &Path, positions: &[f32]) -> Result<(), String> {
    if positions.len() % 9 != 0 {
        return Err(format!(
            "Position count {} is not a multiple of 9",
            positions.len()
        ));
    }

    let num_triangles = positions.len() / 9;
    let mut buf = Vec::with_capacity(84 + num_triangles * 50);

    // 80-byte header
    buf.extend_from_slice(&[0u8; 80]);
    buf.extend_from_slice(&(num_triangles as u32).to_le_bytes());

    for t in 0..num_triangles {
        let base = t * 9;
        let ax = positions[base];
        let ay = positions[base + 1];
        let az = positions[base + 2];
        let bx = positions[base + 3];
        let by = positions[base + 4];
        let bz = positions[base + 5];
        let cx = positions[base + 6];
        let cy = positions[base + 7];
        let cz = positions[base + 8];

        // Face normal via cross product
        let ux = bx - ax;
        let uy = by - ay;
        let uz = bz - az;
        let vx = cx - ax;
        let vy = cy - ay;
        let vz = cz - az;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        let (nx, ny, nz) = if len > 0.0 {
            (nx / len, ny / len, nz / len)
        } else {
            (0.0, 0.0, 0.0)
        };

        buf.extend_from_slice(&nx.to_le_bytes());
        buf.extend_from_slice(&ny.to_le_bytes());
        buf.extend_from_slice(&nz.to_le_bytes());
        for j in 0..9 {
            buf.extend_from_slice(&positions[base + j].to_le_bytes());
        }
        buf.extend_from_slice(&0u16.to_le_bytes());
    }

    std::fs::write(path, &buf).map_err(|e| format!("Failed to write STL: {e}"))
}

// ---------------------------------------------------------------------------
// 3MF Export
// ---------------------------------------------------------------------------

/// Write flat `[x,y,z,...]` f32 positions as a minimal 3MF file.
/// 3MF is a ZIP containing XML model data. Produces a valid 3MF Core Spec archive.
pub fn write_3mf(path: &Path, positions: &[f32]) -> Result<(), String> {
    use std::io::Write;

    if positions.len() % 9 != 0 {
        return Err(format!(
            "Position count {} is not a multiple of 9",
            positions.len()
        ));
    }

    let num_triangles = positions.len() / 9;

    // Deduplicate vertices for compact 3MF (hash position to index)
    let mut vertices: Vec<[f32; 3]> = Vec::new();
    let mut vertex_map: std::collections::HashMap<[u32; 3], usize> = std::collections::HashMap::new();
    let mut tri_indices: Vec<[usize; 3]> = Vec::with_capacity(num_triangles);

    for t in 0..num_triangles {
        let base = t * 9;
        let mut face = [0usize; 3];
        for v in 0..3 {
            let vb = base + v * 3;
            let key = [
                positions[vb].to_bits(),
                positions[vb + 1].to_bits(),
                positions[vb + 2].to_bits(),
            ];
            let idx = vertex_map.entry(key).or_insert_with(|| {
                let i = vertices.len();
                vertices.push([positions[vb], positions[vb + 1], positions[vb + 2]]);
                i
            });
            face[v] = *idx;
        }
        tri_indices.push(face);
    }

    // Build XML model
    let mut model_xml = String::new();
    model_xml.push_str(r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
"#);
    for v in &vertices {
        model_xml.push_str(&format!(
            "          <vertex x=\"{}\" y=\"{}\" z=\"{}\" />\n",
            v[0], v[1], v[2]
        ));
    }
    model_xml.push_str("        </vertices>\n        <triangles>\n");
    for tri in &tri_indices {
        model_xml.push_str(&format!(
            "          <triangle v1=\"{}\" v2=\"{}\" v3=\"{}\" />\n",
            tri[0], tri[1], tri[2]
        ));
    }
    model_xml.push_str(
        r#"        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>
"#,
    );

    let content_types = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>
"#;

    let rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>
"#;

    let file = std::fs::File::create(path)
        .map_err(|e| format!("Failed to create 3MF: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("[Content_Types].xml", options)
        .map_err(|e| format!("3MF zip: {e}"))?;
    zip.write_all(content_types.as_bytes())
        .map_err(|e| format!("3MF write: {e}"))?;

    zip.start_file("_rels/.rels", options)
        .map_err(|e| format!("3MF zip: {e}"))?;
    zip.write_all(rels.as_bytes())
        .map_err(|e| format!("3MF write: {e}"))?;

    zip.start_file("3D/3dmodel.model", options)
        .map_err(|e| format!("3MF zip: {e}"))?;
    zip.write_all(model_xml.as_bytes())
        .map_err(|e| format!("3MF write: {e}"))?;

    zip.finish().map_err(|e| format!("3MF finalize: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// VOXL Loading (V2 binary + ORIG full-res chunk preference)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct VoxlChunkEntry {
    type_tag: [u8; 4],
    index: u16,
    compression: u16,
    offset: usize,
    compressed_size: usize,
    uncompressed_size: usize,
}

/// Helper function to parse binary STL buffer from memory.
pub fn parse_binary_stl_bytes(data: &[u8]) -> Result<Vec<f32>, String> {
    if data.len() < 84 {
        return Err("STL byte buffer too small (< 84 bytes)".into());
    }
    let num_triangles = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
    let expected = 84 + num_triangles * 50;
    if data.len() < expected {
        return Err(format!(
            "STL bytes truncated: expected {} bytes for {} triangles, got {}",
            expected, num_triangles, data.len()
        ));
    }
    let mut flat = Vec::with_capacity(num_triangles * 9);
    let mut offset = 84;
    for _ in 0..num_triangles {
        offset += 12; // skip normal
        for _ in 0..3 {
            flat.push(f32::from_le_bytes([
                data[offset],
                data[offset + 1],
                data[offset + 2],
                data[offset + 3],
            ]));
            flat.push(f32::from_le_bytes([
                data[offset + 4],
                data[offset + 5],
                data[offset + 6],
                data[offset + 7],
            ]));
            flat.push(f32::from_le_bytes([
                data[offset + 8],
                data[offset + 9],
                data[offset + 10],
                data[offset + 11],
            ]));
            offset += 12;
        }
        offset += 2; // attribute byte count
    }
    Ok(flat)
}

/// Check if file starts with VOXL V2 binary header.
pub fn is_voxl_file(path: &Path) -> bool {
    if let Ok(mut file) = std::fs::File::open(path) {
        let mut header = [0u8; 6];
        if std::io::Read::read_exact(&mut file, &mut header).is_ok() {
            if &header[0..4] == b"VOXL" {
                let ver = u16::from_le_bytes([header[4], header[5]]);
                return ver >= 2;
            }
        }
    }
    false
}

/// Load triangles from a VOXL binary file.
/// Prefers `ORIG` (full-resolution) chunks over `MESH` (preview) chunks.
/// Returns `(positions_f32, used_orig_chunk)`.
pub fn load_voxl_triangles(path: &Path) -> Result<(Vec<f32>, bool), String> {
    use flate2::read::ZlibDecoder;

    let data = std::fs::read(path).map_err(|e| format!("Failed to read VOXL file: {e}"))?;
    if data.len() < 16 {
        return Err("VOXL file too small (< 16 bytes)".into());
    }
    if &data[0..4] != b"VOXL" {
        return Err("Invalid VOXL magic header".into());
    }
    let ver = u16::from_le_bytes([data[4], data[5]]);
    if ver < 2 {
        return Err(format!("Unsupported VOXL container version: {ver}"));
    }
    let chunk_count = u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
    let dir_end = 16 + chunk_count * 20;
    if data.len() < dir_end {
        return Err("VOXL file truncated: incomplete chunk directory".into());
    }

    let mut entries = Vec::with_capacity(chunk_count);
    for i in 0..chunk_count {
        let b = 16 + i * 20;
        let mut type_tag = [0u8; 4];
        type_tag.copy_from_slice(&data[b..b + 4]);
        let index = u16::from_le_bytes([data[b + 4], data[b + 5]]);
        let compression = u16::from_le_bytes([data[b + 6], data[b + 7]]);
        let offset = u32::from_le_bytes([data[b + 8], data[b + 9], data[b + 10], data[b + 11]]) as usize;
        let compressed_size = u32::from_le_bytes([data[b + 12], data[b + 13], data[b + 14], data[b + 15]]) as usize;
        let uncompressed_size = u32::from_le_bytes([data[b + 16], data[b + 17], data[b + 18], data[b + 19]]) as usize;

        if offset + compressed_size > data.len() {
            return Err("VOXL chunk extends beyond file boundary".into());
        }

        entries.push(VoxlChunkEntry {
            type_tag,
            index,
            compression,
            offset,
            compressed_size,
            uncompressed_size,
        });
    }

    let read_chunk_data = |entry: &VoxlChunkEntry| -> Result<Vec<u8>, String> {
        let raw = &data[entry.offset..entry.offset + entry.compressed_size];
        match entry.compression {
            0 => Ok(raw.to_vec()),
            1 => {
                let mut decoder = ZlibDecoder::new(raw);
                let mut out = Vec::with_capacity(entry.uncompressed_size);
                std::io::Read::read_to_end(&mut decoder, &mut out)
                    .map_err(|e| format!("Decompress chunk failed: {e}"))?;
                Ok(out)
            }
            c => Err(format!("Unsupported compression mode {c}")),
        }
    };

    let orig_chunk_indices: Vec<u16> = entries.iter().filter(|e| &e.type_tag == b"ORIG").map(|e| e.index).collect();
    let mesh_chunk_indices: Vec<u16> = entries.iter().filter(|e| &e.type_tag == b"MESH").map(|e| e.index).collect();

    // 1. If embedded ORIG chunks are present, load them
    if !orig_chunk_indices.is_empty() {
        let mut idxs = orig_chunk_indices;
        idxs.sort();
        idxs.dedup();
        let mut all_positions = Vec::new();
        for &idx in &idxs {
            if let Some(entry) = entries.iter().find(|e| &e.type_tag == b"ORIG" && e.index == idx) {
                let chunk_bytes = read_chunk_data(entry)?;
                let pos = parse_binary_stl_bytes(&chunk_bytes)?;
                all_positions.extend_from_slice(&pos);
            }
        }
        return Ok((all_positions, true));
    }

    // 2. Check for originalRef / sidecar file references in MODL chunk if no embedded ORIG chunk exists
    if let Some(modl_entry) = entries.iter().find(|e| &e.type_tag == b"MODL") {
        if let Ok(modl_bytes) = read_chunk_data(modl_entry) {
            if let Ok(modl_str) = std::str::from_utf8(&modl_bytes) {
                if let Ok(models) = serde_json::from_str::<serde_json::Value>(modl_str) {
                    if let Some(model_list) = models.as_array() {
                        let mut sidecar_positions = Vec::new();
                        let mut loaded_sidecars = 0;

                        for model in model_list {
                            let file_name = model.get("originalRef")
                                .and_then(|r| r.get("fileName"))
                                .and_then(|v| v.as_str())
                                .or_else(|| model.get("sourcePath").and_then(|v| v.as_str()));

                            if let Some(fname) = file_name {
                                let fname_trimmed = fname.trim();
                                if !fname_trimmed.is_empty() {
                                    let rel_path = Path::new(fname_trimmed);
                                    let sidecar_path = if rel_path.is_absolute() {
                                        rel_path.to_path_buf()
                                    } else {
                                        path.parent().unwrap_or_else(|| Path::new("")).join(rel_path)
                                    };

                                    if sidecar_path.exists() {
                                        if let Ok(pos) = load_binary_stl(&sidecar_path) {
                                            sidecar_positions.extend_from_slice(&pos);
                                            loaded_sidecars += 1;
                                        }
                                    }
                                }
                            }
                        }

                        if loaded_sidecars > 0 && !sidecar_positions.is_empty() {
                            return Ok((sidecar_positions, true));
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback: load MESH chunks (decimated preview)
    let mut idxs = mesh_chunk_indices;
    idxs.sort();
    idxs.dedup();

    if idxs.is_empty() {
        return Err("No MESH or ORIG geometry chunks found in VOXL file".into());
    }

    let mut all_positions = Vec::new();

    for &idx in &idxs {
        if let Some(entry) = entries.iter().find(|e| &e.type_tag == b"MESH" && e.index == idx) {
            let chunk_bytes = read_chunk_data(entry)?;
            let pos = parse_binary_stl_bytes(&chunk_bytes)?;
            all_positions.extend_from_slice(&pos);
        }
    }

    Ok((all_positions, false))
}

// ---------------------------------------------------------------------------
// Ensure directory exists
// ---------------------------------------------------------------------------

pub fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// VOXL File Loading & Support Routing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct VoxlOriginalRef {
    #[serde(rename = "fileName")]
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct VoxlModelEntry {
    pub id: String,
    pub name: Option<String>,
    pub visible: Option<bool>,
    #[serde(rename = "polygonCount")]
    pub polygon_count: Option<u32>,
    #[serde(rename = "isSupportGeometry")]
    pub is_support_geometry: Option<bool>,
    pub mesh: Option<VoxlMeshRef>,
    #[serde(rename = "originalRef")]
    pub original_ref: Option<VoxlOriginalRef>,
    #[serde(rename = "sourcePath")]
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct VoxlMeshRef {
    pub mode: Option<String>,
    #[serde(rename = "chunkIndex")]
    pub chunk_index: Option<u16>,
    #[serde(rename = "dataBase64")]
    pub data_base64: Option<String>,
}

#[derive(Debug, Clone)]
pub struct VoxlLoadedMesh {
    pub triangles_xyz: Vec<f32>,
    pub model_triangle_count: usize,
    pub total_triangle_count: usize,
    pub mesh_encoding: String,
}

pub fn load_binary_stl_from_bytes(data: &[u8]) -> Result<Vec<f32>, String> {
    if data.len() < 84 {
        return Err("STL data too small (< 84 bytes)".into());
    }

    let num_triangles = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
    let expected = 84 + num_triangles * 50;
    if data.len() < expected {
        return Err(format!(
            "STL data truncated: expected {} bytes for {} triangles, got {}",
            expected, num_triangles, data.len()
        ));
    }

    let mut flat = Vec::with_capacity(num_triangles * 9);
    let mut offset = 84;
    for _ in 0..num_triangles {
        offset += 12; // skip normal
        for _ in 0..3 {
            flat.push(f32::from_le_bytes([
                data[offset],
                data[offset + 1],
                data[offset + 2],
                data[offset + 3],
            ]));
            flat.push(f32::from_le_bytes([
                data[offset + 4],
                data[offset + 5],
                data[offset + 6],
                data[offset + 7],
            ]));
            flat.push(f32::from_le_bytes([
                data[offset + 8],
                data[offset + 9],
                data[offset + 10],
                data[offset + 11],
            ]));
            offset += 12;
        }
        offset += 2; // attribute byte count
    }
    Ok(flat)
}

pub fn parse_mesh_bytes(data: &[u8]) -> Result<Vec<f32>, String> {
    if data.len() >= 84 {
        let num_triangles = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
        let expected_stl = 84 + num_triangles * 50;
        if data.len() == expected_stl || (data.len() >= expected_stl && data.len() % 4 != 0) {
            return load_binary_stl_from_bytes(data);
        }
    }
    if data.len() % 36 == 0 {
        return read_positions_bin_from_bytes(data);
    }
    load_binary_stl_from_bytes(data)
}

pub fn read_positions_bin_from_bytes(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() % 4 != 0 {
        return Err(format!("positions.bin size {} not multiple of 4", bytes.len()));
    }
    let count = bytes.len() / 4;
    let mut floats = vec![0.0f32; count];
    #[cfg(target_endian = "little")]
    {
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), floats.as_mut_ptr() as *mut u8, bytes.len());
        }
    }
    #[cfg(not(target_endian = "little"))]
    {
        for (i, chunk) in bytes.chunks_exact(4).enumerate() {
            floats[i] = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
    }
    Ok(floats)
}

pub fn load_voxl(path: &Path) -> Result<VoxlLoadedMesh, String> {
    let data = std::fs::read(path).map_err(|e| format!("Failed to read VOXL file: {e}"))?;
    load_voxl_from_bytes_with_path(&data, path)
}

pub fn load_voxl_from_bytes(data: &[u8]) -> Result<VoxlLoadedMesh, String> {
    load_voxl_from_bytes_with_path(data, Path::new(""))
}

pub fn load_voxl_from_bytes_with_path(data: &[u8], path: &Path) -> Result<VoxlLoadedMesh, String> {
    if data.len() >= 16 && &data[0..4] == b"VOXL" {
        return load_voxl_v2_from_bytes_with_path(data, path);
    }
    load_voxl_v1_from_bytes(data)
}

struct VoxlChunkHeader {
    tag: [u8; 4],
    index: u16,
    compression: u16,
    offset: usize,
    comp_size: usize,
    raw_size: usize,
}

fn decompress_chunk_bytes(data: &[u8], chunk: &VoxlChunkHeader) -> Result<Vec<u8>, String> {
    if data.len() < chunk.offset + chunk.comp_size {
        return Err("Truncated chunk data in VOXL file".into());
    }
    let slice = &data[chunk.offset..chunk.offset + chunk.comp_size];
    if chunk.compression == 0 {
        Ok(slice.to_vec())
    } else if chunk.compression == 1 {
        let mut decompressed = vec![0u8; chunk.raw_size];
        let mut decompressor = libdeflater::Decompressor::new();
        decompressor.zlib_decompress(slice, &mut decompressed)
            .map_err(|e| format!("Decompress chunk failed: {e:?}"))?;
        Ok(decompressed)
    } else {
        Err(format!("Unsupported chunk compression: {}", chunk.compression))
    }
}

fn load_voxl_v2_from_bytes_with_path(data: &[u8], path: &Path) -> Result<VoxlLoadedMesh, String> {
    let chunk_count = u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
    let mut dir_offset = 16;
    if data.len() < 16 + chunk_count * 20 {
        return Err("Truncated VOXL header/directory".into());
    }

    let mut chunks = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        let tag = [data[dir_offset], data[dir_offset + 1], data[dir_offset + 2], data[dir_offset + 3]];
        let index = u16::from_le_bytes([data[dir_offset + 4], data[dir_offset + 5]]);
        let compression = u16::from_le_bytes([data[dir_offset + 6], data[dir_offset + 7]]);
        let offset = u32::from_le_bytes([data[dir_offset + 8], data[dir_offset + 9], data[dir_offset + 10], data[dir_offset + 11]]) as usize;
        let comp_size = u32::from_le_bytes([data[dir_offset + 12], data[dir_offset + 13], data[dir_offset + 14], data[dir_offset + 15]]) as usize;
        let raw_size = u32::from_le_bytes([data[dir_offset + 16], data[dir_offset + 17], data[dir_offset + 18], data[dir_offset + 19]]) as usize;
        dir_offset += 20;

        chunks.push(VoxlChunkHeader { tag, index, compression, offset, comp_size, raw_size });
    }

    let modl_chunk = chunks.iter().find(|c| &c.tag == b"MODL")
        .ok_or_else(|| "VOXL container missing MODL chunk".to_string())?;

    let modl_raw_bytes = decompress_chunk_bytes(data, modl_chunk)?;
    let modl_json_str = std::str::from_utf8(&modl_raw_bytes)
        .map_err(|e| format!("Invalid UTF-8 in MODL chunk: {e}"))?;

    let models: Vec<VoxlModelEntry> = serde_json::from_str(modl_json_str)
        .map_err(|e| format!("Failed to parse MODL JSON: {e}"))?;

    let has_orig_chunks = chunks.iter().any(|c| &c.tag == b"ORIG");

    let mut used_orig = false;
    let mut model_triangles = Vec::new();
    let mut support_triangles = Vec::new();

    if has_orig_chunks {
        used_orig = true;
        for (i, m) in models.iter().enumerate() {
            if !m.visible.unwrap_or(true) {
                continue;
            }
            let is_support = m.is_support_geometry.unwrap_or(false);
            let target_chunk_index = m.mesh.as_ref()
                .and_then(|mesh| mesh.chunk_index)
                .unwrap_or(i as u16);

            if let Some(c) = chunks.iter().find(|c| &c.tag == b"ORIG" && c.index == target_chunk_index) {
                let chunk_bytes = decompress_chunk_bytes(data, c)?;
                let tris = parse_mesh_bytes(&chunk_bytes)?;
                if is_support {
                    support_triangles.extend(tris);
                } else {
                    model_triangles.extend(tris);
                }
            }
        }
    } else {
        let mut loaded_sidecars = 0;
        for m in &models {
            if !m.visible.unwrap_or(true) {
                continue;
            }
            let is_support = m.is_support_geometry.unwrap_or(false);
            let file_name = m.original_ref.as_ref()
                .and_then(|r| r.file_name.as_ref())
                .map(|s| s.as_str())
                .or_else(|| m.source_path.as_deref());

            if let Some(fname) = file_name {
                let fname_trimmed = fname.trim();
                if !fname_trimmed.is_empty() {
                    let rel_path = Path::new(fname_trimmed);
                    let sidecar_path = if rel_path.is_absolute() {
                        rel_path.to_path_buf()
                    } else {
                        path.parent().unwrap_or_else(|| Path::new("")).join(rel_path)
                    };

                    if sidecar_path.exists() {
                        if let Ok(tris) = load_binary_stl(&sidecar_path) {
                            if is_support {
                                support_triangles.extend(tris);
                            } else {
                                model_triangles.extend(tris);
                            }
                            loaded_sidecars += 1;
                        }
                    }
                }
            }
        }

        if loaded_sidecars > 0 {
            used_orig = true;
        } else {
            for (i, m) in models.iter().enumerate() {
                if !m.visible.unwrap_or(true) {
                    continue;
                }
                let is_support = m.is_support_geometry.unwrap_or(false);
                let target_chunk_index = m.mesh.as_ref()
                    .and_then(|mesh| mesh.chunk_index)
                    .unwrap_or(i as u16);

                if let Some(c) = chunks.iter().find(|c| &c.tag == b"MESH" && c.index == target_chunk_index) {
                    let chunk_bytes = decompress_chunk_bytes(data, c)?;
                    let tris = parse_mesh_bytes(&chunk_bytes)?;
                    if is_support {
                        support_triangles.extend(tris);
                    } else {
                        model_triangles.extend(tris);
                    }
                }
            }
        }
    }

    let model_triangle_count = model_triangles.len() / 9;
    let mut triangles_xyz = model_triangles;
    triangles_xyz.extend(support_triangles);
    let total_triangle_count = triangles_xyz.len() / 9;
    let mesh_encoding = if used_orig { "voxl_orig" } else { "voxl_mesh" };

    Ok(VoxlLoadedMesh {
        triangles_xyz,
        model_triangle_count,
        total_triangle_count,
        mesh_encoding: mesh_encoding.to_string(),
    })
}

fn load_voxl_v1_from_bytes(data: &[u8]) -> Result<VoxlLoadedMesh, String> {
    use base64::Engine;

    let json_bytes = if data.len() >= 2 && data[0] == 0x78 {
        let mut decompressor = libdeflater::Decompressor::new();
        let mut buf = vec![0u8; data.len() * 10 + 65536];
        match decompressor.zlib_decompress(data, &mut buf) {
            Ok(sz) => {
                buf.truncate(sz);
                buf
            }
            Err(_) => data.to_vec(),
        }
    } else {
        data.to_vec()
    };

    let text = std::str::from_utf8(&json_bytes).map_err(|e| format!("Invalid UTF-8 in VOXL V1: {e}"))?;
    let doc: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Invalid VOXL V1 JSON: {e}"))?;

    let models = doc.get("models").and_then(|v| v.as_array()).ok_or("VOXL V1 missing models array")?;

    let mut model_triangles = Vec::new();
    let mut support_triangles = Vec::new();

    for m in models {
        let visible = m.get("visible").and_then(|v| v.as_bool()).unwrap_or(true);
        if !visible {
            continue;
        }

        let is_support = m.get("isSupportGeometry").and_then(|v| v.as_bool()).unwrap_or(false);

        if let Some(mesh) = m.get("mesh") {
            if let Some(base64_str) = mesh.get("dataBase64").and_then(|v| v.as_str()) {
                if let Ok(raw_bytes) = base64::engine::general_purpose::STANDARD.decode(base64_str) {
                    if let Ok(tris) = parse_mesh_bytes(&raw_bytes) {
                        if is_support {
                            support_triangles.extend(tris);
                        } else {
                            model_triangles.extend(tris);
                        }
                    }
                }
            }
        }
    }

    let model_triangle_count = model_triangles.len() / 9;
    let mut triangles_xyz = model_triangles;
    triangles_xyz.extend(support_triangles);
    let total_triangle_count = triangles_xyz.len() / 9;

    Ok(VoxlLoadedMesh {
        triangles_xyz,
        model_triangle_count,
        total_triangle_count,
        mesh_encoding: "voxl_mesh".to_string(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use dragonfruit_islands::model::{RleLabelRun, RleRun};
    use proptest::prelude::*;
    use std::path::PathBuf;

    /// RAII temp directory — cleaned up on drop (even on panic).
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "df-cli-test-{}-{}", std::process::id(), n
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path { &self.0 }

        fn join(&self, name: &str) -> PathBuf { self.0.join(name) }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // -- Positions binary roundtrip --

    #[test]
    fn positions_bin_roundtrip_basic() {
        let dir = TempDir::new();
        let path = dir.join("pos.bin");
        let data = vec![1.0f32, 2.0, 3.0, 4.5, -1.0, 0.0];
        write_positions_bin(&path, &data).unwrap();
        let back = read_positions_bin(&path).unwrap();
        assert_eq!(data, back);
    }

    proptest! {
        #[test]
        fn positions_bin_roundtrip_prop(data in proptest::collection::vec(-1000.0f32..1000.0, 0..300)) {
            let dir = TempDir::new();
            let path = dir.join("pos_prop.bin");
            write_positions_bin(&path, &data).unwrap();
            let back = read_positions_bin(&path).unwrap();
            prop_assert_eq!(data, back);
        }
    }

    // -- RleMask JSON roundtrip --

    #[test]
    fn rle_mask_json_roundtrip_basic() {
        let dir = TempDir::new();
        let path = dir.join("mask.json");
        let mask = RleMask {
            width: 10,
            height: 3,
            rows: vec![
                vec![RleRun { start: 2, length: 3 }, RleRun { start: 7, length: 2 }],
                vec![],
                vec![RleRun { start: 0, length: 10 }],
            ],
        };
        write_rle_mask_json(&path, &mask).unwrap();
        let back = read_rle_mask_json(&path).unwrap();
        assert_eq!(mask, back);
    }

    // Strategy: generate valid RleMask with sorted non-overlapping runs
    fn rle_mask_strategy() -> impl Strategy<Value = RleMask> {
        (1..50i32, 1..50i32).prop_flat_map(|(w, h)| {
            let w2 = w;
            proptest::collection::vec(
                proptest::collection::vec((0..w2 as usize, 1..w2.max(2) as usize), 0..5)
                    .prop_map(move |raw_runs| {
                        let mut runs = Vec::new();
                        let mut x = 0i32;
                        for (offset, len) in raw_runs {
                            let start = x + offset as i32;
                            if start >= w2 { break; }
                            let length = (len as i32).min(w2 - start);
                            if length <= 0 { continue; }
                            runs.push(RleRun { start, length });
                            x = start + length;
                        }
                        runs
                    }),
                h as usize,
            )
            .prop_map(move |rows| RleMask { width: w, height: h, rows })
        })
    }

    proptest! {
        #[test]
        fn rle_mask_json_roundtrip_prop(mask in rle_mask_strategy()) {
            let dir = TempDir::new();
            let path = dir.join("mask_prop.json");
            write_rle_mask_json(&path, &mask).unwrap();
            let back = read_rle_mask_json(&path).unwrap();
            prop_assert_eq!(mask, back);
        }
    }

    // -- RleLabels JSON roundtrip --

    #[test]
    fn rle_labels_json_roundtrip_basic() {
        let dir = TempDir::new();
        let path = dir.join("labels.json");
        let labels = RleLabels {
            width: 10,
            height: 2,
            rows: vec![
                vec![RleLabelRun { start: 1, length: 3, id: 1 }, RleLabelRun { start: 6, length: 2, id: 2 }],
                vec![RleLabelRun { start: 0, length: 5, id: 1 }],
            ],
        };
        write_rle_labels_json(&path, &labels).unwrap();
        let back = read_rle_labels_json(&path).unwrap();
        assert_eq!(labels, back);
    }

    proptest! {
        #[test]
        fn rle_labels_json_roundtrip_prop(
            width in 1..50i32,
            height in 1..20i32,
            num_runs in 0..5usize,
        ) {
            let rows: Vec<Vec<RleLabelRun>> = (0..height).map(|_| {
                let mut runs = Vec::new();
                let mut x = 0i32;
                for id in 1..=num_runs as i32 {
                    let start = x + 1;
                    if start >= width { break; }
                    let length = 1.min(width - start);
                    runs.push(RleLabelRun { start, length, id });
                    x = start + length;
                }
                runs
            }).collect();
            let labels = RleLabels { width, height, rows };

            let dir = TempDir::new();
            let path = dir.join("labels_prop.json");
            write_rle_labels_json(&path, &labels).unwrap();
            let back = read_rle_labels_json(&path).unwrap();
            prop_assert_eq!(labels, back);
        }
    }

    // -- BBox computation --

    #[test]
    fn bbox_single_triangle() {
        let flat = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let tris = parse_triangles(&flat);
        let bb = compute_bbox(&tris);
        assert_eq!(bb.min_x, 0.0);
        assert_eq!(bb.max_x, 1.0);
        assert_eq!(bb.min_y, 0.0);
        assert_eq!(bb.max_y, 1.0);
        assert_eq!(bb.min_z, 0.0);
        assert_eq!(bb.max_z, 0.0);
    }

    // -- JSON generic roundtrip --

    #[test]
    fn json_roundtrip_generic() {
        let dir = TempDir::new();
        let path = dir.join("test.json");
        let data = serde_json::json!({"a": 1, "b": [2, 3], "c": "hello"});
        write_json(&path, &data).unwrap();
        let back: serde_json::Value = read_json(&path).unwrap();
        assert_eq!(data, back);
    }

    // -- Error handling --

    #[test]
    fn read_nonexistent_file_returns_error() {
        let result = read_positions_bin(Path::new("/nonexistent/positions.bin"));
        assert!(result.is_err());
    }

    #[test]
    fn load_stl_too_small_returns_error() {
        let dir = TempDir::new();
        let path = dir.join("tiny.stl");
        std::fs::write(&path, b"too small").unwrap();
        let result = load_binary_stl(&path);
        assert!(result.is_err());
    }

    // -- STL write roundtrip --

    #[test]
    fn stl_write_roundtrip() {
        let positions = vec![
            0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let dir = TempDir::new();
        let path = dir.join("rt.stl");
        write_binary_stl(&path, &positions).unwrap();
        let back = load_binary_stl(&path).unwrap();
        assert_eq!(positions.len(), back.len());
        for (a, b) in positions.iter().zip(back.iter()) {
            assert!((a - b).abs() < 1e-6, "{} != {}", a, b);
        }
    }

    #[test]
    fn stl_write_rejects_non_multiple_of_9() {
        let dir = TempDir::new();
        let result = write_binary_stl(&dir.join("bad.stl"), &[1.0, 2.0]);
        assert!(result.is_err());
    }

    proptest! {
        #[test]
        fn stl_roundtrip_prop(positions in proptest::collection::vec(-100.0f32..100.0, 0..90)
            .prop_map(|mut v| { v.truncate(v.len() / 9 * 9); v }))
        {
            if positions.is_empty() { return Ok(()); }
            let dir = TempDir::new();
            let path = dir.join("stl_prop.stl");
            write_binary_stl(&path, &positions).unwrap();
            let back = load_binary_stl(&path).unwrap();
            prop_assert_eq!(positions.len(), back.len());
            for (a, b) in positions.iter().zip(back.iter()) {
                prop_assert!((a - b).abs() < 1e-5, "{} != {}", a, b);
            }
        }
    }

    // -- 3MF write --

    #[test]
    fn write_3mf_produces_valid_zip() {
        let positions = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let dir = TempDir::new();
        let path = dir.join("test.3mf");
        write_3mf(&path, &positions).unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        assert!(zip.by_name("[Content_Types].xml").is_ok());
        assert!(zip.by_name("_rels/.rels").is_ok());
        assert!(zip.by_name("3D/3dmodel.model").is_ok());
    }

    #[test]
    fn write_3mf_contains_correct_counts() {
        let positions = vec![
            0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let dir = TempDir::new();
        let path = dir.join("test2.3mf");
        write_3mf(&path, &positions).unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut model = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("3D/3dmodel.model").unwrap(), &mut model).unwrap();
        // 2 triangles
        assert_eq!(model.matches("<triangle ").count(), 2);
        // vertices (deduplicated: 6 input verts but some may share coords)
        assert!(model.matches("<vertex ").count() >= 4);
    }

    #[test]
    fn write_3mf_rejects_non_multiple_of_9() {
        let dir = TempDir::new();
        let result = write_3mf(&dir.join("bad.3mf"), &[1.0, 2.0]);
        assert!(result.is_err());
    }

    proptest! {
        #[test]
        fn write_3mf_valid_zip_prop(positions in proptest::collection::vec(-100.0f32..100.0, 0..90)
            .prop_map(|mut v| { v.truncate(v.len() / 9 * 9); v }))
        {
            if positions.is_empty() { return Ok(()); }
            let dir = TempDir::new();
            let path = dir.join("3mf_prop.3mf");
            write_3mf(&path, &positions).unwrap();
            let file = std::fs::File::open(&path).unwrap();
            let zip = zip::ZipArchive::new(file).unwrap();
            prop_assert!(zip.len() >= 3);
        }
    }

    // -- Inspect archive (ZIP) --

    #[test]
    fn inspect_nanodlp_archive() {
        // Create a fake nanodlp archive with 3 PNGs + manifest
        let dir = TempDir::new();
        let path = dir.join("test.nanodlp");

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::FileOptions::default();

        // 3 layer PNGs
        for i in 1..=3 {
            zip.start_file(format!("{}.png", i), opts).unwrap();
            std::io::Write::write_all(&mut zip, b"fake png data").unwrap();
        }

        // manifest
        zip.start_file("manifest.json", opts).unwrap();
        std::io::Write::write_all(
            &mut zip,
            br#"{"layers":3,"format":"nanodlp"}"#,
        ).unwrap();

        zip.finish().unwrap();

        // Now inspect
        let file = std::fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();

        assert_eq!(archive.len(), 4); // 3 PNGs + manifest

        let mut layer_count = 0u32;
        for i in 0..archive.len() {
            if let Ok(entry) = archive.by_index(i) {
                if entry.name().ends_with(".png") {
                    layer_count += 1;
                }
            }
        }
        assert_eq!(layer_count, 3);
    }

    // -- 3MF inspect --

    #[test]
    fn inspect_3mf_archive() {
        let positions = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let dir = TempDir::new();
        let path = dir.join("test.3mf");
        write_3mf(&path, &positions).unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let archive = zip::ZipArchive::new(file).unwrap();
        assert!(archive.len() >= 3);
    }

    // -- STL → 3MF → inspect roundtrip --

    #[test]
    fn stl_to_3mf_inspect_roundtrip() {
        let positions = vec![
            0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let dir = TempDir::new();

        // Write STL
        let stl_path = dir.join("test.stl");
        write_binary_stl(&stl_path, &positions).unwrap();

        // Read STL back
        let back = load_binary_stl(&stl_path).unwrap();
        assert_eq!(positions.len(), back.len());

        // Write as 3MF
        let mf_path = dir.join("test.3mf");
        write_3mf(&mf_path, &back).unwrap();

        // Inspect 3MF
        let file = std::fs::File::open(&mf_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();

        // Should have model with 2 triangles
        let mut model = String::new();
        std::io::Read::read_to_string(
            &mut archive.by_name("3D/3dmodel.model").unwrap(),
            &mut model,
        ).unwrap();
        assert_eq!(model.matches("<triangle ").count(), 2);
        drop(archive); // release file handle before TempDir cleanup
    }

    // -- Format version passthrough --

    #[test]
    fn slice_job_format_version_field() {
        // Verify SliceJobV3 accepts format_version
        use dragonfruit_slicing_engine::types::SliceJobV3;

        let job_json = r#"{
            "output_format": ".ctb",
            "source_width_px": 100, "source_height_px": 100,
            "width_px": 100, "height_px": 100,
            "build_width_mm": 50, "build_depth_mm": 50,
            "layer_height_mm": 0.05, "total_layers": 10,
            "triangles_xyz": [],
            "metadata_json": "{}",
            "format_version": "v5enc",
            "minimum_aa_alpha_percent": 5.0
        }"#;

        let job: SliceJobV3 = serde_json::from_str(job_json).unwrap();
        assert_eq!(job.format_version, Some("v5enc".to_string()));
        assert!((job.minimum_aa_alpha_percent - 5.0).abs() < 0.01);
    }

    #[test]
    fn slice_job_format_version_defaults_to_none() {
        use dragonfruit_slicing_engine::types::SliceJobV3;

        let job_json = r#"{
            "output_format": ".nanodlp",
            "source_width_px": 100, "source_height_px": 100,
            "width_px": 100, "height_px": 100,
            "build_width_mm": 50, "build_depth_mm": 50,
            "layer_height_mm": 0.05, "total_layers": 10,
            "triangles_xyz": [],
            "metadata_json": "{}"
        }"#;

        let job: SliceJobV3 = serde_json::from_str(job_json).unwrap();
        assert_eq!(job.format_version, None);
        assert!(job.minimum_aa_alpha_percent >= 0.0);
    }

    #[test]
    fn voxl_load_is_support_geometry_partitioning() {
        use base64::Engine;

        // Tri 1 (model): z=1.0
        let tri1_stl = vec![
            0.0f32, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0,
        ];
        let mut tri1_buf = Vec::new();
        for f in &tri1_stl {
            tri1_buf.extend_from_slice(&f.to_le_bytes());
        }
        let tri1_b64 = base64::engine::general_purpose::STANDARD.encode(&tri1_buf);

        // Tri 2 (support): z=5.0
        let tri2_stl = vec![
            0.0f32, 0.0, 5.0, 1.0, 0.0, 5.0, 0.0, 1.0, 5.0,
        ];
        let mut tri2_buf = Vec::new();
        for f in &tri2_stl {
            tri2_buf.extend_from_slice(&f.to_le_bytes());
        }
        let tri2_b64 = base64::engine::general_purpose::STANDARD.encode(&tri2_buf);

        let voxl_json = serde_json::json!({
            "version": 1,
            "models": [
                {
                    "id": "m1",
                    "name": "Model Part",
                    "visible": true,
                    "isSupportGeometry": false,
                    "mesh": {
                        "mode": "base64-raw",
                        "dataBase64": tri1_b64
                    }
                },
                {
                    "id": "s1",
                    "name": "Support Part",
                    "visible": true,
                    "isSupportGeometry": true,
                    "mesh": {
                        "mode": "base64-raw",
                        "dataBase64": tri2_b64
                    }
                }
            ]
        }).to_string();

        let voxl = load_voxl_from_bytes(voxl_json.as_bytes()).unwrap();
        assert_eq!(voxl.model_triangle_count, 1);
        assert_eq!(voxl.total_triangle_count, 2);
        assert_eq!(voxl.triangles_xyz.len(), 18);

        // Model tri (z=1.0) must come first
        assert_eq!(voxl.triangles_xyz[2], 1.0);
        // Support tri (z=5.0) must come second
        assert_eq!(voxl.triangles_xyz[11], 5.0);
    }

    #[test]
    fn voxl_v2_priority_and_classification_loading() {
        // Let's create two meshes
        // Tri 1 (model): z=1.0. 9 floats = 36 bytes. We will use raw positions binary (since parse_mesh_bytes accepts it if multiple of 36)
        let tri1_xyz = vec![0.0f32, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0];
        let mut tri1_bytes = Vec::new();
        for &f in &tri1_xyz {
            tri1_bytes.extend_from_slice(&f.to_le_bytes());
        }

        // Tri 2 (support): z=5.0. 36 bytes.
        let tri2_xyz = vec![0.0f32, 0.0, 5.0, 1.0, 0.0, 5.0, 0.0, 1.0, 5.0];
        let mut tri2_bytes = Vec::new();
        for &f in &tri2_xyz {
            tri2_bytes.extend_from_slice(&f.to_le_bytes());
        }

        // MODL JSON
        let modl_json = serde_json::json!([
            {
                "id": "m1",
                "visible": true,
                "isSupportGeometry": false,
                "mesh": { "chunkIndex": 0 }
            },
            {
                "id": "s1",
                "visible": true,
                "isSupportGeometry": true,
                "mesh": { "chunkIndex": 1 }
            }
        ]).to_string();
        let modl_bytes = modl_json.into_bytes();

        // Let's assemble a VOXL V2 file.
        // We have 3 chunks: MODL (index 0), MESH (index 0), MESH (index 1)
        // Chunks layout:
        // Header: 16 bytes
        // Directory: 3 chunks * 20 bytes = 60 bytes
        // Total header/dir: 76 bytes
        let modl_offset = 76;
        let modl_len = modl_bytes.len();
        let mesh0_offset = modl_offset + modl_len;
        let mesh0_len = tri1_bytes.len();
        let mesh1_offset = mesh0_offset + mesh0_len;
        let mesh1_len = tri2_bytes.len();

        let mut data = Vec::new();
        data.extend_from_slice(b"VOXL"); // magic
        data.extend_from_slice(&2u16.to_le_bytes()); // version
        data.extend_from_slice(&0u16.to_le_bytes()); // flags
        data.extend_from_slice(&3u32.to_le_bytes()); // chunk count
        data.extend_from_slice(&0u32.to_le_bytes()); // reserved

        // Chunk 1: MODL, index 0, compression 0
        data.extend_from_slice(b"MODL");
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&(modl_offset as u32).to_le_bytes());
        data.extend_from_slice(&(modl_len as u32).to_le_bytes());
        data.extend_from_slice(&(modl_len as u32).to_le_bytes());

        // Chunk 2: MESH, index 0, compression 0
        data.extend_from_slice(b"MESH");
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&(mesh0_offset as u32).to_le_bytes());
        data.extend_from_slice(&(mesh0_len as u32).to_le_bytes());
        data.extend_from_slice(&(mesh0_len as u32).to_le_bytes());

        // Chunk 3: MESH, index 1, compression 0
        data.extend_from_slice(b"MESH");
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&(mesh1_offset as u32).to_le_bytes());
        data.extend_from_slice(&(mesh1_len as u32).to_le_bytes());
        data.extend_from_slice(&(mesh1_len as u32).to_le_bytes());

        // Append payloads
        data.extend_from_slice(&modl_bytes);
        data.extend_from_slice(&tri1_bytes);
        data.extend_from_slice(&tri2_bytes);

        // Load V2 mesh and check classification
        let voxl = load_voxl_from_bytes(&data).unwrap();
        assert_eq!(voxl.model_triangle_count, 1);
        assert_eq!(voxl.total_triangle_count, 2);
        assert_eq!(voxl.mesh_encoding, "voxl_mesh");
        // Model tri first (z=1.0)
        assert_eq!(voxl.triangles_xyz[2], 1.0);
        // Support tri second (z=5.0)
        assert_eq!(voxl.triangles_xyz[11], 5.0);
    }
}
