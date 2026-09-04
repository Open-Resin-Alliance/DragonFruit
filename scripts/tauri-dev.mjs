#!/usr/bin/env node
/**
 * `tauri dev` wrapper.
 *
 * Exists for one reason: on Linux the webview backend has to be selected
 * explicitly. src-tauri/Cargo.toml declares
 *
 *     default = ["custom-protocol", "tauri-wry"]
 *
 * so a bare `tauri dev` builds WebKitGTK, while every Linux release ships CEF.
 * Development and release therefore exercised different webviews, and
 * CEF-only failures were invisible locally — which is how the blank build
 * plate in #606 reached users. See #614.
 *
 * Keep the feature list here identical to the one in tauri-build.mjs.
 */
import { spawnSync } from "node:child_process";

const isLinux = process.platform === "linux";
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

const cmdArgs = ["tauri", "dev", ...process.argv.slice(2)];

if (isLinux) {
  cmdArgs.push("--", "--no-default-features", "--features", "custom-protocol,tauri-cef");
}

console.log(`[tauri-dev] ${npxCmd} ${cmdArgs.join(" ")}`);

const result = spawnSync(npxCmd, cmdArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
