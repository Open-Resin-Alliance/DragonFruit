import { access, copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const nextRoot = path.resolve(projectRoot, '.next');
const frontendDistRoot = path.resolve(projectRoot, 'src-tauri', 'frontend-dist');
const srcIndex = path.resolve(nextRoot, 'server', 'app', 'index.html');
const dstIndex = path.resolve(frontendDistRoot, 'index.html');
const srcNextStatic = path.resolve(nextRoot, 'static');
const dstNextStatic = path.resolve(frontendDistRoot, '_next', 'static');
const srcPublic = path.resolve(projectRoot, 'public');
const srcPlugins = path.resolve(projectRoot, 'plugins');
const dstPlugins = path.resolve(frontendDistRoot, 'plugins');
const nextDev = path.resolve(nextRoot, 'dev');

// Tauri's build script watches `frontendDist`, so rewriting identical files
// there re-runs it and can recompile the whole app crate. Copy only files whose
// bytes changed, and remove stale ones, so an unchanged frontend leaves the
// directory's mtimes alone.
const seen = new Set();
let copied = 0;
let unchanged = 0;
let removed = 0;

function skipNodeModules(name) {
      return name !== 'node_modules';
}

async function ensureFileExists(filePath) {
      try {
            await access(filePath);
            return true;
      } catch {
            return false;
      }
}

async function syncFile(src, dst, relative) {
      seen.add(relative);
      try {
            const [srcStat, dstStat] = await Promise.all([stat(src), stat(dst)]);
            if (srcStat.size === dstStat.size) {
                  const [srcBytes, dstBytes] = await Promise.all([readFile(src), readFile(dst)]);
                  if (srcBytes.equals(dstBytes)) {
                        unchanged += 1;
                        return;
                  }
            }
      } catch {
            // Destination is missing or unreadable; fall through to the copy.
      }
      await mkdir(path.dirname(dst), { recursive: true });
      // A stale directory at this path would make copyFile fail.
      await rm(dst, { recursive: true, force: true });
      await copyFile(src, dst);
      copied += 1;
}

async function syncTree(srcRoot, dstRoot) {
      let entries;
      try {
            entries = await readdir(srcRoot, { withFileTypes: true });
      } catch {
            return;
      }
      for (const entry of entries) {
            if (!skipNodeModules(entry.name)) continue;
            const src = path.join(srcRoot, entry.name);
            const dst = path.join(dstRoot, entry.name);
            if (entry.isDirectory()) {
                  await syncTree(src, dst);
            } else {
                  await syncFile(src, dst, path.relative(frontendDistRoot, dst));
            }
      }
}

async function prune(root) {
      let entries;
      try {
            entries = await readdir(root, { withFileTypes: true });
      } catch {
            return;
      }
      for (const entry of entries) {
            const full = path.join(root, entry.name);
            if (entry.isDirectory()) {
                  await prune(full);
                  const remaining = await readdir(full).catch(() => []);
                  if (remaining.length === 0) await rm(full, { recursive: true, force: true });
            } else if (!seen.has(path.relative(frontendDistRoot, full))) {
                  await rm(full, { force: true });
                  removed += 1;
            }
      }
}

async function main() {
      const hasSrc = await ensureFileExists(srcIndex);
      if (!hasSrc) {
            throw new Error(`[prepare-tauri-frontend] Missing source index: ${srcIndex}`);
      }

      const hasNextStatic = await ensureFileExists(srcNextStatic);
      if (!hasNextStatic) {
            throw new Error(`[prepare-tauri-frontend] Missing Next static directory: ${srcNextStatic}`);
      }

      await mkdir(frontendDistRoot, { recursive: true });
      await syncFile(srcIndex, dstIndex, 'index.html');
      await syncTree(srcNextStatic, dstNextStatic);

      const hasPublic = await ensureFileExists(srcPublic);
      if (hasPublic) {
            await syncTree(srcPublic, frontendDistRoot);
      }

      const hasPlugins = await ensureFileExists(srcPlugins);
      if (hasPlugins) {
            await syncTree(srcPlugins, dstPlugins);
      }

      await prune(frontendDistRoot);

      // Tauri embeds everything under frontendDist. Next dev artifacts can include
      // transient turbopack files that disappear between builds and break asset embedding.
      //
      // `.next/cache` stays: frontendDist is the curated copy above, so nothing in it is
      // embedded, and it is Turbopack's persistent build cache, which CI restores between
      // runs. Deleting it here left `actions/cache` with nothing to save. Locally, a build
      // over the cache of the previous commit took 15.8 s against 25-29 s cold.
      await rm(nextDev, { recursive: true, force: true });

      console.log(
            `[prepare-tauri-frontend] Synced ${path.relative(projectRoot, frontendDistRoot)}: ` +
                  `${copied} copied, ${unchanged} unchanged, ${removed} removed`,
      );
      if (hasPublic) {
            console.log(`[prepare-tauri-frontend] Mirrored public assets from ${path.relative(projectRoot, srcPublic)}`);
      }
      if (hasPlugins) {
            console.log(`[prepare-tauri-frontend] Mirrored plugin assets from ${path.relative(projectRoot, srcPlugins)}`);
      }
      console.log(`[prepare-tauri-frontend] Removed transient dev artifacts from ${path.relative(projectRoot, nextRoot)}`);
}

main().catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
});
