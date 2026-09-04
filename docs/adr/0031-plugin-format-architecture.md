---
issue: dragonfruit-kb-harvest-2026-08
date: 2026-08-18
kind: pattern
---

# ADR-0031: Plugin format architecture — external submodule pattern

## Context

DragonFruit supports multiple printer file formats (CTB, GOO, Anycubic AFF,
Elegoo GOO, SirayaTech, Uniformation) and import formats (Lychee .lys,
Chitubox .ctb/.cbddlp). Early formats were built inline; as the number grew,
a consistent architecture was needed to isolate format-specific parsing from
the core slicer.

## Decision

**1. Every format is a git submodule under `plugins/`.** Each plugin lives in
its own repository (`Open-Resin-Alliance/df-plugin-*`) and is mounted at
`plugins/<name>`. This gives each format:
- Independent version history and release cadence
- Clear ownership boundaries (format-specific contributors don't need core access)
- Build-time isolation — a broken plugin doesn't block the core build

Current submodules (as of 2026-08-18):

| Plugin | Path | Format |
|--------|------|--------|
| ctb | `plugins/ctb` | ChiTuBox v2–v5 output |
| sdcp-v3 | `plugins/sdcp-v3` | SDCP v3 network print |
| anycubic | `plugins/anycubic` | Anycubic AFF output |
| elegoo | `plugins/elegoo` | Elegoo GOO output |
| sirayatech | `plugins/sirayatech` | SirayaTech output |
| uniformation | `plugins/uniformation` | Uniformation output |
| lys-import | `plugins/lys-import` | Lychee .lys import |
| chitubox-import | `plugins/chitubox-import` | ChiTuBox project import |

**2. Registration via build-time codegen.** Plugin discovery uses the
auto-registry codegen pattern from ADR-0010. Plugins declare their format
capabilities in a manifest; the build step generates the registration code
with SHA256 integrity checks.

**3. Import vs output plugins follow the same submodule pattern** but have
different internal shapes. Output plugins produce binary format files from
rasterised layers. Import plugins parse external project files into
DragonFruit's internal scene representation (see ADR-0020 for the .lys import
pipeline).

**4. GOO format modes.** GOO v5 uses static mode rather than dynamic mode,
decided in PR #341 and confirmed by the `use static mode instead of dynamic
for goo v5` commit. GOO/CTB interpolation was optimised in PR #296.

## Consequences

- Adding a new printer format requires creating a new `df-plugin-*` repo,
  adding it as a submodule, and running the registry codegen.
- Plugin submodule pointers must be bumped explicitly — stale pointers are a
  recurring maintenance task (see `chore: bump chitubox-import submodule`
  pattern).
- Tauri builds require all plugin submodules to be initialised — missing
  submodules cause build failures (see ADR-0006 for related bundling gotchas).

## References

- Plugin registry codegen: ADR-0010
- Lychee import pipeline: ADR-0020
- Submodules: `.gitmodules` in the repo root
- Key PRs: #250 (chitubox-import), #244 (GOO), #335 (Anycubic AFF)
