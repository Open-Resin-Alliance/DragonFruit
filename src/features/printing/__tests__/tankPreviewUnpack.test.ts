import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { unpackTankLayerPreviewPngs } from '@/features/slicing/tauri/nativeSlicerBridge';

function packTankEntries(entries: Array<{ tankIndex: number; bytes: number[] }>): Uint8Array {
  const total = entries.reduce((sum, entry) => sum + 8 + entry.bytes.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const entry of entries) {
    view.setUint32(offset, entry.tankIndex, true);
    view.setUint32(offset + 4, entry.bytes.length, true);
    offset += 8;
    out.set(entry.bytes, offset);
    offset += entry.bytes.length;
  }
  return out;
}

describe('unpackTankLayerPreviewPngs', () => {
  it('returns an empty list for an empty layer payload', () => {
    assert.deepEqual(unpackTankLayerPreviewPngs(new Uint8Array(0)), []);
  });

  it('unpacks multiple tank entries including non-zero tank indices', () => {
    const packed = packTankEntries([
      { tankIndex: 0, bytes: [137, 80, 78, 71] },
      { tankIndex: 2, bytes: [1, 2, 3, 4, 5] },
    ]);
    const unpacked = unpackTankLayerPreviewPngs(packed);
    assert.equal(unpacked.length, 2);
    assert.equal(unpacked[0].tankIndex, 0);
    assert.deepEqual(Array.from(unpacked[0].pngBytes), [137, 80, 78, 71]);
    assert.equal(unpacked[1].tankIndex, 2);
    assert.deepEqual(Array.from(unpacked[1].pngBytes), [1, 2, 3, 4, 5]);
  });

  it('ignores a truncated trailing header or payload', () => {
    const valid = packTankEntries([{ tankIndex: 1, bytes: [9, 8] }]);
    const truncated = new Uint8Array(valid.length + 10);
    truncated.set(valid, 0);
    const tailView = new DataView(truncated.buffer, valid.length, 10);
    tailView.setUint32(0, 3, true);
    tailView.setUint32(4, 100, true);

    const unpacked = unpackTankLayerPreviewPngs(truncated);
    assert.equal(unpacked.length, 1);
    assert.equal(unpacked[0].tankIndex, 1);
    assert.deepEqual(Array.from(unpacked[0].pngBytes), [9, 8]);
  });
});
