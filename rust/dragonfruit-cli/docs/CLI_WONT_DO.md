# CLI — Won't Do (Review Later)

Operations that cannot be exposed via CLI without significant new code or
fundamental architecture changes. Revisit when requirements change.

## GUI-Only by Design

| Operation | Reason |
|-----------|--------|
| `cancel_slicing` | CLI runs to completion — no interactive cancellation |
| `pick_open_files` / `pick_save_path` | OS file dialogs — CLI uses paths directly |
| `focus_main_window_command` | Tauri window management |
| `get_launch_scene_files` / `notify_launch_scene_handoff` | App launch handoff |
| `setSelectedId` / `setHoveredId` / `setHoveredCategory` / `setInteractionWarning` | UI interaction state |

## THREE.js Geometry-Dependent (no headless path)

| Operation | Reason |
|-----------|--------|
| `transformSupportsForModel` | Requires delta Matrix4 from model transform change — the matrix is computed from the difference between before/after THREE.js Euler/Scale/Position, not available from file state alone |
| `transformAllSupportsForSingleModel` | Same — needs live delta matrix |
| `transformKickstandsForModel` / `transformAllKickstands` | Same — needs Matrix4 |
| Raster layer ZIP export (`rasterLayerZipExport.ts`) | Requires THREE.js BufferGeometry for scanline rasterization — the Rust slicer does this natively via `slice run` |
| Auto-lift Z / snap-to-platform with geometry | `useTransformManager.ts::getLowestWorldZForTransform` needs THREE.js geometry bounds computation. **Workaround:** `scene place-on-platform` loads STL and computes bbox directly |
| `toggleSegmentCurve` straight→bezier | Needs `calculateBezierControlPoints` which requires THREE.js Vector3 math for control point placement. **Workaround:** `support straighten-segment` handles bezier→straight direction |

## Plugin System

| Operation | Reason |
|-----------|--------|
| `plugin_network_request` | Requires plugin registry initialization (`plugin_registry::initialize_plugins`) which loads compiled-in plugin modules. Could be exposed but the plugin registry is tightly coupled to the Tauri build — would need refactoring to work standalone |

## Import Formats

| Operation | Reason |
|-----------|--------|
| `scene import-lys` | LYS import (`useLysImport.ts`, `LysParser.ts`, `LysConverter.ts`) is ~1000 lines with THREE.js geometry construction for mesh loading. Could work in Node.js with THREE but needs significant wiring. Lower priority since VOXL is the primary interchange format |
| 3MF import (read) | No existing Rust or TS reader that produces `positions.bin`. The GUI uses `loadMeshGeometry` which delegates to THREE.js loaders. Would need a Rust 3MF parser crate or porting the XML parsing |

## Unused Internal APIs

| Operation | Reason |
|-----------|--------|
| `rle_encode` / `rle_decode` | Encoding from dense grids — useful only if CLI produces raw raster data, which it doesn't (island pipeline works on masks from STL rasterization) |
| `rle_intersect_dilated` | Used internally by `scan_layer` — exposed indirectly via `island scan`. Direct use would need raw mask files |
| `rle_encode_labels` / `rle_decode_labels` | Same — internal to island pipeline |
| `rasterize_layer` / `rasterize_layer_with_stats` | Internal to `render_layers_bounded` — exposed indirectly via `slice run` |
| `render_layers_bounded` | Internal to engine — exposed via `slice run` |
| `encode_grayscale_png` | Internal to raster pipeline |
| `build_layer_index` | Internal to engine |
