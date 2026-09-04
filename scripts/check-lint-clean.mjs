/**
 * Runs ESLint over the directories that are already clean, and fails on any
 * problem found there.
 *
 * The repo carries thousands of pre-existing ESLint problems, so `npm run lint`
 * cannot gate CI as a whole — a full-repo gate would either be permanently red
 * or force one enormous, unreviewable cleanup. This check inverts the ratchet:
 * a directory is cleaned once, listed in scripts/lint-clean-dirs.json, and from
 * then on CI refuses any new error or warning inside it. Coverage grows one
 * directory at a time and never slides back.
 *
 * Warnings count as failures. A directory only earns its place on the list when
 * `npx eslint <dir> --max-warnings 0` already passes, so tolerating warnings
 * afterwards would just let the debt back in through the side door.
 *
 * Usage:
 *   node scripts/check-lint-clean.mjs            # check every listed directory
 *   node scripts/check-lint-clean.mjs <dir>…     # check specific directories
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const LIST_FILE = 'scripts/lint-clean-dirs.json';

async function readDirectories() {
      const raw = await fs.readFile(path.join(projectRoot, LIST_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.directories)) {
            throw new Error(`${LIST_FILE} has no "directories" array.`);
      }
      return parsed.directories;
}

/** A renamed or deleted directory must fail loudly — silently losing coverage is the failure mode this check exists to prevent. */
async function checkDirectoriesExist(directories) {
      const missing = [];
      for (const directory of directories) {
            try {
                  const stats = await fs.stat(path.join(projectRoot, directory));
                  if (!stats.isDirectory()) missing.push(directory);
            } catch {
                  missing.push(directory);
            }
      }
      return missing;
}

/** A listed directory covers a submodule when either path contains the other. */
function covers(directory, submodulePath) {
      const dir = directory.replace(/\/+$/, '');
      if (dir === '' || dir === '.') return true;
      return (
            submodulePath === dir ||
            submodulePath.startsWith(`${dir}/`) ||
            dir.startsWith(`${submodulePath}/`)
      );
}

/**
 * An uninitialized submodule is an empty directory, so it survives the existence
 * check above and then ESLint refuses the whole run with "all of the files
 * matching the glob pattern are ignored" — a message that says nothing about the
 * cause. Worse, once a listed entry sits *above* the submodules (`plugins` rather
 * than `plugins/ctb`), the directory is no longer empty and the run goes green
 * having linted a fraction of what it claims to cover.
 *
 * So read the submodule paths from .gitmodules rather than inferring them from
 * the list, and check the ones any listed directory reaches.
 */
async function uninitializedSubmodules(directories) {
      let raw;
      try {
            raw = await fs.readFile(path.join(projectRoot, '.gitmodules'), 'utf8');
      } catch {
            return [];
      }
      const submodulePaths = [...raw.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((match) => match[1].trim());
      const uninitialized = [];
      for (const submodulePath of submodulePaths) {
            if (!directories.some((directory) => covers(directory, submodulePath))) continue;
            try {
                  const contents = await fs.readdir(path.join(projectRoot, submodulePath));
                  if (contents.length === 0) uninitialized.push(submodulePath);
            } catch {
                  // Not on disk at all — checkDirectoriesExist already reports it if it was listed.
            }
      }
      return uninitialized;
}

function runEslint(directories) {
      return new Promise((resolve, reject) => {
            const child = spawn(
                  'npx',
                  ['eslint', '--max-warnings', '0', ...directories],
                  { cwd: projectRoot, stdio: 'inherit' },
            );
            child.on('error', reject);
            child.on('close', (code) => resolve(code ?? 1));
      });
}

async function main() {
      const requested = process.argv.slice(2);
      const directories = requested.length > 0 ? requested : await readDirectories();

      if (directories.length === 0) {
            console.log('[lint-clean] No directories under lint control yet.');
            return;
      }

      const missing = await checkDirectoriesExist(directories);
      if (missing.length > 0) {
            console.error('[lint-clean] Listed directories that no longer exist:');
            for (const directory of missing) console.error(`  - ${directory}`);
            console.error(`Update ${LIST_FILE} to follow the rename — do not just drop the entry.`);
            process.exit(1);
      }

      const uninitialized = await uninitializedSubmodules(directories);
      if (uninitialized.length > 0) {
            console.error('[lint-clean] Submodules under lint control are not checked out:');
            for (const submodulePath of uninitialized) console.error(`  - ${submodulePath}`);
            console.error('Run `git submodule update --init --recursive` and try again.');
            process.exit(1);
      }

      const code = await runEslint(directories);
      if (code !== 0) {
            console.error('');
            console.error(`[lint-clean] ESLint reported problems in directories that are supposed to be clean.`);
            console.error(`Fix them — removing the directory from ${LIST_FILE} is not the fix.`);
            process.exit(1);
      }

      console.log(`[lint-clean] OK: ${directories.length} directories clean (0 errors, 0 warnings).`);
}

main().catch((error) => {
      console.error('[lint-clean] Failed to run check:', error);
      process.exit(1);
});
