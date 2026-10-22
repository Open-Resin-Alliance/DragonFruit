#!/usr/bin/env node
/**
 * Builds the documentation snapshots the site serves: one directory per branch.
 *
 * The deployed site can be built from `dev` while its documentation should still
 * come from `main`. The viewer's code comes from the branch being deployed; the
 * Markdown does not. This exports each configured ref's `docs/` (and the nav file
 * it happens to use) into `website/.docs-versions/<id>/`, so the Astro build can
 * render the same pages from several refs without checking them all out.
 *
 * A ref from before the Astro docs viewer existed is fine: its `docs/` and
 * `mkdocs.yml` are all the renderer needs. `.docs-versions/` is generated and
 * gitignored.
 *
 * Usage:
 *   node scripts/prepare-docs-versions.mjs
 *   DOCS_VERSIONS=main,dev,release/1.0 node scripts/prepare-docs-versions.mjs
 *   DOCS_DEFAULT=dev node scripts/prepare-docs-versions.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputRoot = path.join(repoRoot, 'website', '.docs-versions');
const versions = (process.env.DOCS_VERSIONS ?? 'main,dev')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const defaultRef = process.env.DOCS_DEFAULT ?? 'main';

const LABELS = {
  main: 'Main',
  dev: 'Dev',
};

/** The main branch's documentation is tied to the latest stable release. */
async function latestMainlineVersion() {
  const repository = process.env.GITHUB_REPOSITORY ?? 'Open-Resin-Alliance/DragonFruit';
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const release = await response.json();
    if (typeof release.tag_name !== 'string') return null;
    return release.tag_name.replace(/^v/i, '');
  } catch {
    return null;
  }
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result;
}

function resolveRef(ref) {
  for (const candidate of [ref, `refs/remotes/origin/${ref}`]) {
    const result = git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { allowFailure: true });
    if (result.status === 0) return candidate;
  }

  const fetched = git(
    ['fetch', '--depth=1', '--no-tags', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`],
    { allowFailure: true },
  );
  if (fetched.status !== 0) return null;

  const result = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}^{commit}`], {
    allowFailure: true,
  });
  return result.status === 0 ? `refs/remotes/origin/${ref}` : null;
}

function exportRef(ref, destination) {
  const paths = ['docs', 'mkdocs.yml', 'website/src/data/docs-nav.json'].filter((candidate) => {
    const result = git(['ls-tree', '-r', '--name-only', ref, '--', candidate], { allowFailure: true });
    return result.status === 0 && result.stdout.trim() !== '';
  });

  if (!paths.includes('docs')) throw new Error(`${ref} has no docs/ directory`);

  const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dragonfruit-docs-')), 'source.tar');
  try {
    git(['archive', '--format=tar', '--output', archive, ref, ...paths]);
    fs.mkdirSync(destination, { recursive: true });
    const extracted = spawnSync('tar', ['-xf', archive, '-C', destination], { encoding: 'utf8' });
    if (extracted.error) throw extracted.error;
    if (extracted.status !== 0) {
      throw new Error(`tar could not extract ${ref}: ${extracted.stderr.trim()}`);
    }
  } finally {
    fs.rmSync(path.dirname(archive), { recursive: true, force: true });
  }
}

function labelFor(id) {
  return LABELS[id] ?? id.replace(/(^|[-_/])([a-z])/g, (_, __, letter) => ` ${letter.toUpperCase()}`).trim();
}

function idForRef(ref, used) {
  const base = ref.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'version';
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

if (!versions.includes(defaultRef)) {
  console.error(`DOCS_DEFAULT=${defaultRef} is not in DOCS_VERSIONS (${versions.join(',')})`);
  process.exit(1);
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

const mainlineVersion = await latestMainlineVersion();
const usedIds = new Set();
const manifest = {
  default: '',
  exclude: ['internal'],
  versions: [],
};

for (const ref of versions) {
  const resolved = resolveRef(ref);
  if (!resolved) {
    if (ref === defaultRef) {
      console.error(`Could not find the default documentation ref "${ref}".`);
      process.exit(1);
    }
    console.warn(`[docs-versions] skipping ${ref}: no local branch and fetch failed`);
    continue;
  }

  const id = idForRef(ref, usedIds);
  const root = id;
  const destination = path.join(outputRoot, root);
  exportRef(resolved, destination);

  /* Placeholder screenshots are not committed; materialize them inside the
     snapshot so the renderer's missing-asset check sees the same files the
     working tree gets before a normal build. */
  const materialized = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'materialize-doc-placeholder-assets.mjs'), path.join(destination, 'docs')],
    { stdio: 'inherit' },
  );
  if (materialized.status !== 0) throw new Error(`Could not materialize placeholders for ${ref}`);

  manifest.versions.push({
    id,
    label: labelFor(ref),
    version: ref === 'main' ? mainlineVersion ?? undefined : undefined,
    root,
    exclude: ['internal'],
    ref: resolved,
  });
  console.log(`[docs-versions] ${ref} as ${id} <- ${resolved}`);
}

const defaultVersion = manifest.versions.find((version) => version.ref === defaultRef);
if (!defaultVersion) {
  console.error(`The default documentation ref "${defaultRef}" was not exported.`);
  process.exit(1);
}
manifest.default = defaultVersion.id;

fs.writeFileSync(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[docs-versions] ${manifest.versions.length} version(s), default ${defaultVersion.ref}`);
