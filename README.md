# DragonFruit: The Resin Slicer

[![GitHub release](https://img.shields.io/github/release/Open-Resin-Alliance/DragonFruit.svg?style=for-the-badge)](https://github.com/Open-Resin-Alliance/DragonFruit/releases)
[![GitHub issues](https://img.shields.io/github/issues/Open-Resin-Alliance/DragonFruit.svg?style=for-the-badge)](https://github.com/Open-Resin-Alliance/DragonFruit/issues)
[![Discord](https://img.shields.io/discord/1281738817417777204?style=for-the-badge&logo=discord&logoColor=white&color=%235865F2)](https://discord.gg/beFeTaPH6v)
[![Crowdin translations](https://img.shields.io/badge/dynamic/regex?url=https%3A%2F%2Fbadges.crowdin.net%2Fdragonfruit%2Flocalized.svg&search=%22%3E(%5B0-9%5D%2B%25)%3C%2Ftext%3E%20%20%20%20%3C%2Fg&replace=%241&style=for-the-badge&logo=crowdin&label=Crowdin%20translations&link=https%3A%2F%2Ftranslate.dragonfruit-slicer.com)](https://translate.dragonfruit-slicer.com)


DragonFruit is an open-source resin slicer and support-generation environment built by the Open Resin Alliance. It combines a modern Next.js + React frontend with native Rust slicing backends and a Tauri desktop runtime.

Unless a subdirectory or submodule states otherwise, DragonFruit content in this repository is licensed under **AGPL-3.0-or-later**.

> :warning: **DragonFruit is under active development. Please exercise caution for production print workflows, validate outputs, and avoid unattended printing on first use.**

## Table of Contents

- [About DragonFruit](#about-dragonfruit)
- [Features](#features)
- [Getting started](#getting-started)
  - [Variant 1: Frontend development (Next.js)](#variant-1-frontend-development-nextjs)
  - [Variant 2: Desktop development (Tauri + Rust)](#variant-2-desktop-development-tauri--rust)
  - [Variant 3: Production build & bundling](#variant-3-production-build--bundling)
- [Localization (i18n)](LOCALE.md)
- [Project structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)

## About DragonFruit

DragonFruit focuses on practical resin-print preparation workflows, including model inspection, island analysis, transform tooling, support authoring, and native slicing integration. It is designed as a desktop-first toolchain while keeping the frontend highly iterative for rapid feature development.

## Features

DragonFruit currently includes a growing set of capabilities for resin 3D printing:

- **Interactive 3D Workspace:** High-performance model visualization and manipulation using `three.js` + `react-three-fiber`.
- **Advanced Transform Tooling:** Move/Rotate/Scale workflows with precision controls and viewport gizmos.
- **Island Analysis & Volume Tools:** Layer-aware unsupported-region detection and analysis workflows.
- **Support Authoring Systems:** Branch/grid/raft support workflows with rendering and snapping infrastructure.
- **Desktop Runtime via Tauri:** Native desktop app pipeline with Rust backend integration.
- **Extensible Architecture:** Plugin and profile systems for materials, printers, and ecosystem integrations.

## Getting started

To get started with DragonFruit, follow one of these variants depending on your workflow.

### Submodule note (plugin development)

DragonFruit supports plugins that can be sourced as Git submodules (for example `plugins/ctb`).
If your local clone is missing plugin folders, generation/build will continue with available plugins only (missing submodules are skipped with warnings).
Initialize/update submodules when you need to develop or validate those specific plugin integrations.

### Variant 1: Frontend development (Next.js)

For UI and interaction development only (without full desktop packaging):

1. **Prerequisites:** Install Node.js (LTS recommended) and npm.
2. **Install dependencies:** From the repository root, install packages with `npm install`.
3. **Run dev server:** Start the app with `npm run dev`.
4. **Open in browser:** Visit `http://localhost:3005`.

### Variant 2: Desktop development (Tauri + Rust)

For full desktop development with native backend wiring:

1. **Prerequisites:** Install Node.js, Rust toolchain, and Tauri system dependencies for your platform.
2. **Install JS dependencies:** Run `npm install` in the project root.
3. **Run desktop dev mode:** Launch with `npm run tauri:dev`.
4. **Iterate across stacks:** Frontend and Rust backend changes can be tested through the same Tauri dev workflow.

### Variant 3: Production build & bundling

For release-style builds and bundles:

1. **Frontend build:** Run `npm run build` (or `npm run build:tauri` for prepared Tauri frontend artifacts).
2. **Desktop build:** Build desktop binaries with `npm run tauri:build`.
3. **Bundle targets:** Use `npm run tauri:bundle` (builds Windows, Linux, and a
   universal macOS DMG) or platform-specific scripts:
   - `npm run tauri:bundle:windows`
   - `npm run tauri:bundle:linux`
   - `npm run tauri:bundle:macos:universal` — **canonical macOS / release target.**
     Produces one fat `.dmg` that runs natively on both Intel and Apple Silicon.
     It builds via `tauri-build.mjs --universal`, which sets
     `CMAKE_OSX_ARCHITECTURES="arm64;x86_64"` so manifold's C++ links fat, embeds
     the universal QuickLook extension, code-signs, and verifies the bundle is fat
     - signed. See [ADR 0005](../Dragonfruit-kb/ADR/0005-macos-universal-distribution.md).
   - `npm run tauri:bundle:macos` / `npm run tauri:bundle:macos:arm64` — single-arch
     shortcuts for fast local dev only (these do **not** embed the QuickLook
     extension and are not suitable for release).

## Localization (i18n)

See [LOCALE.md](LOCALE.md) for details on DragonFruit's internationalization
setup, including supported locales, catalog structure, workflow commands, and
runtime language selection.

Help translate DragonFruit at **[translate.dragonfruit-slicer.com](https://translate.dragonfruit-slicer.com/)**.

## Project structure

High-level layout of key project areas:

- `docs/` — Architecture notes, implementation guides, and domain documentation.
- `plugins/` — Plugin architecture and ecosystem integrations (see LICENSE).
- `profiles/` — Printer and material profile definitions.
- `rust/dragonfruit-slicing-engine/` — Rust slicer backend workspace.
- `src/` — Next.js app, React components, scene controls, support systems, hooks, i18n catalogs, and utilities.
- `src-tauri/` — Tauri desktop host and native integration points.

## Contributing

We welcome and appreciate contributions to DragonFruit! If you'd like to contribute:

1. **Fork the Repository:** Create a personal fork and branch for your feature/fix.
2. **Implement Changes:** Keep changes focused and aligned with project conventions.
3. **Run Checks:** Validate with `npm run lint` and `npm run test` where applicable.
4. **Submit a Pull Request:** Open a PR with a clear summary, rationale, and validation notes.

## License

Unless stated otherwise in a subdirectory or submodule, DragonFruit is licensed under **AGPL-3.0-or-later**. See the top-level `LICENSE` file for the full terms.

The plugin submodules under `plugins/` are licensed separately under **MIT**. Each plugin repository includes its own `LICENSE` file.

## Contact

If you have questions, feedback, or ideas, join us on the [Open Resin Alliance Discord](https://discord.gg/beFeTaPH6v).
