//! Fast PNG encoding for V3 layer masks.
//!
//! Uses hand-rolled PNG chunk assembly (signature + IHDR + IDAT + IEND) with
//! libdeflate zlib compression (3-5× faster than miniz_oxide) and crc32fast
//! for hardware-accelerated chunk CRCs.
//!
//! Container-specific archive assembly lives in encoder modules under
//! `src/encoders/`.

use crate::engine::SlicerV3Error;
use crc32fast::Hasher as Crc32Hasher;
use libdeflater::{CompressionLvl, Compressor};

const PNG_SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

fn png_compression_level(strategy: &str) -> CompressionLvl {
    match strategy {
        "smallest" | "optimal" => CompressionLvl::new(6).unwrap_or(CompressionLvl::best()),
        _ => CompressionLvl::fastest(),
    }
}

fn chunk_crc32(type_bytes: &[u8; 4], data: &[u8]) -> u32 {
    let mut h = Crc32Hasher::new();
    h.update(type_bytes);
    h.update(data);
    h.finalize()
}

fn write_chunk(out: &mut Vec<u8>, type_bytes: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(type_bytes);
    out.extend_from_slice(data);
    out.extend_from_slice(&chunk_crc32(type_bytes, data).to_be_bytes());
}

fn write_ihdr(out: &mut Vec<u8>, width: u32, height: u32, bit_depth: u8) {
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = bit_depth;
    ihdr[9] = 0; // color type: Grayscale
    ihdr[10] = 0; // compression: deflate
    ihdr[11] = 0; // filter: adaptive
    ihdr[12] = 0; // interlace: none
    write_chunk(out, b"IHDR", &ihdr);
}

fn zlib_compress(data: &[u8], level: CompressionLvl) -> Result<Vec<u8>, SlicerV3Error> {
    let mut compressor = Compressor::new(level);
    let max_size = compressor.zlib_compress_bound(data.len());
    let mut buf = vec![0u8; max_size];
    let actual = compressor
        .zlib_compress(data, &mut buf)
        .map_err(|e| SlicerV3Error::Png(e.to_string()))?;
    buf.truncate(actual);
    Ok(buf)
}

/// Encode a grayscale pixel mask to PNG.
///
/// Pass `is_binary = true` when the caller already knows all pixels are 0 or
/// 255 (e.g. AA is off). This skips the full-buffer scan and emits a compact
/// 1-bit PNG. When `false`, emits an 8-bit grayscale PNG with Sub filtering.
pub fn encode_grayscale_png(
    width: u32,
    height: u32,
    pixels: &[u8],
    png_compression_strategy: &str,
    is_binary: bool,
) -> Result<Vec<u8>, SlicerV3Error> {
    if is_binary {
        encode_binary_grayscale_png_1bit(width, height, pixels, png_compression_strategy)
    } else {
        encode_grayscale_png_8bit(width, height, pixels, png_compression_strategy)
    }
}

/// Encode an 8-bit grayscale (AA) layer PNG with Sub filter + libdeflate.
pub fn encode_grayscale_png_8bit(
    width: u32,
    height: u32,
    pixels: &[u8],
    png_compression_strategy: &str,
) -> Result<Vec<u8>, SlicerV3Error> {
    let w = width as usize;
    let h = height as usize;
    // Sub filter (type=1) for AA: filt[i] = raw[i] - raw[i-1], good for gradients.
    // "fastest" falls back to no-filter for maximum speed.
    let use_sub = !matches!(png_compression_strategy, "fastest");
    let row_bytes = 1 + w;
    let mut filtered = vec![0u8; row_bytes * h];

    for y in 0..h {
        let src = &pixels[y * w..(y + 1) * w];
        let dst = &mut filtered[y * row_bytes..(y + 1) * row_bytes];
        if use_sub {
            dst[0] = 1; // Sub
            dst[1] = src[0];
            for i in 1..w {
                dst[i + 1] = src[i].wrapping_sub(src[i - 1]);
            }
        } else {
            dst[0] = 0; // None
            dst[1..].copy_from_slice(src);
        }
    }

    let level = png_compression_level(png_compression_strategy);
    let compressed = zlib_compress(&filtered, level)?;

    let mut out = Vec::with_capacity(8 + 25 + 12 + compressed.len() + 12);
    out.extend_from_slice(&PNG_SIG);
    write_ihdr(&mut out, width, height, 8);
    write_chunk(&mut out, b"IDAT", &compressed);
    write_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

/// Encode a grayscale pixel mask as a **Truecolor (RGB) PNG** with a pHYs
/// pixel-aspect-ratio hint.
///
/// Used by NanoDLP's `rgb8_div3` packing mode: every grayscale pixel is
/// stored as an RGB triplet with R = G = B = pixel_value.  The `pHYs` chunk
/// carries a `phys_x_pixels_per_logical` : 1 aspect ratio so NanoDLP knows
/// each PNG pixel represents that many physical display sub-pixels.
///
/// `pixels` must contain exactly `width × height` grayscale byte values.
/// The PNG IHDR width is set to `width`; callers that render at logical
/// resolution (e.g. `source_width_px / 3`) should pass the logical width here.
pub fn encode_truecolor_rgb_png_8bit(
    width: u32,
    height: u32,
    pixels: &[u8],
    png_compression_strategy: &str,
    phys_x_pixels_per_logical: u32,
) -> Result<Vec<u8>, SlicerV3Error> {
    let w = width as usize;
    let h = height as usize;
    let channels = 3usize;
    let row_bytes = 1 + w * channels;
    let mut filtered = vec![0u8; row_bytes * h];

    for y in 0..h {
        let src = &pixels[y * w..(y + 1) * w];
        let dst = &mut filtered[y * row_bytes..(y + 1) * row_bytes];
        // Sub filter (type=1), bpp=3 for RGB.
        // Sub(x) = Raw(x) - Raw(x - bpp), where Raw(-n) = 0 for n > 0.
        // For an RGB triplet where R=G=B=V:
        //   First pixel : [V, V, V]
        //   Pixel i≥1  : [V[i]-V[i-1], V[i]-V[i-1], V[i]-V[i-1]]
        // Uniform runs produce a single non-zero transition then all zeros.
        dst[0] = 1; // Sub
        dst[1] = src[0]; // R[0]
        dst[2] = src[0]; // G[0]
        dst[3] = src[0]; // B[0]
        for i in 1..w {
            let delta = src[i].wrapping_sub(src[i - 1]);
            dst[i * channels + 1] = delta; // R[i] - R[i-1]
            dst[i * channels + 2] = delta; // G[i] - G[i-1]
            dst[i * channels + 3] = delta; // B[i] - B[i-1]
        }
    }

    let level = png_compression_level(png_compression_strategy);
    let compressed = zlib_compress(&filtered, level)?;

    // IHDR for Truecolor: color_type=2.
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // 8 bits per channel
    ihdr[9] = 2; // color_type: Truecolor
                 // compression, filter, interlace all 0

    // pHYs chunk: pixel aspect ratio phys_x:1 (unit=0 = unknown, just a ratio).
    let mut phys = [0u8; 9];
    phys[0..4].copy_from_slice(&phys_x_pixels_per_logical.to_be_bytes()); // pixels_per_unit_x
    phys[4..8].copy_from_slice(&1u32.to_be_bytes()); // pixels_per_unit_y
    phys[8] = 0; // unit: unknown

    let mut out = Vec::with_capacity(8 + 12 + 13 + 12 + 9 + 12 + compressed.len() + 12);
    out.extend_from_slice(&PNG_SIG);
    write_chunk(&mut out, b"IHDR", &ihdr);
    write_chunk(&mut out, b"pHYs", &phys);
    write_chunk(&mut out, b"IDAT", &compressed);
    write_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

/// Encode a binary (all-0/all-255) grayscale mask as a compact 1-bit PNG.
pub fn encode_binary_grayscale_png_1bit(
    width: u32,
    height: u32,
    pixels: &[u8],
    png_compression_strategy: &str,
) -> Result<Vec<u8>, SlicerV3Error> {
    let w = width as usize;
    let h = height as usize;
    let packed_row = (w + 7) / 8;
    // Filtered scanlines: 1 filter byte (None=0) + packed bits per row.
    let row_bytes = 1 + packed_row;
    let mut filtered = vec![0u8; row_bytes * h];

    for y in 0..h {
        let src_row = &pixels[y * w..(y + 1) * w];
        let dst_row = &mut filtered[y * row_bytes..(y + 1) * row_bytes];
        dst_row[0] = 0; // filter type: None — optimal for binary runs

        let full_bytes = w / 8;
        let src_chunks = src_row.chunks_exact(8);
        let remainder = src_chunks.remainder();

        for (i, chunk) in src_chunks.enumerate() {
            let mut byte = 0u8;
            byte |= (chunk[0] != 0) as u8 * 128;
            byte |= (chunk[1] != 0) as u8 * 64;
            byte |= (chunk[2] != 0) as u8 * 32;
            byte |= (chunk[3] != 0) as u8 * 16;
            byte |= (chunk[4] != 0) as u8 * 8;
            byte |= (chunk[5] != 0) as u8 * 4;
            byte |= (chunk[6] != 0) as u8 * 2;
            byte |= (chunk[7] != 0) as u8;
            dst_row[i + 1] = byte;
        }

        if !remainder.is_empty() {
            let mut byte = 0u8;
            for (j, &px) in remainder.iter().enumerate() {
                if px != 0 {
                    byte |= 1 << (7 - j);
                }
            }
            dst_row[full_bytes + 1] = byte;
        }
    }

    let level = png_compression_level(png_compression_strategy);
    let compressed = zlib_compress(&filtered, level)?;

    let mut out = Vec::with_capacity(8 + 25 + 12 + compressed.len() + 12);
    out.extend_from_slice(&PNG_SIG);
    write_ihdr(&mut out, width, height, 1);
    write_chunk(&mut out, b"IDAT", &compressed);
    write_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct RLE → PNG via custom fixed-Huffman deflate
//
// Encodes RLE runs straight into a valid deflate bitstream using fixed Huffman
// codes and distance-1 LZ77 matches.  Encoding time is O(num_runs + height),
// not O(width × height).  For a typical resin layer with ~3 000 runs on a
// 12 K platform this turns 20-30 ms of libdeflate work into <0.5 ms of
// Huffman coding.
//
// Inspired by connorslade/mslicer's PNG encoder.
// ─────────────────────────────────────────────────────────────────────────────

/// Bitstream writer for constructing raw deflate streams.
///
/// Bits accumulate in a `u32` buffer and are flushed byte-by-byte in the
/// byte order mandated by the deflate specification (LSB-first within each
/// byte).
struct BitWriter {
    bytes: Vec<u8>,
    buf: u32,
    nbits: u8,
}

impl BitWriter {
    fn new(cap: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(cap),
            buf: 0,
            nbits: 0,
        }
    }

    /// Write `count` bits from `val`, LSB first (block headers, extra bits).
    #[inline]
    fn bits_lsb(&mut self, val: u32, count: u8) {
        self.buf |= val << self.nbits;
        self.nbits += count;
        while self.nbits >= 8 {
            self.bytes.push(self.buf as u8);
            self.buf >>= 8;
            self.nbits -= 8;
        }
    }

    /// Write `count` bits of a Huffman code, MSB first.
    ///
    /// Deflate packs Huffman codes with the most-significant code bit into the
    /// *least*-significant available byte position, so we reverse the bits
    /// before feeding them to the LSB-first emitter.
    #[inline]
    fn bits_msb(&mut self, val: u32, count: u8) {
        let mut rev = 0u32;
        let mut v = val;
        for _ in 0..count {
            rev = (rev << 1) | (v & 1);
            v >>= 1;
        }
        self.bits_lsb(rev, count);
    }

    /// Flush remaining bits (zero-padded) and return the byte vector.
    fn finish(mut self) -> Vec<u8> {
        if self.nbits > 0 {
            self.bytes.push(self.buf as u8);
        }
        self.bytes
    }
}

/// Emit a fixed-Huffman literal/length symbol (RFC 1951 §3.2.6).
#[inline]
fn huffman_sym(w: &mut BitWriter, sym: u32) {
    match sym {
        0..=143 => w.bits_msb(sym + 0x30, 8),
        144..=255 => w.bits_msb(sym - 144 + 0x190, 9),
        256..=279 => w.bits_msb(sym - 256, 7),
        280..=287 => w.bits_msb(sym - 280 + 0xC0, 8),
        _ => unreachable!(),
    }
}

/// Emit a length + distance=1 back-reference.
#[inline]
fn emit_match(w: &mut BitWriter, len: u16) {
    let (code, extra, nbits): (u32, u32, u8) = match len {
        3..=10 => (254 + len as u32, 0, 0),
        11..=18 => (265 + (len - 11) as u32 / 2, (len - 11) as u32 % 2, 1),
        19..=34 => (269 + (len - 19) as u32 / 4, (len - 19) as u32 % 4, 2),
        35..=66 => (273 + (len - 35) as u32 / 8, (len - 35) as u32 % 8, 3),
        67..=130 => (277 + (len - 67) as u32 / 16, (len - 67) as u32 % 16, 4),
        131..=257 => (281 + (len - 131) as u32 / 32, (len - 131) as u32 % 32, 5),
        258 => (285, 0, 0),
        _ => unreachable!(),
    };
    huffman_sym(w, code);
    if nbits > 0 {
        w.bits_lsb(extra, nbits);
    }
    // Distance = 1 → fixed distance code 0 → 5 zero bits.
    w.bits_lsb(0, 5);
}

/// Adler-32 state that can be updated from constant-value runs in O(1) each
/// using closed-form sums (no per-byte loop).
struct Adler32State {
    a: u32,
    b: u32,
}

impl Adler32State {
    const MOD: u64 = 65521;

    fn new() -> Self {
        Self { a: 1, b: 0 }
    }

    /// Update for a run of `length` identical bytes with value `value`.
    #[inline]
    fn update_run(&mut self, length: u64, value: u8) {
        let v = value as u64;
        let mut rem = length;
        while rem > 0 {
            let n = rem.min(380_368_439); // keeps intermediate products < u64::MAX
            rem -= n;
            let (a, b) = (self.a as u64, self.b as u64);
            let new_a = (a + n * v) % Self::MOD;
            let new_b = (b + n * a + v * (n * (n + 1) / 2)) % Self::MOD;
            self.a = new_a as u32;
            self.b = new_b as u32;
        }
    }

    fn finish(self) -> u32 {
        (self.b << 16) | self.a
    }
}

/// Push a run onto `out`, merging with the tail if the value matches.
#[inline]
fn push_run(out: &mut Vec<(u64, u8)>, length: u64, value: u8) {
    if let Some(last) = out.last_mut() {
        if last.1 == value {
            last.0 += length;
            return;
        }
    }
    out.push((length, value));
}

/// Walk the original RLE runs and intersperse PNG filter bytes (0 = None) at
/// row boundaries.  Merges adjacent runs of the same value so the downstream
/// LZ77 encoder produces optimal distance-1 matches.
fn intersperse_filter_runs(runs: &[crate::rle::RleRun], width: u64, height: u64) -> Vec<(u64, u8)> {
    let mut out: Vec<(u64, u8)> = Vec::with_capacity(runs.len() + height as usize);
    let mut run_idx: usize = 0;
    let mut run_offset: u64 = 0;

    for _row in 0..height {
        // Filter byte (value 0, length 1).
        push_run(&mut out, 1, 0);

        // Emit `width` pixels from the run stream.
        let mut remaining = width;
        while remaining > 0 && run_idx < runs.len() {
            let run = &runs[run_idx];
            let avail = run.length as u64 - run_offset;
            let take = remaining.min(avail);

            push_run(&mut out, take, run.value);

            remaining -= take;
            run_offset += take;
            if run_offset >= run.length as u64 {
                run_idx += 1;
                run_offset = 0;
            }
        }
        // Pad remaining pixels with zeros (shouldn't happen with well-formed input).
        if remaining > 0 {
            push_run(&mut out, remaining, 0);
        }
    }

    out
}

/// Encode an 8-bit grayscale PNG directly from RLE runs using a hand-rolled
/// fixed-Huffman deflate encoder.
///
/// Encoding time is **O(num_runs + height)** — the full pixel buffer is never
/// materialised and no general-purpose compressor is invoked.
pub fn encode_grayscale_png_from_rle(
    width: u32,
    height: u32,
    runs: &[crate::rle::RleRun],
    _png_compression_strategy: &str,
    _is_binary: bool,
) -> Result<Vec<u8>, SlicerV3Error> {
    let w = width as u64;
    let h = height as u64;

    // Step 1 — intersperse filter bytes into the run stream.
    let isp = intersperse_filter_runs(runs, w, h);

    // Step 2 — single pass: Adler-32 + LZ77 + fixed-Huffman bitstream.
    let mut adler = Adler32State::new();
    let mut bw = BitWriter::new(isp.len() * 4 + 64);

    // Zlib header (CMF=0x78 CINFO=7 CM=8, FLG=0x01 FCHECK=1).
    bw.bytes.push(0x78);
    bw.bytes.push(0x01);

    // Single deflate block — BFINAL=1, BTYPE=01 (fixed Huffman).
    bw.bits_lsb(0b011, 3);

    for &(length, value) in &isp {
        adler.update_run(length, value);

        // First byte of each run is emitted as a literal.
        huffman_sym(&mut bw, value as u32);

        let mut rem = length - 1;
        // Bulk: distance-1 matches (max match length = 258).
        while rem >= 3 {
            let m = rem.min(258) as u16;
            rem -= m as u64;
            emit_match(&mut bw, m);
        }
        // Tail (0, 1, or 2 bytes) as literals.
        for _ in 0..rem {
            huffman_sym(&mut bw, value as u32);
        }
    }

    // End-of-block symbol (256).
    huffman_sym(&mut bw, 256);

    let mut idat = bw.finish();

    // Adler-32 checksum (big-endian, directly after the deflate bitstream).
    idat.extend_from_slice(&adler.finish().to_be_bytes());

    // Step 3 — assemble PNG.
    let mut out = Vec::with_capacity(8 + 25 + 12 + idat.len() + 12);
    out.extend_from_slice(&PNG_SIG);
    write_ihdr(&mut out, width, height, 8);
    write_chunk(&mut out, b"IDAT", &idat);
    write_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

/// Walk grayscale RLE runs and produce a Truecolor byte stream by tripling
/// each grayscale value (R=G=B=value) with interspersed PNG filter bytes.
///
/// Input runs are at logical width (e.g. 3840 for a 12 K printer with div3).
/// Each grayscale pixel V becomes 3 bytes (V, V, V), so the PNG row stride
/// is `logical_width × 3`.  This is equivalent to rasterising at full
/// sub-pixel resolution, but avoids 3× the rasterisation work.
fn intersperse_filter_runs_rgb_expand(
    runs: &[crate::rle::RleRun],
    logical_width: u64,
    height: u64,
) -> Vec<(u64, u8)> {
    let mut out: Vec<(u64, u8)> = Vec::with_capacity(runs.len() + height as usize);
    let mut run_idx: usize = 0;
    let mut run_offset: u64 = 0;

    for _row in 0..height {
        // Filter byte (value 0, length 1).
        push_run(&mut out, 1, 0);

        // Emit `logical_width` grayscale pixels, tripled to RGB bytes.
        let mut remaining = logical_width;
        while remaining > 0 && run_idx < runs.len() {
            let run = &runs[run_idx];
            let avail = run.length as u64 - run_offset;
            let take = remaining.min(avail);

            // Grayscale V → (V, V, V) per pixel = 3× byte run.
            push_run(&mut out, take * 3, run.value);

            remaining -= take;
            run_offset += take;
            if run_offset >= run.length as u64 {
                run_idx += 1;
                run_offset = 0;
            }
        }
        if remaining > 0 {
            push_run(&mut out, remaining * 3, 0);
        }
    }

    out
}

/// Encode a Truecolor (RGB) PNG directly from **grayscale** RLE runs for
/// NanoDLP `rgb8_div3` packing.
///
/// Runs are at logical resolution (`width_px`, e.g. 3840).  Each grayscale
/// pixel V is expanded to an RGB triplet (V, V, V) at encode time, giving
/// PNG IHDR width = `logical_width`, color_type = Truecolor.
///
/// A `pHYs` chunk with `phys_x_pixels_per_logical : 1` aspect ratio is
/// emitted so the firmware maps each PNG pixel to the correct number of
/// physical sub-pixels.
///
/// Encoding time is **O(num_runs + height)** — no pixel buffer is materialised.
pub fn encode_truecolor_png_from_rle(
    logical_width: u32,
    height: u32,
    runs: &[crate::rle::RleRun],
    phys_x_pixels_per_logical: u32,
) -> Result<Vec<u8>, SlicerV3Error> {
    let png_width = logical_width;
    let h = height as u64;

    // Step 1 — grayscale RLE → RGB byte stream with filter bytes.
    let isp = intersperse_filter_runs_rgb_expand(runs, logical_width as u64, h);

    // Step 2 — single pass: Adler-32 + LZ77 + fixed-Huffman bitstream.
    let mut adler = Adler32State::new();
    let mut bw = BitWriter::new(isp.len() * 4 + 64);

    // Zlib header.
    bw.bytes.push(0x78);
    bw.bytes.push(0x01);

    // Single deflate block — BFINAL=1, BTYPE=01 (fixed Huffman).
    bw.bits_lsb(0b011, 3);

    for &(length, value) in &isp {
        adler.update_run(length, value);

        huffman_sym(&mut bw, value as u32);

        let mut rem = length - 1;
        while rem >= 3 {
            let m = rem.min(258) as u16;
            rem -= m as u64;
            emit_match(&mut bw, m);
        }
        for _ in 0..rem {
            huffman_sym(&mut bw, value as u32);
        }
    }

    huffman_sym(&mut bw, 256);

    let mut idat = bw.finish();
    idat.extend_from_slice(&adler.finish().to_be_bytes());

    // Step 3 — assemble PNG: IHDR (Truecolor) + pHYs + IDAT + IEND.
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&png_width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // 8 bits per channel
    ihdr[9] = 2; // color_type: Truecolor
                 // compression=0, filter=0, interlace=0

    let mut phys = [0u8; 9];
    phys[0..4].copy_from_slice(&phys_x_pixels_per_logical.to_be_bytes());
    phys[4..8].copy_from_slice(&1u32.to_be_bytes());
    phys[8] = 0; // unit: unknown (ratio only)

    let mut out = Vec::with_capacity(8 + 25 + 21 + 12 + idat.len() + 12);
    out.extend_from_slice(&PNG_SIG);
    write_chunk(&mut out, b"IHDR", &ihdr);
    write_chunk(&mut out, b"pHYs", &phys);
    write_chunk(&mut out, b"IDAT", &idat);
    write_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}
