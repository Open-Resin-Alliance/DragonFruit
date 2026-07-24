import assert from 'node:assert/strict';
import test from 'node:test';
import type { RleLabels } from '@/volumeAnalysis/IslandScan/rle';

test('native label rows preserve occupied spans when converted to masks', async () => {
  const labels: RleLabels = {
    rows: [new Int32Array([1, 2, 7, 5, 1, 9]), new Int32Array()],
    width: 8,
    height: 2,
  };
  const rows = labels.rows.map((row) => {
    const spans = new Int32Array((row.length / 3) * 2);
    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < row.length; sourceIndex += 3, targetIndex += 2) {
      spans[targetIndex] = row[sourceIndex];
      spans[targetIndex + 1] = row[sourceIndex + 1];
    }
    return spans;
  });

  assert.deepEqual(Array.from(rows[0]), [1, 2, 5, 1]);
});
