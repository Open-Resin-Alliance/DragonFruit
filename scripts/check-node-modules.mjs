#!/usr/bin/env node
// Fails when node_modules does not match package-lock.json (e.g. after a
// `git pull` that bumped dependencies). Fix: `npm ci`.
//
// Compares the lockfile with npm's hidden lockfile, node_modules/.package-lock.json,
// which npm rewrites on every install. Set DF_SKIP_DEPS_CHECK=1 to bypass.
//
//   node scripts/check-node-modules.mjs [repo-root]

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Returns { missing: boolean, drift: [{ name, locked, installed }] }. */
export function findDrift(root = DEFAULT_ROOT) {
  const hiddenPath = join(root, "node_modules", ".package-lock.json");
  if (!existsSync(hiddenPath)) return { missing: true, drift: [] };

  const locked = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages ?? {};
  const installed = JSON.parse(readFileSync(hiddenPath, "utf8")).packages ?? {};

  const drift = [];
  for (const [path, entry] of Object.entries(locked)) {
    // "" is the root project; links are workspace symlinks.
    if (!path || entry.link || !entry.version) continue;
    const have = installed[path]?.version;
    // Platform-specific optional packages are legitimately absent on other OSes.
    if (have === undefined && (entry.optional || entry.os || entry.cpu)) continue;
    if (have !== entry.version) drift.push({ name: path.replace(/^.*node_modules\//, ""), locked: entry.version, installed: have });
  }
  return { missing: false, drift };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.env.DF_SKIP_DEPS_CHECK) process.exit(0);
  const { missing, drift } = findDrift(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_ROOT);
  if (missing) {
    console.error("node_modules is missing. Run `npm ci`.");
    process.exit(1);
  }
  if (drift.length) {
    const shown = drift.slice(0, 8).map((d) => `  ${d.name}: lock ${d.locked}, installed ${d.installed ?? "none"}`);
    const more = drift.length > 8 ? [`  … and ${drift.length - 8} more`] : [];
    console.error(`node_modules does not match package-lock.json (${drift.length} packages):`);
    console.error([...shown, ...more].join("\n"));
    console.error("Run `npm ci` to sync (DF_SKIP_DEPS_CHECK=1 to bypass).");
    process.exit(1);
  }
}
