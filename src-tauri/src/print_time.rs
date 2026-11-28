use dragonfruit_slicing_engine::encoders::registry::estimate_print_time_sec;

/// Print-time estimate from the encoder that owns the printer's output format.
/// `None` means that format has no vendor timing model; callers fall back.
#[tauri::command]
pub fn estimate_print_time(
    output_format: String,
    metadata_json: String,
    layer_height_mm: f32,
    total_layers: u32,
) -> Option<u32> {
    estimate_print_time_sec(&output_format, &metadata_json, layer_height_mm, total_layers)
}
