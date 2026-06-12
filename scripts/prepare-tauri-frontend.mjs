import { access, copyFile, cp, mkdir, rm } from 'node:fs/promises';
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
const nextCache = path.resolve(nextRoot, 'cache');

function skipNodeModules(sourcePath) {
      return path.basename(sourcePath) !== 'node_modules';
}

async function ensureFileExists(filePath) {
      try {
            await access(filePath);
            return true;
      } catch {
            return false;
      }
}

async function main() {
      const hasSrc = await ensureFileExists(srcIndex);
      if (!hasSrc) {
            throw new Error(`[prepare-tauri-frontend] Missing source index: ${srcIndex}`);
      }

      await rm(frontendDistRoot, { recursive: true, force: true });
      await mkdir(frontendDistRoot, { recursive: true });
      await copyFile(srcIndex, dstIndex);

      const hasNextStatic = await ensureFileExists(srcNextStatic);
      if (!hasNextStatic) {
            throw new Error(`[prepare-tauri-frontend] Missing Next static directory: ${srcNextStatic}`);
      }

      await mkdir(path.dirname(dstNextStatic), { recursive: true });
      await cp(srcNextStatic, dstNextStatic, { recursive: true, force: true, filter: skipNodeModules });

      const hasPublic = await ensureFileExists(srcPublic);
      if (hasPublic) {
            await cp(srcPublic, frontendDistRoot, { recursive: true, force: true, filter: skipNodeModules });
      }

      const hasPlugins = await ensureFileExists(srcPlugins);
      if (hasPlugins) {
            await cp(srcPlugins, dstPlugins, { recursive: true, force: true, filter: skipNodeModules });
      }

      // Tauri embeds everything under frontendDist. Next dev/cache artifacts can include
      // transient turbopack files that disappear between builds and break asset embedding.
      await rm(nextDev, { recursive: true, force: true });
      await rm(nextCache, { recursive: true, force: true });

      console.log(`[prepare-tauri-frontend] Prepared ${path.relative(projectRoot, dstIndex)} from ${path.relative(projectRoot, srcIndex)}`);
      console.log(`[prepare-tauri-frontend] Mirrored ${path.relative(projectRoot, srcNextStatic)} -> ${path.relative(projectRoot, dstNextStatic)}`);
      if (hasPublic) {
            console.log(`[prepare-tauri-frontend] Copied public assets from ${path.relative(projectRoot, srcPublic)} to ${path.relative(projectRoot, frontendDistRoot)}`);
      }
      if (hasPlugins) {
            console.log(`[prepare-tauri-frontend] Copied plugin assets from ${path.relative(projectRoot, srcPlugins)} to ${path.relative(projectRoot, dstPlugins)}`);
      }
      console.log(`[prepare-tauri-frontend] Removed transient build caches from ${path.relative(projectRoot, nextRoot)} and prepared ${path.relative(projectRoot, frontendDistRoot)}`);
}

main().catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
});
