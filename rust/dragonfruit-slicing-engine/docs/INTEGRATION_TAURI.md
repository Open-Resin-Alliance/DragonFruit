# Tauri Integration Guide

## Where this crate is used

DragonFruit Desktop (`src-tauri`) consumes `dragonfruit-slicer-v3` as a path dependency.

Primary integration responsibilities in desktop layer:

- construct `SliceJobV3` from app-side slice requests
- provide progress callback bridge to frontend
- wire cancellation token (`AtomicBool`)
- choose in-memory vs path-based output mode
- map `SlicerV3Error` to command/IPC-safe errors

## Recommended integration pattern

1. Resolve printer/output settings into `SliceJobV3`.
2. Create per-job cancellation flag and store handle for cancellation commands.
3. Run `slice_with_progress_v3` or `slice_with_progress_v3_to_path`.
4. Stream progress `(done,total)` to UI.
5. On completion, return artifact bytes/path + perf counters.

## Choosing output mode

### In-memory mode

Use `slice_with_progress_v3` when caller needs bytes immediately in process.

### Path mode

Use `slice_with_progress_v3_to_path` for larger outputs to reduce copy pressure at IPC boundaries.

## Cancellation behavior

Cancellation is cooperative:

- set `AtomicBool` from external cancel command
- running job exits with `SlicerV3Error::Cancelled`

No abrupt thread kill or panic path is used.

## Progress behavior

Progress callback is invoked as worker results complete (not only strict in-order flush), producing smoother frontend updates under out-of-order parallel completion.

## Error translation

At Tauri command boundary, map `SlicerV3Error` variants to user-facing categories:

- input validation errors
- unsupported format/config errors
- cancellation
- encoding/IO runtime failures

Preserve original error string for diagnostics.

## Build/runtime notes

- Encoder availability depends on generated plugin registry artifacts.
- If output format suddenly appears unsupported, regenerate plugin registry and rebuild.
- For local dev performance consistency, ensure desktop and slicer crates use intended profile settings.
