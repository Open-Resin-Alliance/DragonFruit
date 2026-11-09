# Flathub submission checklist

Path to listing DragonFruit on [Flathub](https://flathub.org). The v0.1.3
`.flatpak` in `dist/` is **self-hosted** only — it consumes pre-built binaries
and does not meet Flathub's reproducibility / offline-source requirements.

## Blockers (must be resolved before opening the submission PR)

All three were checked on 2026-09-30 and no longer block:

- [x] **OSS licence file published at repo root.** Flathub rejects
      submissions without a valid OSS licence file. `LICENSE` is at the root;
      it is AGPL-3.0, not the GPL-3.0 this item originally named.
- [x] **Private submodules public or vendored.** `plugins/ctb`, `plugins/elegoo`
      and `plugins/sdcp-v3` were private and checked out in CI with per-repo SSH
      deploy keys, which Flathub builders cannot use. All three are public now,
      `.gitmodules` points at them over HTTPS, and no workflow uses a deploy key.
- [x] **Public repo**. The main DragonFruit repo is public.

## Manifest work needed

Replace the fast-path manifest with a hermetic one:

- [ ] **Offline cargo sources** — generate with
      `flatpak-cargo-generator.py src-tauri/Cargo.lock -o flatpak/generated-cargo-sources.json`.
      Script lives at <https://github.com/flatpak/flatpak-builder-tools/tree/master/cargo>.
- [ ] **Offline npm sources** — generate with
      `flatpak-node-generator.py npm package-lock.json -o flatpak/generated-npm-sources.json`.
      Script lives at <https://github.com/flatpak/flatpak-builder-tools/tree/master/node>.
- [ ] **CEF tarball as `type: archive`** — pin the exact
      `cef_binary_*_linux64_minimal.tar.bz2` URL + SHA256 that `cef-dll-sys`
      downloads during its build. Spotify's CDN is generally reliable, but
      Flathub prefers a verified checksum over a runtime download.
- [ ] **Build from source** — manifest module invokes the Tauri build
      (`node scripts/tauri-build.mjs`) with `--offline` for cargo and
      `--prefer-offline` for npm, fed by the generated sources JSON files.
- [ ] **SDK extensions** enabled:
      - `org.freedesktop.Sdk.Extension.rust-stable//24.08`
      - `org.freedesktop.Sdk.Extension.node20//24.08`
      - `org.freedesktop.Sdk.Extension.llvm18//24.08`
      - Wire them via `build-options.append-path` +
        `build-options.prepend-ld-library-path`.
- [ ] **Remove `--share=network` from `finish-args` while building** — the
      build itself must be offline. The deployed app retains network access
      for printer communication.

## Metadata polish

- [ ] **Screenshots (≥3, ≥1280×720)** — commit to `docs/screenshots/flathub-*.png`
      and reference from `flatpak/org.openresinalliance.dragonfruit.metainfo.xml`
      `<screenshots>` via `raw.githubusercontent.com` URLs.
- [ ] **Translated summary / description** — optional but welcomed.
- [ ] **Release history** — fill `<releases>` with prior versions as the
      project tags them.
- [ ] **Content rating** — currently `oars-1.1` with no ratings. Review
      against the [OARS spec](https://hughsie.github.io/oars/generate.html);
      a slicer should be clean across the board.
- [ ] **Branding colours** — already set. Validate they render well in
      GNOME Software / KDE Discover previews.

## Validation

- [ ] **`appstreamcli validate --strict`** — currently passes with `--no-net`;
      needs to pass in strict mode (warnings → errors).
- [ ] **`desktop-file-validate`** — currently passes.
- [ ] **`flatpak-builder-lint manifest …`** — Flathub's own linter. Install
      via `flatpak install flathub org.flatpak.Builder//24.08`, run as
      `flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest flatpak/…yml`.
      Must report zero errors. Lints `finish-args` completeness, `app-id`
      conventions, forbidden patterns (`--filesystem=host`, SUID binaries).
- [ ] **Reproducible rebuild** — run the hermetic build twice, diff the
      resulting OSTree trees. Any non-determinism is a Flathub auto-reject.

## Submission

- [ ] Fork `flathub/flathub`
- [ ] Open PR adding a new submission under `com.<id>` — for us,
      `org.openresinalliance.dragonfruit/` containing the manifest + any
      patches
- [ ] Flathub reviewer-bot runs automated checks; human review follows
      (expect 1–4 weeks)
- [ ] Respond to review feedback
- [ ] On merge, Flathub's CI builds and publishes to the stable repo;
      listing appears on flathub.org usually within a few hours

## Things NOT to do

- ❌ Do not claim `org.openresinalliance.*` as a Flathub app-id prefix
  without owning the `openresinalliance.org` domain and proving so via
  reverse-DNS rules. If the domain isn't controlled, use
  `io.github.open-resin-alliance.dragonfruit` instead (GitHub org mapping
  is an accepted Flathub convention).
- ❌ Do not ship `--filesystem=host` or `--share=home` — instant reject.
  The current manifest does not, and should not.
- ❌ Do not use `--talk-name=*` as a wildcard. Enumerate each portal name.
- ❌ Do not add `--device=all` — only `--device=dri` is needed.

## References

- Flathub submission guide: <https://docs.flathub.org/docs/for-app-authors/submission>
- AppStream spec: <https://www.freedesktop.org/software/appstream/docs/>
- Flatpak manifest reference: <https://docs.flatpak.org/en/latest/manifests.html>
- flatpak-builder-tools: <https://github.com/flatpak/flatpak-builder-tools>
