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

const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const cmdArgs = ["tauri", "build", ...extraArgs];

if (isLinux) {
  cmdArgs.push("--", "--no-default-features", "--features", "custom-protocol,tauri-cef");
}

const rustflags = "-C target-feature=+avx2,+fma";
console.log(`[tauri-build] ${npxCmd} ${cmdArgs.join(" ")} (RUSTFLAGS=${rustflags})`);

// On Windows, .cmd files cannot be spawned directly — they require the shell
// (cmd.exe) to execute them. Pass RUSTFLAGS explicitly through env so it is
// guaranteed to reach cargo/rustc regardless of inherited process.env state.
const result = spawnSync(npxCmd, cmdArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, RUSTFLAGS: rustflags },
});

process.exit(result.status ?? 1);
