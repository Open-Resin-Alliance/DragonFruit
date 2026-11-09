# CLI New Format Support Plan

4 features to implement, wrapping existing code only.

## Available Formats (after #88 CTB merge)

| Extension | Encoder | Versions | Notes |
|-----------|---------|----------|-------|
| `.nanodlp` | Athena | — | ZIP of PNGs + metadata |
| `.ctb` | CTB plugin | v4 (default), v5, v5enc (encrypted) | Binary format with RLE-compressed layers |

Format version is controlled by `SliceJobV3.format_version: Option<String>`.
CTB accepts: `None` (v4 default), `"v5"`, `"v5enc"`.

## Feature 1: `slice formats` — list formats with details

**Wraps:** `encoders::registry::supported_output_formats()` + encoder trait methods.

**Output:**
```json
{
  "formats": [
    {
      "extension": ".nanodlp",
      "requires_area_stats": false,
      "requires_png_layers": true,
      "requires_raw_mask_layers": false
    },
    {
      "extension": ".ctb",
      "versions": ["v4", "v5", "v5enc"],
      "requires_area_stats": true,
      "requires_png_layers": false,
      "requires_raw_mask_layers": true
    }
  ]
}
```

**Problem:** The `FormatEncoder` trait doesn't expose version info or metadata schema.
We can hardcode known format metadata for now, or add a `format_info()` method to the trait.

**Decision:** Hardcode — the encoder plugins are compiled-in and change rarely.
Query `requires_area_stats`, `requires_png_layers`, `requires_raw_mask_layers` from the trait.
Add version/metadata info as static JSON per known format.

**Implementation:**
- Add `SliceCommands::Formats` variant (no args, always JSON)
- In `cmd_slice_formats()`: call `find_encoder` for each format, query capabilities
- Merge with static metadata for version info

## Feature 2: `slice run --format-version` flag

**Wraps:** `SliceJobV3.format_version` field (already exists, just not exposed in CLI).

**Current CLI `slice run` code:**
```rust
let job = SliceJobV3 {
    // ...
    format_version: None,          // ← always None
    minimum_aa_alpha_percent: 0.0, // ← always 0
};
```

**Implementation:**
- Add `--format-version <VERSION>` optional flag to `SliceCommands::Run`
- Add `--min-aa-alpha <PERCENT>` optional flag
- Pass through to `SliceJobV3`

**Example:**
```bash
dragonfruit-cli slice run model.stl -o out.ctb --format-version v5enc --json
```

## Feature 3: `island batch` — process multiple STLs

**Wraps:** Existing `island full` logic, run in a loop with aggregated JSON output.

**Implementation:**
- Add `IslandCommands::Batch` variant with `inputs: Vec<PathBuf>` (glob-expanded)
- For each input: run same logic as `cmd_island_full`
- Aggregate results into a single JSON array
- Report per-file timing

**Example:**
```bash
dragonfruit-cli island batch models/*.stl -o /tmp/results --json
# Output: [{ "stl": "model1.stl", "islands_filtered": 15, ... }, ...]
```

**Note:** Each STL is independent — could parallelize with rayon `par_iter` over files.

## Feature 4: `print inspect` — read metadata from archives

**Wraps:** `zip::ZipArchive` to list contents + read metadata entries.

CTB files aren't ZIP — they're a custom binary format. So this is primarily for
nanodlp/ZIP-based archives. For CTB inspection, we'd need to parse the binary header.

**Decision:** Start with ZIP-based archives (list entries, read manifest).
CTB binary inspection can be added later if needed.

**Implementation:**
- Add `PrintCommands::Inspect` variant
- Open as ZIP, list entries with sizes
- If `manifest.json` or `metadata.json` exists, parse and include in output
- Report layer count, total size, compression ratio

**Example:**
```bash
dragonfruit-cli print inspect out.nanodlp --json
# Output: { "format": "zip", "entries": 1345, "layers": 1344, "total_bytes": 98000000, ... }
```

## Implementation Order

| # | Feature | Effort | Files |
|---|---------|--------|-------|
| 1 | `--format-version` flag | XS | `main.rs` only (2 lines) |
| 2 | `slice formats` | S | `main.rs` (new command + handler) |
| 3 | `print inspect` | S | `main.rs` (new command + handler) |
| 4 | `island batch` | M | `main.rs` (new command + loop logic) |

Total: ~100 lines of new code, all wrapping existing functions.
