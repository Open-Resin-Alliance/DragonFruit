//! Container helpers for the Echo example: a run-native grayscale PNG, and a
//! store-only zip.
//!
//! The PNG writer mirrors the engine's own RLE→PNG encoder: the run stream is
//! never expanded to a pixel buffer and no general-purpose compressor runs.
//! Each run becomes a literal plus distance-1 back-references inside one
//! fixed-Huffman deflate block, so encoding is O(runs + height) per layer. That
//! is what keeps a 400-layer 4K container finishing in seconds instead of
//! chewing through zlib over 10 MB of pixels per layer.

use dragonfruit_plugin_sdk::Runs;

const PNG_SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// Encode an 8-bit grayscale PNG straight from RLE runs, row-major.
pub fn encode_grayscale_png(width: u32, height: u32, runs: &Runs<'_>) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err("a PNG needs a non-zero size".to_string());
    }
    let mut input: Vec<(u32, u8)> = Vec::new();
    let mut pixels: u64 = 0;
    for run in runs.clone() {
        pixels += run.length as u64;
        input.push((run.length, run.value));
    }
    let expected = width as u64 * height as u64;
    if pixels != expected {
        return Err(format!(
            "the run stream covers {pixels} pixels of {expected}",
        ));
    }

    // Filter byte 0 (None) at every row start, merged with the runs around it.
    let interspersed = intersperse_filter_runs(&input, width as u64, height as u64);

    let mut adler = Adler32State::new();
    let mut bits = BitWriter::new(interspersed.len() * 2 + 64);
    // zlib header: deflate, 32 KiB window, fastest-level FCHECK.
    bits.bytes.push(0x78);
    bits.bytes.push(0x01);
    // One final fixed-Huffman block.
    bits.bits_lsb(0b011, 3);

    for &(length, value) in &interspersed {
        adler.update_run(length as u64, value);
        huffman_sym(&mut bits, value as u32);
        let mut remaining = length as u64 - 1;
        while remaining >= 3 {
            let take = remaining.min(258) as u16;
            remaining -= take as u64;
            emit_match(&mut bits, take);
        }
        for _ in 0..remaining {
            huffman_sym(&mut bits, value as u32);
        }
    }
    huffman_sym(&mut bits, 256);

    let mut idat = bits.finish();
    idat.extend_from_slice(&adler.finish().to_be_bytes());

    let mut png = Vec::with_capacity(8 + 25 + 12 + idat.len() + 12);
    png.extend_from_slice(&PNG_SIG);
    write_ihdr(&mut png, width, height);
    write_chunk(&mut png, b"IDAT", &idat);
    write_chunk(&mut png, b"IEND", &[]);
    Ok(png)
}

fn write_ihdr(out: &mut Vec<u8>, width: u32, height: u32) {
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 0; // grayscale
    write_chunk(out, b"IHDR", &ihdr);
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    let mut crc = Crc32::new();
    crc.update(kind);
    crc.update(body);
    out.extend_from_slice(&crc.finish().to_be_bytes());
}

/// Merge a run into `out` if its value matches the tail.
fn push_run(out: &mut Vec<(u32, u8)>, length: u32, value: u8) {
    if let Some(last) = out.last_mut() {
        if last.1 == value {
            last.0 = last.0.saturating_add(length);
            return;
        }
    }
    out.push((length, value));
}

/// Insert the per-row filter byte into the run stream, splitting runs at row
/// boundaries and merging same-valued neighbours.
fn intersperse_filter_runs(runs: &[(u32, u8)], width: u64, height: u64) -> Vec<(u32, u8)> {
    let mut out: Vec<(u32, u8)> = Vec::with_capacity(runs.len() + height as usize);
    let mut run_index = 0usize;
    let mut run_offset = 0u64;

    for _row in 0..height {
        push_run(&mut out, 1, 0);
        let mut remaining = width;
        while remaining > 0 && run_index < runs.len() {
            let (length, value) = runs[run_index];
            let available = length as u64 - run_offset;
            let take = remaining.min(available);
            push_run(&mut out, take as u32, value);
            remaining -= take;
            run_offset += take;
            if run_offset >= length as u64 {
                run_index += 1;
                run_offset = 0;
            }
        }
        if remaining > 0 {
            push_run(&mut out, remaining as u32, 0);
        }
    }
    // Filter bytes can push a run past u32; rare enough to accept here.
    out
}

struct BitWriter {
    bytes: Vec<u8>,
    buf: u32,
    nbits: u8,
}

impl BitWriter {
    fn new(capacity: usize) -> Self {
        Self { bytes: Vec::with_capacity(capacity), buf: 0, nbits: 0 }
    }

    fn bits_lsb(&mut self, value: u32, count: u8) {
        self.buf |= value << self.nbits;
        self.nbits += count;
        while self.nbits >= 8 {
            self.bytes.push(self.buf as u8);
            self.buf >>= 8;
            self.nbits -= 8;
        }
    }

    /// Huffman codes go most-significant bit first inside an LSB-first stream.
    fn bits_msb(&mut self, value: u32, count: u8) {
        let mut reversed = 0u32;
        let mut rest = value;
        for _ in 0..count {
            reversed = (reversed << 1) | (rest & 1);
            rest >>= 1;
        }
        self.bits_lsb(reversed, count);
    }

    fn finish(mut self) -> Vec<u8> {
        if self.nbits > 0 {
            self.bytes.push(self.buf as u8);
        }
        self.bytes
    }
}

/// A fixed-Huffman literal/length symbol (RFC 1951 §3.2.6).
fn huffman_sym(writer: &mut BitWriter, symbol: u32) {
    match symbol {
        0..=143 => writer.bits_msb(symbol + 0x30, 8),
        144..=255 => writer.bits_msb(symbol - 144 + 0x190, 9),
        256..=279 => writer.bits_msb(symbol - 256, 7),
        280..=287 => writer.bits_msb(symbol - 280 + 0xC0, 8),
        _ => unreachable!(),
    }
}

/// A length code plus distance 1 (fixed distance code 0, five zero bits).
fn emit_match(writer: &mut BitWriter, length: u16) {
    let (code, extra, extra_bits): (u32, u32, u8) = match length {
        3..=10 => (254 + length as u32, 0, 0),
        11..=18 => (265 + (length - 11) as u32 / 2, (length - 11) as u32 % 2, 1),
        19..=34 => (269 + (length - 19) as u32 / 4, (length - 19) as u32 % 4, 2),
        35..=66 => (273 + (length - 35) as u32 / 8, (length - 35) as u32 % 8, 3),
        67..=130 => (277 + (length - 67) as u32 / 16, (length - 67) as u32 % 16, 4),
        131..=257 => (281 + (length - 131) as u32 / 32, (length - 131) as u32 % 32, 5),
        258 => (285, 0, 0),
        _ => unreachable!(),
    };
    huffman_sym(writer, code);
    if extra_bits > 0 {
        writer.bits_lsb(extra, extra_bits);
    }
    writer.bits_lsb(0, 5);
}

struct Adler32State {
    a: u32,
    b: u32,
}

impl Adler32State {
    const MOD: u64 = 65521;

    fn new() -> Self {
        Self { a: 1, b: 0 }
    }

    fn update_run(&mut self, length: u64, value: u8) {
        let v = value as u64;
        let mut remaining = length;
        while remaining > 0 {
            let n = remaining.min(380_368_439);
            remaining -= n;
            let (a, b) = (self.a as u64, self.b as u64);
            self.a = ((a + n * v) % Self::MOD) as u32;
            self.b = ((b + n * a + v * (n * (n + 1) / 2)) % Self::MOD) as u32;
        }
    }

    fn finish(self) -> u32 {
        (self.b << 16) | self.a
    }
}

pub struct Crc32 {
    value: u32,
}

impl Crc32 {
    fn new() -> Self {
        Self { value: 0xffff_ffff }
    }

    fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.value ^= u32::from(*byte);
            for _ in 0..8 {
                let mask = (self.value & 1).wrapping_neg();
                self.value = (self.value >> 1) ^ (0xedb8_8320 & mask);
            }
        }
    }

    fn finish(self) -> u32 {
        !self.value
    }
}

/// A store-only zip: local headers, then the central directory. No compression,
/// because every entry is already a PNG.
#[derive(Default)]
pub struct ZipWriter {
    body: Vec<u8>,
    /// name, crc, size, local-header offset
    entries: Vec<(String, u32, u32, u32)>,
}

impl ZipWriter {
    pub fn add(&mut self, name: &str, payload: &[u8]) {
        let offset = self.body.len() as u32;
        let mut crc = Crc32::new();
        crc.update(payload);
        let crc = crc.finish();
        let name_bytes = name.as_bytes();
        let size = payload.len() as u32;

        self.body.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        self.body.extend_from_slice(&20u16.to_le_bytes()); // version needed
        self.body.extend_from_slice(&0u16.to_le_bytes()); // flags
        self.body.extend_from_slice(&0u16.to_le_bytes()); // store
        self.body.extend_from_slice(&0u16.to_le_bytes()); // time
        self.body.extend_from_slice(&0x21u16.to_le_bytes()); // 1980-01-01
        self.body.extend_from_slice(&crc.to_le_bytes());
        self.body.extend_from_slice(&size.to_le_bytes());
        self.body.extend_from_slice(&size.to_le_bytes());
        self.body.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        self.body.extend_from_slice(&0u16.to_le_bytes()); // extra
        self.body.extend_from_slice(name_bytes);
        self.body.extend_from_slice(payload);

        self.entries.push((name.to_string(), crc, size, offset));
    }

    pub fn finish(self) -> Vec<u8> {
        let mut out = self.body;
        let directory_offset = out.len() as u32;
        for (name, crc, size, offset) in &self.entries {
            let name_bytes = name.as_bytes();
            out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes()); // made by
            out.extend_from_slice(&20u16.to_le_bytes()); // needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&0u16.to_le_bytes()); // store
            out.extend_from_slice(&0u16.to_le_bytes()); // time
            out.extend_from_slice(&0x21u16.to_le_bytes()); // date
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra
            out.extend_from_slice(&0u16.to_le_bytes()); // comment
            out.extend_from_slice(&0u16.to_le_bytes()); // disk
            out.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            out.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(name_bytes);
        }
        let directory_size = out.len() as u32 - directory_offset;
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // disk
        out.extend_from_slice(&0u16.to_le_bytes()); // directory disk
        out.extend_from_slice(&(self.entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(self.entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&directory_size.to_le_bytes());
        out.extend_from_slice(&directory_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // comment length
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dragonfruit_plugin_sdk::write_runs;

    fn runs(width: u32, height: u32, value: u8) -> Vec<u8> {
        let mut wire = Vec::new();
        write_runs([(width * height, value)], &mut wire);
        wire
    }

    #[test]
    fn a_layer_becomes_a_grayscale_png() {
        let wire = runs(4, 2, 255);
        let runs = Runs::new(&wire).expect("runs");
        let png = encode_grayscale_png(4, 2, &runs).expect("png");
        assert_eq!(&png[..8], PNG_SIG);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes([png[16], png[17], png[18], png[19]]), 4);
        assert_eq!(u32::from_be_bytes([png[20], png[21], png[22], png[23]]), 2);
    }

    #[test]
    fn a_solid_layer_stays_small_because_runs_are_not_expanded() {
        // 1024x1024 all-solid: a pixel buffer would be 1 MiB, a run-native PNG
        // is a header plus a handful of back-references.
        let wire = runs(1024, 1024, 255);
        let runs = Runs::new(&wire).expect("runs");
        let png = encode_grayscale_png(1024, 1024, &runs).expect("png");
        // A row costs about five fixed-Huffman matches, so ~5 bytes × height;
        // what matters is that it is O(rows), not O(pixels).
        assert!(
            png.len() < 16 * 1024,
            "solid 1024² PNG was {} bytes",
            png.len(),
        );
    }

    #[test]
    fn a_run_stream_that_does_not_cover_the_layer_is_refused() {
        let wire = runs(4, 2, 255);
        let runs = Runs::new(&wire).expect("runs");
        assert!(encode_grayscale_png(5, 2, &runs).is_err());
    }

    #[test]
    fn the_zip_lists_one_entry_per_tank_and_layer() {
        let mut zip = ZipWriter::default();
        zip.add("echo.json", b"{}");
        zip.add("layer_00001_tank_1.png", b"one");
        zip.add("layer_00001_tank_2.png", b"two");
        let bytes = zip.finish();
        assert_eq!(&bytes[..4], &0x0403_4b50u32.to_le_bytes());
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("layer_00001_tank_1.png"));
        assert!(text.contains("layer_00001_tank_2.png"));
        assert!(text.contains("echo.json"));
    }
}
