import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVoxlAuto } from '@/features/scene/voxl';
import { attachEmbeddedVoxlSceneToMetadata, type EmbedVoxlSceneModel } from '../lumenEmbeddedVoxlScene';

/** LUMEN's transport check is `lumen::chunks::voxl::is_voxl`: the V2 binary magic. */
const VOXL_V2_MAGIC = [0x56, 0x4f, 0x58, 0x4c];

function sceneModel(id: string): EmbedVoxlSceneModel {
  return {
    id,
    name: `${id}.stl`,
    visible: true,
    color: '#a3a3a3',
    polygonCount: 12,
    fileSizeBytes: 2048,
    transform: {
      position: { x: 3, y: -4, z: 5 },
      rotation: { x: 0, y: 0, z: 90 },
      scale: { x: 1, y: 1, z: 1 },
    },
  };
}

/** Metadata as the settings merge leaves it for a LUMEN profile (`metadataPath`s of the schema). */
function lumenJobMetadata(embedVoxlScene: boolean | undefined): string {
  return JSON.stringify({
    printer: { id: 'test-printer', outputFormat: '.lumen' },
    lumen: { ...(embedVoxlScene === undefined ? {} : { embedVoxlScene }) },
  });
}

/** Parsed metadata as a plain record — `JSON.parse` is the boundary, and the test asserts every field it reads. */
function readMetadata(metadataJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(metadataJson);
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'metadata is not a JSON object');
  return parsed as Record<string, unknown>;
}

function readLumenNode(metadataJson: string): Record<string, unknown> {
  const lumen = readMetadata(metadataJson).lumen;
  assert.ok(lumen !== null && typeof lumen === 'object' && !Array.isArray(lumen), 'metadata has no lumen node');
  return lumen as Record<string, unknown>;
}

test('an enabled setting bakes a base64 VOXL scene into the metadata', async () => {
  const json = await attachEmbeddedVoxlSceneToMetadata(
    lumenJobMetadata(true),
    [sceneModel('m1'), sceneModel('m2')],
  );

  const lumen = readLumenNode(json);
  assert.equal(lumen.embedVoxlScene, true);
  assert.deepEqual(readMetadata(json).printer, { id: 'test-printer', outputFormat: '.lumen' });

  const payload = lumen.voxlSceneBase64;
  assert.ok(typeof payload === 'string', 'metadata carries a base64 VOXL payload');

  const bytes = new Uint8Array(Buffer.from(payload, 'base64'));
  assert.deepEqual([...bytes.subarray(0, 4)], VOXL_V2_MAGIC);

  // Readable as a VOXL document, carrying the scene the job was sliced from.
  const parsed = parseVoxlAuto(bytes);
  assert.deepEqual(parsed.document.models.map((model) => model.id), ['m1', 'm2']);
  assert.deepEqual(parsed.document.models[0].transform.position, { x: 3, y: -4, z: 5 });
  assert.ok(Array.isArray(parsed.document.supports.roots));
});

test('a disabled or absent setting adds no payload key', async () => {
  for (const metadataJson of [lumenJobMetadata(false), lumenJobMetadata(undefined)]) {
    const json = await attachEmbeddedVoxlSceneToMetadata(metadataJson, [sceneModel('m1')]);

    assert.equal(json, metadataJson);
    assert.equal('voxlSceneBase64' in readLumenNode(json), false);
  }
});

test('an enabled setting with no models to bake leaves the metadata untouched', async () => {
  const metadataJson = lumenJobMetadata(true);

  assert.equal(await attachEmbeddedVoxlSceneToMetadata(metadataJson, []), metadataJson);
});

test('metadata that is not readable as a job payload is passed through', async () => {
  assert.equal(await attachEmbeddedVoxlSceneToMetadata('not json', [sceneModel('m1')]), 'not json');
});
