/**
 * Platform-aware tauri build wrapper.
 *
 * On Linux: passes --no-default-features --features custom-protocol,tauri-cef
 * to build with CEF instead of WebKitGTK.
 *
 * On macOS/Windows: passes through to tauri build with default features (wry).
 *
 * Usage: node scripts/tauri-build.mjs [extra tauri args...]
 */

import { spawnSync } from "node:child_process";

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

process.exit(result.status ?? 1);
