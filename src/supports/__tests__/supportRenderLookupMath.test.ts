import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeSupportRenderLookup } from '../interaction/supportRenderLookupMath';

describe('computeSupportRenderLookup', () => {
  it('maps brace segment IDs back to brace support IDs', () => {
    const braceId = 'brace-1';
    const modelId = 'model-1';

    const snapshot = computeSupportRenderLookup({
      state: {
        roots: {},
        trunks: {},
        branches: {},
        leaves: {},
        twigs: {},
        sticks: {},
        braces: {
          [braceId]: {
            id: braceId,
            modelId,
            startKnotId: 'knot-a',
            endKnotId: 'knot-b',
          },
        },
        knots: {
          'knot-a': { id: 'knot-a', parentShaftId: 'segment-a', pos: { x: 0, y: 0, z: 0 } },
          'knot-b': { id: 'knot-b', parentShaftId: 'segment-b', pos: { x: 1, y: 0, z: 0 } },
        },
      } as any,
      kickstandState: {
        kickstands: {},
        knots: {},
      },
      activePreviewSupport: null,
    });

    assert.strictEqual(snapshot.supportIdBySegmentId[`braceSegment:${braceId}`], braceId);
    assert.strictEqual(snapshot.entitySegmentModelIdById[`braceSegment:${braceId}`], modelId);
    assert.strictEqual(snapshot.supportIdByKnotId['knot-a'], braceId);
    assert.strictEqual(snapshot.supportIdByKnotId['knot-b'], braceId);
  });
});
