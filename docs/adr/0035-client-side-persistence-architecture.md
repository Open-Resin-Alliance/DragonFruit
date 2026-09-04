---
issue: dragonfruit-kb-harvest-2026-08
date: 2026-08-18
kind: pattern
---

# ADR-0035: Client-side persistence architecture

## Context

DragonFruit is a Tauri desktop app whose UI runs in a webview. User settings,
layout state, profile data, and caches must survive across sessions. Because
the webview provides standard Web Storage and IndexedDB APIs — and Tauri's
Rust side handles file-system operations (VOXL autosave, scene files) — the
persistence stack splits naturally into a web-storage tier for settings and a
file-system tier for scene data.

Over time, 50+ storage keys accumulated across localStorage, sessionStorage,
and IndexedDB, spanning three naming eras. This ADR captures the architectural
pattern, not the full key catalog (that lives in the in-repo source of truth).

## Decision

**1. Three storage tiers, each with a defined role.**

| Tier | Use | Lifecycle |
|------|-----|-----------|
| `localStorage` | Persistent settings and feature state (support parameters, theme, camera, profiles, backup config) | Survives until explicit clear |
| `sessionStorage` | Transient session fallback for slicing/profile selections that should reset on app restart | Cleared on window close |
| IndexedDB (`dragonfruit-recent-files`, version 1, store `files`) | Binary payload cache for recently opened file data | Persistent; metadata index in `app-recent-opened-files` (localStorage) |

Slicing settings that span both tiers (e.g. `dragonfruit.slicing.aaLevel`)
write to localStorage for persistence and sessionStorage for session override
— sessionStorage wins when present, falling back to localStorage.

**2. Namespace conventions.**

| Prefix | Era | Status |
|--------|-----|--------|
| `app-*` | Current | UI, layout, view settings |
| `dragonfruit-*` / `dragonfruit.*` | Current | Product/feature-scoped data |
| `lumenslicer:*` | Legacy (pre-rename) | Retained for compatibility — must not be removed without migration |
| Unprefixed (`autoLift`, `liftDistance`) | Legacy debt | Treat as frozen — new keys must be namespaced |

**3. Versioned keys for schema evolution.** Keys that carry structured data
use a `-v1` / `-v2` suffix (e.g. `support-presets-v1`,
`dragonfruit-profiles-v1`). On schema change, a new versioned key is created
with a migration read-path from the old key. The old key is deprecated but not
deleted, so a downgrade falls back gracefully.

**4. Backup envelope for profiles.** Profile data
(`dragonfruit-profiles-v1`) has a companion `dragonfruit-profiles-v1-backup`
key for crash recovery. Backup sync (both GitHub and local filesystem)
operates through dedicated key families (`dragonfruit-backups:*` and
`dragonfruit-local-backups:*`) with client identity, interval, and
last-sync tracking. Auth state uses secure cookies and server-side endpoints,
never web storage.

**5. Window geometry persistence.** Window position and size are persisted by
the Tauri shell (not web storage) via the `window.persist_position` and
`window.persist_size` Tauri APIs, restoring on launch including multi-monitor
placement.

**6. Autosave path recovery.** Scene autosave writes beside the project file
(Tauri filesystem, not web storage). Settings controlling autosave behavior
live in `dragonfruit-scene-autosave:settings-v1` (localStorage). Path recovery
on crash-restart is handled by Tauri-side file scanning, not by web storage
lookups.

## Consequences

- Every new persisted key must use a namespaced prefix and be documented in
  `docs/dev/data-storage.md` in the same PR.
- Schema changes to structured keys require a new version suffix and a
  migration path — never mutate an existing versioned key's shape in place.
- The `lumenslicer:*` namespace is frozen — needed for users upgrading from
  pre-rename builds. Removing any key without a migration is a silent data
  loss bug.
- Secrets (tokens, API keys) must never appear in web storage — use
  environment variables, server-side endpoints, or secure cookies.
- The IndexedDB store is a cache, not a source of truth — the metadata index
  in localStorage is authoritative for the recent-files list.

## References

- Full key catalog: `docs/dev/data-storage.md` (in-repo, 50+ keys)
- Window geometry: commit `deb1e742`
- Autosave: ADR-0005 (macOS distribution context), UAT `autosave-restore.md`
- Profile backup: `dragonfruit-backups:*` key family in data-storage.md
