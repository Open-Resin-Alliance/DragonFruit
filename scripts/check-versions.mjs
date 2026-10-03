#!/usr/bin/env node
// Reports which toolchain and dependency versions are worth bumping.
// Read-only: queries public registries, never edits the repo.
// Holds (deliberate pins) live in scripts/version-policy.json.
//
//   node scripts/check-versions.mjs
//   GITHUB_TOKEN=... node scripts/check-versions.mjs   # avoids the 60 req/h GitHub limit

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));
const policy = readJson("scripts/version-policy.json");

const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint(31), yellow = paint(33), green = paint(32), dim = paint(2), bold = paint(1);

// ---------- semver ----------

function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}

function cmp(a, b) {
  const x = parse(a), y = parse(b);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (!pn && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// For 0.x versions Cargo treats a minor bump as breaking, so we do too.
function bump(from, to, zeroXBreaks = false) {
  const a = parse(from), b = parse(to);
  if (b.major !== a.major || (zeroXBreaks && a.major === 0 && b.minor !== a.minor)) return "major";
  if (b.minor !== a.minor) return "minor";
  if (b.patch !== a.patch || cmp(from, to) !== 0) return "patch";
  return null;
}

const bumpColor = { major: red, minor: yellow, patch: green };
const clean = (v) => String(v).replace(/^[\^~>=<v\s]+/, "");

// ---------- output ----------

let warnings = [];

function section(title, items) {
  console.log(`\n${bold(title)}`);
  if (!items.length) return console.log(dim("  all up to date"));
  const w = [0, 0, 0];
  for (const r of items) r.cells.slice(0, 3).forEach((c, i) => (w[i] = Math.max(w[i], c.length)));
  for (const r of items) {
    const [name, cur, next, note = ""] = r.cells;
    const arrow = r.kind ? bumpColor[r.kind](`${next.padEnd(w[2])} ${r.kind}`) : dim(next.padEnd(w[2]));
    console.log(`  ${name.padEnd(w[0])}  ${cur.padEnd(w[1])} → ${arrow}${note ? "  " + dim(note) : ""}`);
  }
}

// ---------- network ----------

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "user-agent": "dragonfruit-check-versions", ...headers } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]).catch((e) => ({ error: e.message }));
      }
    }),
  );
  return out;
}

// ---------- checks ----------

async function checkNode(pkg) {
  const current = (existsSync(join(ROOT, ".nvmrc")) ? read(".nvmrc") : read(".node-version")).trim();
  const index = await getJson("https://nodejs.org/dist/index.json");
  const all = index.map((e) => ({ v: e.version.slice(1), lts: e.lts, date: e.date }));
  const hold = policy.node?.maxMajor;
  const pool_ = hold ? all.filter((e) => parse(e.v).major === hold) : all;
  const target = pool_.reduce((a, b) => (cmp(a.v, b.v) >= 0 ? a : b));
  const newestLts = all.filter((e) => e.lts).reduce((a, b) => (cmp(a.v, b.v) >= 0 ? a : b));
  const newest = all.reduce((a, b) => (cmp(a.v, b.v) >= 0 ? a : b));

  const items = [];
  const k = bump(current, target.v);
  if (k) items.push({ kind: k, cells: ["node", current, target.v, `released ${target.date}`] });
  if (hold && parse(newestLts.v).major > hold)
    items.push({ kind: null, cells: ["node", `${hold}.x`, newestLts.v, `held: ${policy.node.reason}`] });
  section("Node.js", items);

  const engines = pkg.engines?.node ?? "";
  const m = /(\d+)\.\d+\.\d+/.exec(engines);
  if (m && `${m[0]}` !== current)
    warnings.push(`package.json engines.node (${engines}) floor ${m[0]} differs from .nvmrc ${current}`);
  return { current, newest };
}

async function checkNpm() {
  const { stdout } = await run("npm", ["-v"], { cwd: ROOT });
  const current = stdout.trim();
  const latest = (await getJson("https://registry.npmjs.org/npm/latest")).version;
  const k = bump(current, latest);
  section("npm (CLI)", k ? [{ kind: k, cells: ["npm", current, latest] }] : []);
}

async function checkRust() {
  const tc = read("rust-toolchain.toml");
  const current = /channel\s*=\s*"([^"]+)"/.exec(tc)?.[1];
  const toml = await (await fetch("https://static.rust-lang.org/dist/channel-rust-stable.toml")).text();
  const latest = /\[pkg\.rust\]\s+version = "(\d+\.\d+\.\d+)/.exec(toml)?.[1];
  const date = /^date = "([^"]+)"/m.exec(toml)?.[1];
  const k = current && latest ? bump(current, latest) : null;
  section("Rust toolchain", k ? [{ kind: k, cells: ["rustc", current, latest, `stable of ${date}`] }] : []);
}

async function checkTauri() {
  const cargo = read("src-tauri/Cargo.toml");
  const tag = /tag = "(tauri-cef-v[^"]+)"/.exec(cargo)?.[1];
  const current = tag?.replace("tauri-cef-v", "");
  const headers = ghHeaders();
  const refs = await getJson(
    "https://api.github.com/repos/tauri-apps/tauri/git/matching-refs/tags/tauri-cef-v?per_page=100",
    headers,
  );
  const versions = refs.map((r) => r.ref.replace("refs/tags/tauri-cef-v", "")).filter(parse);
  const ceiling = policy.tauriCef?.ceiling;
  const allowed = ceiling ? versions.filter((v) => cmp(v, ceiling) <= 0) : versions;
  const target = allowed.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
  const newest = versions.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));

  const items = [];
  if (cmp(target, current) > 0) items.push({ kind: bump(current, target) ?? "patch", cells: ["tauri (cef, git tag)", current, target] });
  if (cmp(newest, target) > 0)
    items.push({ kind: null, cells: ["tauri (cef, git tag)", target, newest, `held: ${policy.tauriCef.reason}`] });
  section("Tauri (git dependency, tags from GitHub)", items);
}

// Packages the project is built around; shown apart from the long tail.
const CORE = new Set(["next", "react", "react-dom", "typescript", "@types/node", "@types/react", "@types/react-dom", "babel-plugin-react-compiler", "@lingui/core", "@lingui/swc-plugin"]);
const isCore = (n) => CORE.has(n) || n.startsWith("@tauri-apps/");

async function checkNpmPackages(pkg, nodeInfo) {
  let outdated = {};
  try {
    const { stdout } = await run("npm", ["outdated", "--json"], { cwd: ROOT, maxBuffer: 1 << 26 });
    outdated = JSON.parse(stdout || "{}");
  } catch (e) {
    // npm outdated exits 1 when anything is outdated.
    outdated = JSON.parse(e.stdout || "{}");
  }
  const core = [], rest = [];
  for (const [name, o] of Object.entries(outdated)) {
    if (!o.current) continue;
    const hold = policy.npm?.[name];
    let latest = o.latest, note = "";
    if (hold?.maxMajor && parse(o.latest).major > hold.maxMajor) {
      note = `held: ${hold.reason}`;
      latest = o.wanted;
    }
    const k = bump(o.current, latest);
    const row = k
      ? { kind: k, cells: [name, o.current, latest, note] }
      : note ? { kind: null, cells: [name, o.current, o.latest, note] } : null;
    if (row) (isCore(name) ? core : rest).push(row);
  }
  const byName = (a, b) => a.cells[0].localeCompare(b.cells[0]);
  section("npm packages: core", core.sort(byName));
  section("npm packages: the rest", rest.sort(byName));

  // Cross-checks between the toolchain and the type/runtime packages.
  const typesNode = (pkg.devDependencies?.["@types/node"] ?? pkg.dependencies?.["@types/node"]);
  const nodeMajor = parse(nodeInfo.current).major;
  if (typesNode && parse(clean(typesNode) + (clean(typesNode).split(".").length < 3 ? ".0" : ""))?.major !== nodeMajor)
    warnings.push(`@types/node ${typesNode} does not follow the Node major (${nodeMajor})`);
  const react = pkg.dependencies?.react, reactDom = pkg.dependencies?.["react-dom"];
  if (react && reactDom && react !== reactDom) warnings.push(`react (${react}) and react-dom (${reactDom}) differ`);

  // TypeScript's own Node floor against ours.
  try {
    readFileSync(join(ROOT, "node_modules/typescript/package.json"));
    const latestTs = await getJson("https://registry.npmjs.org/typescript/latest");
    const floor = /(\d+\.\d+\.\d+)/.exec(latestTs.engines?.node ?? "")?.[1];
    if (floor && cmp(floor, nodeInfo.current) > 0)
      warnings.push(`typescript@${latestTs.version} needs Node ${latestTs.engines.node}; this repo pins ${nodeInfo.current}`);
  } catch { /* typescript not installed */ }

  const tsconfig = read("tsconfig.json");
  const target = /"target":\s*"([^"]+)"/.exec(tsconfig)?.[1];
  const noEmit = /"noEmit":\s*true/.test(tsconfig);
  if (target)
    console.log(dim(`\n  info: tsconfig target ${target}${noEmit ? " with noEmit (Next/SWC transpiles; target only affects type-checking)" : ""}`));
}

// ---------- crates ----------

function sparsePath(name) {
  const n = name.toLowerCase();
  if (n.length === 1) return `1/${n}`;
  if (n.length === 2) return `2/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

function lockVersions(lockPath) {
  const out = new Map();
  if (!existsSync(lockPath)) return out;
  for (const block of readFileSync(lockPath, "utf8").split("[[package]]").slice(1)) {
    const name = /name = "([^"]+)"/.exec(block)?.[1];
    const version = /version = "([^"]+)"/.exec(block)?.[1];
    const source = /source = "([^"]+)"/.exec(block)?.[1] ?? "";
    if (name && version && source.startsWith("registry+")) {
      if (!out.has(name)) out.set(name, []);
      out.get(name).push(version);
    }
  }
  return out;
}

async function checkCrates() {
  const { stdout } = await run("git", ["-C", ROOT, "ls-files", "*Cargo.toml"], { maxBuffer: 1 << 24 });
  const manifests = stdout.split("\n").filter(Boolean);
  const packages = new Map(); // manifest_path → { pkg, lockRoot }
  for (const m of manifests) {
    try {
      const { stdout: meta } = await run(
        "cargo",
        ["metadata", "--no-deps", "--format-version", "1", "--offline", "--manifest-path", join(ROOT, m)],
        { cwd: ROOT, maxBuffer: 1 << 26 },
      );
      const j = JSON.parse(meta);
      for (const p of j.packages) packages.set(p.manifest_path, { p, root: j.workspace_root });
    } catch (e) {
      warnings.push(`cargo metadata failed for ${m}: ${String(e.stderr || e.message).split("\n")[0]}`);
    }
  }

  const locks = new Map();
  const crates = new Map(); // name → { locked: Set, users: Set }
  const gitDeps = new Set();
  for (const { p, root } of packages.values()) {
    if (!locks.has(root)) locks.set(root, lockVersions(join(root, "Cargo.lock")));
    const lock = locks.get(root);
    for (const d of p.dependencies) {
      if (d.source?.startsWith("git+")) { gitDeps.add(d.name); continue; }
      if (!d.source?.startsWith("registry+")) continue;
      const entry = crates.get(d.name) ?? { locked: new Set(), users: new Set() };
      for (const v of lock.get(d.name) ?? []) entry.locked.add(v);
      entry.users.add(p.name);
      crates.set(d.name, entry);
    }
  }

  const names = [...crates.keys()];
  const latest = await pool(names, 8, async (name) => {
    const text = await (await fetch(`https://index.crates.io/${sparsePath(name)}`, { headers: { "user-agent": "dragonfruit-check-versions" } })).text();
    const vs = text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !e.yanked && !e.vers.includes("-")).map((e) => e.vers);
    return vs.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
  });

  const items = [];
  names.forEach((name, i) => {
    const l = latest[i];
    if (!l || l.error) return warnings.push(`crates.io lookup failed for ${name}: ${l?.error}`);
    const { locked, users } = crates.get(name);
    if (!locked.size) return;
    const cur = [...locked].reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
    const k = bump(cur, l, true);
    if (k && cmp(l, cur) > 0) items.push({ kind: k, cells: [name, cur, l, `${users.size} crate${users.size > 1 ? "s" : ""}`] });
  });
  items.sort((a, b) => a.cells[0].localeCompare(b.cells[0]));
  section(`Crates (direct deps of ${packages.size} workspace members, locked vs crates.io)`, items);
  if (gitDeps.size) console.log(dim(`  skipped git dependencies: ${[...gitDeps].sort().join(", ")}`));
}


// ---------- CI: workflow actions, runner images, flatpak runtime ----------

let ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!ghToken) ghToken = await run("gh", ["auth", "token"]).then((r) => r.stdout.trim(), () => "");
const ghHeaders = () => (ghToken ? { authorization: `Bearer ${ghToken}` } : {});

async function checkActions() {
  const { stdout } = await run("git", ["-C", ROOT, "ls-files", ".github/workflows/*.yml", ".github/workflows/*.yaml", ".github/actions/**/action.yml"]);
  const uses = new Map(); // "owner/repo" → Map(ref → Set(file))
  for (const f of stdout.split("\n").filter(Boolean)) {
    for (const m of read(f).matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const [spec, ref] = m[1].split("@");
      if (!ref || spec.startsWith("./") || spec.startsWith("docker://")) continue;
      const repo = spec.split("/").slice(0, 2).join("/");
      if (!uses.has(repo)) uses.set(repo, new Map());
      const refs = uses.get(repo);
      if (!refs.has(ref)) refs.set(ref, new Set());
      refs.get(ref).add(f.replace(".github/workflows/", ""));
    }
  }
  const norm = (v) => { const p = v.replace(/^v/, "").split("."); while (p.length < 3) p.push("0"); return p.join("."); };
  const tagVersion = (t) => /(\d+\.\d+\.\d+)/.exec(t)?.[1];
  const repos = [...uses.keys()];
  const latest = await pool(repos, 6, async (repo) => {
    const rel = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { "user-agent": "dragonfruit-check-versions", ...ghHeaders() } });
    if (rel.ok) return (await rel.json()).tag_name;
    const tags = await getJson(`https://api.github.com/repos/${repo}/tags?per_page=30`, ghHeaders());
    return tags.map((t) => t.name).filter((n) => tagVersion(n)).sort((a, b) => cmp(tagVersion(b), tagVersion(a)))[0];
  });

  const items = [], floating = [];
  repos.forEach((repo, i) => {
    const l = latest[i];
    if (!l || l.error) return warnings.push(`latest release of ${repo} unknown: ${l?.error ?? "no release or tag"}`);
    for (const [ref, files] of uses.get(repo)) {
      if (!/^v?\d+(\.\d+){0,2}$/.test(ref)) { floating.push(`${repo}@${ref}`); continue; }
      const lv = tagVersion(l);
      const k = bump(norm(ref), lv);
      const hold = policy.actions?.[repo];
      const held = hold?.maxMajor && parse(lv).major > hold.maxMajor;
      if (k === "major" && held) items.push({ kind: null, cells: [repo, ref, lv, `held: ${hold.reason}`] });
      else if (k && (k === "major" || ref.split(".").length > 1)) items.push({ kind: k, cells: [repo, ref, lv, `${files.size} workflow${files.size > 1 ? "s" : ""}`] });
    }
    if (uses.get(repo).size > 1) warnings.push(`${repo} used at several refs: ${[...uses.get(repo).keys()].join(", ")}`);
  });
  items.sort((a, b) => a.cells[0].localeCompare(b.cells[0]));
  section("GitHub Actions (refs in .github/workflows vs latest release)", items);
  if (floating.length) console.log(dim(`  floating refs, not comparable: ${floating.join(", ")}`));
}

async function checkRunners() {
  const { stdout } = await run("git", ["-C", ROOT, "ls-files", ".github/workflows/*.yml", ".github/workflows/*.yaml"]);
  const labels = new Map();
  for (const f of stdout.split("\n").filter(Boolean))
    for (const m of read(f).matchAll(/\b(ubuntu|macos|windows)-(latest|\d+(?:\.\d+)?)(?:-(?:arm|xlarge|large|intel))?\b/g))
      labels.set(m[0], (labels.get(m[0]) ?? 0) + 1);

  const tagsOf = async (prefix) => {
    const refs = await getJson(`https://api.github.com/repos/actions/runner-images/git/matching-refs/tags/${prefix}?per_page=100`, ghHeaders());
    return [...new Set(refs.map((r) => r.ref.replace("refs/tags/", "").split("/")[0]))];
  };
  const [u, m, w] = await Promise.all([tagsOf("ubuntu"), tagsOf("macos"), tagsOf("win")]);
  const newest = {
    ubuntu: Math.max(...u.map((t) => /^ubuntu(\d+)$/.exec(t)?.[1]).filter(Boolean).map(Number)),
    macos: Math.max(...m.map((t) => /^macos-(\d+)$/.exec(t)?.[1]).filter(Boolean).map(Number)),
    windows: Math.max(...w.map((t) => /^win(\d+)$/.exec(t)?.[1]).filter(Boolean).map(Number)),
  };
  const items = [], floating = [];
  for (const [label, n] of labels) {
    const [, os, v] = /^(ubuntu|macos|windows)-(latest|[\d.]+)/.exec(label);
    if (v === "latest") { floating.push(`${label} ×${n}`); continue; }
    const cur = parseInt(v, 10), top = newest[os];
    if (!(top > cur)) continue;
    const maxHold = policy.runners?.[os]?.max;
    const allowed = maxHold ? Math.min(top, parseInt(maxHold, 10)) : top;
    const fmt = (n) => (os === "ubuntu" ? `${os}-${n}.04` : `${os}-${n}`);
    if (allowed > cur) items.push({ kind: "major", cells: [label, `${n} use${n > 1 ? "s" : ""}`, fmt(allowed)] });
    if (top > allowed) items.push({ kind: null, cells: [allowed > cur ? fmt(allowed) : label, "", fmt(top), `held: ${policy.runners[os].reason}`] });
  }
  section("Runner images (pinned labels vs newest in actions/runner-images)", items);
  if (floating.length) console.log(dim(`  floating labels, move when GitHub moves them: ${floating.join(", ")}`));
}

async function checkFlatpak() {
  const yml = read("flatpak/org.openresinalliance.dragonfruit.yml");
  const current = /^runtime-version:\s*"?([\d.]+)"?/m.exec(yml)?.[1];
  const tags = await getJson("https://gitlab.com/api/v4/projects/freedesktop-sdk%2Ffreedesktop-sdk/repository/tags?per_page=100&search=freedesktop-sdk-2");
  const branches = [...new Set(tags.map((t) => /^freedesktop-sdk-(\d+\.08)\.\d+$/.exec(t.name)?.[1]).filter(Boolean))].sort((a, b) => parseFloat(a) - parseFloat(b));
  const top = branches.at(-1);
  const hold = policy.flatpak?.maxVersion;
  const items = [];
  if (current && top && parseFloat(top) > parseFloat(current)) {
    const held = hold && parseFloat(top) > parseFloat(hold);
    items.push({ kind: held ? null : "major", cells: ["org.freedesktop.Platform", current, top, held ? `held: ${policy.flatpak.reason}` : `${branches.indexOf(top) - branches.indexOf(current)} branches behind`] });
  }
  section("Flatpak runtime (flatpak/*.yml vs freedesktop-sdk)", items);
}

// ---------- main ----------

const pkg = readJson("package.json");
const steps = [
  ["node", () => checkNode(pkg)],
  ["npm", checkNpm],
  ["rust", checkRust],
  ["tauri", checkTauri],
];
let nodeInfo;
for (const [label, fn] of steps) {
  try {
    const r = await fn();
    if (label === "node") nodeInfo = r;
  } catch (e) {
    warnings.push(`${label}: ${e.message}`);
  }
}
try { await checkNpmPackages(pkg, nodeInfo ?? { current: "0.0.0" }); } catch (e) { warnings.push(`npm packages: ${e.message}`); }
try { await checkCrates(); } catch (e) { warnings.push(`crates: ${e.message}`); }
for (const [label, fn] of [["actions", checkActions], ["runners", checkRunners], ["flatpak", checkFlatpak]]) {
  try { await fn(); } catch (e) { warnings.push(`${label}: ${e.message}`); }
}

if (warnings.length) {
  console.log(`\n${bold("Warnings")}`);
  for (const w of warnings) console.log(`  ${yellow("!")} ${w}`);
}
