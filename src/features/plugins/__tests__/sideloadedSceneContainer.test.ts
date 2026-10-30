import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSideloadedSceneContainer,
  SCENE_CONTAINER_MAGIC,
} from '@/features/plugins/sideloadedSceneContainer';

type ModelSpec = {
  modelId: string;
  name?: string;
  transform?: number[];
  positions: number[];
  normals?: number[];
  indices?: number[];
};

/** Mirrors the writer side of the format, so the reader is tested against bytes. */
function buildContainer(models: ModelSpec[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode(SCENE_CONTAINER_MAGIC)];

  const u32 = (value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
  };
  const f32s = (values: number[]) => {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setFloat32(index * 4, value, true));
    return bytes;
  };

  chunks.push(u32(models.length));
  for (const model of models) {
    const meta = encoder.encode(
      JSON.stringify({
        modelId: model.modelId,
        name: model.name,
        transform: model.transform ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1],
        positionCount: model.positions.length / 3,
        indexCount: model.indices?.length ?? 0,
        hasNormals: Array.isArray(model.normals),
      }),
    );
    chunks.push(u32(meta.length), meta, f32s(model.positions));
    if (model.normals) chunks.push(f32s(model.normals));
    if (model.indices) {
      const bytes = new Uint8Array(model.indices.length * 4);
      const view = new DataView(bytes.buffer);
      model.indices.forEach((value, index) => view.setUint32(index * 4, value, true));
      chunks.push(bytes);
    }
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

test('a container parses into geometry, transform and identity', () => {
  const container = buildContainer([
    {
      modelId: 'part-1',
      name: 'Part One',
      positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
      indices: [0, 1, 2],
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1],
    },
  ]);

  const models = parseSideloadedSceneContainer(container);
  assert.equal(models.length, 1);
  assert.equal(models[0].modelId, 'part-1');
  assert.equal(models[0].objName, 'Part One');
  assert.equal(models[0].geometry.getAttribute('position').count, 3);
  assert.equal(models[0].geometry.getIndex()?.count, 3);
  assert.equal(models[0].transform.position.x, 5);
  assert.equal(models[0].transform.position.y, 6);
  assert.equal(models[0].transform.position.z, 7);
});

test('several models keep their own identity and geometry', () => {
  const container = buildContainer([
    { modelId: 'a', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
    { modelId: 'b', positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2] },
  ]);

  const models = parseSideloadedSceneContainer(container);
  assert.deepEqual(
    models.map((model) => model.modelId),
    ['a', 'b'],
  );
  assert.equal(models[1].geometry.getAttribute('position').count, 3);
});

test('a foreign header is refused', () => {
  const bytes = new Uint8Array(buildContainer([{ modelId: 'a', positions: [0, 0, 0] }]));
  bytes[0] = 'X'.charCodeAt(0);
  assert.throws(() => parseSideloadedSceneContainer(bytes.buffer), /unknown header/);
});

test('a truncated container is refused rather than half-read', () => {
  const container = buildContainer([
    { modelId: 'a', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
  ]);
  const truncated = container.slice(0, container.byteLength - 8);
  assert.throws(() => parseSideloadedSceneContainer(truncated));
});
