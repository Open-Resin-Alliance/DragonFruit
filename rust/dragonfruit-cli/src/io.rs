//! Shared CLI utilities for DragonFruit pipeline tools.
//!
//! Provides common I/O functions used across all CLI subcommands:
//! STL loading, bounding box computation, JSON/RLE file read/write.

use std::path::Path;

use serde::{de::DeserializeOwned, Serialize};

use dragonfruit_slicing_engine::geometry::{parse_triangles, Triangle};
use dragonfruit_islands::model::{ComponentInfo, RleLabels, RleMask};

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
// Ensure directory exists
// ---------------------------------------------------------------------------

pub fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create {}: {e}", path.display()))
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
}
