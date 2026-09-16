//! Thumbnail extractor for the containers DragonFruit reads and writes.
//!
//! Two formats, one entry point: [`extract_thumbnail`] and
//! [`extract_thumbnail_from_bytes`] dispatch on the file magic.
//!
//! * **VOXL V2** — the scene format. The scene thumbnail rides in the `EXTD`
//!   chunk as `ora.preview.dataBase64` (base64 PNG), so the reader walks the
//!   header, the chunk directory, and that one chunk; mesh data is never read.
//! * **LUMEN v1** — the print format. Previews ride in `PREV` chunks as PNG
//!   payloads, with the role (large/small/icon) in the descriptor flags. The
//!   directory sits at the end of the file, so the reader seeks to it and then
//!   to the best preview; layer data is never read.
//!
//! The reader-based implementation only ever reads headers, directories, and
//! the one chunk that carries the image.

use std::fs::File;
use std::io::{self, BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::read::ZlibDecoder;
use thiserror::Error;

const VOXL_MAGIC: &[u8; 4] = b"VOXL";
const VOXL_HEADER_SIZE: usize = 16;
const VOXL_DIR_ENTRY_SIZE: usize = 20;

/// The eight-byte PNG signature: the payload shape both containers promise.
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// `LUMN` — the LUMEN v1 file magic.
const LUMEN_MAGIC: &[u8; 4] = b"LUMN";
/// Fixed file header, per LUMEN spec §3.1.
const LUMEN_HEADER_SIZE: u64 = 32;
/// One chunk descriptor, per LUMEN spec §3.2.
const LUMEN_DIR_ENTRY_SIZE: u64 = 32;
/// `LEND` + CRC-32C, per LUMEN spec §3.3.
const LUMEN_TRAILER_SIZE: u64 = 8;
/// Descriptor flag bit 4: the payload is sealed and needs the file's key.
const LUMEN_FLAG_ENCRYPTED: u32 = 1 << 4;
/// Descriptor flag bits 0-3: the preview role.
const LUMEN_PREVIEW_ROLE_MASK: u32 = 0x0F;
/// Preview role values, per LUMEN spec §4.6.
const LUMEN_ROLE_UNSPECIFIED: u32 = 0;
const LUMEN_ROLE_LARGE: u32 = 1;
const LUMEN_ROLE_SMALL: u32 = 2;
const LUMEN_ROLE_ICON: u32 = 3;

#[derive(Debug, Error)]
pub enum ThumbnailError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("not a VOXL scene or LUMEN print file")]
    UnsupportedFile,

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

    #[error("not a LUMEN v1 file")]
    NotLumenV1,

    #[error("malformed LUMEN file: {0}")]
    MalformedLumen(String),

    #[error("no thumbnail (VOXL ora.preview, or an unsealed LUMEN PREV) in file")]
    NoThumbnail,

    #[error("image error: {0}")]
    Image(String),
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Which container a file holds, decided by its first four bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Container {
    Voxl,
    Lumen,
}

fn sniff(magic: &[u8]) -> Result<Container, ThumbnailError> {
    match magic {
        m if m.starts_with(VOXL_MAGIC) => Ok(Container::Voxl),
        m if m.starts_with(LUMEN_MAGIC) => Ok(Container::Lumen),
        _ => Err(ThumbnailError::UnsupportedFile),
    }
}

/// Extract raw PNG thumbnail bytes from a VOXL scene or LUMEN print file.
pub fn extract_thumbnail(path: &Path) -> Result<Vec<u8>, ThumbnailError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);

    let mut magic = [0u8; 4];
    reader.read_exact(&mut magic)?;
    let container = sniff(&magic)?;
    reader.seek(SeekFrom::Start(0))?;

    match container {
        Container::Voxl => voxl_from_reader(&mut reader),
        Container::Lumen => lumen_from_reader(&mut reader),
    }
}

/// Extract raw PNG thumbnail bytes from file data already in memory.
pub fn extract_thumbnail_from_bytes(data: &[u8]) -> Result<Vec<u8>, ThumbnailError> {
    let head = &data[..data.len().min(4)];
    let container = sniff(head)?;

    let mut cursor = Cursor::new(data);
    match container {
        Container::Voxl => voxl_from_reader(&mut cursor),
        Container::Lumen => lumen_from_reader(&mut cursor),
    }
}

/// Extract and resize the thumbnail to fit within `max_size × max_size`.
pub fn extract_thumbnail_resized(path: &Path, max_size: u32) -> Result<Vec<u8>, ThumbnailError> {
    let png = extract_thumbnail(path)?;
    resize_png(&png, max_size)
}

/// Extract from memory and resize.
pub fn extract_thumbnail_from_bytes_resized(
    data: &[u8],
    max_size: u32,
) -> Result<Vec<u8>, ThumbnailError> {
    let png = extract_thumbnail_from_bytes(data)?;
    resize_png(&png, max_size)
}

/// Extract from memory, resize to fit within `size × size`, and center on a
/// transparent `size × size` square canvas.
pub fn extract_thumbnail_from_bytes_square(
    data: &[u8],
    size: u32,
) -> Result<Vec<u8>, ThumbnailError> {
    let png = extract_thumbnail_from_bytes(data)?;
    resize_png_square(&png, size)
}

/// Resize existing PNG bytes to fit within `max_size × max_size`,
/// preserving aspect ratio. Returns the original bytes unchanged if the
/// image already fits.
pub fn resize_png(png_bytes: &[u8], max_size: u32) -> Result<Vec<u8>, ThumbnailError> {
    let img = image::load_from_memory_with_format(png_bytes, image::ImageFormat::Png)
        .map_err(|e| ThumbnailError::Image(e.to_string()))?;

    if img.width() <= max_size && img.height() <= max_size {
        return Ok(png_bytes.to_vec());
    }

    let resized = img.thumbnail(max_size, max_size);

    let mut buf = Cursor::new(Vec::new());
    resized
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| ThumbnailError::Image(e.to_string()))?;

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
pub fn resize_png_square(png_bytes: &[u8], size: u32) -> Result<Vec<u8>, ThumbnailError> {
    use image::{DynamicImage, GenericImage, RgbaImage};

    let img = image::load_from_memory_with_format(png_bytes, image::ImageFormat::Png)
        .map_err(|e| ThumbnailError::Image(e.to_string()))?;

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
        .map_err(|e| ThumbnailError::Image(e.to_string()))?;

    let mut buf = Cursor::new(Vec::new());
    canvas
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| ThumbnailError::Image(e.to_string()))?;

    Ok(buf.into_inner())
}

// ---------------------------------------------------------------------------
// Core parsers — each works with any Read + Seek
// ---------------------------------------------------------------------------

/// One `PREV` descriptor worth reading: where its payload is, how long, and how
/// well it suits a shell thumbnail.
struct PreviewCandidate {
    /// Preference order — lower is better.
    rank: u8,
    /// Directory position, so two previews of the same role stay deterministic.
    index: u64,
    offset: u64,
    size: u64,
}

/// Rank a preview role for a file-browser thumbnail: the biggest image wins.
///
/// `None` means a reserved role, which LUMEN validation rejects rather than
/// interprets — the descriptor is skipped, not guessed at.
fn preview_rank(role: u32) -> Option<u8> {
    match role {
        LUMEN_ROLE_LARGE => Some(0),
        // Unspecified says nothing about its size, but it is still a preview the
        // file offered, so it beats the roles that promise to be small.
        LUMEN_ROLE_UNSPECIFIED => Some(1),
        LUMEN_ROLE_SMALL => Some(2),
        LUMEN_ROLE_ICON => Some(3),
        _ => None,
    }
}

fn lumen_malformed(reason: impl Into<String>) -> ThumbnailError {
    ThumbnailError::MalformedLumen(reason.into())
}

/// Read the best unsealed `PREV` PNG from a LUMEN v1 file.
///
/// Only the header, the chunk directory, and the preview payloads are read: the
/// directory sits at the end of the file (spec §3), so layer data is never
/// touched. Encrypted previews are skipped rather than failed on — a file whose
/// previews are all sealed simply has no thumbnail to offer.
fn lumen_from_reader<R: Read + Seek>(reader: &mut R) -> Result<Vec<u8>, ThumbnailError> {
    let file_len = reader.seek(SeekFrom::End(0))?;
    if file_len < LUMEN_HEADER_SIZE + LUMEN_TRAILER_SIZE {
        return Err(lumen_malformed("the file is shorter than its header and trailer"));
    }

    // ── Header (32 bytes) ──────────────────────────────────────────────
    reader.seek(SeekFrom::Start(0))?;
    let mut header = [0u8; LUMEN_HEADER_SIZE as usize];
    reader.read_exact(&mut header)?;

    if &header[0..4] != LUMEN_MAGIC {
        return Err(ThumbnailError::NotLumenV1);
    }
    let version = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    // v1 is the only layout this reader knows. A future version is refused
    // rather than misread: the directory moves, the fields grow, and a wrong
    // guess would surface as a wrong image instead of a missing one.
    if version != 1 {
        return Err(ThumbnailError::NotLumenV1);
    }

    let dir_offset = u64::from_le_bytes(header[8..16].try_into().unwrap());
    let chunk_count = u64::from(u32::from_le_bytes(header[16..20].try_into().unwrap()));

    // ── Trailer ────────────────────────────────────────────────────────
    reader.seek(SeekFrom::Start(file_len - LUMEN_TRAILER_SIZE))?;
    let mut trailer = [0u8; LUMEN_TRAILER_SIZE as usize];
    reader.read_exact(&mut trailer)?;
    if &trailer[0..4] != b"LEND" {
        return Err(lumen_malformed("the file does not end with the LEND trailer"));
    }
    // The CRC-32C in the trailer is deliberately not recomputed: verifying it
    // means reading the whole file, which is exactly what this reader exists to
    // avoid. The bounds checks below plus the PNG signature are what stand
    // between a corrupt file and the shell.

    // ── Chunk directory ────────────────────────────────────────────────
    let dir_len = chunk_count
        .checked_mul(LUMEN_DIR_ENTRY_SIZE)
        .ok_or_else(|| lumen_malformed("the directory length overflows"))?;
    let dir_end = dir_offset
        .checked_add(dir_len)
        .ok_or_else(|| lumen_malformed("the directory offset overflows"))?;
    // Compared the safe way round: `dir_end + LUMEN_TRAILER_SIZE` could itself
    // overflow on a corrupt offset, and in a release build that wraps silently.
    if dir_offset < LUMEN_HEADER_SIZE || dir_end > file_len - LUMEN_TRAILER_SIZE {
        return Err(lumen_malformed("the chunk directory lies outside the file"));
    }

    reader.seek(SeekFrom::Start(dir_offset))?;
    let mut dir = vec![0u8; dir_len as usize];
    reader.read_exact(&mut dir)?;

    let mut candidates: Vec<PreviewCandidate> = Vec::new();
    for index in 0..chunk_count {
        let base = (index * LUMEN_DIR_ENTRY_SIZE) as usize;
        let entry = &dir[base..base + LUMEN_DIR_ENTRY_SIZE as usize];
        if &entry[0..4] != b"PREV" {
            continue;
        }

        let flags = u32::from_le_bytes(entry[28..32].try_into().unwrap());
        if flags & LUMEN_FLAG_ENCRYPTED != 0 {
            continue;
        }
        let Some(rank) = preview_rank(flags & LUMEN_PREVIEW_ROLE_MASK) else {
            continue;
        };

        let offset = u64::from_le_bytes(entry[4..12].try_into().unwrap());
        if offset == 0 {
            continue; // null descriptor
        }
        let size_uncompressed = u64::from_le_bytes(entry[12..20].try_into().unwrap());
        // PREV is never zstd-compressed (spec §6.3), but it may be sealed, which
        // frames it — so a non-zero stored size is the payload's real length.
        let size_compressed = u64::from_le_bytes(entry[20..28].try_into().unwrap());
        let size = if size_compressed != 0 {
            size_compressed
        } else {
            size_uncompressed
        };
        // Bounds first, and compared the safe way round: `offset + size` can
        // overflow on a corrupt descriptor, which would wrap in a release build.
        if size == 0 || offset > file_len || size > file_len - offset {
            continue;
        }

        candidates.push(PreviewCandidate {
            rank,
            index,
            offset,
            size,
        });
    }

    // Best role first, file order breaking ties, so the choice is deterministic.
    candidates.sort_by_key(|c| (c.rank, c.index));

    for candidate in candidates {
        reader.seek(SeekFrom::Start(candidate.offset))?;
        let mut payload = vec![0u8; candidate.size as usize];
        reader.read_exact(&mut payload)?;

        // A payload that is not a PNG is not a preview this reader can hand to
        // the shell; keep looking in case a better-formed one is behind it.
        if payload.starts_with(&PNG_SIGNATURE) {
            return Ok(payload);
        }
    }

    Err(ThumbnailError::NoThumbnail)
}

fn voxl_from_reader<R: Read + Seek>(reader: &mut R) -> Result<Vec<u8>, ThumbnailError> {
    // ── Header (16 bytes) ──────────────────────────────────────────────
    let mut header = [0u8; VOXL_HEADER_SIZE];
    reader.read_exact(&mut header)?;

    if &header[0..4] != VOXL_MAGIC {
        return Err(ThumbnailError::NotVoxlV2);
    }
    let version = u16::from_le_bytes([header[4], header[5]]);
    if version < 2 {
        return Err(ThumbnailError::NotVoxlV2);
    }

    let chunk_count = u32::from_le_bytes([header[8], header[9], header[10], header[11]]) as usize;

    // ── Chunk directory (chunk_count × 20 bytes) ───────────────────────
    let mut dir = vec![0u8; chunk_count * VOXL_DIR_ENTRY_SIZE];
    reader.read_exact(&mut dir)?;

    // ── Locate EXTD[0] ────────────────────────────────────────────────
    for i in 0..chunk_count {
        let b = i * VOXL_DIR_ENTRY_SIZE;
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
                    .map_err(|e| ThumbnailError::Decompression(e.to_string()))?;
                out
            }
            c => return Err(ThumbnailError::UnknownCompression(c)),
        };

        // Parse JSON → extract ora.preview.dataBase64
        let val: serde_json::Value = serde_json::from_slice(&json_bytes)?;
        let b64 = val
            .get("ora.preview")
            .and_then(|p| p.get("dataBase64"))
            .and_then(|v| v.as_str())
            .ok_or(ThumbnailError::NoThumbnail)?;

        return Ok(STANDARD.decode(b64)?);
    }

    Err(ThumbnailError::NoExtdChunk)
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
        let data_offset = (VOXL_HEADER_SIZE + VOXL_DIR_ENTRY_SIZE) as u32;

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
    fn unknown_magic_is_refused() {
        // Neither container: the entry point says so without guessing.
        let err = extract_thumbnail_from_bytes(b"not a voxl file!").unwrap_err();
        assert!(matches!(err, ThumbnailError::UnsupportedFile));
    }

    #[test]
    fn voxl_v1_is_refused() {
        let mut data = Vec::new();
        data.extend_from_slice(VOXL_MAGIC);
        data.extend_from_slice(&1u16.to_le_bytes()); // version 1
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());

        let err = extract_thumbnail_from_bytes(&data).unwrap_err();
        assert!(matches!(err, ThumbnailError::NotVoxlV2));
    }

    // ── LUMEN v1 ───────────────────────────────────────────────────────────
    // The fixture holds what the reader walks — header, preview payloads,
    // directory, trailer — and leaves out the chunks a thumbnail never needs.

    fn make_test_lumen(previews: &[(u32, Vec<u8>)]) -> Vec<u8> {
        let mut file = Vec::new();

        file.extend_from_slice(LUMEN_MAGIC);
        file.extend_from_slice(&1u32.to_le_bytes()); // version
        let dir_offset_at = file.len();
        file.extend_from_slice(&0u64.to_le_bytes()); // dir_offset, patched below
        file.extend_from_slice(&(previews.len() as u32).to_le_bytes());
        file.extend_from_slice(&0u32.to_le_bytes()); // flags
        file.extend_from_slice(&0u64.to_le_bytes()); // total_uncompressed_size

        let mut entries = Vec::new();
        for (flags, payload) in previews {
            entries.push((*flags, file.len() as u64, payload.len() as u64));
            file.extend_from_slice(payload);
        }

        let dir_offset = file.len() as u64;
        for (flags, offset, size) in &entries {
            file.extend_from_slice(b"PREV");
            file.extend_from_slice(&offset.to_le_bytes());
            file.extend_from_slice(&size.to_le_bytes()); // size_uncompressed
            file.extend_from_slice(&0u64.to_le_bytes()); // size_compressed: stored as-is
            file.extend_from_slice(&flags.to_le_bytes());
        }
        file[dir_offset_at..dir_offset_at + 8].copy_from_slice(&dir_offset.to_le_bytes());

        file.extend_from_slice(b"LEND");
        file.extend_from_slice(&0u32.to_le_bytes()); // CRC, not verified by the reader
        file
    }

    const SEALED: u32 = LUMEN_FLAG_ENCRYPTED;

    #[test]
    fn lumen_round_trip_extract() {
        let png = make_test_png();
        let lumen = make_test_lumen(&[(LUMEN_ROLE_LARGE, png.clone())]);

        let extracted = extract_thumbnail_from_bytes(&lumen).unwrap();
        assert_eq!(extracted, png);
    }

    #[test]
    fn lumen_prefers_the_large_preview() {
        let small = {
            let mut bytes = make_test_png();
            bytes.push(1); // distinguishable trailing byte
            bytes
        };
        let large = make_test_png();

        // Small is written first: the role, not the file order, picks the winner.
        let lumen = make_test_lumen(&[
            (LUMEN_ROLE_SMALL, small),
            (LUMEN_ROLE_LARGE, large.clone()),
        ]);

        assert_eq!(extract_thumbnail_from_bytes(&lumen).unwrap(), large);
    }

    #[test]
    fn lumen_skips_sealed_previews() {
        let png = make_test_png();
        // A sealed preview cannot be read without the file's key, so the small
        // clear one is the thumbnail even though the large one is unreadable.
        let mixed = make_test_lumen(&[
            (LUMEN_ROLE_LARGE | SEALED, make_test_png()),
            (LUMEN_ROLE_SMALL, png.clone()),
        ]);
        assert_eq!(extract_thumbnail_from_bytes(&mixed).unwrap(), png);

        let all_sealed = make_test_lumen(&[(LUMEN_ROLE_LARGE | SEALED, make_test_png())]);
        let err = extract_thumbnail_from_bytes(&all_sealed).unwrap_err();
        assert!(matches!(err, ThumbnailError::NoThumbnail));
    }

    #[test]
    fn lumen_skips_a_reserved_preview_role() {
        let png = make_test_png();
        // Role 4 is reserved: the descriptor is skipped, not interpreted.
        let with_reserved = make_test_lumen(&[
            (4, make_test_png()),
            (LUMEN_ROLE_LARGE, png.clone()),
        ]);
        assert_eq!(extract_thumbnail_from_bytes(&with_reserved).unwrap(), png);

        let only_reserved = make_test_lumen(&[(4, make_test_png())]);
        let err = extract_thumbnail_from_bytes(&only_reserved).unwrap_err();
        assert!(matches!(err, ThumbnailError::NoThumbnail));
    }

    #[test]
    fn lumen_requires_a_png_payload() {
        let png = make_test_png();
        let with_junk = make_test_lumen(&[
            (LUMEN_ROLE_LARGE, b"not a png at all".to_vec()),
            (LUMEN_ROLE_SMALL, png.clone()),
        ]);
        assert_eq!(extract_thumbnail_from_bytes(&with_junk).unwrap(), png);

        let only_junk = make_test_lumen(&[(LUMEN_ROLE_LARGE, b"not a png at all".to_vec())]);
        let err = extract_thumbnail_from_bytes(&only_junk).unwrap_err();
        assert!(matches!(err, ThumbnailError::NoThumbnail));
    }

    #[test]
    fn lumen_refuses_another_version() {
        let mut lumen = make_test_lumen(&[(LUMEN_ROLE_LARGE, make_test_png())]);
        lumen[4..8].copy_from_slice(&2u32.to_le_bytes());

        let err = extract_thumbnail_from_bytes(&lumen).unwrap_err();
        assert!(matches!(err, ThumbnailError::NotLumenV1));
    }

    #[test]
    fn lumen_refuses_a_directory_outside_the_file() {
        let mut lumen = make_test_lumen(&[(LUMEN_ROLE_LARGE, make_test_png())]);
        // Point the directory past the end of the file.
        let past_end = lumen.len() as u64 + 4096;
        lumen[8..16].copy_from_slice(&past_end.to_le_bytes());

        let err = extract_thumbnail_from_bytes(&lumen).unwrap_err();
        assert!(matches!(err, ThumbnailError::MalformedLumen(_)));
    }

    #[test]
    fn lumen_refuses_a_missing_trailer() {
        let mut lumen = make_test_lumen(&[(LUMEN_ROLE_LARGE, make_test_png())]);
        let trailer_at = lumen.len() - LUMEN_TRAILER_SIZE as usize;
        lumen[trailer_at..trailer_at + 4].copy_from_slice(b"XXXX");

        let err = extract_thumbnail_from_bytes(&lumen).unwrap_err();
        assert!(matches!(err, ThumbnailError::MalformedLumen(_)));
    }

    #[test]
    fn lumen_ignores_a_descriptor_pointing_outside_the_file() {
        let mut lumen = make_test_lumen(&[(LUMEN_ROLE_LARGE, make_test_png())]);
        // The single PREV descriptor starts right after the payloads, at
        // dir_offset; its offset field is the first u64 after the 4-byte type.
        let dir_offset = u64::from_le_bytes(lumen[8..16].try_into().unwrap()) as usize;
        let offset_at = dir_offset + 4;
        // A corrupt offset near the top of the range used to be able to wrap the
        // bounds check; the reader has to skip it rather than panic or allocate.
        lumen[offset_at..offset_at + 8].copy_from_slice(&u64::MAX.to_le_bytes());

        let err = extract_thumbnail_from_bytes(&lumen).unwrap_err();
        assert!(matches!(err, ThumbnailError::NoThumbnail));
    }

    #[test]
    fn truncated_header() {
        // Fewer than 16 bytes → IO error (unexpected EOF)
        let err = extract_thumbnail_from_bytes(b"VOXL").unwrap_err();
        assert!(matches!(err, ThumbnailError::Io(_)));
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
        assert!(matches!(err, ThumbnailError::NoExtdChunk));
    }
}
