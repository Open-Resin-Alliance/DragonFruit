/**
 * Verify a universal macOS bundle is actually shippable:
 *   - the .app main binary, the externalBin sidecar, and the embedded QuickLook
 *     .appex Mach-O are all fat (contain BOTH x86_64 AND arm64);
 *   - the .app and the .appex carry valid code signatures;
 *   - the produced .dmg passes hdiutil verify.
 *
 * Shared by both build paths so the contract is enforced identically:
 *   - scripts/tauri-bundle-macos-universal.mjs (local wrapper), and
 *   - .github/workflows/tauri-bundle.yml (CI, after the embed step).
 *
 * `lipo -info` exits 0 even for a thin binary, so we grep its output for both
 * arches rather than trusting the exit code. We do NOT enforce a certificate
 * TYPE — Apple Development (dev machines) and ad-hoc "-" (CI) are both accepted;
 * we are verifying signature INTEGRITY, not Gatekeeper acceptance. Developer ID
 * + notarization is the follow-up df-macos-ci-developer-id-notarize.
 *
 * Usage: node scripts/verify-universal-bundle.mjs
 * Exits non-zero if any assertion fails (all are checked before exiting, so one
 * run reports every problem).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const srcTauri = path.join(repoRoot, "src-tauri");
const TARGET = "universal-apple-darwin";

if (process.platform !== "darwin") {
  console.error("[verify-universal] macOS-only (uses lipo/codesign/hdiutil).");
  process.exit(1);
}

let failures = 0;
const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  failures += 1;
};

// productName drives the .app and main-binary names. Read the JSON directly
// (no jq dependency on the runner); tauri.macos.conf.json does not override it.
const conf = JSON.parse(readFileSync(path.join(srcTauri, "tauri.conf.json"), "utf8"));
const productName = conf.productName;
if (!productName) {
  console.error("[verify-universal] could not read productName from tauri.conf.json");
  process.exit(1);
}

// Locate the bundle. Tauri puts an explicit-target build under
// target/<triple>/release/bundle/; fall back to target/release/bundle/.
function findBundle() {
  const bases = [
    path.join(srcTauri, "target", TARGET, "release", "bundle"),
    path.join(srcTauri, "target", "release", "bundle"),
  ];
  for (const base of bases) {
    const appPath = path.join(base, "macos", `${productName}.app`);
    if (existsSync(appPath)) {
      const dmgDir = path.join(base, "dmg");
      const dmgEntry = existsSync(dmgDir)
        ? readdirSync(dmgDir).find((f) => f.endsWith(".dmg"))
        : undefined;
      return { appPath, dmgPath: dmgEntry ? path.join(dmgDir, dmgEntry) : undefined };
    }
  }
  return {};
}

const { appPath, dmgPath } = findBundle();
if (!appPath) {
  console.error(
    `[verify-universal] no ${productName}.app under src-tauri/target/${TARGET}/release/bundle/macos or src-tauri/target/release/bundle/macos`
  );
  process.exit(1);
}
console.log(`[verify-universal] verifying ${path.relative(repoRoot, appPath)}`);

function lipoHasBothArches(binPath, label) {
  if (!existsSync(binPath)) {
    const parent = path.dirname(binPath);
    const listing = existsSync(parent) ? ` (parent contains: ${readdirSync(parent).join(", ")})` : "";
    fail(`${label}: not found at ${binPath}${listing}`);
    return;
  }
  let out;
  try {
    out = execFileSync("lipo", ["-info", binPath], { encoding: "utf8" });
  } catch (e) {
    fail(`${label}: lipo -info failed: ${e.message}`);
    return;
  }
  const hasX86 = out.includes("x86_64");
  const hasArm = out.includes("arm64");
  if (hasX86 && hasArm) {
    pass(`${label}: fat (x86_64 + arm64)`);
  } else {
    fail(`${label}: not universal (x86_64=${hasX86}, arm64=${hasArm}) — lipo: ${out.trim()}`);
  }
}

function codesignValid(targetPath, label) {
  if (!existsSync(targetPath)) {
    fail(`${label}: not found at ${targetPath}`);
    return;
  }
  const r = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", targetPath], {
    encoding: "utf8",
  });
  if (r.status === 0) {
    pass(`${label}: code signature valid`);
  } else {
    fail(`${label}: codesign --verify failed (status ${r.status}): ${(r.stderr || "").trim()}`);
  }
}

const contentsMacOS = path.join(appPath, "Contents", "MacOS");
const appexPath = path.join(appPath, "Contents", "PlugIns", "VoxlThumbnailExtension.appex");

// The main executable inside Contents/MacOS/ is named after the Cargo binary
// (dragonfruit-desktop), NOT the productName (DragonFruit) — read the authoritative
// CFBundleExecutable from Info.plist rather than assuming.
function bundleExecutableName() {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  try {
    return execFileSync("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPlist], {
      encoding: "utf8",
    }).trim();
  } catch {
    return productName;
  }
}
const mainBinName = bundleExecutableName();

// (b) main binary, (c) externalBin sidecar, (d) embedded .appex Mach-O
lipoHasBothArches(path.join(contentsMacOS, mainBinName), `main binary (${mainBinName})`);
lipoHasBothArches(path.join(contentsMacOS, "dragonfruit-voxl-thumbnailer"), "externalBin sidecar");
lipoHasBothArches(
  path.join(appexPath, "Contents", "MacOS", "VoxlThumbnailExtension"),
  ".appex Mach-O"
);

// (e) .app signature, (f) .appex signature
codesignValid(appPath, ".app");
codesignValid(appexPath, ".appex");

// (g) dmg integrity
if (!dmgPath) {
  fail("dmg: no .dmg found alongside the .app");
} else {
  const r = spawnSync("hdiutil", ["verify", dmgPath], { encoding: "utf8" });
  if (r.status === 0) {
    pass(`dmg: hdiutil verify ok (${path.basename(dmgPath)})`);
  } else {
    fail(`dmg: hdiutil verify failed: ${(r.stderr || "").trim()}`);
  }
}

if (failures > 0) {
  console.error(`[verify-universal] FAILED — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("[verify-universal] OK — universal binary + sidecar + .appex, all signed, dmg valid.");
