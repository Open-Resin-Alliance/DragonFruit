import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateVoxelPairs, rleEncodeLabels } from '@/volumeAnalysis/IslandScan/rle';

/**
 * The candidate extraction that used to run on the main thread, per layer.
 *
 * It moved into the scan worker because shipping the label RLE instead meant
 * structured-cloning thousands of small `Int32Array`s per layer on the
 * receiving thread, ~2525 times a scan. The contract that matters is the one
 * the union loop relied on: every voxel whose label is non-zero, as `[col,
 * row]` pairs, and nothing else.
 */
test('candidateVoxelPairs: every labelled voxel, as col/row pairs', () => {
    const width = 6;
    const height = 3;
    const grid = new Int32Array(width * height);
    // Row 1: two adjacent labelled voxels. Row 2: one, at the row start.
    grid[1 * width + 2] = 5;
    grid[1 * width + 3] = 5;
    grid[2 * width + 0] = 9;

    const pairs = candidateVoxelPairs(rleEncodeLabels(grid, width, height));

    assert.deepEqual(Array.from(pairs), [2, 1, 3, 1, 0, 2]);
});

test('candidateVoxelPairs: an empty grid yields nothing', () => {
    const pairs = candidateVoxelPairs(rleEncodeLabels(new Int32Array(12), 4, 3));

    assert.equal(pairs.length, 0);
});

test('candidateVoxelPairs: zero labels are not candidates', () => {
    const width = 4;
    const grid = new Int32Array(width * 2);
    grid[0] = 0;
    grid[1] = 3;
    const pairs = candidateVoxelPairs(rleEncodeLabels(grid, width, 2));

    assert.deepEqual(Array.from(pairs), [1, 0]);
});
