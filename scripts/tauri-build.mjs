/**
 * Platform-aware tauri build wrapper.
 *
 * On Linux: passes --no-default-features --features custom-protocol,tauri-cef
 * to build with CEF instead of WebKitGTK.
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
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
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

if (isLinux) {
  cmdArgs.push("--", "--no-default-features", "--features", "custom-protocol,tauri-cef");
}

const targetTriple = process.env.CARGO_BUILD_TARGET ?? resolveDefaultTargetTriple();
const rustflags = rustflagsForTarget(targetTriple);
console.log(
  `[tauri-build] ${npxCmd} ${cmdArgs.join(" ")} (target=${targetTriple ?? "unknown"}${rustflags ? `, RUSTFLAGS=${rustflags}` : ""})`
);

// On Windows, .cmd files cannot be spawned directly — they require the shell
// (cmd.exe) to execute them. Pass RUSTFLAGS explicitly through env so it is
// guaranteed to reach cargo/rustc regardless of inherited process.env state.
const result = spawnSync(npxCmd, cmdArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: rustflags ? { ...process.env, RUSTFLAGS: rustflags } : { ...process.env },
});

// ── macOS post-build: embed QuickLook extension into Contents/PlugIns/ ───────
// Tauri has no native PlugIns/ support. We build the Swift .appex and copy it
// into the app bundle ourselves, then re-sign so the signature is valid.
if (process.platform === "darwin" && result.status === 0) {
  const qlExtDir = path.join(repoRoot, "rust", "dragonfruit-voxl-thumbnail", "macos-qlext");
  const appexSrc = path.join(qlExtDir, "build", "VoxlThumbnailExtension.appex");

  // Build the .appex (build.sh is idempotent)
  console.log("[tauri-build] Building QuickLook extension (.appex)...");
  const buildResult = spawnSync("bash", ["./build.sh"], { cwd: qlExtDir, stdio: "inherit" });
  if (buildResult.status !== 0) {
    console.error("[tauri-build] .appex build failed — skipping PlugIns embed.");
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
      console.log(`[tauri-build] Embedded .appex → ${appexDst}`);

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

      console.log(`[tauri-build] Re-signing .appex (identity=${signIdentity})...`);
      spawnSync("codesign", ["--force", "--sign", signIdentity, "--entitlements", entitlements, appexDst], { stdio: "inherit" });
      console.log("[tauri-build] Re-signing app bundle...");
      spawnSync("codesign", ["--force", "--sign", signIdentity, "--deep", appBundle], { stdio: "inherit" });
      console.log("[tauri-build] PlugIns embed complete.");
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

process.exit(result.status ?? 1);
