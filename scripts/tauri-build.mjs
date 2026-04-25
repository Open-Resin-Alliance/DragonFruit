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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const isLinux = process.platform === "linux";
const extraArgs = process.argv.slice(2);

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

function rustflagsForTarget(targetTriple) {
  if (!targetTriple) return undefined;
  return targetTriple.startsWith("x86_64") ? "-C target-feature=+avx2,+fma" : undefined;
}

const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const cmdArgs = ["tauri", "build", ...extraArgs];
const hasBundlesArg = extraArgs.includes("--bundles");

if (isLinux) {
  if (!hasBundlesArg) {
    cmdArgs.push("--bundles", "deb,rpm");
  }
  cmdArgs.push("--", "--no-default-features", "--features", "custom-protocol,tauri-cef");
}

const targetTriple = process.env.CARGO_BUILD_TARGET ?? resolveDefaultTargetTriple();
const rustflags = rustflagsForTarget(targetTriple);
console.log(
  `[tauri-build] ${npxCmd} ${cmdArgs.join(" ")} (target=${targetTriple ?? "unknown"}${rustflags ? `, RUSTFLAGS=${rustflags}` : ""})`
);

const tauriEnv = {
  ...process.env,
  ...(rustflags ? { RUSTFLAGS: rustflags } : {}),
  ...(isLinux ? { APPIMAGE_EXTRACT_AND_RUN: process.env.APPIMAGE_EXTRACT_AND_RUN ?? "1" } : {}),
};

// On Windows, .cmd files cannot be spawned directly — they require the shell
// (cmd.exe) to execute them. Pass RUSTFLAGS explicitly through env so it is
// guaranteed to reach cargo/rustc regardless of inherited process.env state.
const result = spawnSync(npxCmd, cmdArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: tauriEnv,
});

// ── macOS post-build: embed QuickLook extension into Contents/PlugIns/ ───────
// Tauri has no native PlugIns/ support. We build the Swift .appex and copy it
// into the app bundle ourselves, then re-sign so the signature is valid.
if (process.platform === "darwin" && result.status === 0) {
  const qlExtDir = path.join(repoRoot, "rust", "dragonfruit-voxl-thumbnail", "macos-qlext");
  const appexSrc = path.join(qlExtDir, "build", "VoxlThumbnailExtension.appex");

  // Build the .appex (build.sh is idempotent)
  const buildResult = spawnSync("bash", ["./build.sh"], { cwd: qlExtDir, stdio: "pipe" });
  if (buildResult.status !== 0) {
    console.error("[tauri-build] .appex build failed — skipping PlugIns embed.");
    console.error(buildResult.stderr?.toString());
  } else if (!existsSync(appexSrc)) {
    console.error(`[tauri-build] .appex not found at ${appexSrc} — skipping PlugIns embed.`);
  } else {
    // Find the app bundle produced by `tauri build`
    const bundleBase = path.join(repoRoot, "src-tauri", "target");
    const searchDirs = [
      path.join(bundleBase, targetTriple ?? "", "release", "bundle", "macos"),
      path.join(bundleBase, "release", "bundle", "macos"),
    ];
    let appBundle = null;
    for (const dir of searchDirs) {
      if (!existsSync(dir)) continue;
      const appEntry = readdirSync(dir).find((f) => f.endsWith(".app"));
      if (appEntry) { appBundle = path.join(dir, appEntry); break; }
    }

    if (!appBundle) {
      console.error("[tauri-build] Could not locate .app bundle — skipping PlugIns embed.");
    } else {
      const pluginsDir = path.join(appBundle, "Contents", "PlugIns");
      const appexDst = path.join(pluginsDir, "VoxlThumbnailExtension.appex");
      mkdirSync(pluginsDir, { recursive: true });
      cpSync(appexSrc, appexDst, { recursive: true, force: true });
      // Re-sign: appex first (with sandbox entitlement), then outer bundle.
      // Use Apple Development cert if available; fall back to ad-hoc for CI.
      const identityResult = spawnSync(
        "bash", ["-c", "security find-identity -v -p codesigning 2>/dev/null | grep 'Apple Development:' | head -1 | awk '{print $2}'"],
        { encoding: "utf8" }
      );
      const signIdentity = identityResult.stdout?.trim() || "-";
      const entitlements = path.join(
        qlExtDir, "Sources", "VoxlThumbnailExtension", "VoxlThumbnailExtension.entitlements"
      );

      spawnSync("xattr", ["-rc", appexDst], { stdio: "pipe" });
      spawnSync("codesign", ["--force", "--sign", signIdentity, "--entitlements", entitlements, appexDst], { stdio: "pipe" });
      spawnSync("xattr", ["-rc", appBundle], { stdio: "pipe" });
      spawnSync("codesign", ["--force", "--sign", signIdentity, "--deep", appBundle], { stdio: "pipe" });

      // Rebuild the DMG from the updated .app — tauri created it before we
      // embedded the .appex, so the old DMG doesn't include PlugIns/.
      // Re-run bundle_dmg.sh (tauri's create-dmg wrapper) with the same args
      // tauri used, so the result is identical in layout and appearance.
      const dmgSearchDirs = [
        path.join(bundleBase, targetTriple ?? "", "release", "bundle", "dmg"),
        path.join(bundleBase, "release", "bundle", "dmg"),
      ];
      for (const dmgDir of dmgSearchDirs) {
        if (!existsSync(dmgDir)) continue;
        const dmgEntry = readdirSync(dmgDir).find((f) => f.endsWith(".dmg"));
        if (!dmgEntry) continue;
        const dmgPath = path.join(dmgDir, dmgEntry);
        const bundleDmgSh = path.join(dmgDir, "bundle_dmg.sh");
        if (!existsSync(bundleDmgSh)) break;

        const appBundleName = path.basename(appBundle); // "DragonFruit.app"
        const appName = path.basename(appBundle, ".app"); // "DragonFruit"
        const volIcon = path.join(dmgDir, "icon.icns");

        rmSync(dmgPath, { force: true });

        // Mirror the exact args tauri uses (from dmg/mod.rs). Defaults:
        //   window-size 660x400, app at (180,170), Applications link at (480,170)
        const args = [
          "--volname", appName,
          "--icon", appBundleName, "180", "170",
          "--app-drop-link", "480", "170",
          "--window-size", "660", "400",
          "--hide-extension", appBundleName,
        ];
        if (existsSync(volIcon)) {
          args.push("--volicon", volIcon);
        }
        args.push(dmgEntry, appBundleName);

        spawnSync("bash", [bundleDmgSh, ...args], {
          cwd: path.dirname(appBundle),
          stdio: "pipe",
        });
        // bundle_dmg.sh writes the DMG next to DragonFruit.app; move it to dmg/
        const producedDmg = path.join(path.dirname(appBundle), dmgEntry);
        if (existsSync(producedDmg) && producedDmg !== dmgPath) {
          cpSync(producedDmg, dmgPath);
          rmSync(producedDmg, { force: true });
        }
        console.log(`[tauri-build] Bundled DragonFruit.app + ${dmgEntry} with QuickLook extension.`);
        break;
      }
    }
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
