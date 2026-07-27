import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { serializeVoxlDocumentV2, parseVoxlBinaryV2 } from '../codec-v2';
import { meshLike, testInput, testModel } from './voxlTestSupport';

/**
 * Stale-geometry honesty (Ph0.1 sub-phase D2).
 *
 * A tick that fires while a bake is still in flight waits, bounded. When that
 * wait expires the tick still writes — losing the autosave entirely would be
 * worse — but it writes the LAST COMMITTED chunk for that model. Presenting
 * those bytes as current would be a lie of exactly the class this arc exists to
 * remove, so the model's MODL entry records `geometryStale: true` and recovery
 * can say "this model's geometry is one operation behind".
 *
 * The flag is additive and omitted when false, so a normal scene's bytes are
 * unchanged.
 */

const MESH = meshLike(21);

describe('geometryStale', () => {
  test('is written onto exactly the affected model', async () => {
    const input = testInput([
      testModel('fresh'),
      testModel('behind', { geometryStale: true }),
    ]);

    const bin = await serializeVoxlDocumentV2(
      input,
      new Map([[0, MESH], [1, MESH]]),
      new Map([[0, 'sha-a'], [1, 'sha-b']]),
    );

    const { document } = parseVoxlBinaryV2(bin);
    assert.equal(document.models[0].geometryStale, undefined, 'a fresh model must carry no flag at all');
    assert.equal(document.models[1].geometryStale, true);
  });

  test('is omitted entirely when nothing is stale, keeping the bytes unchanged', async () => {
    const withFlagFalse = testInput([testModel('a', { geometryStale: false })]);
    const withoutFlag = testInput([testModel('a')]);

    const meshBytes = new Map([[0, MESH]]);
    const sha = new Map([[0, 'sha-a']]);

    const withFalse = await serializeVoxlDocumentV2(withFlagFalse, meshBytes, sha);
    const without = await serializeVoxlDocumentV2(withoutFlag, meshBytes, sha);

    assert.equal(
      withFalse.length,
      without.length,
      '`geometryStale: false` must serialize to nothing, not to a field',
    );
    const { document } = parseVoxlBinaryV2(withFalse);
    assert.equal(document.models[0].geometryStale, undefined);
  });
});
