#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const crateManifestPath = path.join(repoRoot, "rust", "dragonfruit-voxl-thumbnail", "Cargo.toml");
const qlExtDir = path.join(repoRoot, "rust", "dragonfruit-voxl-thumbnail", "macos-qlext");
const installScript = path.join(
      repoRoot,
      "rust",
      "dragonfruit-voxl-thumbnail",
      "platform",
      "macos",
      "install.sh",
);

const args = new Set(process.argv.slice(2));
const showHelp = args.has("--help") || args.has("-h");

if (showHelp) {
      console.log("DragonFruit macOS thumbnail dev installer");
      console.log("");
      console.log("Builds the VOXL thumbnailer CLI, builds the Quick Look extension,");
      console.log("and runs the macOS dev install script.");
      console.log("");
      console.log("Usage:");
      console.log("  npm run macos:thumbnails");
      console.log("  node scripts/macos-thumbnails.mjs");
      console.log("");
      console.log("Notes:");
      console.log("  - macOS only");
      console.log("  - install step may prompt for sudo to copy the CLI to /usr/local/bin");
      console.log("  - installs the Quick Look extension to ~/Library/QuickLook");
      process.exit(0);
}

if (process.platform !== "darwin") {
      console.error("[macos:thumbnails] This runner only supports macOS.");
      process.exit(1);
}

function run(command, commandArgs, options = {}) {
      const cwd = options.cwd ?? repoRoot;
      console.log(`[macos:thumbnails] ${command} ${commandArgs.join(" ")}`);
      const result = spawnSync(command, commandArgs, {
            cwd,
            stdio: "inherit",
            shell: process.platform === "win32",
            env: { ...process.env, ...(options.env ?? {}) },
      });

      if (result.status !== 0) {
            process.exit(result.status ?? 1);
      }
}

run("cargo", ["build", "--release", "--manifest-path", crateManifestPath]);
run("bash", ["./build.sh"], { cwd: qlExtDir });
run("bash", [installScript]);
