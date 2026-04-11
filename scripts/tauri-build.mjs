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

console.log(`[tauri-build] ${npxCmd} ${cmdArgs.join(" ")}`);

// Set RUSTFLAGS in the environment.
process.env.RUSTFLAGS = "-C target-feature=+avx2,+fma";

// Use shell:true to work around Windows spawnSync EINVAL issues with npx.cmd
const result = spawnSync(npxCmd, cmdArgs, {
  stdio: "inherit",
  shell: true,
});

process.exit(result.status ?? 1);
