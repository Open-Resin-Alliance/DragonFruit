//! Creality plugin `.cxdlpv4` slicing encoder entry point.

#[path = "cxdlpv4_types.rs"]
mod cxdlpv4_types;
#[path = "cxdlpv4_metadata.rs"]
mod cxdlpv4_metadata;
#[path = "cxdlpv4_preview.rs"]
mod cxdlpv4_preview;
#[path = "cxdlpv4_layout.rs"]
mod cxdlpv4_layout;
#[path = "cxdlpv4_encoder.rs"]
mod cxdlpv4_encoder;

use cxdlpv4_encoder::{
    encode_rendered_layers_to_cxdlpv4, CxdlpV4RawMaskStreamEncoder, CxdlpV4StreamEncoder,
};

use crate::encoders::{FormatEncoder, RawMaskStreamEncoder, RleStreamEncoder};
use crate::engine::SlicerV3Error;
use crate::types::{LayerAreaStatsV3, RenderedLayersV3, SliceJobV3};

/// FormatEncoder implementation for `.cxdlpv4` (Creality CXSW3DV2 v4).
pub struct CrealityCxdlpV4Encoder;

impl FormatEncoder for CrealityCxdlpV4Encoder {
    fn output_format(&self) -> &'static str {
        ".cxdlpv4"
    }

    fn requires_area_stats(&self) -> bool {
        true
    }

    fn requires_png_layers(&self) -> bool {
        false
    }

    fn requires_raw_mask_layers(&self) -> bool {
        true
    }

    fn create_rle_stream_encoder(
        &self,
        job: &SliceJobV3,
    ) -> Result<Option<Box<dyn RleStreamEncoder>>, SlicerV3Error> {
        Ok(Some(Box::new(CxdlpV4StreamEncoder::new(job))))
    }

    fn create_raw_mask_stream_encoder(
        &self,
        job: &SliceJobV3,
    ) -> Result<Option<Box<dyn RawMaskStreamEncoder>>, SlicerV3Error> {
        Ok(Some(Box::new(CxdlpV4RawMaskStreamEncoder::new(job))))
    }

    fn encode_container_from_rendered_layers_with_progress(
        &self,
        job: &SliceJobV3,
        rendered_layers: &RenderedLayersV3,
        layer_area_stats: &[LayerAreaStatsV3],
        on_progress: Option<&dyn Fn(u32, u32)>,
    ) -> Result<Vec<u8>, SlicerV3Error> {
        encode_rendered_layers_to_cxdlpv4(job, rendered_layers, layer_area_stats, on_progress)
    }
}

pub fn create_plugin_encoder() -> Vec<Box<dyn FormatEncoder>> {
    vec![Box::new(CrealityCxdlpV4Encoder)]
}

#[cfg(test)]
mod tests {
    use super::cxdlpv4_layout::compute_creality_crc32;
    use super::*;
    use crate::rle::RleRun;

    #[test]
    fn encodes_valid_cxdlpv4_container_for_halot_r6() {
        let width_px = 1620u32;
        let height_px = 2560u32;
        let total_px = width_px * height_px;

        let job = SliceJobV3 {
            output_format: ".cxdlpv4".to_string(),
            source_width_px: width_px,
            source_height_px: height_px,
            width_px,
            height_px,
            build_width_mm: 82.62,
            build_depth_mm: 130.56,
            layer_height_mm: 0.05,
            total_layers: 2,
            anti_aliasing_level: "Off".to_string(),
            metadata_json: serde_json::json!({
                "printer": { "name": "HALOT-R6", "buildHeightMm": 160.0 },
                "material": {
                    "layerHeightMm": 0.05,
                    "bottomLayerCount": 1,
                    "bottomExposureSec": 25.0,
                    "normalExposureSec": 2.5,
                    "bottomLiftDistanceMm": 6.0,
                    "bottomLiftSpeedMmMin": 60.0,
                    "bottomRetractSpeedMmMin": 120.0,
                    "liftDistanceMm": 6.0,
                    "liftSpeedMmMin": 60.0,
                    "retractSpeedMmMin": 150.0
                },
                "cxdlpv4": {
                    "lightOffDelaySec": 1.0,
                    "bottomLightOffDelaySec": 1.0,
                    "antiAliasingLevel": 1,
                    "projectorPwmPercent": 100
                }
            })
            .to_string(),
            ..Default::default()
        };

        let mut enc = CxdlpV4StreamEncoder::new(&job);
        enc.set_area_stats(vec![
            LayerAreaStatsV3 {
                total_solid_pixels: 1000,
                largest_area_mm2: 2.601,
                ..Default::default()
            },
            LayerAreaStatsV3 {
                total_solid_pixels: 500,
                largest_area_mm2: 1.3005,
                ..Default::default()
            },
        ]);

        // Layer 0: 1000 white pixels, rest black
        enc.consume_rle_layer(
            0,
            vec![
                RleRun { length: 1000, value: 255 },
                RleRun { length: total_px - 1000, value: 0 },
            ],
        )
        .expect("layer 0");

        // Layer 1: 500 white pixels, rest black
        enc.consume_rle_layer(
            1,
            vec![
                RleRun { length: 500, value: 255 },
                RleRun { length: total_px - 500, value: 0 },
            ],
        )
        .expect("layer 1");

        let bytes = enc.finalize().expect("finalize");
        assert!(bytes.len() > 256);

        // Header magic, BE version 4, BE printer model "HALOT-R6\0"
        assert_eq!(&bytes[0..4], &9u32.to_be_bytes());
        assert_eq!(&bytes[4..13], b"CXSW3DV2\0");
        assert_eq!(&bytes[13..15], &4u16.to_be_bytes());
        assert_eq!(&bytes[15..19], &9u32.to_be_bytes());
        assert_eq!(&bytes[19..28], b"HALOT-R6\0");

        // Verify Creality CRC32 trailer
        let payload_len = bytes.len() - 4;
        let expected_crc = compute_creality_crc32(&bytes[..payload_len]);
        let stored_crc = u32::from_be_bytes(bytes[payload_len..].try_into().unwrap());
        assert_eq!(stored_crc, expected_crc);

        if let Ok(out_path) = std::env::var("DF_CREALITY_TEST_OUT") {
            if !out_path.trim().is_empty() {
                std::fs::write(&out_path, &bytes).expect("write test .cxdlpv4 output");
            }
        }
    }

    #[test]
    fn encodes_container_with_png_preview_and_transitions() {
        let mut png_buf = Vec::new();
        {
            let mut png_enc = png::Encoder::new(&mut png_buf, 4, 4);
            png_enc.set_color(png::ColorType::Rgba);
            png_enc.set_depth(png::BitDepth::Eight);
            let mut writer = png_enc.write_header().unwrap();
            let pixels = [220u8, 100u8, 40u8, 255u8].repeat(16);
            writer.write_image_data(&pixels).unwrap();
        }
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        let b64 = format!("data:image/png;base64,{}", STANDARD.encode(&png_buf));

        let width_px = 64u32;
        let height_px = 64u32;
        let job = SliceJobV3 {
            output_format: ".cxdlpv4".to_string(),
            source_width_px: width_px,
            source_height_px: height_px,
            width_px,
            height_px,
            build_width_mm: 82.62,
            build_depth_mm: 130.56,
            layer_height_mm: 0.05,
            total_layers: 3,
            export_thumbnail_png_base64: Some(b64),
            metadata_json: serde_json::json!({
                "printer": { "name": "HALOT-R6" },
                "material": { "bottomLayerCount": 1, "bottomExposureSec": 25.0, "normalExposureSec": 2.5 },
                "cxdlpv4": { "transitionLayerCount": 1, "lightOffDelaySec": 1.5 }
            })
            .to_string(),
            ..Default::default()
        };

        let mut enc = CxdlpV4RawMaskStreamEncoder::new(&job);
        enc.consume_raw_mask_layer(0, vec![255u8; (width_px * height_px) as usize]).unwrap();
        enc.consume_raw_mask_layer(1, vec![128u8; (width_px * height_px) as usize]).unwrap();
        enc.consume_raw_mask_layer(2, Vec::new()).unwrap();

        let bytes = Box::new(enc).finalize_to_bytes().expect("finalize raw mask");
        let payload_len = bytes.len() - 4;
        assert_eq!(
            u32::from_be_bytes(bytes[payload_len..].try_into().unwrap()),
            compute_creality_crc32(&bytes[..payload_len])
        );
    }
}
