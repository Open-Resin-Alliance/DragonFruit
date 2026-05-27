/**
 * Embed the QuickLook thumbnail extension (VoxlThumbnailExtension.appex) into a
 * macOS .app bundle, re-sign the bundle, and rebuild the DMG so the shipped
 * disk image actually contains the extension.
 *
 * Why this is a standalone module:
 *   Tauri has no native Contents/PlugIns/ support, so this repo does the embed
 *   + re-sign + DMG rebuild as a post-build step. Two callers need that exact
 *   sequence and must not duplicate it:
 *     1. scripts/tauri-build.mjs   — the local build wrapper (best-effort: a dev
 *        without the QL extension still gets a runnable app).
 *     2. .github/workflows/tauri-bundle.yml — CI uses tauri-action (`npx tauri`)
 *        which never runs tauri-build.mjs, so CI invokes this script directly
 *        after the build (strict: a missing/failed embed must fail the build).
 *
 * The .appex itself is built universal (fat arm64 + x86_64) by
 * rust/dragonfruit-voxl-thumbnail/macos-qlext/build.sh, so embedding it into a
 * universal .app keeps QuickLook thumbnails working on both Intel and Apple
 * Silicon. `codesign --force --deep` signs fat Mach-O binaries natively.
 *
 * Usage (import):     import { embedAppex } from "./macos-embed-appex.mjs";
 *                     const { ok, reason } = embedAppex({ targetTriple });
 * Usage (standalone): node scripts/macos-embed-appex.mjs --target <triple>
 *                     (exits non-zero if the embed could not be completed)
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Embed + re-sign + rebuild-DMG. Returns { ok, reason } rather than throwing so
 * the local wrapper can stay best-effort while CI treats !ok as fatal.
 *
 * @param {object} opts
 * @param {string} [opts.targetTriple] Rust target triple the bundle was built
 *   for (e.g. "universal-apple-darwin"). Used to locate target/<triple>/release.
 * @param {string} [opts.repoRoot] Repository root (defaults to scripts/..).
 * @returns {{ ok: boolean, reason?: string }}
 */
export function embedAppex({ targetTriple, repoRoot = DEFAULT_REPO_ROOT } = {}) {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "not macOS — embed is a darwin-only step" };
  }

  const qlExtDir = path.join(repoRoot, "rust", "dragonfruit-voxl-thumbnail", "macos-qlext");
  const appexSrc = path.join(qlExtDir, "build", "VoxlThumbnailExtension.appex");

  // Build the .appex (build.sh is idempotent and produces a fat binary).
  const buildResult = spawnSync("bash", ["./build.sh"], { cwd: qlExtDir, stdio: "pipe" });
  if (buildResult.status !== 0) {
    console.error("[embed-appex] .appex build failed.");
    console.error(buildResult.stderr?.toString());
    return { ok: false, reason: "build.sh failed" };
  }
  if (!existsSync(appexSrc)) {
    return { ok: false, reason: `.appex not found at ${appexSrc}` };
  }

  // Find the .app bundle produced by `tauri build`. For an explicit --target
  // (incl. universal-apple-darwin) the bundle lives under target/<triple>/...;
  // for a host-default build it lives under target/release/...
  const bundleBase = path.join(repoRoot, "src-tauri", "target");
  const searchDirs = [
    path.join(bundleBase, targetTriple ?? "", "release", "bundle", "macos"),
    path.join(bundleBase, "release", "bundle", "macos"),
  ];
  let appBundle = null;
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const appEntry = readdirSync(dir).find((f) => f.endsWith(".app"));
    if (appEntry) {
      appBundle = path.join(dir, appEntry);
      break;
    }
  }
  if (!appBundle) {
    return { ok: false, reason: "could not locate .app bundle" };
  }

  // Embed the .appex into Contents/PlugIns/.
  const pluginsDir = path.join(appBundle, "Contents", "PlugIns");
  const appexDst = path.join(pluginsDir, "VoxlThumbnailExtension.appex");
  mkdirSync(pluginsDir, { recursive: true });
  cpSync(appexSrc, appexDst, { recursive: true, force: true });

  // Re-sign: appex first (with sandbox entitlement), then the outer bundle.
  // Use an Apple Development cert if one is available (gives the extension a
  // Team ID so the QL system will load it); fall back to ad-hoc ("-") on CI.
  const identityResult = spawnSync(
    "bash",
    ["-c", "security find-identity -v -p codesigning 2>/dev/null | grep 'Apple Development:' | head -1 | awk '{print $2}'"],
    { encoding: "utf8" }
  );
  const signIdentity = identityResult.stdout?.trim() || "-";
  const entitlements = path.join(
    qlExtDir, "Sources", "VoxlThumbnailExtension", "VoxlThumbnailExtension.entitlements"
  );

  // codesign failures are fatal: a silently-unsigned bundle (the QL system won't
  // load an unsigned extension, and Gatekeeper rejects an unsigned app) is worse
  // than a loud failure. xattr -rc is best-effort (it can fail benignly when
  // there are no extended attributes to clear).
  spawnSync("xattr", ["-rc", appexDst], { stdio: "pipe" });
  const signAppex = spawnSync(
    "codesign",
    ["--force", "--sign", signIdentity, "--entitlements", entitlements, appexDst],
    { encoding: "utf8" }
  );
  if (signAppex.status !== 0) {
    return { ok: false, reason: `codesign of .appex failed: ${(signAppex.stderr || "").trim()}` };
  }
  spawnSync("xattr", ["-rc", appBundle], { stdio: "pipe" });
  const signApp = spawnSync(
    "codesign",
    ["--force", "--sign", signIdentity, "--deep", appBundle],
    { encoding: "utf8" }
  );
  if (signApp.status !== 0) {
    return { ok: false, reason: `codesign of .app failed: ${(signApp.stderr || "").trim()}` };
  }

  // Rebuild the DMG from the updated .app — tauri created it before we embedded
  // the .appex, so the old DMG doesn't include PlugIns/. Re-run bundle_dmg.sh
  // (tauri's create-dmg wrapper) with the same args tauri used, so the result is
  // identical in layout and appearance.
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
    const backupDmgPath = `${dmgPath}.bak`;

    const appBundleName = path.basename(appBundle); // "DragonFruit.app"
    const appName = path.basename(appBundle, ".app"); // "DragonFruit"
    const volIcon = path.join(dmgDir, "icon.icns");

    // Keep the last-good DMG until we have a replacement. If both rebuild
    // paths fail, restore it so the bundle is still usable for inspection.
    rmSync(backupDmgPath, { force: true });
    renameSync(dmgPath, backupDmgPath);

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

    const dmgResult = spawnSync("bash", [bundleDmgSh, ...args], {
      cwd: path.dirname(appBundle),
      stdio: "pipe",
    });
    const producedDmg = path.join(path.dirname(appBundle), dmgEntry);

    if (dmgResult.status === 0 && existsSync(producedDmg)) {
      if (producedDmg !== dmgPath) {
        cpSync(producedDmg, dmgPath);
        rmSync(producedDmg, { force: true });
      }
      rmSync(backupDmgPath, { force: true });
      console.log(`[embed-appex] Bundled ${appBundleName} + ${dmgEntry} with QuickLook extension.`);
      break;
    }

    // Fallback: build a plain DMG without the Finder/AppleScript layout step.
    // This avoids the statusbar AppleScript failure in headless or restricted
    // environments while still shipping a valid disk image.
    rmSync(dmgPath, { force: true });
    const fallbackDmg = spawnSync(
      "hdiutil",
      [
        "create",
        "-ov",
        "-format",
        "UDZO",
        "-volname",
        appName,
        "-srcfolder",
        appBundle,
        dmgPath,
      ],
      { encoding: "utf8" }
    );
    if (fallbackDmg.status === 0 && existsSync(dmgPath)) {
      rmSync(backupDmgPath, { force: true });
      console.warn(
        `[embed-appex] bundle_dmg.sh failed; fell back to a plain DMG (${path.basename(dmgPath)}).`
      );
      break;
    }

    renameSync(backupDmgPath, dmgPath);
    return {
      ok: false,
      reason:
        `DMG rebuild failed (bundle_dmg.sh status ${dmgResult.status}, fallback status ${fallbackDmg.status}): ` +
        `${(dmgResult.stderr?.toString() || "").trim()}${fallbackDmg.stderr ? ` | ${fallbackDmg.stderr.trim()}` : ""}`,
    };
  }

  return { ok: true };
}

// ── Standalone CLI ───────────────────────────────────────────────────────────
// Run directly (e.g. from CI after tauri-action) — strict: exit non-zero if the
// embed could not be completed, so a broken QuickLook extension fails the build.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const targetIdx = argv.indexOf("--target");
  const targetTriple = targetIdx !== -1 ? argv[targetIdx + 1] : process.env.DF_BUILD_TARGET_TRIPLE;

  const { ok, reason } = embedAppex({ targetTriple });
  if (!ok) {
    console.error(`[embed-appex] FAILED: ${reason}`);
    process.exit(1);
  }
  console.log("[embed-appex] QuickLook extension embedded and bundle re-signed.");
}
