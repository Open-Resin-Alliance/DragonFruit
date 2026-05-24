/**
 * Platform-aware tauri build wrapper.
 *
 * On Linux: passes --no-default-features --features custom-protocol,tauri-cef
 * to build with CEF instead of WebKitGTK. After a build attempt, if
 * flatpak-builder is on PATH, stages CEF libs and produces a .flatpak bundle
 * in src-tauri/target/release/bundle/flatpak/.
 *
 * On macOS/Windows: passes through to tauri build with default features (wry).
 *
 * On macOS, a post-build step embeds the QuickLook thumbnail extension
 * (VoxlThumbnailExtension.appex) into Contents/PlugIns/ of the app bundle
 * and re-signs the bundle so Finder/quicklookd can load it.
 *
 * Usage: node scripts/tauri-build.mjs [extra tauri args...]
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embedAppex } from "./macos-embed-appex.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const isLinux = process.platform === "linux";
const extraArgs = process.argv.slice(2);

// --universal (or TAURI_BUILD_UNIVERSAL=1): build a single fat
// universal-apple-darwin bundle (native on both Intel + Apple Silicon). macOS
// only. Builds manifold's C++ fat via CMAKE_OSX_ARCHITECTURES and tells
// build-thumbnail-providers.mjs to emit a universal sidecar via
// DF_BUILD_TARGET_TRIPLE.
const isUniversal = extraArgs.includes("--universal") || process.env.TAURI_BUILD_UNIVERSAL === "1";
// Strip our custom flag so it isn't forwarded to `tauri build`.
const passThroughArgs = extraArgs.filter((a) => a !== "--universal");

if (isUniversal && process.platform !== "darwin") {
  console.error("[tauri-build] --universal is macOS-only (produces a universal-apple-darwin bundle).");
  process.exit(1);
}

function resolveDefaultTargetTriple() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  return undefined;
}

const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const cmdArgs = ["tauri", "build", ...passThroughArgs];
const hasBundlesArg = passThroughArgs.includes("--bundles");

// Universal builds target universal-apple-darwin (Tauri lipos both arches)
// unless the caller already pinned an explicit --target.
if (isUniversal && !passThroughArgs.includes("--target")) {
  cmdArgs.push("--target", "universal-apple-darwin");
}

if (isLinux) {
  if (!hasBundlesArg) {
    cmdArgs.push("--bundles", "deb,rpm");
  }
  cmdArgs.push("--", "--no-default-features", "--features", "custom-protocol,tauri-cef");
}

// x86_64 codegen flags (+avx2,+fma) now live in .cargo/config.toml so they apply
// to every cargo invocation (including each arch of a universal build); no
// RUSTFLAGS env injection here (env would clobber the config entries).
const targetTriple = isUniversal
  ? "universal-apple-darwin"
  : (process.env.CARGO_BUILD_TARGET ?? resolveDefaultTargetTriple());
console.log(`[tauri-build] ${npxCmd} ${cmdArgs.join(" ")} (target=${targetTriple ?? "unknown"})`);

const tauriEnv = {
  ...process.env,
  ...(isLinux ? { APPIMAGE_EXTRACT_AND_RUN: process.env.APPIMAGE_EXTRACT_AND_RUN ?? "1" } : {}),
  // Universal: build manifold's C++ fat and tell build-thumbnail-providers.mjs
  // to emit a universal sidecar. Respect a caller-provided CMAKE_OSX_ARCHITECTURES.
  ...(isUniversal
    ? {
        CMAKE_OSX_ARCHITECTURES: process.env.CMAKE_OSX_ARCHITECTURES ?? "arm64;x86_64",
        DF_BUILD_TARGET_TRIPLE: "universal-apple-darwin",
      }
    : {}),
};

// On Windows, .cmd files cannot be spawned directly — they require the shell
// (cmd.exe) to execute them.
const result = spawnSync(npxCmd, cmdArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: tauriEnv,
});

// ── macOS post-build: embed QuickLook extension into Contents/PlugIns/ ───────
// Tauri has no native PlugIns/ support. The embed + re-sign + DMG-rebuild lives
// in macos-embed-appex.mjs so CI (which uses tauri-action, not this script) can
// run the identical sequence. Best-effort here: a dev without the QL extension
// still gets a runnable app; the universal wrapper + CI then run
// verify-universal-bundle.mjs, which hard-fails on a missing/thin/unsigned .appex.
if (process.platform === "darwin" && result.status === 0) {
  const { ok, reason } = embedAppex({ targetTriple, repoRoot });
  if (!ok) {
    console.warn(`[tauri-build] QuickLook extension not embedded: ${reason}`);
  }
}

// ── Linux post-build: produce Flatpak bundle if tooling is available ─────────
// Mirrors the macOS post-build pattern above. Detects flatpak-builder,
// appstreamcli, and desktop-file-validate on PATH. If all three are present,
// stages CEF libs, validates metadata, stages the binary + assets, runs
// flatpak-builder, and exports a single-file .flatpak bundle to
// src-tauri/target/release/bundle/flatpak/. Entirely non-fatal — if any tool
// is missing or any step fails, the Tauri build itself is unaffected.
//
// Note: we intentionally attempt Flatpak even if `tauri build` returned
// non-zero (for example, AppImage/linuxdeploy failure) so partial outputs can
// still be repackaged when the required binary artifacts exist.
if (isLinux) {
  if (result.status !== 0) {
    console.warn(
      "[tauri-build] tauri build exited non-zero; attempting Flatpak anyway if required artifacts exist.",
    );
  }

  const requiredTools = ["flatpak-builder", "appstreamcli", "desktop-file-validate"];
  const missingTools = requiredTools.filter(
    (t) => spawnSync("sh", ["-c", `command -v ${t}`], { stdio: "pipe" }).status !== 0
  );

  if (missingTools.length > 0) {
    console.log(
      `[tauri-build] ${missingTools.join(", ")} not found — skipping Flatpak bundle.`
    );
  } else {
    console.log("[tauri-build] Flatpak tooling detected — building Flatpak bundle.");

    // (b) Stage CEF libs into target/release/ (idempotent)
    const cefResult = spawnSync("bash", ["scripts/bundle-cef-libs.sh"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    if (cefResult.status !== 0) {
      console.error("[tauri-build] bundle-cef-libs.sh failed — skipping Flatpak bundle.");
      console.error(cefResult.stderr?.toString());
    } else {
      // (c) Validate metadata
      const metainfoPath = "flatpak/org.openresinalliance.dragonfruit.metainfo.xml";
      const desktopPath = "flatpak/org.openresinalliance.dragonfruit.desktop";

      const metaValid = spawnSync("appstreamcli", ["validate", "--no-net", metainfoPath], {
        cwd: repoRoot,
        stdio: "pipe",
      });
      if (metaValid.status !== 0) {
        console.error("[tauri-build] appstreamcli validate failed — skipping Flatpak bundle.");
        console.error(metaValid.stdout?.toString());
      } else {
        const desktopValid = spawnSync("desktop-file-validate", [desktopPath], {
          cwd: repoRoot,
          stdio: "pipe",
        });
        if (desktopValid.status !== 0) {
          console.error("[tauri-build] desktop-file-validate failed — skipping Flatpak bundle.");
          console.error(desktopValid.stdout?.toString());
        } else {
          // (d) Find CEF binary — we just built it, so search known paths
          const rel = path.join(repoRoot, "src-tauri", "target", "release");
          const tripleRel = path.join(
            repoRoot, "src-tauri", "target", "x86_64-unknown-linux-gnu", "release"
          );
          const binaryName = "dragonfruit-desktop";
          const binPath = [rel, tripleRel]
            .map((dir) => path.join(dir, binaryName))
            .find((p) => existsSync(p));

          if (!binPath) {
            console.error(
              `[tauri-build] ${binaryName} not found in target/release — skipping Flatpak bundle.`
            );
          } else if (!existsSync(path.join(rel, "libcef.so"))) {
            console.error("[tauri-build] libcef.so missing after CEF staging — skipping Flatpak bundle.");
          } else {
            // (e) Stage files for flatpak-builder
            const staging = path.join(repoRoot, "flatpak", "staging");
            rmSync(staging, { recursive: true, force: true });
            mkdirSync(path.join(staging, "bin"), { recursive: true });
            mkdirSync(path.join(staging, "cef"), { recursive: true });
            mkdirSync(path.join(staging, "icons"), { recursive: true });

            // Binary
            cpSync(binPath, path.join(staging, "bin", binaryName));

            // CEF blobs from target/release/
            const cefExts = [".so", ".pak", ".dat", ".bin"];
            for (const entry of readdirSync(rel)) {
              if (cefExts.some((ext) => entry.endsWith(ext))) {
                cpSync(path.join(rel, entry), path.join(staging, "cef", entry));
              }
            }
            if (existsSync(path.join(rel, "vk_swiftshader_icd.json"))) {
              cpSync(
                path.join(rel, "vk_swiftshader_icd.json"),
                path.join(staging, "cef", "vk_swiftshader_icd.json")
              );
            }
            if (existsSync(path.join(rel, "chrome-sandbox"))) {
              cpSync(path.join(rel, "chrome-sandbox"), path.join(staging, "cef", "chrome-sandbox"));
            }
            if (existsSync(path.join(rel, "locales"))) {
              cpSync(path.join(rel, "locales"), path.join(staging, "cef", "locales"), {
                recursive: true,
              });
            }

            // Flatpak metadata + launcher
            const flatpakDir = path.join(repoRoot, "flatpak");
            cpSync(path.join(flatpakDir, "launcher.sh"), path.join(staging, "launcher.sh"));
            cpSync(
              path.join(flatpakDir, "org.openresinalliance.dragonfruit.desktop"),
              path.join(staging, "org.openresinalliance.dragonfruit.desktop")
            );
            cpSync(
              path.join(flatpakDir, "org.openresinalliance.dragonfruit.metainfo.xml"),
              path.join(staging, "org.openresinalliance.dragonfruit.metainfo.xml")
            );
            cpSync(
              path.join(flatpakDir, "dragonfruit-voxl-mime.xml"),
              path.join(staging, "dragonfruit-voxl-mime.xml")
            );

            // Icons
            const iconsDir = path.join(repoRoot, "src-tauri", "icons");
            cpSync(path.join(iconsDir, "32x32.png"), path.join(staging, "icons", "32x32.png"));
            cpSync(path.join(iconsDir, "64x64.png"), path.join(staging, "icons", "64x64.png"));
            cpSync(path.join(iconsDir, "128x128.png"), path.join(staging, "icons", "128x128.png"));
            cpSync(path.join(iconsDir, "128x128@2x.png"), path.join(staging, "icons", "256x256.png"));
            cpSync(path.join(iconsDir, "icon.png"), path.join(staging, "icons", "512x512.png"));

            // (f) Run flatpak-builder
            const manifest = path.join(flatpakDir, "org.openresinalliance.dragonfruit.yml");
            const builderFlags = process.env.FLATPAK_BUILDER_FLAGS ?? "--disable-rofiles-fuse";
            const buildDirPath = path.join(flatpakDir, "build-dir");
            rmSync(buildDirPath, { recursive: true, force: true });

            console.log("[tauri-build] Running flatpak-builder...");
            const builderResult = spawnSync(
              "flatpak-builder",
              [
                "--user", "--force-clean", ...builderFlags.split(/\s+/).filter(Boolean),
                `--repo=${path.join(flatpakDir, "repo")}`,
                buildDirPath,
                manifest,
              ],
              { cwd: repoRoot, stdio: "inherit" }
            );

            if (builderResult.status !== 0) {
              console.error("[tauri-build] flatpak-builder failed — Flatpak bundle not produced.");
            } else {
              // (g) Export single-file bundle
              const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
              const version = pkg.version;
              const arch = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim() || process.arch;
              const bundleDir = path.join(rel, "bundle", "flatpak");
              mkdirSync(bundleDir, { recursive: true });
              const bundlePath = path.join(bundleDir, `dragonfruit-${version}-${arch}.flatpak`);
              const appId = "org.openresinalliance.dragonfruit";

              const exportResult = spawnSync(
                "flatpak",
                ["build-bundle", path.join(flatpakDir, "repo"), bundlePath, appId],
                { cwd: repoRoot, stdio: "inherit" }
              );

              if (exportResult.status !== 0) {
                console.error("[tauri-build] flatpak build-bundle failed.");
              } else {
                console.log(`[tauri-build] Flatpak bundle: ${bundlePath}`);
              }
            }

            // (h) Cleanup staging
            rmSync(staging, { recursive: true, force: true });
          }
        }
      }
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

process.exit(result.status ?? 1);
