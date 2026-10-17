/**
 * End-to-end check of the TS CLI's `scene slice`: build a scene from a cube,
 * slice it with a bundled printer, and check what the Rust slicer reports.
 *
 * It starts the CLI the way its usage line does (`tsx scripts/dragonfruit-ts-cli.ts`)
 * instead of importing its functions, because what broke after #801 was the
 * CLI's own loading: every command died on a Lingui macro before running.
 *
 * Needs the release build of `rust/dragonfruit-cli` (the CLI shells out to it)
 * and the generated registries (`precheck:scene-slice` generates them).
 *
 *   npm run check:scene-slice
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const cliScript = join(root, 'scripts', 'dragonfruit-ts-cli.ts');
const rustCli = join(root, 'rust', 'dragonfruit-cli', 'target', 'release', 'dragonfruit-cli');
const printer = join(root, 'scripts', 'bench', 'printers', 'saturn_2-bundle.json');

const CUBE_MM = 20;
// Floating above the plate, so `place-on-platform` has to move it for the
// layer count to come out right.
const CUBE_LIFT_MM = 5;

/** Binary STL of an axis-aligned cube from (0, 0, z0) to (size, size, z0 + size). */
function cubeStl(size, z0) {
  const v = [];
  for (const x of [0, size]) for (const y of [0, size]) for (const z of [z0, z0 + size]) v.push([x, y, z]);
  const faces = [
    [0, 2, 3], [0, 3, 1], [4, 5, 7], [4, 7, 6], [0, 1, 5], [0, 5, 4],
    [2, 6, 7], [2, 7, 3], [0, 4, 6], [0, 6, 2], [1, 3, 7], [1, 7, 5],
  ];
  const buf = Buffer.alloc(84 + faces.length * 50);
  buf.writeUInt32LE(faces.length, 80);
  faces.forEach((face, i) => {
    let o = 84 + i * 50 + 12; // normal left at zero; the loader recomputes it
    for (const index of face) {
      for (const c of v[index]) { buf.writeFloatLE(c, o); o += 4; }
    }
  });
  return buf;
}

function cli(...args) {
  return execFileSync(tsx, [cliScript, ...args], { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fail(message) {
  console.error(`check-scene-slice: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(rustCli)) {
  console.error(`check-scene-slice: ${rustCli} is missing. Build it with:\n  cargo build --release --locked --manifest-path rust/dragonfruit-cli/Cargo.toml`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'df-scene-slice-'));
try {
  const stl = join(dir, 'cube.stl');
  const scene = join(dir, 'scene.voxl');
  const output = join(dir, 'out.ctb');
  writeFileSync(stl, cubeStl(CUBE_MM, CUBE_LIFT_MM));

  cli('scene', 'create', '--o', scene);
  const model = JSON.parse(cli('scene', 'add-model', scene, '--mesh', stl, '--name', 'Cube', '--json'));
  cli('scene', 'place-on-platform', scene, '--id', model.id);
  const result = JSON.parse(cli('scene', 'slice', scene, '--o', output, '--printer', printer, '--json'));

  // A layer whose top reaches the cube's top counts, so ceil; the epsilon keeps
  // an f32 layer height from adding one at an exact multiple.
  const expectedLayers = Math.ceil(CUBE_MM / result.layer_height_mm - 1e-4);
  if (result.layers !== expectedLayers) {
    fail(`${result.layers} layers, expected ${expectedLayers} (${CUBE_MM} mm at ${result.layer_height_mm} mm)`);
  }
  if (result.model_triangle_count !== 12) {
    fail(`sliced ${result.model_triangle_count} triangles, expected the cube's 12`);
  }
  if (result.format !== '.ctb') fail(`format ${result.format}, expected .ctb`);
  if (!existsSync(output) || statSync(output).size === 0) fail(`no output at ${output}`);

  if (!process.exitCode) {
    console.log(`check-scene-slice: ok (${result.layers} layers, ${statSync(output).size} bytes)`);
  }
} catch (err) {
  // execFileSync's message already carries the child's stderr.
  fail(err.stderr !== undefined ? err.message : String(err.stack ?? err));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
