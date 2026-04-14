/**
 * Build the VOXL thumbnail provider artifacts for the current platform
 * and copy them to the locations Tauri expects for bundling.
 *
 * Called by tauri.conf.json's `build.beforeBundleCommand`.
 *
 * Environment variables set by Tauri CLI:
 *   TAURI_ENV_PLATFORM   — "windows", "linux", or "darwin"
 *   CARGO_BUILD_TARGET   — explicit Rust target triple (cross-compile)
 */

import { execSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const platform = process.env.TAURI_ENV_PLATFORM
      ?? (process.platform === 'darwin'
            ? 'darwin'
            : process.platform === 'win32'
                  ? 'windows'
                  : process.platform === 'linux'
                        ? 'linux'
                        : undefined);
const projectRoot = process.cwd();
const cliCrateDir = path.join(projectRoot, 'rust', 'dragonfruit-voxl-thumbnail');
const comCrateDir = path.join(cliCrateDir, 'windows-com');
const binariesDir = path.join(projectRoot, 'src-tauri', 'binaries');
const winResourcesDir = path.join(projectRoot, 'src-tauri', 'windows-resources');

if (!platform) {
      console.error('[build-thumbnail-providers] Could not determine platform');
      process.exit(1);
}

// ---------------------------------------------------------------------------
// Determine the Rust target triple
// ---------------------------------------------------------------------------
let triple = process.env.CARGO_BUILD_TARGET;
if (!triple) {
      try {
            const rustcOut = execSync('rustc -vV', { encoding: 'utf8' });
            const hostLine = rustcOut.split('\n').find((l) => l.startsWith('host:'));
            triple = hostLine?.split(':')[1]?.trim();
      } catch {
            // rustc not found or failed
      }
}
if (!triple) {
      console.error('[build-thumbnail-providers] Could not determine Rust target triple');
      process.exit(1);
}

const binExt = platform === 'windows' ? '.exe' : '';
const targetArgs = process.env.CARGO_BUILD_TARGET ? ['--target', triple] : [];
// Release artifact dir differs when --target is specified
const releaseSuffix = process.env.CARGO_BUILD_TARGET
      ? path.join('target', triple, 'release')
      : path.join('target', 'release');

function run(cmd, args, cwd) {
      console.log(`[build-thumbnail-providers] ${cmd} ${args.join(' ')}`);
      const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
      if (r.status !== 0) process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------------------
// Windows — build the COM DLL and copy it to src-tauri/windows-resources/
// ---------------------------------------------------------------------------
if (platform === 'windows') {
      run('cargo', ['build', '--release', ...targetArgs], comCrateDir);

      const dllSrc = path.join(comCrateDir, releaseSuffix, 'dragonfruit_voxl_thumbnail_com.dll');
      mkdirSync(winResourcesDir, { recursive: true });
      const dllDst = path.join(winResourcesDir, 'dragonfruit_voxl_thumbnail_com.dll');
      copyFileSync(dllSrc, dllDst);
      console.log(`[build-thumbnail-providers] DLL → ${path.relative(projectRoot, dllDst)}`);
}

// ---------------------------------------------------------------------------
// Linux / macOS — build the CLI binary and copy it into src-tauri/binaries/
// (Tauri externalBin expects files named <name>-<triple>[.exe])
// ---------------------------------------------------------------------------
if (platform === 'linux' || platform === 'darwin') {
      run(
            'cargo',
            ['build', '--release', '--bin', 'dragonfruit-voxl-thumbnailer', ...targetArgs],
            cliCrateDir,
      );

      const binSrc = path.join(cliCrateDir, releaseSuffix, `dragonfruit-voxl-thumbnailer${binExt}`);
      const macExternalBinDir = path.join(cliCrateDir, releaseSuffix);
      const destinationDir = platform === 'darwin' ? macExternalBinDir : binariesDir;
      mkdirSync(destinationDir, { recursive: true });
      const binDst = path.join(destinationDir, `dragonfruit-voxl-thumbnailer-${triple}${binExt}`);
      copyFileSync(binSrc, binDst);
      console.log(`[build-thumbnail-providers] Binary → ${path.relative(projectRoot, binDst)}`);
}
