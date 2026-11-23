import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VOXL_PLATE_ORDERING_EXTENSION } from '@/features/scene/plates/plateCascade';
import { payloadOf, supportsOf } from '@/supports/__tests__/helpers/modelSupportFixtures';
import { IMPORT_PAYLOAD_COLLECTION_ORDER } from '@/supports/supportCollections';
import { parseVoxlBinaryV2, serializeVoxlDocumentV2 } from '../codec-v2';
import type { BuildVoxlDocumentInput, ParsedVoxlResult, VoxlModelEntry } from '../types';
import { meshLike, readVoxlChunks, testModel } from './voxlTestSupport';

/**
 * ADR-0045 rule 6: a CLI save keeps every field the writer accepts. The scene is
 * written by the app's writer, put through the CLI's own load and save by a
 * command that changes nothing, and read back: whatever differs, the CLI lost.
 * `scene duplicate` gets the same check for the copies it adds.
 */

const CLI = resolve(fileURLToPath(import.meta.url), '../../../../../../scripts/dragonfruit-ts-cli.ts');

/** Run the TS CLI the way a user would, under tsx. */
function runCli(...args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const MESH_A = meshLike(1);
const MESH_B = meshLike(2);
const ORIGINAL_B = meshLike(3, 16384);

const MATERIALS = [{ id: 'mat-blue', name: 'Blue Resin', printerProfileId: 'printer-a' }];

const BODIES = [
  { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), index: new Uint32Array([0, 1, 2]) },
  { positions: new Float32Array([5, 0, 0, 6, 0, 0, 5, 1, 0]), index: null },
];

/**
 * Two plates; a linked pair sharing one mesh on the first, so the writer dedups
 * their chunk; a model on the second with a saved original, a material and split
 * bodies; a support of every collection on each model.
 */
function appScene(): { input: BuildVoxlDocumentInput; meshBytes: Map<number, Uint8Array>; originals: Map<number, Uint8Array> } {
  const embedded = { mode: 'embedded-chunk' as const, mimeType: 'model/stl' };
  const input: BuildVoxlDocumentInput = {
    models: [
      testModel('m-a', { mesh: embedded, plateId: 'plate-1', linkGroupId: 'link-1' }),
      testModel('m-a-link', {
        mesh: embedded,
        plateId: 'plate-1',
        linkGroupId: 'link-1',
        transform: {
          position: { x: 30, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0.5 },
          scale: { x: 1, y: 1, z: 1 },
        },
      }),
      testModel('m-b', {
        mesh: embedded,
        plateId: 'plate-2',
        materialProfileId: 'mat-blue',
        materialBaseColor: '#a3a3a3',
        bodies: BODIES,
        bodyCenter: { x: 2, y: 3, z: 4 },
        bodyMaterialProfileIds: ['mat-blue', null],
        bodyColors: ['#3b82f6', null],
      }),
    ],
    activeModelId: 'm-b',
    selectedModelIds: ['m-a'],
    plates: [{ id: 'plate-1', name: 'First' }, { id: 'plate-2', name: 'Second' }],
    activePlateId: 'plate-2',
    supports: payloadOf(supportsOf('m-a'), supportsOf('m-b')),
    extensions: { [VOXL_PLATE_ORDERING_EXTENSION]: { mode: 'fixed', columns: 2 } },
    materials: MATERIALS,
    meta: { generator: 'DragonFruit', generatorVersion: '0.0.0-test' },
  };
  return {
    input,
    meshBytes: new Map([[0, MESH_A], [1, MESH_A], [2, MESH_B]]),
    originals: new Map([[2, ORIGINAL_B]]),
  };
}

/** The scene as the app saves it, hashes and originals included. */
async function writeAppScene(): Promise<Uint8Array> {
  const { input, meshBytes, originals } = appScene();
  // The app hands the writer each mesh's hash, which is what lets it share a chunk.
  const sha256 = new Map([...meshBytes].map(([index, bytes]) => [index, createHash('sha256').update(bytes).digest('hex')]));
  return serializeVoxlDocumentV2(input, meshBytes, sha256, {
    originalMeshBytes: originals,
    embedOriginalMesh: true,
  });
}

/** The model fields that belong to multi-body material state, compared on their own. */
const BODY_FIELDS = ['bodyCount', 'bodyMaterialProfileIds', 'bodyColors'] as const;

/** A shallow copy of `value` without `keys`. */
function omit<T extends object>(value: T, keys: readonly (keyof T)[]): Partial<T> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

/** A model without what its own cases compare: body state, and how its mesh is shared. */
function modelBasics(model: VoxlModelEntry): Partial<VoxlModelEntry> {
  return { ...omit(model, BODY_FIELDS), mesh: omit(model.mesh, ['sha256', 'chunkIndex']) as VoxlModelEntry['mesh'] };
}

function bodyFields(model: VoxlModelEntry): Partial<VoxlModelEntry> {
  return Object.fromEntries(BODY_FIELDS.map((field) => [field, model[field]]));
}

function meshSharing(model: VoxlModelEntry): Pick<VoxlModelEntry['mesh'], 'sha256' | 'chunkIndex'> {
  return { sha256: model.mesh.sha256, chunkIndex: model.mesh.chunkIndex };
}

/** Chunks of one type, keyed `TYPE[index]`. */
function chunksOfType(chunks: Map<string, Uint8Array>, type: string): Map<string, Uint8Array> {
  return new Map([...chunks].filter(([key]) => key.startsWith(`${type}[`)));
}

/** Same chunks, byte for byte; the keys first, so a lost chunk reads as one. */
function assertSameChunks(actual: Map<string, Uint8Array>, expected: Map<string, Uint8Array>): void {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [key, bytes] of expected) {
    assert.ok(Buffer.from(bytes).equals(actual.get(key) as Uint8Array), `${key} differs`);
  }
}

describe('a CLI save keeps what the app wrote', () => {
  let dir: string;
  let appBytes: Uint8Array;
  let cliBytes: Uint8Array;
  let app: ParsedVoxlResult;
  let cli: ParsedVoxlResult;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'df-cli-roundtrip-'));
    appBytes = await writeAppScene();
    const path = join(dir, 'scene.voxl');
    writeFileSync(path, appBytes);

    // No position, rotation or scale: the command loads and saves, nothing else.
    runCli('scene', 'transform-model', path, '--id', 'm-a');

    cliBytes = new Uint8Array(readFileSync(path));
    app = await parseVoxlBinaryV2(appBytes);
    cli = await parseVoxlBinaryV2(cliBytes);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test('the fixture covers every support collection', () => {
    for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
      const list = app.document.supports[key as keyof typeof app.document.supports] as unknown[] | undefined;
      assert.ok(list && list.length > 0, `no ${key} in the fixture`);
    }
  });

  test('scene: plates, active plate, selection', () => {
    assert.deepEqual(cli.document.scene, app.document.scene);
  });

  test('models: placement, plates, link groups, mesh refs', () => {
    assert.deepEqual(cli.document.models.map(modelBasics), app.document.models.map(modelBasics));
  });

  test('supports of every collection', () => {
    assert.deepEqual(cli.document.supports, app.document.supports);
  });

  test('extensions', () => {
    assert.deepEqual(cli.document.extensions, app.document.extensions);
  });

  test('meta, apart from its timestamps', () => {
    const stamps = ['createdAt', 'updatedAt'] as const;
    assert.deepEqual(omit(cli.document.meta, stamps), omit(app.document.meta, stamps));
  });

  test('every model keeps its mesh', () => {
    for (const model of app.document.models) {
      assert.deepEqual(cli.meshBytes.get(model.id), app.meshBytes.get(model.id), `mesh of ${model.id}`);
    }
  });

  test('mesh hashes, and the linked pair still sharing one chunk', () => {
    assert.equal(chunksOfType(readVoxlChunks(appBytes), 'MESH').size, 2, 'the app should share the chunk');
    assert.deepEqual(cli.document.models.map(meshSharing), app.document.models.map(meshSharing));
    assertSameChunks(
      chunksOfType(readVoxlChunks(cliBytes), 'MESH'),
      chunksOfType(readVoxlChunks(appBytes), 'MESH'),
    );
  });

  test('original full-resolution meshes', () => {
    assertSameChunks(
      chunksOfType(readVoxlChunks(cliBytes), 'ORIG'),
      chunksOfType(readVoxlChunks(appBytes), 'ORIG'),
    );
  });

  test('material profiles', () => {
    assert.deepEqual(cli.document.materials, app.document.materials);
  });

  test('split bodies and their material state', () => {
    assert.deepEqual(cli.document.models.map(bodyFields), app.document.models.map(bodyFields));
    assertSameChunks(
      chunksOfType(readVoxlChunks(cliBytes), 'BODY'),
      chunksOfType(readVoxlChunks(appBytes), 'BODY'),
    );
  });

  test('every chunk but META byte for byte, so nothing is lost, added or changed', () => {
    // META carries the timestamps, compared above without them.
    const withoutMeta = (chunks: Map<string, Uint8Array>) =>
      new Map([...chunks].filter(([key]) => !key.startsWith('META[')));
    assertSameChunks(withoutMeta(readVoxlChunks(cliBytes)), withoutMeta(readVoxlChunks(appBytes)));
  });
});

describe('scene duplicate gives each copy its source geometry', () => {
  let dir: string;
  let source: ParsedVoxlResult;
  let parsed: ParsedVoxlResult;
  let appBytes: Uint8Array;
  let bytes: Uint8Array;
  let duplicated: string[];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'df-cli-duplicate-'));
    appBytes = await writeAppScene();
    const path = join(dir, 'scene.voxl');
    writeFileSync(path, appBytes);

    ({ duplicated } = JSON.parse(
      runCli('scene', 'duplicate', path, '--id', 'm-b', '--count', '2', '--json'),
    ) as { duplicated: string[] });

    bytes = new Uint8Array(readFileSync(path));
    source = await parseVoxlBinaryV2(appBytes);
    parsed = await parseVoxlBinaryV2(bytes);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test('two copies', () => {
    assert.equal(duplicated.length, 2);
  });

  test('each copy carries the mesh of its source', () => {
    for (const id of duplicated) {
      assert.deepEqual(parsed.meshBytes.get(id), MESH_B, `copy ${id} has no mesh`);
    }
  });

  test('the copies share the source mesh chunk instead of adding their own', () => {
    assertSameChunks(chunksOfType(readVoxlChunks(bytes), 'MESH'), chunksOfType(readVoxlChunks(appBytes), 'MESH'));
  });

  test('each copy keeps the source original and split bodies', () => {
    const sourceBodies = source.bodyChunks?.get('m-b');
    assert.ok(sourceBodies);
    for (const id of duplicated) {
      assert.deepEqual(parsed.originalMeshBytes?.get(id), ORIGINAL_B, `copy ${id} has no original`);
      assert.deepEqual(parsed.bodyChunks?.get(id), sourceBodies, `copy ${id} has no bodies`);
      const copy = parsed.document.models.find((model) => model.id === id);
      assert.deepEqual(copy && bodyFields(copy), bodyFields(source.document.models[2]));
    }
  });
});
