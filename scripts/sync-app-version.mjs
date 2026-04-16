import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const packageJsonPath = path.join(repoRoot, 'package.json');
const cargoTomlPath = path.join(repoRoot, 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(repoRoot, 'src-tauri', 'Cargo.lock');
const tauriConfigPaths = [
      path.join(repoRoot, 'src-tauri', 'tauri.conf.json'),
      path.join(repoRoot, 'src-tauri', 'tauri.windows.conf.json'),
      path.join(repoRoot, 'src-tauri', 'tauri.linux.conf.json'),
      path.join(repoRoot, 'src-tauri', 'tauri.macos.conf.json'),
];

function replaceWithinMatch(sourceText, pattern, replacer) {
      const match = sourceText.match(pattern);
      if (!match || match.index == null) {
            return null;
      }

      const replacement = replacer(match);
      if (replacement === match[0]) {
            return sourceText;
      }

      return `${sourceText.slice(0, match.index)}${replacement}${sourceText.slice(match.index + match[0].length)}`;
}

async function readPackageVersion() {
      const packageJsonRaw = await readFile(packageJsonPath, 'utf8');
      const packageJson = JSON.parse(packageJsonRaw);
      const version = `${packageJson.version ?? ''}`.trim();
      if (!version) {
            throw new Error('[sync-app-version] package.json is missing a valid version field.');
      }
      return version;
}

async function syncTauriConfig(filePath, version) {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Object.prototype.hasOwnProperty.call(parsed, 'version')) {
            return null;
      }
      if (parsed.version === version) {
            return null;
      }

      parsed.version = version;
      await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      return path.relative(repoRoot, filePath);
}

async function syncCargoToml(version) {
      const raw = await readFile(cargoTomlPath, 'utf8');
      const updated = replaceWithinMatch(
            raw,
            /(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m,
            ([fullMatch, prefix, , suffix]) => `${prefix}${version}${suffix}`
      );

      if (updated == null) {
            throw new Error('[sync-app-version] Could not find [package] version in src-tauri/Cargo.toml.');
      }
      if (updated === raw) {
            return null;
      }

      await writeFile(cargoTomlPath, updated, 'utf8');
      return path.relative(repoRoot, cargoTomlPath);
}

async function syncCargoLock(version) {
      const raw = await readFile(cargoLockPath, 'utf8');
      const updated = replaceWithinMatch(
            raw,
            /(\[\[package\]\]\r?\nname = "dragonfruit-desktop"\r?\nversion = ")([^"]+)(")/m,
            ([fullMatch, prefix, , suffix]) => `${prefix}${version}${suffix}`
      );

      if (updated == null || updated === raw) {
            return null;
      }

      await writeFile(cargoLockPath, updated, 'utf8');
      return path.relative(repoRoot, cargoLockPath);
}

async function main() {
      const version = await readPackageVersion();
      const updatedFiles = [];

      for (const tauriConfigPath of tauriConfigPaths) {
            const updatedFile = await syncTauriConfig(tauriConfigPath, version);
            if (updatedFile) {
                  updatedFiles.push(updatedFile);
            }
      }

      const cargoTomlUpdated = await syncCargoToml(version);
      if (cargoTomlUpdated) {
            updatedFiles.push(cargoTomlUpdated);
      }

      const cargoLockUpdated = await syncCargoLock(version);
      if (cargoLockUpdated) {
            updatedFiles.push(cargoLockUpdated);
      }

      if (updatedFiles.length === 0) {
            console.log(`[sync-app-version] Already synced to ${version}.`);
            return;
      }

      console.log(`[sync-app-version] Synced version ${version} from package.json:`);
      for (const file of updatedFiles) {
            console.log(`  - ${file}`);
      }
}

main().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
});
