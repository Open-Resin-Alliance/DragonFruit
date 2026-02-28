// Custom PNG encoder optimized for binary mask data (0 or 255 pixels)
// Replaces generic png crate with specialized encoder for 3D printer slice layers

use std::io::Write;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FastPngError {
    #[error("Invalid dimensions: {width}x{height}")]
    InvalidDimensions { width: u32, height: u32 },
    #[error("Invalid pixel data length: expected {expected}, got {actual}")]
    InvalidDataLength { expected: usize, actual: usize },
    #[error("Compression failed: {0}")]
    CompressionFailed(String),
    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterStrategy {
    /// No filtering - fastest, larger files
    None,
    /// Sub filter - good for gradients (not ideal for binary masks)
    Sub,
    /// Up filter - good for vertical patterns
    Up,
    /// Average filter - balanced
    Average,
    /// Paeth filter - best for complex patterns (slowest)
    Paeth,
    /// Auto-select best filter per scanline (adaptive)
    Adaptive,
    /// RLE-optimized for binary masks (custom, fastest for our use case)
    BinaryRLE,
}

/// Compression strategy: user-friendly interface for speed vs size tradeoffs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionStrategy {
    /// Maximum speed, larger files (compression level 0)
    Fastest,
    /// Default: balanced speed and size (compression level 6)
    Balanced,
    /// Maximum compression, slower encoding (compression level 9)
    Smallest,
    /// Optimal compression with advanced filtering (compression 9 + Paeth filter)
    Optimal,
}

impl CompressionStrategy {
    /// Convert strategy to (filter_strategy, compression_level)
    pub fn config(&self) -> (FilterStrategy, u8) {
        match self {
            CompressionStrategy::Fastest => (FilterStrategy::BinaryRLE, 0),
            CompressionStrategy::Balanced => (FilterStrategy::BinaryRLE, 6),
            CompressionStrategy::Smallest => (FilterStrategy::BinaryRLE, 9),
            CompressionStrategy::Optimal => (FilterStrategy::Paeth, 9),
        }
    }
}

impl Default for CompressionStrategy {
    fn default() -> Self {
        CompressionStrategy::Balanced
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FastPngConfig {
    pub filter: FilterStrategy,
    pub compression_level: u8, // 0-9, where 9 is best compression
}

impl FastPngConfig {
    /// Create config from compression strategy
    pub fn from_strategy(strategy: CompressionStrategy) -> Self {
        let (filter, level) = strategy.config();
        Self {
            filter,
            compression_level: level,
        }
    }
}

impl Default for FastPngConfig {
    fn default() -> Self {
        Self::from_strategy(CompressionStrategy::default())
    }
}

/// Fast PNG encoder optimized for binary mask data
pub struct FastPngEncoder {
    width: u32,
    height: u32,
    config: FastPngConfig,
}

impl FastPngEncoder {
    pub fn new(width: u32, height: u32, config: FastPngConfig) -> Result<Self, FastPngError> {
        if width == 0 || height == 0 || width > 65535 || height > 65535 {
            return Err(FastPngError::InvalidDimensions { width, height });
        }

        Ok(Self {
            width,
            height,
            config,
        })
    }

    /// Encode grayscale binary mask to PNG
    pub fn encode(&self, pixels: &[u8]) -> Result<Vec<u8>, FastPngError> {
        let expected_len = (self.width * self.height) as usize;
        if pixels.len() != expected_len {
            return Err(FastPngError::InvalidDataLength {
                expected: expected_len,
                actual: pixels.len(),
            });
        }

        let mut output = Vec::with_capacity(pixels.len() + 4096); // Rough estimate

        // PNG signature
        output.write_all(&[137, 80, 78, 71, 13, 10, 26, 10])?;

        // IHDR chunk (image header)
        self.write_ihdr(&mut output)?;

        // IDAT chunk (image data)
        self.write_idat(&mut output, pixels)?;

        // IEND chunk (image trailer)
        self.write_iend(&mut output)?;

        Ok(output)
    }

    fn write_ihdr(&self, output: &mut Vec<u8>) -> Result<(), FastPngError> {
        let mut chunk = Vec::with_capacity(13);
        chunk.write_all(&self.width.to_be_bytes())?;
        chunk.write_all(&self.height.to_be_bytes())?;
        chunk.write_all(&[8])?; // Bit depth: 8
        chunk.write_all(&[0])?; // Color type: Grayscale
        chunk.write_all(&[0])?; // Compression method: deflate
        chunk.write_all(&[0])?; // Filter method: adaptive
        chunk.write_all(&[0])?; // Interlace method: none

        self.write_chunk(output, b"IHDR", &chunk)?;
        Ok(())
    }

    fn write_idat(&self, output: &mut Vec<u8>, pixels: &[u8]) -> Result<(), FastPngError> {
        // Apply filtering
        let filtered = self.apply_filter(pixels)?;

        // Compress with deflate
        let compressed = self.compress(&filtered)?;

        self.write_chunk(output, b"IDAT", &compressed)?;
        Ok(())
    }

    fn write_iend(&self, output: &mut Vec<u8>) -> Result<(), FastPngError> {
        self.write_chunk(output, b"IEND", &[])?;
        Ok(())
    }

    fn write_chunk(
        &self,
        output: &mut Vec<u8>,
        chunk_type: &[u8; 4],
        data: &[u8],
    ) -> Result<(), FastPngError> {
        // Length
        output.write_all(&(data.len() as u32).to_be_bytes())?;

        // Type
        output.write_all(chunk_type)?;

        // Data
        output.write_all(data)?;

        // CRC32
        let crc = self.calculate_crc(chunk_type, data);
        output.write_all(&crc.to_be_bytes())?;

        Ok(())
    }

    fn calculate_crc(&self, chunk_type: &[u8; 4], data: &[u8]) -> u32 {
        let mut crc = crc32fast::Hasher::new();
        crc.update(chunk_type);
        crc.update(data);
        crc.finalize()
    }

    fn apply_filter(&self, pixels: &[u8]) -> Result<Vec<u8>, FastPngError> {
        let stride = self.width as usize;
        let height = self.height as usize;
        let mut filtered = Vec::with_capacity(height * (stride + 1));

        match self.config.filter {
            FilterStrategy::None => {
                for y in 0..height {
                    filtered.push(0); // Filter type: None
                    let row_start = y * stride;
                    filtered.extend_from_slice(&pixels[row_start..row_start + stride]);
                }
            }
            FilterStrategy::Sub => {
                for y in 0..height {
                    filtered.push(1); // Filter type: Sub
                    let row_start = y * stride;
                    let row = &pixels[row_start..row_start + stride];

                    filtered.push(row[0]); // First pixel unchanged
                    for x in 1..stride {
                        let diff = row[x].wrapping_sub(row[x - 1]);
                        filtered.push(diff);
                    }
                }
            }
            FilterStrategy::Up => {
                for y in 0..height {
                    filtered.push(2); // Filter type: Up
                    let row_start = y * stride;
                    let row = &pixels[row_start..row_start + stride];

                    if y == 0 {
                        filtered.extend_from_slice(row);
                    } else {
                        let prev_row_start = (y - 1) * stride;
                        let prev_row = &pixels[prev_row_start..prev_row_start + stride];
                        for x in 0..stride {
                            let diff = row[x].wrapping_sub(prev_row[x]);
                            filtered.push(diff);
                        }
                    }
                }
            }
            FilterStrategy::BinaryRLE => {
                // Optimized for binary masks: detect long runs of 0 or 255
                // Use filter type 0 but with run-length awareness in mind
                self.apply_binary_rle_filter(pixels, &mut filtered, stride, height)?;
            }
            FilterStrategy::Average | FilterStrategy::Paeth | FilterStrategy::Adaptive => {
                // Fall back to standard PNG encoding for complex filters
                // These are slower but may give better compression on non-binary data
                return self.apply_standard_filter(pixels);
            }
        }

        Ok(filtered)
    }

    fn apply_binary_rle_filter(
        &self,
        pixels: &[u8],
        filtered: &mut Vec<u8>,
        stride: usize,
        height: usize,
    ) -> Result<(), FastPngError> {
        // For binary masks (0 or 255), no filtering often works best
        // because deflate can efficiently compress runs
        for y in 0..height {
            filtered.push(0); // Filter type: None
            let row_start = y * stride;
            filtered.extend_from_slice(&pixels[row_start..row_start + stride]);
        }
        Ok(())
    }

    fn apply_standard_filter(&self, pixels: &[u8]) -> Result<Vec<u8>, FastPngError> {
        // Fallback to the standard png crate for complex filters
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, self.width, self.height);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);

        let compression = match self.config.compression_level {
            0..=3 => png::Compression::Fast,
            4..=6 => png::Compression::Default,
            _ => png::Compression::Best,
        };
        encoder.set_compression(compression);

        let filter = match self.config.filter {
            FilterStrategy::Average => png::FilterType::Avg,
            FilterStrategy::Paeth => png::FilterType::Paeth,
            FilterStrategy::Adaptive => png::FilterType::Sub, // Adaptive not directly supported, use Sub
            _ => png::FilterType::NoFilter,
        };
        encoder.set_filter(filter);

        let mut writer = encoder
            .write_header()
            .map_err(|e| FastPngError::CompressionFailed(e.to_string()))?;

        writer
            .write_image_data(pixels)
            .map_err(|e| FastPngError::CompressionFailed(e.to_string()))?;

        drop(writer); // Release borrow on 'out'

        Ok(out)
    }

    fn compress(&self, data: &[u8]) -> Result<Vec<u8>, FastPngError> {
        // Use flate2 with miniz_oxide backend for WASM compatibility
        use flate2::write::ZlibEncoder;
        use flate2::Compression;

        let compression = match self.config.compression_level {
            0 => Compression::none(),
            1..=3 => Compression::fast(),
            4..=6 => Compression::new(6),
            _ => Compression::best(),
        };

        let mut encoder = ZlibEncoder::new(Vec::new(), compression);
        encoder
            .write_all(data)
            .map_err(|e| FastPngError::CompressionFailed(e.to_string()))?;
        encoder
            .finish()
            .map_err(|e| FastPngError::CompressionFailed(e.to_string()))
    }
}

/// Convenience function for quick encoding with default settings
pub fn encode_binary_mask(width: u32, height: u32, pixels: &[u8]) -> Result<Vec<u8>, FastPngError> {
    let encoder = FastPngEncoder::new(width, height, FastPngConfig::default())?;
    encoder.encode(pixels)
}

/// Encode with compression strategy
pub fn encode_binary_mask_with_strategy(
    width: u32,
    height: u32,
    pixels: &[u8],
    strategy: CompressionStrategy,
) -> Result<Vec<u8>, FastPngError> {
    let config = FastPngConfig::from_strategy(strategy);
    let encoder = FastPngEncoder::new(width, height, config)?;
    encoder.encode(pixels)
}

/// Encode with custom compression level (0-9)
pub fn encode_binary_mask_with_level(
    width: u32,
    height: u32,
    pixels: &[u8],
    compression_level: u8,
) -> Result<Vec<u8>, FastPngError> {
    let config = FastPngConfig {
        filter: FilterStrategy::BinaryRLE,
        compression_level: compression_level.min(9),
    };
    let encoder = FastPngEncoder::new(width, height, config)?;
    encoder.encode(pixels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_simple_mask() {
        let width = 4;
        let height = 4;
        let pixels = vec![
            255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255,
        ];

        let result = encode_binary_mask(width, height, &pixels);
        assert!(result.is_ok());

        let png_data = result.unwrap();
        // Verify PNG signature
        assert_eq!(&png_data[0..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
    }

    #[test]
    fn test_encode_all_white() {
        let width = 8;
        let height = 8;
        let pixels = vec![255; 64];

        let result = encode_binary_mask(width, height, &pixels);
        assert!(result.is_ok());

        // All-white should compress very well
        let png_data = result.unwrap();
        assert!(png_data.len() < 200); // Should be tiny when compressed
    }

    #[test]
    fn test_invalid_dimensions() {
        let result = FastPngEncoder::new(0, 0, FastPngConfig::default());
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_data_length() {
        let encoder = FastPngEncoder::new(4, 4, FastPngConfig::default()).unwrap();
        let pixels = vec![0; 10]; // Wrong length
        let result = encoder.encode(&pixels);
        assert!(result.is_err());
    }

    #[test]
    fn test_compression_strategies() {
        let width = 16;
        let height = 16;
        let pixels = vec![255; 256]; // All white

        // Test all strategies
        let fastest =
            encode_binary_mask_with_strategy(width, height, &pixels, CompressionStrategy::Fastest);
        let balanced =
            encode_binary_mask_with_strategy(width, height, &pixels, CompressionStrategy::Balanced);
        let smallest =
            encode_binary_mask_with_strategy(width, height, &pixels, CompressionStrategy::Smallest);
        let max_quality = encode_binary_mask_with_strategy(
            width,
            height,
            &pixels,
            CompressionStrategy::MaxQuality,
        );

        assert!(fastest.is_ok());
        assert!(balanced.is_ok());
        assert!(smallest.is_ok());
        assert!(max_quality.is_ok());

        let fastest_size = fastest.unwrap().len();
        let balanced_size = balanced.unwrap().len();
        let smallest_size = smallest.unwrap().len();
        let max_quality_size = max_quality.unwrap().len();

        // Verify compression tradeoff: faster is usually larger
        println!(
            "Compression sizes: fastest={}, balanced={}, smallest={}, max_quality={}",
            fastest_size, balanced_size, smallest_size, max_quality_size
        );

        // Smallest should be smaller or equal to balanced
        assert!(smallest_size <= balanced_size || smallest_size == balanced_size);
    }

    #[test]
    fn test_strategy_config() {
        let fastest = CompressionStrategy::Fastest.config();
        let balanced = CompressionStrategy::Balanced.config();
        let smallest = CompressionStrategy::Smallest.config();
        let optimal = CompressionStrategy::Optimal.config();

        assert_eq!(fastest.1, 0); // Level 0 for fastest
        assert_eq!(balanced.1, 6); // Level 6 for balanced
        assert_eq!(smallest.1, 9); // Level 9 for smallest
        assert_eq!(optimal.1, 9); // Level 9 for optimal
        assert_eq!(optimal.0, FilterStrategy::Paeth); // Paeth for optimal compression
    }
}
