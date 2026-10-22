# Documentation

DragonFruit is an open-source resin slicer and support-authoring environment. These pages
cover what it does, how each workflow is meant to be used, and how it is built.

The site root is the [landing page](https://dragonfruit-slicer.com/); everything below is
the manual.

## Start here

- [Installation](getting-started/installation.md) — installers for Windows, macOS and
  Linux, Flatpak, and building from source.
- [Quick start](getting-started/quick-start.md) — a first plate, from import to slice.
- [Interface tour](getting-started/interface-tour.md) — what lives where in the workspace.

## Workflows

The order the pages are written in is the order the work usually happens in:

1. [Model preparation](workflows/model-preparation.md) and
   [transform and positioning](workflows/transform-and-positioning.md)
1. [Place on-face and mirror](workflows/place-on-face-and-mirror.md),
   [mesh smoothing](workflows/mesh-smoothing.md)
1. [Hollowing and hole punch](workflows/hollowing.md), then
   [arrange](workflows/arrange-models.md) and
   [duplicate models](workflows/duplicate-models.md)
1. [Support placement](workflows/support-placement.md) and
   [island analysis](workflows/island-analysis-workflow.md)
1. [Raft and export](workflows/raft-and-export.md), then
   [printing preview and send](workflows/printing-preview-and-send.md)

## Reference

- [Anatomy of supports](reference/support-anatomy/index.md) — one page per piece, from
  roots to contact tips, with the geometry and the constraints.
- [Support types](reference/support-types.md),
  [support placement modifiers](reference/support-placement-modifiers.md) and
  [auto-support settings](reference/auto-support-settings.md).
- [Hotkeys](reference/hotkeys.md) — every shortcut in the workspace.
- [File formats](reference/file-formats.md),
  [auto-support preset format](reference/auto-support-preset-format.md) and the
  [command-line interface](reference/cli.md).
- [Island analysis and voxels](features/island-analysis.md) — how the scan works.

## Developer guide

Building, extending and debugging DragonFruit:

- [Architecture and conventions](dev/index.md) — the entry point, with a table of "what you
  are touching" to the pages that matter.
- [Feature frameworks](dev/experiments-framework.md). Plugins start at the
  [plugin framework](dev/plugins-framework.md).
- [Core systems and contracts](dev/history-and-undo-redo.md) — history, stores, IPC,
  hotkeys, the support system and the auto-support pipeline.
- [Slicing engine](dev/slicing-engine/index.md) — pipeline, encoders and benchmarks.
- [Data and formats](dev/data-storage.md),
  [architecture](dev/architecture-overview.md) and
  [integration and operations](dev/releases.md) — releases, Flatpak, the RTSP relay and the
  OS thumbnailers. The decision records live under **Decision Records** in the sidebar.

## Maintenance

- [Where this site is built](dev/site-and-landing.md) — the landing page, the
  documentation viewer, and the single Pages artifact they are published as.
