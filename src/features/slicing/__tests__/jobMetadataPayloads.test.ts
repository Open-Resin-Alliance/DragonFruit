import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVoxlAuto } from '@/features/scene/voxl';
import type { PluginJobMetadataPayloadDefinition } from '@/features/plugins/complexPluginContracts';
import { attachJobMetadataPayloads } from '../jobMetadataPayloads';
import type { EmbedVoxlSceneModel } from '../voxlScenePayload';

/** A format's transport check for an embedded scene is the VOXL V2 magic. */
const VOXL_V2_MAGIC = [0x56, 0x4f, 0x58, 0x4c];

/**
 * The declaration LUMEN ships. Nothing here is named after it: the driver takes the
 * declarations as data, which is the point of the capability - a second plugin
 * asking for the same kind of payload needs no code change anywhere.
 */
const SCENE_EMBED: PluginJobMetadataPayloadDefinition = {
  settingPath: 'demo.embedScene',
  payloadPath: 'demo.sceneBase64',
  payload: 'voxl-scene',
};

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

/** Metadata as the settings merge leaves it, keyed by the schema's `metadataPath`s. */
function jobMetadata(setting: boolean | undefined): string {
  return JSON.stringify({
    printer: { id: 'test-printer', outputFormat: '.demo' },
    demo: { ...(setting === undefined ? {} : { embedScene: setting }) },
  });
}

/** Parsed metadata as a plain record — `JSON.parse` is the boundary. */
function readMetadata(metadataJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(metadataJson);
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'metadata is not a JSON object');
  return parsed as Record<string, unknown>;
}

function readNode(metadataJson: string, key: string): Record<string, unknown> {
  const node = readMetadata(metadataJson)[key];
  assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `metadata has no ${key} node`);
  return node as Record<string, unknown>;
}

test('an enabled setting bakes a base64 scene at the declared path', async () => {
  const json = await attachJobMetadataPayloads(
    jobMetadata(true),
    { models: [sceneModel('m1'), sceneModel('m2')] },
    [SCENE_EMBED],
  );

  const demo = readNode(json, 'demo');
  assert.equal(demo.embedScene, true);
  assert.deepEqual(readMetadata(json).printer, { id: 'test-printer', outputFormat: '.demo' });

  const payload = demo.sceneBase64;
  assert.ok(typeof payload === 'string', 'metadata carries a base64 payload');

  const bytes = new Uint8Array(Buffer.from(payload, 'base64'));
  assert.deepEqual([...bytes.subarray(0, 4)], VOXL_V2_MAGIC);

  // Readable as a VOXL document, carrying the scene the job was sliced from.
  const parsed = parseVoxlAuto(bytes);
  assert.deepEqual(parsed.document.models.map((model) => model.id), ['m1', 'm2']);
  assert.deepEqual(parsed.document.models[0].transform.position, { x: 3, y: -4, z: 5 });
  assert.ok(Array.isArray(parsed.document.supports.roots));
});

test('a disabled or absent setting adds no payload key', async () => {
  for (const metadataJson of [jobMetadata(false), jobMetadata(undefined)]) {
    const json = await attachJobMetadataPayloads(metadataJson, { models: [sceneModel('m1')] }, [SCENE_EMBED]);

    assert.equal(json, metadataJson);
    assert.equal('sceneBase64' in readNode(json, 'demo'), false);
  }
});

test('an enabled setting with no models to bake leaves the metadata untouched', async () => {
  const metadataJson = jobMetadata(true);

  assert.equal(await attachJobMetadataPayloads(metadataJson, { models: [] }, [SCENE_EMBED]), metadataJson);
});

test('a payload kind this build does not implement is skipped, not failed on', async () => {
  const metadataJson = jobMetadata(true);
  const unimplemented = { ...SCENE_EMBED, payload: 'something-newer' } as unknown as PluginJobMetadataPayloadDefinition;

  assert.equal(await attachJobMetadataPayloads(metadataJson, { models: [sceneModel('m1')] }, [unimplemented]), metadataJson);
});

test('metadata that is not a job payload object is passed through', async () => {
  for (const metadataJson of ['not json', '[]', 'null']) {
    assert.equal(
      await attachJobMetadataPayloads(metadataJson, { models: [sceneModel('m1')] }, [SCENE_EMBED]),
      metadataJson,
    );
  }
});
