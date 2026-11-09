# Tauri Integration (Desktop)

## Dependency + crate identity

`src-tauri` depends on:

- package: `dragonfruit-slicing-engine`
- library target: `dragonfruit_slicing_engine`
- path: `rust/dragonfruit-slicing-engine`

## Command-level responsibilities

Desktop layer should:

1. build `SliceJobV3` from UI/profile state
2. create/store cancellation flag (`Arc<AtomicBool>`)
3. run slicing in `spawn_blocking` + dedicated Rayon pool
4. bridge progress updates to frontend
5. map `SlicerV3Error` to user-facing diagnostics

## Dedicated Rayon pool

Slicing runs inside a named pool (`dragonfruit-slicing-engine-{i}`) so heavy work stays separate from async runtime concerns.

## Progress behavior in V3.1

- engine reports progress on worker completion arrival
- Tauri bridge throttles emits (~8ms gate)
- first/final/phase-change updates bypass throttle

This combination avoids event floods while keeping UI movement smooth and responsive.

## Output mode choices

### In-memory bytes

`slice_with_progress_v3` — useful when bytes must be returned directly over IPC.

### Path output

`slice_with_progress_v3_to_path` — preferred for large outputs to avoid extra copy overhead.

## Cancellation semantics

Cancellation is cooperative:

- flag set by cancel command
- checked by worker loop and drain loop
- exits as `SlicerV3Error::Cancelled`

## Error mapping guidance

- treat `Cancelled` as expected user action
- surface validation errors as input/config issues
- include supported formats for `UnsupportedOutput`
- preserve low-level details for `Png`/`Zip`/`Json`/payload mismatch errors for diagnostics

## Build profile note

Keep `[profile.dev.package.dragonfruit-slicing-engine] opt-level = 3` in desktop crate for representative dev throughput.
