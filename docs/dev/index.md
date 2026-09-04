# Developer Guide

Internals of DragonFruit, for people changing them. Start with [Architecture Overview](architecture-overview.md) — it says which of the four codebases your change belongs in — then come back here for the page that covers it.

## By what you are doing

| You want to… | Read |
| ------------ | ---- |
| Understand the shape of the whole thing | [Architecture Overview](architecture-overview.md) |
| Add a UI feature with state | [State and Stores](state-and-stores.md), [Registration Seams](registration-seams.md) |
| Make something undoable | [History and Undo/Redo](history-and-undo-redo.md) |
| Show the user a message | [Notifications and Toasts](notifications.md) |
| Bind a key | [Hotkeys](hotkeys.md), [Support Placement Modifiers](../reference/support-placement-modifiers.md) |
| Call native code | [Tauri IPC and Native Bridge](tauri-ipc-bridge.md) |
| Ship something unfinished | [Experiments Framework](experiments-framework.md) |
| Support a new printer or format | [Plugin Framework](plugins-framework.md), [Complex Plugin Contributing](plugins-complex-contributing.md), [Formats](formats.md) |
| Change automatic support placement | [Auto-Supports](auto-supports.md) |
| Add a support type | [Adding a New Support Type](support-type-extension.md), [Support System](support-system.md) |
| Touch slicing or the raster pipeline | [ADR-0036](../adr/0036-stream-ctb-layer-payloads-to-disk.md), and the 3DAA vocabulary in `CONTEXT.md` |
| Add a config file | [Config Schemas](config-schemas.md) |
| Persist something | [Data Storage](data-storage.md), [VOXL Format Spec](voxl-format-spec.md) |
| Cut a release | [Release Process](releases.md) |
| Write or change docs | [Contributing](contributing.md) |

## Ground rules

Three that are easy to get wrong and fail silently:

1. **Register history handlers at app-root lifetime.** Gate them on a component and Ctrl+Z stops working depending on what is on screen — with no error.
2. **Interpolating translations live in module-scope helpers.** React Compiler renames locals in production builds, desyncing the message id; dev looks fine. See [Backlog](backlog.md).
3. **Bump a `rust/` crate's version when you change it.** Path dependencies always resolve, so a stale version is invisible locally and breaks the lock file. See `AGENTS.md`.

## Keeping these pages true

`npm run check:docs` verifies that every path and symbol these pages cite still exists, bans pinned line numbers, and keeps the MkDocs nav in sync. It runs in CI. What it cannot check is whether a page's *description of behaviour* is still right — that needs a human reading the code beside the page, and it is where every real error found so far has been.

New developer-facing interfaces ship with documentation here; that rule and its checklist are in `AGENTS.md`.

## Decision records

[`docs/adr/`](../adr/0036-stream-ctb-layer-payloads-to-disk.md) records load-bearing choices and, as importantly, what was ruled out and why — so a closed road is not walked twice.
