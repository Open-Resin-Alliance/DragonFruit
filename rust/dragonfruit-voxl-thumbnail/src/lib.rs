//! VOXL V2 thumbnail extractor.
//!
//! Parses a VOXL V2 binary file, locates the EXTD chunk, and extracts the
//! embedded `ora.preview` scene thumbnail as raw PNG bytes.
//!
//! The reader-based implementation only reads the header, chunk directory,
//! and EXTD chunk — it never loads mesh data into memory.

use std::fs::File;
use std::io::{self, BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::read::ZlibDecoder;
use thiserror::Error;

const VOXL_MAGIC: &[u8; 4] = b"VOXL";
const HEADER_SIZE: usize = 16;
const DIR_ENTRY_SIZE: usize = 20;

#[derive(Debug, Error)]
pub enum VoxlThumbnailError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("not a VOXL V2 binary file")]
    NotVoxlV2,

    #[error("no EXTD chunk in file")]
    NoExtdChunk,

    #[error("unknown compression code: {0}")]
    UnknownCompression(u16),

    #[error("decompression failed: {0}")]
    Decompression(String),

    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("base64 decode error: {0}")]
    Base64(#[from] base64::DecodeError),

    #[error("no thumbnail (ora.preview) in extensions")]
    NoThumbnail,

    #[error("image error: {0}")]
    Image(String),
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Extract raw PNG thumbnail bytes from a VOXL V2 file on disk.
pub fn extract_thumbnail(path: &Path) -> Result<Vec<u8>, VoxlThumbnailError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    extract_from_reader(&mut reader)
}

/// Extract raw PNG thumbnail bytes from VOXL V2 data already in memory.
pub fn extract_thumbnail_from_bytes(data: &[u8]) -> Result<Vec<u8>, VoxlThumbnailError> {
    let mut cursor = Cursor::new(data);
    extract_from_reader(&mut cursor)
}

/// Extract and resize the thumbnail to fit within `max_size × max_size`.
pub fn extract_thumbnail_resized(
    path: &Path,
    max_size: u32,
) -> Result<Vec<u8>, VoxlThumbnailError> {
    let png = extract_thumbnail(path)?;
    resize_png(&png, max_size)
}

/// Extract from memory and resize.
pub fn extract_thumbnail_from_bytes_resized(
    data: &[u8],
    max_size: u32,
) -> Result<Vec<u8>, VoxlThumbnailError> {
    let png = extract_thumbnail_from_bytes(data)?;
    resize_png(&png, max_size)
}

/// Extract from memory, resize to fit within `size × size`, and center on a
/// transparent `size × size` square canvas.
pub fn extract_thumbnail_from_bytes_square(
    data: &[u8],
    size: u32,
) -> Result<Vec<u8>, VoxlThumbnailError> {
    let png = extract_thumbnail_from_bytes(data)?;
    resize_png_square(&png, size)
}

/// Resize existing PNG bytes to fit within `max_size × max_size`,
/// preserving aspect ratio. Returns the original bytes unchanged if the
/// image already fits.
pub fn resize_png(png_bytes: &[u8], max_size: u32) -> Result<Vec<u8>, VoxlThumbnailError> {
    let img = image::load_from_memory_with_format(png_bytes, image::ImageFormat::Png)
        .map_err(|e| VoxlThumbnailError::Image(e.to_string()))?;

    if img.width() <= max_size && img.height() <= max_size {
        return Ok(png_bytes.to_vec());
    }

    let resized = img.thumbnail(max_size, max_size);

    let mut buf = Cursor::new(Vec::new());
    resized
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| VoxlThumbnailError::Image(e.to_string()))?;

    Ok(buf.into_inner())
}

/// Crop transparent borders from an image, returning the tight bounding box
/// around any pixel with alpha > 0.  Returns the original if fully opaque or
/// fully transparent.
fn autocrop_transparent(img: image::DynamicImage) -> image::DynamicImage {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();

    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0u32;
    let mut max_y = 0u32;

    for y in 0..h {
        for x in 0..w {
            if rgba.get_pixel(x, y)[3] > 0 {
                if x < min_x {
                    min_x = x;
                }
                if x > max_x {
                    max_x = x;
                }
                if y < min_y {
                    min_y = y;
                }
                if y > max_y {
                    max_y = y;
                }
            }
        }
    }

    if min_x > max_x || min_y > max_y {
        return img; // fully transparent — leave unchanged
    }

    img.crop_imm(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)
}

/// Resize existing PNG bytes to fit within `size × size` (aspect-ratio
/// preserved), then center the result on a fully-transparent `size × size`
/// square canvas.  Transparent borders in the source image are cropped first
/// so the model content fills the canvas rather than inheriting ORA padding.
pub fn resize_png_square(png_bytes: &[u8], size: u32) -> Result<Vec<u8>, VoxlThumbnailError> {
    use image::{DynamicImage, GenericImage, RgbaImage};

    let img = image::load_from_memory_with_format(png_bytes, image::ImageFormat::Png)
        .map_err(|e| VoxlThumbnailError::Image(e.to_string()))?;

    // Remove ORA canvas padding so the model content fills the square.
    let img = autocrop_transparent(img);

    let resized = if img.width() > size || img.height() > size {
        img.thumbnail(size, size)
    } else {
        img
    };

    let (rw, rh) = (resized.width(), resized.height());
    let x_off = (size - rw) / 2;
    let y_off = (size - rh) / 2;

    let mut canvas = DynamicImage::ImageRgba8(RgbaImage::new(size, size));
    canvas
        .copy_from(&resized, x_off, y_off)
        .map_err(|e| VoxlThumbnailError::Image(e.to_string()))?;

    let mut buf = Cursor::new(Vec::new());
    canvas
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| VoxlThumbnailError::Image(e.to_string()))?;

    Ok(buf.into_inner())
}

// ---------------------------------------------------------------------------
// Core parser — works with any Read + Seek
// ---------------------------------------------------------------------------

fn extract_from_reader<R: Read + Seek>(reader: &mut R) -> Result<Vec<u8>, VoxlThumbnailError> {
    // ── Header (16 bytes) ──────────────────────────────────────────────
    let mut header = [0u8; HEADER_SIZE];
    reader.read_exact(&mut header)?;

    if &header[0..4] != VOXL_MAGIC {
        return Err(VoxlThumbnailError::NotVoxlV2);
    }
    let version = u16::from_le_bytes([header[4], header[5]]);
    if version < 2 {
        return Err(VoxlThumbnailError::NotVoxlV2);
    }

    let chunk_count = u32::from_le_bytes([header[8], header[9], header[10], header[11]]) as usize;

    // ── Chunk directory (chunk_count × 20 bytes) ───────────────────────
    let mut dir = vec![0u8; chunk_count * DIR_ENTRY_SIZE];
    reader.read_exact(&mut dir)?;

    // ── Locate EXTD[0] ────────────────────────────────────────────────
    for i in 0..chunk_count {
        let b = i * DIR_ENTRY_SIZE;
        let chunk_type = &dir[b..b + 4];
        let index = u16::from_le_bytes([dir[b + 4], dir[b + 5]]);
        let compression = u16::from_le_bytes([dir[b + 6], dir[b + 7]]);
        let offset = u32::from_le_bytes([dir[b + 8], dir[b + 9], dir[b + 10], dir[b + 11]]);
        let compressed_size =
            u32::from_le_bytes([dir[b + 12], dir[b + 13], dir[b + 14], dir[b + 15]]);

        if chunk_type != b"EXTD" || index != 0 {
            continue;
        }

        // Seek to chunk payload
        reader.seek(SeekFrom::Start(offset as u64))?;
        let mut raw = vec![0u8; compressed_size as usize];
        reader.read_exact(&mut raw)?;

        // Decompress if zlib-compressed
        let json_bytes = match compression {
            0 => raw,
            1 => {
                let mut dec = ZlibDecoder::new(Cursor::new(raw));
                let mut out = Vec::new();
                dec.read_to_end(&mut out)
                    .map_err(|e| VoxlThumbnailError::Decompression(e.to_string()))?;
                out
            }
            c => return Err(VoxlThumbnailError::UnknownCompression(c)),
        };

        // Parse JSON → extract ora.preview.dataBase64
        let val: serde_json::Value = serde_json::from_slice(&json_bytes)?;
        let b64 = val
            .get("ora.preview")
            .and_then(|p| p.get("dataBase64"))
            .and_then(|v| v.as_str())
            .ok_or(VoxlThumbnailError::NoThumbnail)?;

        return Ok(STANDARD.decode(b64)?);
    }

    Err(VoxlThumbnailError::NoExtdChunk)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal VOXL V2 file containing only an EXTD chunk with the
    /// supplied PNG bytes embedded as `ora.preview.dataBase64`.
    fn make_test_voxl(thumbnail_png: &[u8]) -> Vec<u8> {
        let extensions = serde_json::json!({
            "ora.preview": {
                "kind": "scene-thumbnail",
                "mimeType": "image/png",
                "encoding": "base64",
                "dataBase64": STANDARD.encode(thumbnail_png)
            }
        });
        let ext_json = serde_json::to_vec(&extensions).unwrap();

        let chunk_count: u32 = 1;
        let data_offset = (HEADER_SIZE + DIR_ENTRY_SIZE) as u32;

        let mut file = Vec::new();

        // Header
        file.extend_from_slice(VOXL_MAGIC);
        file.extend_from_slice(&2u16.to_le_bytes()); // version
        file.extend_from_slice(&0u16.to_le_bytes()); // flags
        file.extend_from_slice(&chunk_count.to_le_bytes());
        file.extend_from_slice(&0u32.to_le_bytes()); // reserved

        // EXTD directory entry
        file.extend_from_slice(b"EXTD");
        file.extend_from_slice(&0u16.to_le_bytes()); // index
        file.extend_from_slice(&0u16.to_le_bytes()); // compression = none
        file.extend_from_slice(&data_offset.to_le_bytes());
        file.extend_from_slice(&(ext_json.len() as u32).to_le_bytes()); // compressed
        file.extend_from_slice(&(ext_json.len() as u32).to_le_bytes()); // uncompressed

        // Chunk data
        file.extend_from_slice(&ext_json);

        file
    }

    fn make_test_png() -> Vec<u8> {
        use image::codecs::png::PngEncoder;
        use image::{ImageEncoder, RgbaImage};

        let img = RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255]));
        let mut buf = Vec::new();
        PngEncoder::new(&mut buf)
            .write_image(img.as_raw(), 4, 4, image::ExtendedColorType::Rgba8)
            .unwrap();
        buf
    }

    #[test]
    fn round_trip_extract() {
        let png = make_test_png();
        let voxl = make_test_voxl(&png);
        let extracted = extract_thumbnail_from_bytes(&voxl).unwrap();
        // Extracted bytes are valid PNG
        assert_eq!(&extracted[0..4], &[0x89, 0x50, 0x4E, 0x47]);
        assert_eq!(extracted, png);
    }

    #[test]
    fn resize_preserves_png() {
        let png = make_test_png();
        // Image is 4×4 — requesting max 256 should return same bytes
        let out = resize_png(&png, 256).unwrap();
        assert_eq!(out, png);
    }

    #[test]
    fn not_voxl_v2() {
        // 16+ bytes but wrong magic → NotVoxlV2
        let err = extract_thumbnail_from_bytes(b"not a voxl file!").unwrap_err();
        assert!(matches!(err, VoxlThumbnailError::NotVoxlV2));
    }

    #[test]
    fn truncated_header() {
        // Fewer than 16 bytes → IO error (unexpected EOF)
        let err = extract_thumbnail_from_bytes(b"VOXL").unwrap_err();
        assert!(matches!(err, VoxlThumbnailError::Io(_)));
    }

    #[test]
    fn no_extd_chunk() {
        // Valid header, zero chunks
        let mut data = Vec::new();
        data.extend_from_slice(VOXL_MAGIC);
        data.extend_from_slice(&2u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes()); // 0 chunks
        data.extend_from_slice(&0u32.to_le_bytes());

        let err = extract_thumbnail_from_bytes(&data).unwrap_err();
        assert!(matches!(err, VoxlThumbnailError::NoExtdChunk));
    }
}
