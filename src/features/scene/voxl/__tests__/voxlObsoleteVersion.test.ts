import assert from 'node:assert/strict';
import test from 'node:test';

import { detectObsoleteVoxlVersion, parseVoxlAuto, VoxlObsoleteVersionError } from '../codec';
import { serializeVoxlDocumentV2 } from '../codec-v2';
import { EMPTY_SUPPORTS } from './voxlTestSupport';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** `VOXL` magic + a little-endian uint16 container version. */
function binaryHeader(version: number, length = 16): Uint8Array {
  const out = new Uint8Array(length);
  out.set([0x56, 0x4f, 0x58, 0x4c], 0);
  out[4] = version & 0xff;
  out[5] = version >> 8;
  return out;
}

test('detectObsoleteVoxlVersion recognises both V1 shapes', () => {
  assert.equal(detectObsoleteVoxlVersion(bytes('{"magic":"VOXL","version":1}')), 'v1-json');
  assert.equal(detectObsoleteVoxlVersion(bytes('\n\t {"magic":"VOXL"}')), 'v1-json');
  assert.equal(detectObsoleteVoxlVersion(binaryHeader(1)), 'v1-binary');
});

test('detectObsoleteVoxlVersion leaves live formats and foreign bytes alone', () => {
  assert.equal(detectObsoleteVoxlVersion(binaryHeader(2)), null);
  assert.equal(detectObsoleteVoxlVersion(binaryHeader(3)), null);
  assert.equal(detectObsoleteVoxlVersion(bytes('solid cube\n')), null);
  assert.equal(detectObsoleteVoxlVersion(new Uint8Array()), null);
  // A `VOXL` magic too short to carry the version is not classifiable.
  assert.equal(detectObsoleteVoxlVersion(bytes('VOXL')), null);
});

test('parseVoxlAuto refuses a V1 scene by name instead of failing as a parse error', () => {
  assert.throws(
    () => parseVoxlAuto(bytes('{"magic":"VOXL","version":1,"meta":{}}')),
    (error: unknown) => {
      assert.ok(error instanceof VoxlObsoleteVersionError);
      assert.equal(error.detected, 'v1-json');
      return true;
    },
  );

  assert.throws(
    () => parseVoxlAuto(binaryHeader(1)),
    (error: unknown) => {
      assert.ok(error instanceof VoxlObsoleteVersionError);
      assert.equal(error.detected, 'v1-binary');
      return true;
    },
  );
});

test('parseVoxlAuto still reads a binary container and rejects a non-VOXL file', async () => {
  const input = {
    models: [],
    activeModelId: null,
    selectedModelIds: [],
    supports: EMPTY_SUPPORTS,
  };

  const parsed = parseVoxlAuto(await serializeVoxlDocumentV2(input, new Map()));
  assert.equal(parsed.document.models.length, 0);

  assert.throws(
    () => parseVoxlAuto(bytes('solid cube\n')),
    (error: unknown) => {
      assert.equal(error instanceof VoxlObsoleteVersionError, false);
      assert.match((error as Error).message, /Not a VOXL file/);
      return true;
    },
  );
});
