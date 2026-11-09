//! Thumbnail extraction for the containers DragonFruit reads and writes.
//!
//! A format declares where its preview lives - `outputFileTypes.json`, compiled into
//! [`locator`] by the registry generator - and this crate interprets that
//! declaration. Nothing here names a container: a format gets a shell thumbnail by
//! declaring itself, and the OS integrations (Windows COM, the macOS QuickLook
//! extension, the freedesktop thumbnailers) all read the same table.
//!
//! The reader-based implementation only ever reads headers, chunk tables, and the
//! one chunk that carries the image.

use std::fs::File;
use std::io::{self, BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use thiserror::Error;

pub mod locator;

/// The eight-byte PNG signature: the payload shape every declaration promises.
pub(crate) const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

#[derive(Debug, Error)]
pub enum ThumbnailError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("no declared file type matches this file's contents")]
    UnsupportedFile,

    #[error("{0}")]
    Malformed(String),

    #[error("no readable preview in this file")]
    NoThumbnail,

    #[error("image error: {0}")]
    Image(String),
}

/// The extensions this provider answers for, as the declarations spell them
/// (leading dot included). The Windows shell registration reads this so the
/// registered set cannot drift from the formats the reader knows.
pub fn declared_file_extensions() -> Vec<&'static str> {
    locator::output_file_types()
        .iter()
        .map(locator::OutputFileType::file_extension)
        .collect()
}


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// The declared file type this container starts with, if any.
///
/// The magic is the declaration's, so this needs no list of formats: a file is
/// recognised by the same data that says where its preview lives.
fn declared_type_for(head: &[u8]) -> Result<&'static locator::OutputFileType, ThumbnailError> {
    locator::output_file_type_for(head).ok_or(ThumbnailError::UnsupportedFile)
}

/// Extract raw PNG thumbnail bytes from a file of any declared type.
pub fn extract_thumbnail(path: &Path) -> Result<Vec<u8>, ThumbnailError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);

    let mut head = [0u8; 8];
    let read = reader.read(&mut head)?;
    let file_type = declared_type_for(&head[..read])?;
    reader.seek(SeekFrom::Start(0))?;

    file_type.extract(&mut reader)
}

/// Extract raw PNG thumbnail bytes from file data already in memory.
pub fn extract_thumbnail_from_bytes(data: &[u8]) -> Result<Vec<u8>, ThumbnailError> {
    let head = &data[..data.len().min(8)];
    let file_type = declared_type_for(head)?;

    file_type.extract(&mut Cursor::new(data))
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
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    // Fixture facts: the byte layouts the declarations describe, spelled out so a
    // test can build a file by hand.
    const VOXL_MAGIC: &[u8; 4] = b"VOXL";
    const VOXL_HEADER_SIZE: usize = 16;
    const VOXL_DIR_ENTRY_SIZE: usize = 20;
    const LUMEN_MAGIC: &[u8; 4] = b"LUMN";
    const LUMEN_TRAILER_SIZE: usize = 8;
    const LUMEN_SEALED: u32 = 1 << 4;
    const LUMEN_ROLE_LARGE: u32 = 1;
    const LUMEN_ROLE_SMALL: u32 = 2;

    /// A VOXL V2 file whose EXTD chunk carries `thumbnail_png`, optionally
    /// zlib-compressed the way a real scene stores its extensions.
    fn make_test_voxl(thumbnail_png: &[u8], zlib_compressed: bool) -> Vec<u8> {
        let extensions = serde_json::json!({
            "ora.preview": {
                "kind": "scene-thumbnail",
                "mimeType": "image/png",
                "encoding": "base64",
                "dataBase64": STANDARD.encode(thumbnail_png)
            }
        });
        let json = serde_json::to_vec(&extensions).unwrap();
        let (payload, compression) = if zlib_compressed {
            use flate2::write::ZlibEncoder;
            use flate2::Compression;
            use std::io::Write;

            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&json).unwrap();
            (encoder.finish().unwrap(), 1u16)
        } else {
            (json, 0u16)
        };

        let chunk_count: u32 = 1;
        let data_offset = (VOXL_HEADER_SIZE + VOXL_DIR_ENTRY_SIZE) as u32;
        let mut file = Vec::new();

        file.extend_from_slice(VOXL_MAGIC);
        file.extend_from_slice(&2u16.to_le_bytes()); // version
        file.extend_from_slice(&0u16.to_le_bytes()); // flags
        file.extend_from_slice(&chunk_count.to_le_bytes());
        file.extend_from_slice(&0u32.to_le_bytes()); // reserved

        file.extend_from_slice(b"EXTD");
        file.extend_from_slice(&0u16.to_le_bytes()); // index
        file.extend_from_slice(&compression.to_le_bytes());
        file.extend_from_slice(&data_offset.to_le_bytes());
        file.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        file.extend_from_slice(&(payload.len() as u32).to_le_bytes());

        file.extend_from_slice(&payload);
        file
    }

    /// A LUMEN v1 file holding the given `(descriptor flags, payload)` previews.
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
    fn the_declared_table_describes_the_formats_the_app_writes() {
        let declared = locator::output_file_types();
        let extensions: Vec<&str> = declared.iter().map(locator::OutputFileType::file_extension).collect();

        // Both containers in the tree are declared, and each declaration carries the
        // identifiers the platform registrations need.
        assert!(extensions.contains(&".voxl"), "VOXL is declared: {extensions:?}");
        assert!(extensions.contains(&".lumen"), "LUMEN is declared: {extensions:?}");
        assert_eq!(declared_file_extensions().len(), declared.len());

        for file_type in declared {
            assert!(file_type.mime_type().contains('/'), "{} has no media type", file_type.file_extension());
            assert!(file_type.uti().contains('.'), "{} has no UTI", file_type.file_extension());
            assert!(!file_type.display_name().is_empty(), "{} has no display name", file_type.file_extension());
        }
    }

    #[test]
    fn voxl_scene_preview_round_trips() {
        let png = make_test_png();
        for compressed in [false, true] {
            let extracted = extract_thumbnail_from_bytes(&make_test_voxl(&png, compressed)).unwrap();
            assert_eq!(extracted, png, "zlib_compressed={compressed}");
        }
    }

    #[test]
    fn voxl_v1_is_refused() {
        let mut data = Vec::new();
        data.extend_from_slice(VOXL_MAGIC);
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());

        let err = extract_thumbnail_from_bytes(&data).unwrap_err();
        assert!(matches!(err, ThumbnailError::Malformed(_)), "{err:?}");
    }

    #[test]
    fn voxl_without_a_preview_chunk_has_none() {
        let mut data = Vec::new();
        data.extend_from_slice(VOXL_MAGIC);
        data.extend_from_slice(&2u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes()); // no chunks
        data.extend_from_slice(&0u32.to_le_bytes());

        let err = extract_thumbnail_from_bytes(&data).unwrap_err();
        assert!(matches!(err, ThumbnailError::NoThumbnail), "{err:?}");
    }

    #[test]
    fn voxl_unknown_compression_is_refused() {
        let mut data = make_test_voxl(&make_test_png(), false);
        // Compression code 7 is not a code the declaration lists.
        data[VOXL_HEADER_SIZE + VOXL_DIR_ENTRY_SIZE - 12..VOXL_HEADER_SIZE + VOXL_DIR_ENTRY_SIZE - 10]
            .copy_from_slice(&7u16.to_le_bytes());

        let err = extract_thumbnail_from_bytes(&data).unwrap_err();
        assert!(matches!(err, ThumbnailError::Malformed(_)), "{err:?}");
    }

    #[test]
    fn lumen_print_preview_round_trips() {
        let png = make_test_png();
        let lumen = make_test_lumen(&[(LUMEN_ROLE_LARGE, png.clone())]);

        assert_eq!(extract_thumbnail_from_bytes(&lumen).unwrap(), png);
    }

    #[test]
    fn lumen_prefers_the_large_preview() {
        let small = {
            let mut bytes = make_test_png();
            bytes.push(1); // distinguishable trailing byte
            bytes
        };
        let large = make_test_png();

        // Small is written first: the declared role order picks the winner.
        let lumen = make_test_lumen(&[(LUMEN_ROLE_SMALL, small), (LUMEN_ROLE_LARGE, large.clone())]);

        assert_eq!(extract_thumbnail_from_bytes(&lumen).unwrap(), large);
    }

    #[test]
    fn lumen_skips_sealed_previews() {
        let png = make_test_png();
        // A sealed preview cannot be read without the file's key, so the small clear
        // one is the thumbnail even though the large one is unreadable.
        let mixed = make_test_lumen(&[
            (LUMEN_ROLE_LARGE | LUMEN_SEALED, make_test_png()),
            (LUMEN_ROLE_SMALL, png.clone()),
        ]);
        assert_eq!(extract_thumbnail_from_bytes(&mixed).unwrap(), png);

        let all_sealed = make_test_lumen(&[(LUMEN_ROLE_LARGE | LUMEN_SEALED, make_test_png())]);
        let err = extract_thumbnail_from_bytes(&all_sealed).unwrap_err();
        assert!(matches!(err, ThumbnailError::NoThumbnail), "{err:?}");
    }

    #[test]
    fn lumen_skips_a_role_the_format_does_not_use_for_previews() {
        let png = make_test_png();
        let with_other_role = make_test_lumen(&[(4, make_test_png()), (LUMEN_ROLE_LARGE, png.clone())]);
        assert_eq!(extract_thumbnail_from_bytes(&with_other_role).unwrap(), png);

        let only_other_role = make_test_lumen(&[(4, make_test_png())]);
        let err = extract_thumbnail_from_bytes(&only_other_role).unwrap_err();
        assert!(matches!(err, ThumbnailError::NoThumbnail), "{err:?}");
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
        assert!(matches!(err, ThumbnailError::NoThumbnail), "{err:?}");
    }

    #[test]
    fn lumen_ignores_a_descriptor_pointing_outside_the_file() {
        let mut lumen = make_test_lumen(&[(LUMEN_ROLE_LARGE, make_test_png())]);
        let dir_offset = u64::from_le_bytes(lumen[8..16].try_into().unwrap()) as usize;
        let offset_at = dir_offset + 4;
        // A corrupt offset near the top of the range must not wrap the bounds check.
        lumen[offset_at..offset_at + 8].copy_from_slice(&u64::MAX.to_le_bytes());

        let err = extract_thumbnail_from_bytes(&lumen).unwrap_err();
        assert!(matches!(err, ThumbnailError::NoThumbnail), "{err:?}");
    }

    #[test]
    fn lumen_refuses_another_version() {
        let mut lumen = make_test_lumen(&[(LUMEN_ROLE_LARGE, make_test_png())]);
        lumen[4..8].copy_from_slice(&2u32.to_le_bytes());

        let err = extract_thumbnail_from_bytes(&lumen).unwrap_err();
        assert!(matches!(err, ThumbnailError::Malformed(_)), "{err:?}");
    }

    #[test]
    fn lumen_refuses_a_directory_outside_the_file() {
        let mut lumen = make_test_lumen(&[(LUMEN_ROLE_LARGE, make_test_png())]);
        let past_end = lumen.len() as u64 + 4096;
        lumen[8..16].copy_from_slice(&past_end.to_le_bytes());

        let err = extract_thumbnail_from_bytes(&lumen).unwrap_err();
        assert!(matches!(err, ThumbnailError::Malformed(_)), "{err:?}");
    }

    #[test]
    fn lumen_refuses_a_missing_trailer() {
        let mut lumen = make_test_lumen(&[(LUMEN_ROLE_LARGE, make_test_png())]);
        let trailer_at = lumen.len() - LUMEN_TRAILER_SIZE;
        lumen[trailer_at..trailer_at + 4].copy_from_slice(b"XXXX");

        let err = extract_thumbnail_from_bytes(&lumen).unwrap_err();
        assert!(matches!(err, ThumbnailError::Malformed(_)), "{err:?}");
    }

    #[test]
    fn unknown_magic_is_refused() {
        let err = extract_thumbnail_from_bytes(b"not a scene or print file").unwrap_err();
        assert!(matches!(err, ThumbnailError::UnsupportedFile), "{err:?}");
    }

    #[test]
    fn truncated_header_is_refused() {
        let err = extract_thumbnail_from_bytes(b"VOXL").unwrap_err();
        assert!(matches!(err, ThumbnailError::Malformed(_)), "{err:?}");
    }

    #[test]
    fn resize_preserves_png() {
        let png = make_test_png();
        // Image is 4×4 — requesting max 256 should return same bytes
        assert_eq!(resize_png(&png, 256).unwrap(), png);
    }
}
