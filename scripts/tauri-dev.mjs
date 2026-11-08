#!/usr/bin/env node
/**
 * `tauri dev` wrapper.
 *
 * On Linux the webview backend has to be selected explicitly.
 * src-tauri/Cargo.toml declares
 *
 *     default = ["custom-protocol", "tauri-wry"]
 *
 * so a bare `tauri dev` builds WebKitGTK, while every Linux release ships CEF.
 * Development and release therefore exercised different webviews, and
 * CEF-only failures were invisible locally — which is how the blank build
 * plate in #606 reached users. See #614.
 *
 * Keep the feature list here identical to the one in tauri-build.mjs.
 * CUDA feature builds also enable first-output host logs unless overridden.
 */
import { spawnSync } from "node:child_process";

const isLinux = process.platform === "linux";
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

const extraArgs = process.argv.slice(2);
const cmdArgs = ["tauri", "dev", ...extraArgs];

// Match tauri-build's Cargo feature detection; preserve every caller argument.
const cudaEnabled = extraArgs.some((arg, index, args) => {
  if (arg === "--all-features") return true;
  if (arg.startsWith("--features=")) {
    return arg.slice("--features=".length).split(/[\s,]+/).includes("cuda");
  }
  if (arg !== "--features") return false;
  for (let next = index + 1; next < args.length && !args[next].startsWith("-"); next++) {
    if (args[next].split(/[\s,]+/).includes("cuda")) return true;
  }
  return false;
});
const tauriEnv = {
  ...process.env,
  ...(cudaEnabled ? { DF_CUDA_TRACE: process.env.DF_CUDA_TRACE ?? "1" } : {}),
};

if (isLinux) {
  cmdArgs.push("--", "--no-default-features", "--features", "custom-protocol,tauri-cef");
}

console.log(`[tauri-dev] ${npxCmd} ${cmdArgs.join(" ")}`);
if (cudaEnabled) {
  console.log(`[tauri-dev] DF_CUDA_TRACE=${tauriEnv.DF_CUDA_TRACE} (first-output host diagnostics; set 0 to disable)`);
}

const result = spawnSync(npxCmd, cmdArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: tauriEnv,
});

process.exit(result.status ?? 1);
