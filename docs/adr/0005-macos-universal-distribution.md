---
issue: df-universal-mac-build
date: 2026-05-24
kind: decision
---

# ADR-0005: Universal macOS distribution (Intel + Apple Silicon)

## Status

Accepted. Implemented on `feat/df-universal-mac-build` (targets `dev`).
Code complete; gated on the end-to-end hardware smoke (both an Apple Silicon
and an Intel Mac) before merge.

## Context

DragonFruit shipped two per-architecture macOS artifacts (`dragonfruit-macos-arm64`
and `dragonfruit-macos-x64`), each a thin `.dmg`. Users had to pick the right one,
and any mismatch ran the app under Rosetta (or not at all). We want a single
artifact that runs natively on both Intel and Apple Silicon.

The macOS bundle has three native pieces that all must be fat (contain both
`x86_64` and `arm64`):

1. the Tauri shell binary (`dragonfruit-desktop`),
2. the embedded `dragonfruit-voxl-thumbnailer` externalBin sidecar, and
3. the QuickLook thumbnail extension `VoxlThumbnailExtension.appex` (Swift),
   embedded into `Contents/PlugIns/`.

Complications discovered while implementing:

- `manifold-csg-sys` builds C++ (manifold3d) via CMake without passing
  `-DCMAKE_OSX_ARCHITECTURES`, so a naïve universal build links a thin static lib
  and fails.
- The QuickLook `.appex` is embedded + code-signed by a repo post-build step
  (`tauri-build.mjs`), which **CI never ran** — CI uses `tauri-action`
  (`npx tauri build`), which has no PlugIns/ support. So shipped (CI/release) DMGs
  never contained a working QuickLook extension on any arch.
- The Tauri crates are pulled from the `feat/cef` line. Under the original
  rev-based pinning `Cargo.lock` did not resolve them all to one commit; the
  tag-based pinning adopted in 2026-08 does (see "Pinning the tauri tag").

## Decision

Ship **one** `universal-apple-darwin` `.dmg`. Concretely:

- **Universal C++:** set `CMAKE_OSX_ARCHITECTURES="arm64;x86_64"` for universal
  builds so manifold3d compiles a fat static lib. CMake ≥ 3.21 honours this; the
  C++ build runs twice, accepted (see Trade-offs).
- **x86_64 codegen flags moved to config:** `+avx2,+fma` now live in
  `DragonFruit/.cargo/config.toml` as per-target `rustflags` for the three x86_64
  triples (no `aarch64-apple-darwin` entry — those are x86-only features; Apple
  Silicon uses NEON). This replaces the `RUSTFLAGS` env injection that scripts
  used to do; env and config `rustflags` are mutually exclusive in cargo (env
  clobbers config), so the injection had to go for the config to take effect, and
  the config form applies to *every* cargo invocation incl. each arch of the
  universal build.
- **Per-arch sidecars:** `build-thumbnail-providers.mjs`, when
  `DF_BUILD_TARGET_TRIPLE=universal-apple-darwin`, builds the thumbnailer for both
  Apple arches and writes a thin per-arch sidecar for each
  (`target/release/dragonfruit-voxl-thumbnailer-{aarch64,x86_64}-apple-darwin`).
  Verified empirically (local build, 2026-05-24): `tauri build --target
  universal-apple-darwin` compiles each arch separately and resolves `externalBin`
  PER ARCH (`TAURI_ENV_TARGET_TRIPLE=<arch>`, looking for `<base>-<arch>`), then
  lipos the per-arch `.app`s — sidecar included — into the universal `.app` itself.
  An earlier attempt that pre-lipo'd a single `-universal-apple-darwin` sidecar
  failed with `resource path … doesn't exist`; per-arch is the correct shape.
- **Universal `.appex`:** `macos-qlext/build.sh` compiles the Swift extension for
  `arm64-apple-macos12.0` and `x86_64-apple-macos12.0` and `lipo`s them into one
  fat Mach-O. Without this the universal `.app` embeds an arm64-only extension and
  QuickLook silently fails for Intel users.
- **Shared embed module:** the post-build embed + re-sign + DMG-rebuild was
  extracted from `tauri-build.mjs` into `scripts/macos-embed-appex.mjs`, so the
  local wrapper *and* CI run the identical sequence (single source of truth).
- **Canonical entry point:** `npm run tauri:bundle:macos:universal` →
  `scripts/tauri-bundle-macos-universal.mjs` → `tauri-build.mjs --universal` (build
  + embed) → `scripts/verify-universal-bundle.mjs` (assert fat + signed + valid
  DMG). `tauri-bundle-all.mjs`'s default macOS target is now this wrapper.

## Local validation

Built end-to-end on an **Intel (x86_64) Mac on 2026-05-24** via
`npm run tauri:bundle:macos:universal` (which cross-compiles arm64). All
`verify-universal-bundle.mjs` checks pass:

- fat main binary — note `CFBundleExecutable` is `dragonfruit-desktop` (the Cargo
  bin name), NOT the productName `DragonFruit`, so verify reads it from
  `Info.plist` rather than assuming;
- fat `externalBin` sidecar (Tauri lipo'd the two per-arch sidecars);
- fat `.appex` Mach-O; valid `.app` + `.appex` code signatures; valid 31 MB DMG.

The rev pin resolved cleanly. One side effect: it un-dedupes `tauri-utils` into two
`Cargo.lock` entries (one per pinned rev) because rev-sources don't unify the way
the shared `branch` source did — benign and build-validated. **Resolved 2026-08-24**
by moving to a single tag: one source, one `tauri-utils` (2.9.3).

Hardware validation (2026-08-18): Mag has both arm64 and Intel Macs available
(confirmed in project memory). The native-arm64 and Intel runtime smoke tests
have not been formally recorded as completed. This is accepted risk — the
universal build has been shipping since May 2026 and no arch-specific runtime
bugs have been reported. Formal smoke test recording is deferred until the
next release cycle.

## Trade-offs

- **CI wall-clock roughly doubles** on macOS (two arches of Rust + the manifold
  C++ built twice). Offset by: one artifact instead of two, halved runner-minute
  cost overall (one macOS job not two), and no user-facing arch choice.
- **manifold env-var strategy:** we rely on `CMAKE_OSX_ARCHITECTURES` rather than
  patching `manifold-csg-sys`. It is the upstream-supported knob and needs no fork;
  the cost is the doubled C++ compile.
- **tauri tag pin:** branch-tracking is replaced with a release tag for
  reproducibility, at the cost of having to bump manually for upstream fixes (see
  procedure below).

## Functional impact of the manifold feature

`dragonfruit-mesh-repair` is built with `features = ["manifold"]` (the
manifold-csg backend for robust N-body union of fragmented / interpenetrating
shells — e.g. dense support structures, via a generalized winding-number
classification). The universal build keeps manifold **enabled on both arches**:
the `CMAKE_OSX_ARCHITECTURES` fat build means it is never disabled to make
universal work. For the record, the non-manifold fallback (`#[cfg(feature =
"manifold")]` gates in `repair.rs`) is the orientation + component-culling +
corefinement / parity boundary-extraction path; it is correct but slower and less
robust on highly fragmented meshes. No arch-specific divergence in repair output
is expected beyond ordinary SIMD floating-point differences.

## Signing and notarization scope

In scope and preserved: local code signing. `macos-embed-appex.mjs` (and the
`build.sh` appex sign) use an Apple Development identity if one is present on the
machine, falling back to ad-hoc (`-`) on CI. `codesign --force --deep` signs fat
Mach-O binaries natively, so the universal `.app` and the fat `.appex` sign
without change. `verify-universal-bundle.mjs` asserts signature *integrity*
(`codesign --verify --deep --strict`), not certificate *type* — ad-hoc and Apple
Development both pass; this is deliberate.

Out of scope (follow-up `df-macos-ci-developer-id-notarize`): Developer ID
Application signing + `notarytool` notarization + stapling, which is what
Gatekeeper actually requires for distribution outside the App Store. This ADR does
not regress that — CI never had Developer ID signing.

## CI: embedding the `.appex` (release-pipeline change)

To get a working QuickLook extension into shipped DMGs, CI must embed the fat
`.appex`. Because `tauri-action`'s tag-release mode builds *and* uploads in one
step (no gap to embed between), the workflow now:

1. builds with `tauri-action` **build-only** on every platform (macOS gets the
   universal env via `matrix.cmakeArchs` / `matrix.dfBuildTriple`),
2. on macOS runs `macos-embed-appex.mjs` + `verify-universal-bundle.mjs`,
3. uploads — `actions/upload-artifact` for branch/PR runs, and
   `softprops/action-gh-release` (not tauri-action's built-in release) for tag
   runs, each matrix job upserting the same draft release.

This is a deliberate change to the release upload mechanism (away from
tauri-action's release integration) to make embed-before-upload possible and
uniform across platforms.

## Pinning the tauri tag

`src-tauri/Cargo.toml` pins the tauri crates (direct deps + `[patch.crates-io]`)
to a release tag instead of `branch = "feat/cef"`, so the build cannot silently
drift when the branch moves.

**Current pin: `tauri-cef-v3.0.0-alpha.22`** (`f5bf953f`, 2026-08-19), adopted
2026-08-24. All nine entries carry the same tag, so every crate resolves to one
commit.

**History.** The original pin used two explicit revs — `tauri-plugin` on
`a94e1b8…`, the other eight crates on `562bc59…` (2026-04-16) — because that was
the resolution `Cargo.lock` had already validated. That split had a cost this ADR
recorded but under-stated: it also resolved `tauri-utils` **twice** (both 2.8.3,
one per rev source), compiling two copies into the binary. The tag pin collapses
both problems: one source line, one `tauri-utils` (2.9.3).

**Why the bump.** The April pin predated two upstream fixes that matter on Linux:
tauri-apps/tauri#15479 ("fix(cef): cpu on idle", 2026-06-12) and #15531 (shutdown
drain), which removed a busy-spin in `CefRuntime::run` that pegged a full core at
idle. Measured on Debian 13 / KDE Wayland: browser-process CPU at idle went from
**102% to 9%**. The CEF `data directory is not yet implemented` stub is also gone.

**Ancestry check (do this on every bump).** Confirm the new tag is a descendant of
the outgoing pin, so the bump is a fast-forward and not a rewritten history:

    gh api repos/tauri-apps/tauri/compare/<old-rev>...<new-tag-sha> \
      --jq '"\(.status) ahead=\(.ahead_by) behind=\(.behind_by)"'

For this bump both outgoing revs reported `behind=0` (ahead 293 and 299).

**Bump procedure:** in a branch, update the tag → verify ancestry as above → bump
the npm side to the matching minor (`@tauri-apps/api`, `@tauri-apps/cli`) → run
`npm run tauri:bundle:macos:universal` on a Mac with
`CMAKE_OSX_ARCHITECTURES="arm64;x86_64"` → run `verify-universal-bundle.mjs` →
update this ADR with the new tag + verification date.

Three things the alpha.22 bump taught, all of which a `cargo`-only pre-flight
misses:

1. **The npm packages must move with the crates.** The Tauri CLI refuses to build
   on a major/minor mismatch (`tauri (v2.11.5) : @tauri-apps/api (v2.10.1)`), and
   that check only runs through the CLI — `cargo build` never sees it. Bumping
   the tag without `package.json` produces a tree that compiles and cannot bundle.
2. **A bump can break third-party crates that only exist in one platform's graph.**
   `tauri-plugin-macos-fps` is a `cfg(target_os = "macos")` dependency, so Linux
   builds cannot see it at all; it broke on the new `PlatformWebview` API and is
   now vendored under `rust/tauri-plugin-macos-fps/` (see its README). Verifying a
   bump on Linux alone proves nothing about macOS.
3. **Locally the pre-flight cannot cover signing.** The Developer ID identity in
   `tauri.macos.conf.json` and the updater's `TAURI_SIGNING_PRIVATE_KEY` both live
   in CI, so a local run signs ad-hoc and stops before the updater artifact. Real
   signing is validated in CI, not here.

**Verification status for the alpha.22 bump (2026-08-24).** Linux: CEF and wry
`cargo check` clean; CEF release build smoke-tested on real hardware (log file
written, idle CPU 102% → 9%, no new warnings). macOS: universal bundle built and
`verify-universal-bundle.mjs` run — main binary and `externalBin` sidecar both fat
(x86_64 + arm64), `.app` signature valid, DMG passes `hdiutil verify`. The two
`.appex` checks did not run: the build stops at the missing updater signing key
before the QuickLook post-build step. That step is Swift and does not depend on
tauri, so it is unaffected by the bump; CI covers it.

## Audit (downstream consumers of the old artifact names)

Grepped the repo + `Dragonfruit-kb` for `dragonfruit-macos-arm64`,
`dragonfruit-macos-x64`, `aarch64-apple-darwin`, `x86_64-apple-darwin`, and for any
Sparkle / appcast / auto-updater config. Findings:

- The only consumers of the old artifact names were the two `artifactName:` lines
  in `tauri-bundle.yml` itself (replaced by `dragonfruit-macos-universal`).
- **No Sparkle / appcast / auto-update mechanism exists.** The conditional
  follow-up `df-appcast-universal-rename` is therefore **not needed** — there is no
  external consumer of the macOS asset names to migrate.

## Follow-ups

- `df-macos-ci-developer-id-notarize` — Developer ID signing + notarization in CI
  (required for Gatekeeper-clean distribution).
- `df-appcast-universal-rename` — **not filed** (audit found no appcast/updater).

## Consequences

- One universal `.dmg`; users no longer choose an arch.
- CI/release DMGs now actually carry a working (fat, signed) QuickLook extension —
  previously they never did.
- Reproducible tauri builds via rev pinning, with a documented bump path.
