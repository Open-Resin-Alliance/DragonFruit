/**
 * Cross-platform Tauri bundle orchestrator
 * 
 * ⚠️  NOTE: For cross-platform builds, GitHub Actions (in .github/workflows/tauri-bundle.yml)
 * is the recommended approach. This script requires:
 * - Rust toolchains installed for all targets (via rustup)
 * - Platform-specific native dependencies and build tools
 * - Signing certificates for macOS (if creating production bundles)
 * 
 * Usage:
 *   npm run tauri:bundle                          # Build this machine's own target
 *   npm run tauri:bundle -- --dry-run             # Preview targets without building
 *   npm run tauri:bundle -- --only=<triple,...>   # Build specific targets only
 *   npm run tauri:bundle:windows                  # Windows only (fastest locally)
 *   npm run tauri:bundle:linux                    # Linux only
 *   npm run tauri:bundle:macos:universal          # macOS universal (Intel + Apple Silicon)
 *   npm run tauri:bundle:macos                    # macOS x64 only (fast local dev)
 *   npm run tauri:bundle:macos:arm64              # macOS arm64 only (fast local dev)
 *
 * The macOS default is universal-apple-darwin — a single fat DMG, not two
 * per-arch DMGs. The per-arch triples remain available via --only= (and the
 * :macos / :macos:arm64 scripts) as fast local-dev shortcuts.
 *
 * For most use cases, push to main/create a tag to trigger GitHub Actions workflows.
 */

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

// The default is this machine's own target. Building the other two needs cross
// toolchains and native deps almost nobody has locally, so defaulting to all
// three meant every no-arg run failed two of them; --only= is still there for
// whoever really is set up for it.
function hostTarget() {
      if (process.platform === "darwin") return "universal-apple-darwin";
      if (process.platform === "win32") {
            return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
      }
      if (process.platform === "linux") {
            return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
      }
      return null;
}

// Derived from the triple rather than looked up, so an arm64 Windows or Linux
// host is not a missing map entry.
function bundlesFor(target) {
      if (target.includes("windows")) return "msi,nsis";
      if (target.includes("linux")) return "deb,rpm";
      if (target.includes("darwin")) return "app,dmg";
      return null;
}

const defaultTargets = [hostTarget()].filter(Boolean);

const onlyArg = args.find((arg) => arg.startsWith("--only="));
const targets = onlyArg
      ? onlyArg
            .slice("--only=".length)
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
      : defaultTargets;

if (targets.length === 0) {
      console.error(
            `No targets selected (unsupported host platform ${process.platform}?). Use --only=<triple1,triple2,...>.`
      );
      process.exit(1);
}

console.log("DragonFruit Tauri bundle orchestrator");
console.log(`Targets: ${targets.join(", ")}`);
if (dryRun) {
      console.log("Dry run enabled — no builds will be executed.");
}

const failures = [];

// x86_64 codegen flags (+avx2,+fma) live in .cargo/config.toml now, so there is
// no RUSTFLAGS injection here — they apply to every cargo invocation, including
// each arch of the universal build.

for (const target of targets) {
      const bundleArg = bundlesFor(target);

      // Every target goes through a wrapper; none of them shell out to `tauri
      // build` here. The universal macOS one has its own (build via
      // tauri-build.mjs --universal, then verify the bundle is fat + signed);
      // the rest hand tauri-build.mjs the triple and let it decide the CEF
      // features, the AppImage env and the QuickLook embed. Duplicating any of
      // that here is how the two paths drifted apart in the first place.
      const isUniversal = target === "universal-apple-darwin";
      // Per-arch macOS triples are the fast local-dev shortcuts, so they skip
      // the QuickLook embed exactly like `npm run tauri:bundle:macos` does —
      // one triple must not mean two different artifacts depending on which
      // entry point asked for it. universal-apple-darwin is the release path
      // and always carries the extension.
      const skipAppex = target.includes("darwin") && !isUniversal;
      const cmdArgs = isUniversal
            ? ["scripts/tauri-bundle-macos-universal.mjs"]
            : [
                  "scripts/tauri-build.mjs",
                  "--target",
                  target,
                  ...(bundleArg ? ["--bundles", bundleArg] : []),
                  ...(skipAppex ? ["--no-appex"] : []),
            ];

      console.log(`\n=== Building target: ${target} ===`);
      console.log(`node ${cmdArgs.join(" ")}`);

      if (dryRun) {
            continue;
      }

      const result = spawnSync("node", cmdArgs, {
            stdio: "inherit",
      });

      if (result.status !== 0) {
            failures.push({ target, code: result.status ?? 1 });
      }
}

if (dryRun) {
      console.log("\nDry run complete.");
      process.exit(0);
}

if (failures.length > 0) {
      console.error("\nBundle build completed with failures:");
      for (const failure of failures) {
            console.error(`- ${failure.target} (exit code ${failure.code})`);
      }
      console.error(
            "\nNote: Cross-platform Tauri bundling requires target-specific Rust toolchains and native system dependencies/signing setup for each target."
      );
      process.exit(1);
}

console.log("\nAll bundle targets built successfully.");
