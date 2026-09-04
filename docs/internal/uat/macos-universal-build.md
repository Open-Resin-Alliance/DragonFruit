---
issue: df-universal-mac-build
date: 2026-05-24
kind: verification
---

# UAT: macOS universal build (Intel + Apple Silicon)

Manual verification for the single universal `.dmg` produced by
`npm run tauri:bundle:macos:universal` (and the CI macOS job). Re-run after any PR
that touches the macOS build path: `scripts/{tauri-build,tauri-bundle-all,tauri-bundle-macos-universal,build-thumbnail-providers,macos-embed-appex,verify-universal-bundle}.mjs`,
`rust/dragonfruit-voxl-thumbnail/macos-qlext/build.sh`, `src-tauri/tauri.macos.conf.json`,
the tauri rev pin, or the macOS bundling steps in `.github/workflows/release.yml`.

The automated half is `scripts/verify-universal-bundle.mjs` (fat main binary +
sidecar + `.appex`, valid signatures, valid DMG). These scenarios cover what it
cannot: that the app actually runs **natively** on each arch and that QuickLook
works on each. Build the DMG once on either host, then install the **same** file
on both Macs.

## Scenario: Runs natively on Apple Silicon

**Rationale.** A universal DMG that silently runs under Rosetta on arm64 defeats
the purpose. Activity Monitor "Kind" is the ground truth.

```gherkin
Given the universal DragonFruit_<ver>_universal.dmg (built once, on either host)
  And an Apple Silicon (M-series) Mac
When the user mounts the DMG, drags DragonFruit.app to /Applications, and launches it
  And opens a known-good fixtures/*.stl and slices it
Then the app launches and slices to valid output (layer count + bounding box within tolerance)
  And Activity Monitor → CPU → Kind shows "Apple" (NOT "Intel" / Rosetta)
  And `codesign --verify --deep --strict /Applications/DragonFruit.app` exits 0
  And Finder shows a QuickLook thumbnail for a .voxl file
```

## Scenario: Runs natively on Intel

**Rationale.** The fat `.appex` and per-arch sidecars only matter if the same DMG
also runs native on x86_64 — the QuickLook thumbnail on Intel is the proof the
`.appex` lipo actually works on the other arch.

```gherkin
Given the SAME universal DMG installed on an Intel (x86_64) Mac
When the user launches DragonFruit.app and slices the same fixture
Then the app launches and slices to valid output
  And Activity Monitor → CPU → Kind shows "Intel" (native, not the wrong slice under Rosetta)
  And `codesign --verify --deep --strict /Applications/DragonFruit.app` exits 0
  And Finder shows a QuickLook thumbnail for a .voxl file
```

> Byte-exact slice equivalence between arches is NOT asserted — SIMD code paths
> diverge between x86_64 and arm64 and that is expected.
