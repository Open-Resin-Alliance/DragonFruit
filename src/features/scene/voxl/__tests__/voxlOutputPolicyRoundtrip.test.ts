import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { serializeVoxlDocumentV2, parseVoxlBinaryV2 } from '../codec-v2';
import { meshLike, testInput, testModel } from './voxlTestSupport';

/**
 * Ph2 — the Original/Decimated toggle survives a save/reload, and its DEFAULT
 * survives a reader that has never heard of it.
 *
 * The failure mode this pins is asymmetric and only dangerous in one direction:
 * losing `'decimated'` costs the user a re-toggle, while INVENTING it (or
 * writing `mode: 'original'` in a way a future reader could mis-parse into
 * something else) would silently print a decimated mesh. So the field is
 * written only for `'decimated'`, and absence is read as `'original'`.
 */

const MESH = meshLike(37);

describe('outputPolicy round trip', () => {
  test('a `decimated` choice survives the container', async () => {
    const input = testInput([
      testModel('original-default'),
      testModel('user-chose-decimated', { outputPolicy: { mode: 'decimated' } }),
    ]);

    const bin = await serializeVoxlDocumentV2(
      input,
      new Map([[0, MESH], [1, MESH]]),
      new Map([[0, 'sha-a'], [1, 'sha-b']]),
    );

    const { document } = parseVoxlBinaryV2(bin);
    assert.equal(
      document.models[0].outputPolicy,
      undefined,
      'a model that never met the toggle must carry no field at all',
    );
    assert.deepEqual(document.models[1].outputPolicy, { mode: 'decimated' });
  });

  test('an explicit `original` serializes to nothing, keeping the bytes unchanged', async () => {
    const withExplicitDefault = testInput([testModel('a', { outputPolicy: { mode: 'original' } })]);
    const withoutField = testInput([testModel('a')]);

    const meshBytes = new Map([[0, MESH]]);
    const sha = new Map([[0, 'sha-a']]);

    const explicit = await serializeVoxlDocumentV2(withExplicitDefault, meshBytes, sha);
    const without = await serializeVoxlDocumentV2(withoutField, meshBytes, sha);

    assert.equal(
      explicit.length,
      without.length,
      '`outputPolicy: { mode: "original" }` must serialize to nothing — a scene that '
        + 'never chose decimated has to stay byte-identical to a pre-Ph2 save',
    );
    const { document } = parseVoxlBinaryV2(explicit);
    assert.equal(document.models[0].outputPolicy, undefined);
  });
});
