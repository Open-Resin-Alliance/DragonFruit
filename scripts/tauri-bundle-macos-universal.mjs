/**
 * Build the canonical universal (Intel x86_64 + Apple Silicon arm64) macOS
 * bundle — a single fat .dmg that runs natively on both.
 *
 * Thin entry point that composes the existing pieces; it duplicates no build or
 * assertion logic:
 *   1. sets the universal build env (CMAKE_OSX_ARCHITECTURES so manifold's C++
 *      links fat; DF_BUILD_TARGET_TRIPLE so build-thumbnail-providers.mjs emits a
 *      universal sidecar),
 *   2. routes through scripts/tauri-build.mjs --universal — NOT `npx tauri build`
 *      directly — so the macOS post-build runs (QuickLook .appex embed + codesign
 *      of the .app and .appex + DMG rebuild),
 *   3. on success, runs scripts/verify-universal-bundle.mjs to assert the bundle
 *      is actually fat + signed; on build failure it propagates the status and
 *      skips verification.
 *
 * macOS only (cross-compiles both arches from either host arch).
 *
 * Usage: npm run tauri:bundle:macos:universal
 *        node scripts/tauri-bundle-macos-universal.mjs
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.platform !== "darwin") {
  console.error("[bundle:macos:universal] macOS-only — run on a Mac (cross-compiles both arches).");
  process.exit(1);
}

const env = {
  ...process.env,
  CMAKE_OSX_ARCHITECTURES: process.env.CMAKE_OSX_ARCHITECTURES ?? "arm64;x86_64",
  DF_BUILD_TARGET_TRIPLE: "universal-apple-darwin",
};

const build = spawnSync(
  "node",
  [path.join(__dirname, "tauri-build.mjs"), "--universal", "--bundles", "app,dmg"],
  { stdio: "inherit", env }
);
if (build.status !== 0) {
  console.error(`[bundle:macos:universal] build failed (status ${build.status}); skipping verification.`);
  process.exit(build.status ?? 1);
}

const verify = spawnSync(
  "node",
  [path.join(__dirname, "verify-universal-bundle.mjs")],
  { stdio: "inherit", env }
);
process.exit(verify.status ?? 1);
