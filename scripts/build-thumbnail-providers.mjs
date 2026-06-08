/**
 * Build the VOXL thumbnail provider artifacts for the current platform
 * and copy them to the locations Tauri expects for bundling.
 *
 * Called by tauri.conf.json's `build.beforeBundleCommand`.
 *
 * Environment variables set by Tauri CLI:
 *   TAURI_ENV_PLATFORM   — "windows", "linux", or "darwin"
 *   CARGO_BUILD_TARGET   — explicit Rust target triple (cross-compile)
 *
 * Environment variable set by scripts/tauri-build.mjs --universal:
 *   DF_BUILD_TARGET_TRIPLE — "universal-apple-darwin" (overrides the above so we
 *                            build both Apple arches and lipo them into one fat
 *                            sidecar; there is no single rustc target for it).
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
// DF_BUILD_TARGET_TRIPLE (set by tauri-build.mjs --universal) takes precedence
// over Tauri's CARGO_BUILD_TARGET so a universal build is recognised even though
// cargo has no single "universal-apple-darwin" rustc target.
let triple = process.env.DF_BUILD_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET;
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

const isUniversal = platform === 'darwin' && triple === 'universal-apple-darwin';

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
// macOS universal — build both Apple arches as thin per-arch sidecars
// ---------------------------------------------------------------------------
// Tauri resolves externalBin using the target triple suffix. For the universal
// macOS target that means it looks for
//   ../rust/dragonfruit-voxl-thumbnail/target/release/dragonfruit-voxl-thumbnailer-universal-apple-darwin
// so we build both thin arch binaries, then `lipo` them into the universal
// sidecar Tauri expects. We keep the thin copies too because other scripts and
// debugging workflows inspect them directly.
if (isUniversal) {
      const externalBinDir = path.join(cliCrateDir, 'target', 'release');
      mkdirSync(externalBinDir, { recursive: true });
      const archBins = [];
      for (const archTriple of ['x86_64-apple-darwin', 'aarch64-apple-darwin']) {
            run(
                  'cargo',
                  ['build', '--release', '--bin', 'dragonfruit-voxl-thumbnailer', '--target', archTriple],
                  cliCrateDir,
            );
            const archBin = path.join(cliCrateDir, 'target', archTriple, 'release', 'dragonfruit-voxl-thumbnailer');
            const sidecarDst = path.join(externalBinDir, `dragonfruit-voxl-thumbnailer-${archTriple}`);
            copyFileSync(archBin, sidecarDst);
            archBins.push(sidecarDst);
            console.log(`[build-thumbnail-providers] Per-arch sidecar → ${path.relative(projectRoot, sidecarDst)}`);
      }

      const universalSidecar = path.join(externalBinDir, 'dragonfruit-voxl-thumbnailer-universal-apple-darwin');
      const lipoResult = spawnSync('lipo', ['-create', ...archBins, '-output', universalSidecar], {
            stdio: 'inherit',
      });
      if (lipoResult.status !== 0) {
            process.exit(lipoResult.status ?? 1);
      }
      console.log(`[build-thumbnail-providers] Universal sidecar → ${path.relative(projectRoot, universalSidecar)}`);
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
// Linux / macOS (single arch) — build the CLI binary and copy it into
// src-tauri/binaries/ (Tauri externalBin expects files named <name>-<triple>)
// ---------------------------------------------------------------------------
if (!isUniversal && (platform === 'linux' || platform === 'darwin')) {
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
