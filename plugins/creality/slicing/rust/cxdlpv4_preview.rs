//! Preview image decoding, resizing, and RGB15-RLE encoding for `.cxdlpv4`.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

pub const SMALL_PREVIEW_WIDTH: u32 = 120;
pub const SMALL_PREVIEW_HEIGHT: u32 = 120;
pub const LARGE_PREVIEW_WIDTH: u32 = 300;
pub const LARGE_PREVIEW_HEIGHT: u32 = 300;

struct DecodedRgba {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

fn decode_png_base64(raw: Option<&str>) -> Option<DecodedRgba> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let b64 = match raw.find("base64,") {
        Some(idx) => &raw[idx + "base64,".len()..],
        None => raw,
    };
    let png_bytes = STANDARD.decode(b64.trim()).ok()?;
    let mut decoder = png::Decoder::new(std::io::Cursor::new(&png_bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let raw_pixels = &buf[..info.buffer_size()];

    let mut rgba = Vec::with_capacity((info.width * info.height * 4) as usize);
    match info.color_type {
        png::ColorType::Rgba => rgba.extend_from_slice(raw_pixels),
        png::ColorType::Rgb => {
            for px in raw_pixels.chunks_exact(3) {
                rgba.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for px in raw_pixels.chunks_exact(2) {
                rgba.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
        }
        png::ColorType::Grayscale => {
            for &g in raw_pixels {
                rgba.extend_from_slice(&[g, g, g, 255]);
            }
        }
        png::ColorType::Indexed => return None,
    }

    Some(DecodedRgba {
        width: info.width,
        height: info.height,
        rgba,
    })
}

fn resize_rgba_nearest_or_bilinear(src: &DecodedRgba, dst_w: u32, dst_h: u32) -> Vec<[u8; 3]> {
    let mut out = Vec::with_capacity((dst_w * dst_h) as usize);
    if src.width == 0 || src.height == 0 {
        out.resize((dst_w * dst_h) as usize, [0, 0, 0]);
        return out;
    }

    for y in 0..dst_h {
        let sy = ((y as f32 + 0.5) * src.height as f32 / dst_h as f32 - 0.5)
            .clamp(0.0, (src.height.saturating_sub(1)) as f32);
        let y0 = sy.floor() as u32;
        let y1 = (y0 + 1).min(src.height - 1);
        let fy = sy - y0 as f32;

        for x in 0..dst_w {
            let sx = ((x as f32 + 0.5) * src.width as f32 / dst_w as f32 - 0.5)
                .clamp(0.0, (src.width.saturating_sub(1)) as f32);
            let x0 = sx.floor() as u32;
            let x1 = (x0 + 1).min(src.width - 1);
            let fx = sx - x0 as f32;

            let sample = |px: u32, py: u32| -> [f32; 3] {
                let idx = ((py * src.width + px) * 4) as usize;
                let a = src.rgba[idx + 3] as f32 / 255.0;
                [
                    src.rgba[idx] as f32 * a,
                    src.rgba[idx + 1] as f32 * a,
                    src.rgba[idx + 2] as f32 * a,
                ]
            };

            let c00 = sample(x0, y0);
            let c10 = sample(x1, y0);
            let c01 = sample(x0, y1);
            let c11 = sample(x1, y1);

            let mut rgb = [0u8; 3];
            for ch in 0..3 {
                let top = c00[ch] * (1.0 - fx) + c10[ch] * fx;
                let bot = c01[ch] * (1.0 - fx) + c11[ch] * fx;
                rgb[ch] = (top * (1.0 - fy) + bot * fy).round().clamp(0.0, 255.0) as u8;
            }
            out.push(rgb);
        }
    }
    out
}

#[inline]
fn rgb_to_rgb15(rgb: [u8; 3]) -> u16 {
    let r5 = (rgb[0] as u16) >> 3;
    let g5 = (rgb[1] as u16) >> 3;
    let b5 = (rgb[2] as u16) >> 3;
    (r5 << 11) | (g5 << 6) | b5
}

fn push_rgb15_run(out: &mut Vec<u8>, pixel15: u16, count: usize) {
    let mut remaining = count;
    while remaining > 0 {
        let chunk = remaining.min(4096);
        if chunk == 1 {
            out.extend_from_slice(&pixel15.to_le_bytes());
        } else {
            let color_with_repeat = pixel15 | 0x0020;
            let len_word = 0x3000u16 | ((chunk - 1) as u16);
            out.extend_from_slice(&color_with_repeat.to_le_bytes());
            out.extend_from_slice(&len_word.to_le_bytes());
        }
        remaining -= chunk;
    }
}

/// Encodes RGB pixels into CTB/Creality RGB15-RLE format.
pub fn encode_rgb_pixels_rgb15_rle(pixels: &[[u8; 3]]) -> Vec<u8> {
    if pixels.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(pixels.len() / 2);
    let mut cur = rgb_to_rgb15(pixels[0]);
    let mut count = 1usize;

    for &px in &pixels[1..] {
        let p15 = rgb_to_rgb15(px);
        if p15 == cur {
            count += 1;
        } else {
            push_rgb15_run(&mut out, cur, count);
            cur = p15;
            count = 1;
        }
    }
    push_rgb15_run(&mut out, cur, count);
    out
}

/// Generates RGB15-RLE small (`120x120`) and large (`300x300`) preview payloads.
pub fn build_cxdlpv4_previews(
    large_png_b64: Option<&str>,
    small_png_b64: Option<&str>,
) -> (Vec<u8>, Vec<u8>) {
    let decoded_large = decode_png_base64(large_png_b64);
    let decoded_small = decode_png_base64(small_png_b64);

    let fallback = DecodedRgba {
        width: 1,
        height: 1,
        rgba: vec![20, 24, 30, 255],
    };

    let small_src = decoded_small
        .as_ref()
        .or(decoded_large.as_ref())
        .unwrap_or(&fallback);
    let large_src = decoded_large
        .as_ref()
        .or(decoded_small.as_ref())
        .unwrap_or(&fallback);

    let small_rgb = resize_rgba_nearest_or_bilinear(small_src, SMALL_PREVIEW_WIDTH, SMALL_PREVIEW_HEIGHT);
    let large_rgb = resize_rgba_nearest_or_bilinear(large_src, LARGE_PREVIEW_WIDTH, LARGE_PREVIEW_HEIGHT);

    (
        encode_rgb_pixels_rgb15_rle(&small_rgb),
        encode_rgb_pixels_rgb15_rle(&large_rgb),
    )
}
