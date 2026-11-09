/**
 * End-to-end check of the TS CLI's `scene slice`: build a scene from a cube,
 * slice it with a bundled printer, and check what the Rust slicer reports.
 *
 * It starts the CLI the way its usage line does (`tsx scripts/dragonfruit-ts-cli.ts`)
 * instead of importing its functions, because what broke after #801 was the
 * CLI's own loading: every command died on a Lingui macro before running.
 *
 * Two cases:
 * - One cube through create, add-model, place-on-platform and slice.
 * - A cube on each of two plates, written with the app's own writer: a CLI save
 *   has to keep the plates, and `--plate 1` and `--plate 2` have to slice the
 *   same cube at the same place. Before ADR-0045 the second plate was dropped
 *   without a word and every save made the scene single-plate.
 *
 * Needs the release build of `rust/dragonfruit-cli` (the CLI shells out to it)
 * and the generated registries (`precheck:scene-slice` generates them).
 *
 *   npm run check:scene-slice
 */
// The scene codec pulls in Lingui macros, as the CLI does.
import './test-unit/register.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseVoxlAuto } from '../src/features/scene/voxl/codec';
import { serializeVoxlDocumentV2 } from '../src/features/scene/voxl/codec-v2';
import { DYNAMIC_PLATE_ORDERING } from '../src/features/scene/plates/plateCascade';
import { computePlateFrames } from '../src/features/scene/plates/plateLayout';

const root = resolve(__dirname, '..');
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const cliScript = join(root, 'scripts', 'dragonfruit-ts-cli.ts');
const rustCli = join(root, 'rust', 'dragonfruit-cli', 'target', 'release', 'dragonfruit-cli');
const printer = join(root, 'scripts', 'bench', 'printers', 'saturn_2-bundle.json');

const CUBE_MM = 20;
// Floating above the plate, so `place-on-platform` has to move it for the
// layer count to come out right.
const CUBE_LIFT_MM = 5;
// Where two slices of the same geometry may differ: the CTB header, which
// carries per-run values. Measured: two runs of one scene differ only in 64-335.
const CTB_HEADER_NOISE_END = 336;
// Past the header, the two plates may still differ by a pixel's AA level: plate
// two's offset reaches the slicer through a float32 (fround(242.88) - 242.88 is
// 5 nm), which measured flips one level in the top layer. A missing or wrong
// offset moves the cube by a plate and changes every layer.
const MAX_LAYER_BYTES_DIFFERING = 16;

interface SliceReport {
  layers: number;
  layer_height_mm: number;
  model_triangle_count: number;
  format: string;
}

/** Binary STL of an axis-aligned cube from (0, 0, z0) to (size, size, z0 + size). */
function cubeStl(size: number, z0: number): Buffer {
  const v: number[][] = [];
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

function cli(...args: string[]): string {
  return execFileSync(tsx, [cliScript, ...args], { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fail(message: string): void {
  console.error(`check-scene-slice: ${message}`);
  process.exitCode = 1;
}

/** Fails unless the report is one 20 mm cube sliced to CTB. */
function checkCubeSlice(label: string, result: SliceReport, output: string): void {
  // A layer whose top reaches the cube's top counts, so ceil; the epsilon keeps
  // an f32 layer height from adding one at an exact multiple.
  const expectedLayers = Math.ceil(CUBE_MM / result.layer_height_mm - 1e-4);
  if (result.layers !== expectedLayers) {
    fail(`${label}: ${result.layers} layers, expected ${expectedLayers} (${CUBE_MM} mm at ${result.layer_height_mm} mm)`);
  }
  if (result.model_triangle_count !== 12) {
    fail(`${label}: sliced ${result.model_triangle_count} triangles, expected the cube's 12`);
  }
  if (result.format !== '.ctb') fail(`${label}: format ${result.format}, expected .ctb`);
  if (!existsSync(output) || statSync(output).size === 0) fail(`${label}: no output at ${output}`);
}

function slice(scene: string, output: string, ...flags: string[]): SliceReport {
  return JSON.parse(cli('scene', 'slice', scene, '--o', output, '--printer', printer, ...flags, '--json'));
}

function oneCube(dir: string, stl: string): void {
  const scene = join(dir, 'one.voxl');
  const output = join(dir, 'one.ctb');
  cli('scene', 'create', '--o', scene);
  const model = JSON.parse(cli('scene', 'add-model', scene, '--mesh', stl, '--name', 'Cube', '--json'));
  cli('scene', 'place-on-platform', scene, '--id', model.id);
  const result = slice(scene, output);
  checkCubeSlice('one cube', result, output);
  if (!process.exitCode) {
    console.log(`check-scene-slice: one cube ok (${result.layers} layers, ${statSync(output).size} bytes)`);
  }
}

async function twoPlates(dir: string, stl: string): Promise<void> {
  const scene = join(dir, 'two.voxl');
  cli('scene', 'create', '--o', scene);
  const a = JSON.parse(cli('scene', 'add-model', scene, '--mesh', stl, '--name', 'Cube A', '--json'));
  const b = JSON.parse(cli('scene', 'add-model', scene, '--mesh', stl, '--name', 'Cube B', '--json'));
  cli('scene', 'place-on-platform', scene, '--id', a.id);
  cli('scene', 'place-on-platform', scene, '--id', b.id);

  // The CLI has no command that makes a plate, so the second one is written as
  // the app writes it: B at A's place on plate two, offset by the cascade.
  const { width, depth } = JSON.parse(readFileSync(printer, 'utf-8')).printer.buildVolumeMm;
  const plates = [{ id: 'p1' }, { id: 'p2' }];
  const frames = computePlateFrames({
    plates,
    footprint: { widthMm: width, depthMm: depth, originMode: 'center' },
    ordering: DYNAMIC_PLATE_ORDERING,
  });
  const parsed = await parseVoxlAuto(readFileSync(scene));
  const doc = parsed.document;
  const modelA = doc.models.find((m) => m.id === a.id)!;
  const modelB = doc.models.find((m) => m.id === b.id)!;
  modelB.plateId = 'p2';
  modelB.transform.position = {
    ...modelA.transform.position,
    x: modelA.transform.position.x + frames[1].dxMm,
    y: modelA.transform.position.y + frames[1].dyMm,
  };
  const meshBytes = new Map<number, Uint8Array>();
  doc.models.forEach((model, index) => {
    const bytes = parsed.meshBytes.get(model.id);
    if (bytes) meshBytes.set(index, bytes);
  });
  writeFileSync(scene, await serializeVoxlDocumentV2({
    models: doc.models,
    activeModelId: doc.scene.activeModelId,
    selectedModelIds: doc.scene.selectedModelIds,
    plates,
    activePlateId: 'p1',
    supports: doc.supports,
    extensions: doc.extensions,
    meta: { generator: 'check-scene-slice' },
  }, meshBytes));

  // Any command that saves; this one leaves A where it is.
  const p = modelA.transform.position;
  cli('scene', 'transform-model', scene, '--id', a.id, '--position', `${p.x},${p.y},${p.z}`);
  const saved = (await parseVoxlAuto(readFileSync(scene))).document;
  const savedB = saved.models.find((m) => m.id === b.id);
  if (saved.scene.plates?.length !== 2 || saved.scene.activePlateId !== 'p1' || savedB?.plateId !== 'p2') {
    fail(`a CLI save lost the plates: plates ${JSON.stringify(saved.scene.plates)}, active ${saved.scene.activePlateId}, B on ${savedB?.plateId}`);
    return;
  }

  const out1 = join(dir, 'plate1.ctb');
  const out2 = join(dir, 'plate2.ctb');
  checkCubeSlice('plate 1', slice(scene, out1, '--plate', '1'), out1);
  checkCubeSlice('plate 2', slice(scene, out2, '--plate', 'p2'), out2);
  if (process.exitCode) return;

  // The same cube at the same place on its own plate: the same layers.
  const bytes1 = readFileSync(out1);
  const bytes2 = readFileSync(out2);
  if (bytes1.length !== bytes2.length) {
    fail(`plate 1 sliced to ${bytes1.length} bytes, plate 2 to ${bytes2.length}; the offset is not applied`);
    return;
  }
  let differing = 0;
  for (let i = CTB_HEADER_NOISE_END; i < bytes1.length; i++) if (bytes1[i] !== bytes2[i]) differing++;
  if (differing > MAX_LAYER_BYTES_DIFFERING) {
    fail(`plate 1 and plate 2 differ in ${differing} bytes past the header; the offset is not applied`);
    return;
  }
  console.log(`check-scene-slice: two plates ok (plates kept by a save; ${bytes1.length} bytes each, ${differing} differing past the header)`);
}

async function main(): Promise<void> {
  if (!existsSync(rustCli)) {
    console.error(`check-scene-slice: ${rustCli} is missing. Build it with:\n  cargo build --release --locked --manifest-path rust/dragonfruit-cli/Cargo.toml`);
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), 'df-scene-slice-'));
  try {
    const stl = join(dir, 'cube.stl');
    writeFileSync(stl, cubeStl(CUBE_MM, CUBE_LIFT_MM));
    oneCube(dir, stl);
    await twoPlates(dir, stl);
  } catch (err) {
    // execFileSync's message already carries the child's stderr.
    const e = err as { stderr?: unknown; message?: string; stack?: string };
    fail(e.stderr !== undefined ? String(e.message) : String(e.stack ?? err));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
