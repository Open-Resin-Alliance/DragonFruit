/**
 * Point a macOS bundle at an ad-hoc signature instead of the Developer ID.
 *
 * Release builds sign with the Developer ID named in
 * src-tauri/tauri.macos.conf.json and notarize the result. Preview and
 * pull-request builds do neither: they exist to prove the app compiles and to
 * hand a tester something to poke at, and signing every push spends the
 * certificate's notary quota on builds nobody keeps.
 *
 * Ad-hoc ("-") rather than no signature at all, because Tauri skips signing
 * entirely when no identity is configured — and an unsigned .app does not launch
 * on Apple Silicon. Ad-hoc keeps the bundle loadable on the machine that built
 * it while making the absence of a Developer ID explicit.
 *
 * The result still fails Gatekeeper once downloaded and quarantined. That is the
 * trade, and docs/dev/preview-builds.md states it.
 *
 * Usage: node scripts/use-adhoc-macos-signing.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, "src-tauri", "tauri.macos.conf.json");

const config = JSON.parse(readFileSync(configPath, "utf8"));
const previous = config.bundle?.macOS?.signingIdentity;

config.bundle ??= {};
config.bundle.macOS ??= {};
config.bundle.macOS.signingIdentity = "-";

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(
  `macOS signing identity: ${previous ?? "(unset)"} -> "-" (ad-hoc; this build is not notarized)`
);
