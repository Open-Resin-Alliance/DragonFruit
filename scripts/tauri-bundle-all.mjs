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
 *   npm run tauri:bundle                          # Build all targets (requires full setup)
 *   npm run tauri:bundle -- --dry-run             # Preview targets without building
 *   npm run tauri:bundle:windows                  # Windows only (fastest locally)
 *   npm run tauri:bundle:linux                    # Linux only
 *   npm run tauri:bundle:macos                    # macOS x64 only
 *   npm run tauri:bundle:macos:arm64              # macOS arm64 only
 * 
 * For most use cases, push to main/create a tag to trigger GitHub Actions workflows.
 */

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const defaultTargets = [
      "x86_64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
      "x86_64-apple-darwin",
      "aarch64-apple-darwin",
];

const bundlesByTarget = {
      "x86_64-pc-windows-msvc": "msi,nsis",
      "x86_64-unknown-linux-gnu": "deb,rpm",
      "x86_64-apple-darwin": "app,dmg",
      "aarch64-apple-darwin": "app,dmg",
};

const onlyArg = args.find((arg) => arg.startsWith("--only="));
const targets = onlyArg
      ? onlyArg
            .slice("--only=".length)
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
      : defaultTargets;

if (targets.length === 0) {
      console.error("No targets selected. Use --only=<triple1,triple2,...>.");
      process.exit(1);
}

console.log("DragonFruit Tauri bundle orchestrator");
console.log(`Targets: ${targets.join(", ")}`);
if (dryRun) {
      console.log("Dry run enabled — no builds will be executed.");
}

const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const failures = [];

function rustflagsForTarget(targetTriple) {
      return targetTriple.startsWith("x86_64") ? "-C target-feature=+avx2,+fma" : undefined;
}

for (const target of targets) {
      const bundleArg = bundlesByTarget[target];
      let cmdArgs = bundleArg
            ? ["tauri", "build", "--target", target, "--bundles", bundleArg]
            : ["tauri", "build", "--target", target];

      // Linux builds use CEF instead of WebKitGTK (issue #83). Pass cargo
      // feature flags after "--" so the binary links against tauri-cef.
      if (target.includes("linux")) {
            cmdArgs.push("--", "--no-default-features", "--features", "custom-protocol,tauri-cef");
      }
      console.log(`\n=== Building target: ${target} ===`);
      console.log(`${npxCmd} ${cmdArgs.join(" ")}`);

      if (dryRun) {
            continue;
      }

      const rustflags = rustflagsForTarget(target);
      const tauriEnv = {
            ...process.env,
            ...(rustflags ? { RUSTFLAGS: rustflags } : {}),
            ...(target.includes("linux")
                  ? { APPIMAGE_EXTRACT_AND_RUN: process.env.APPIMAGE_EXTRACT_AND_RUN ?? "1" }
                  : {}),
      };

      const result = spawnSync(npxCmd, cmdArgs, {
            stdio: "inherit",
            // Use +avx2 (supported on all CPUs since ~2013) for good vectorization
            // without the illegal-instruction crashes that "target-cpu=native" causes
            // on older hardware (STATUS_ILLEGAL_INSTRUCTION / 0xC000001D).
            env: tauriEnv,
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
