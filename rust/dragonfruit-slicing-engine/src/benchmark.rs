//! Synthetic benchmark helpers for quick V3 throughput checks.
//!
//! The benchmark builds a procedural scene of box solids, runs a full slice,
//! and returns coarse stage timing/throughput metrics.

use crate::encoders::registry::supported_output_formats;
use crate::engine::{slice_with_progress_v3, SlicerV3Error};
use crate::types::SliceJobV3;

#[derive(Debug, Clone)]
pub struct BenchmarkConfigV3 {
    pub layers: u32,
    pub source_width_px: u32,
    pub source_height_px: u32,
    pub output_width_px: u32,
    pub output_height_px: u32,
    pub build_width_mm: f32,
    pub build_depth_mm: f32,
    pub layer_height_mm: f32,
    pub cube_count: u32,
    pub anti_aliasing_level: String,
    pub anti_aliasing_mode: String,
    pub blur_brush_radius_px: u32,
    pub minimum_aa_alpha_percent: f32,
    pub dither_enabled: bool,
}

impl Default for BenchmarkConfigV3 {
    fn default() -> Self {
        Self {
            layers: 200,
            source_width_px: 1920,
            source_height_px: 1080,
            output_width_px: 1920,
            output_height_px: 1080,
            build_width_mm: 218.88,
            build_depth_mm: 122.904,
            layer_height_mm: 0.05,
            cube_count: 400,
            anti_aliasing_level: "Off".to_string(),
            anti_aliasing_mode: "Blur".to_string(),
            blur_brush_radius_px: 1,
            minimum_aa_alpha_percent: 35.0,
            dither_enabled: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct BenchmarkResultV3 {
    pub artifact_bytes: usize,
    pub total_s: f64,
    pub layers_per_second: f64,
    pub render_s: f64,
    pub png_s: f64,
    pub archive_s: f64,
}

fn push_box_triangles(out: &mut Vec<f32>, cx: f32, cy: f32, z0: f32, z1: f32, sx: f32, sy: f32) {
    let x0 = cx - sx * 0.5;
    let x1 = cx + sx * 0.5;
    let y0 = cy - sy * 0.5;
    let y1 = cy + sy * 0.5;

    let verts = [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
    ];

    let faces = [
        (0, 1, 2),
        (0, 2, 3),
        (4, 6, 5),
        (4, 7, 6),
        (0, 4, 5),
        (0, 5, 1),
        (1, 5, 6),
        (1, 6, 2),
        (2, 6, 7),
        (2, 7, 3),
        (3, 7, 4),
        (3, 4, 0),
    ];

    for (a, b, c) in faces {
        out.extend_from_slice(&verts[a]);
        out.extend_from_slice(&verts[b]);
        out.extend_from_slice(&verts[c]);
    }
}

fn build_synthetic_triangles(cfg: &BenchmarkConfigV3) -> Vec<f32> {
    let mut tris = Vec::<f32>::new();
    let n = (cfg.cube_count as f32).sqrt().ceil() as u32;
    let dx = cfg.build_width_mm / n as f32;
    let dy = cfg.build_depth_mm / n as f32;
    let mut produced = 0u32;

    for iy in 0..n {
        for ix in 0..n {
            if produced >= cfg.cube_count {
                return tris;
            }
            let cx = -cfg.build_width_mm * 0.5 + dx * (ix as f32 + 0.5);
            let cy = -cfg.build_depth_mm * 0.5 + dy * (iy as f32 + 0.5);
            push_box_triangles(
                &mut tris,
                cx,
                cy,
                0.0,
                cfg.layers as f32 * cfg.layer_height_mm * 0.8,
                dx * 0.7,
                dy * 0.7,
            );
            produced += 1;
        }
    }

    tris
}

pub fn run_benchmark_v3(cfg: BenchmarkConfigV3) -> Result<BenchmarkResultV3, SlicerV3Error> {
    let triangles = build_synthetic_triangles(&cfg);
    let output_format = supported_output_formats()
        .iter()
        .copied()
        .find(|&f| f.contains("ctb") || f.contains("pw0"))
        .or_else(|| supported_output_formats().first().copied())
        .ok_or_else(|| SlicerV3Error::UnsupportedOutput("no registered output formats".into()))?;

    let job = SliceJobV3 {
        output_format: output_format.to_string(),
        format_version: None,
        source_width_px: cfg.source_width_px,
        source_height_px: cfg.source_height_px,
        width_px: cfg.output_width_px,
        height_px: cfg.output_height_px,
        build_width_mm: cfg.build_width_mm,
        build_depth_mm: cfg.build_depth_mm,
        layer_height_mm: cfg.layer_height_mm,
        total_layers: cfg.layers,
        export_thumbnail_png_base64: None,
        png_compression_strategy: "fastest".to_string(),
        container_compression_level: 2,
        anti_aliasing_level: cfg.anti_aliasing_level,
        anti_aliasing_mode: cfg.anti_aliasing_mode,
        blur_brush_radius_px: cfg.blur_brush_radius_px,
        blur_brush_kernel: "box".to_string(),
        blur_brush_sigma_x: 1.5,
        blur_brush_sigma_y: 1.5,
        z_blur_radius_layers: 0,
        z_blur_kernel: "gaussian".to_string(),
        z_blur_sigma: 0.5,
        aa_on_supports: false,
        model_triangle_count: (triangles.len() / 9) as u32,
        minimum_aa_alpha_percent: cfg.minimum_aa_alpha_percent,
        mirror_x: false,
        mirror_y: false,
        z_blend_look_back: 2,
        z_blend_fade_px: 20,
        z_blend_auto_fade: true,
        z_blend_minimum_alpha_percent: 0.0,
        z_blend_max_alpha_percent: 90.0,
        z_blend_custom_lut: None,
        zaa_kernel: None,
        zaa_pattern: None,
        zaa_duplicate_z: None,
        dither_enabled: cfg.dither_enabled,
        dither_bit_depth: Some(3),
        dither_device_gamma: 3.0,
        triangles_xyz: triangles,
        metadata_json: "{}".to_string(),
        x_packing_mode: "none".to_string(),
    };

    let artifact = slice_with_progress_v3(&job, None, None)?;
    Ok(BenchmarkResultV3 {
        artifact_bytes: artifact.bytes.len(),
        total_s: artifact.perf.total_s(),
        layers_per_second: artifact.perf.layers_per_second(),
        render_s: artifact.perf.render_ns as f64 / 1_000_000_000.0,
        png_s: artifact.perf.png_encode_ns as f64 / 1_000_000_000.0,
        archive_s: artifact.perf.archive_encode_ns as f64 / 1_000_000_000.0,
    })
}
