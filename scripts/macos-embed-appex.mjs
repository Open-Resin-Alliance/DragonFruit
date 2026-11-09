/**
 * Check that the QuickLook thumbnail extension (VoxlThumbnailExtension.appex)
 * made it into the macOS .app bundle, signed, and that a Developer ID build is
 * still notarized with the extension inside. Then notarize the DMG, the one
 * piece Tauri signs but does not notarize.
 *
 * The embedding itself is Tauri's now. `bundle.macOS.files` in
 * src-tauri/tauri.macos.conf.json copies the .appex into Contents/PlugIns/
 * before Tauri signs the .app, `build.beforeBundleCommand` builds it (fat
 * arm64 + x86_64) and gives it its one signature first, and Tauri then signs,
 * notarizes and staples the .app with the extension already in it. So the
 * DMG and the updater's .app.tar.gz are cut from the same bundle, and nothing
 * is signed or notarized twice.
 *
 * It used to be done here, after `tauri build`: copy the .appex in, re-sign
 * the .app, re-notarize it, rebuild and notarize the DMG. That threw away the
 * signature and notarization Tauri had just made, and the updater archive,
 * which Tauri writes before this step ran, shipped without the extension, so
 * an in-app update removed QuickLook thumbnails.
 *
 * The DMG still needs its own notarization. A signed DMG holding a notarized,
 * stapled .app is not enough: Gatekeeper assesses the disk image itself when a
 * downloaded one is opened, and `spctl -a -t open --context
 * context:primary-signature` rejects a quarantined one as "Unnotarized
 * Developer ID".
 *
 * The file keeps its name because the release, preview and PR-check workflows
 * call it by path, and a workflow that runs from `dev` may still call it while
 * a branch is being built.
 *
 * Usage (import):     import { verifyEmbeddedAppex, notarizeDmg } from "./macos-embed-appex.mjs";
 *                     const { ok, reason } = verifyEmbeddedAppex({ targetTriple });
 * Usage (standalone): node scripts/macos-embed-appex.mjs --target <triple>
 *                     (exits non-zero if the extension is missing or unsigned,
 *                     or the DMG could not be notarized)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

/**
 * @param {object} opts
 * @param {string} [opts.targetTriple] Rust target triple the bundle was built
 *   for (e.g. "universal-apple-darwin"). Used to locate target/<triple>/release.
 * @param {string} [opts.repoRoot] Repository root (defaults to scripts/..).
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifyEmbeddedAppex({ targetTriple, repoRoot = DEFAULT_REPO_ROOT } = {}) {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "not macOS — the QuickLook extension is darwin-only" };
  }

  const appBundle = findBundleOutput({ targetTriple, repoRoot, kind: "macos", ext: ".app" });
  if (!appBundle) {
    return { ok: false, reason: "could not locate .app bundle" };
  }

  const appex = path.join(appBundle, "Contents", "PlugIns", "VoxlThumbnailExtension.appex");
  if (!existsSync(appex)) {
    return { ok: false, reason: `${path.relative(repoRoot, appex)} is missing` };
  }

  // --strict on the .app also checks every nested signature it seals, so a
  // .appex that went in unsigned, or changed after Tauri signed around it,
  // fails here.
  for (const target of [appex, appBundle]) {
    const verify = spawnSync("codesign", ["--verify", "--strict", "--verbose=2", target], { encoding: "utf8" });
    if (verify.status !== 0) {
      return { ok: false, reason: `codesign --verify failed for ${path.basename(target)}: ${(verify.stderr || "").trim()}` };
    }
  }

  // The updater archive replaces the whole .app on an in-app update, so one
  // without the extension takes QuickLook thumbnails away from everyone who
  // updates. It only exists when updater signing is configured.
  const updaterArchive = `${appBundle}.tar.gz`;
  if (existsSync(updaterArchive)) {
    const list = spawnSync("tar", ["-tzf", updaterArchive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    // Tauri writes directory entries without a trailing slash, so match the prefix.
    const entry = `${path.basename(appBundle)}/Contents/PlugIns/VoxlThumbnailExtension.appex`;
    if (list.status !== 0 || !list.stdout.split("\n").some((line) => line.startsWith(entry))) {
      return { ok: false, reason: `${path.basename(updaterArchive)} does not contain ${entry}` };
    }
  }

  // Tauri notarizes when the notary credentials are in the environment, so the
  // ticket must be there too. Without them (PR checks, local builds) there is
  // nothing to validate.
  if (readNotaryCredentials()) {
    const staple = spawnSync("xcrun", ["stapler", "validate", appBundle], { encoding: "utf8" });
    if (staple.status !== 0) {
      return { ok: false, reason: `no valid notarization ticket stapled to ${path.basename(appBundle)}: ${(staple.stdout || staple.stderr || "").trim()}` };
    }
  }

  return { ok: true };
}

/**
 * Notarizes and staples the DMG Tauri built, when the notary credentials are in
 * the environment (the same condition under which Tauri notarized the .app).
 * Without them there is nothing to do: PR checks and local builds ship nothing.
 *
 * @param {object} opts
 * @param {string} [opts.targetTriple]
 * @param {string} [opts.repoRoot]
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string }}
 */
export function notarizeDmg({ targetTriple, repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const credentials = readNotaryCredentials();
  if (!credentials) return { ok: true, skipped: true };

  const dmg = findBundleOutput({ targetTriple, repoRoot, kind: "dmg", ext: ".dmg" });
  if (!dmg) return { ok: false, reason: "could not locate the .dmg to notarize" };

  const submit = spawnSync(
    "xcrun",
    [
      "notarytool", "submit", dmg,
      "--apple-id", credentials.appleId,
      "--password", credentials.applePassword,
      "--team-id", credentials.appleTeamId,
      "--wait",
    ],
    { encoding: "utf8" }
  );
  if (submit.status !== 0 || !/status: Accepted/.test(submit.stdout || "")) {
    // "Invalid"/"Rejected" from notarytool submit never says why; the reason
    // only shows up in the per-submission log, so fetch it here.
    let detail = "";
    const idMatch = /id: ([0-9a-f-]{36})/.exec(submit.stdout || "");
    if (idMatch) {
      const log = spawnSync(
        "xcrun",
        [
          "notarytool", "log", idMatch[1],
          "--apple-id", credentials.appleId,
          "--password", credentials.applePassword,
          "--team-id", credentials.appleTeamId,
        ],
        { encoding: "utf8" }
      );
      if (log.stdout) detail = `\nnotarytool log:\n${log.stdout.trim()}`;
    }
    return {
      ok: false,
      reason: `notarytool submit failed for ${path.basename(dmg)}: ${`${submit.stdout || ""} ${submit.stderr || ""}`.trim()}${detail}`,
    };
  }

  const staple = spawnSync("xcrun", ["stapler", "staple", dmg], { encoding: "utf8" });
  if (staple.status !== 0) {
    return { ok: false, reason: `stapler staple failed for ${path.basename(dmg)}: ${(staple.stderr || "").trim()}` };
  }
  return { ok: true };
}

/**
 * Finds a bundle Tauri produced. For an explicit --target (incl.
 * universal-apple-darwin) it lives under target/<triple>/release/bundle/<kind>;
 * for a host-default build under target/release/bundle/<kind>.
 */
function findBundleOutput({ targetTriple, repoRoot, kind, ext }) {
  const bundleBase = path.join(repoRoot, "src-tauri", "target");
  const searchDirs = [
    path.join(bundleBase, targetTriple ?? "", "release", "bundle", kind),
    path.join(bundleBase, "release", "bundle", kind),
  ];
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const entry = readdirSync(dir).find((f) => f.endsWith(ext));
    if (entry) return path.join(dir, entry);
  }
  return null;
}

/** Reads Apple notary credentials from the environment, or null if incomplete. */
function readNotaryCredentials() {
  const appleId = process.env.APPLE_ID;
  const applePassword = process.env.APPLE_PASSWORD;
  const appleTeamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !applePassword || !appleTeamId) return null;
  return { appleId, applePassword, appleTeamId };
}

// Standalone entry point (CI): exits non-zero if the extension is missing,
// unsigned, or, on a notarized build, the ticket is not stapled or the DMG
// could not be notarized.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const targetIdx = argv.indexOf("--target");
  const targetTriple = targetIdx !== -1 ? argv[targetIdx + 1] : process.env.DF_BUILD_TARGET_TRIPLE;

  const { ok, reason } = verifyEmbeddedAppex({ targetTriple });
  if (!ok) {
    console.error(`[embed-appex] FAILED: ${reason}`);
    process.exit(1);
  }
  console.log("[embed-appex] QuickLook extension embedded by Tauri, signed, and sealed in the .app.");

  const dmg = notarizeDmg({ targetTriple });
  if (!dmg.ok) {
    console.error(`[embed-appex] FAILED: ${dmg.reason}`);
    process.exit(1);
  }
  console.log(dmg.skipped ? "[embed-appex] No notary credentials: DMG left signed, not notarized." : "[embed-appex] .dmg notarized and stapled.");
}
