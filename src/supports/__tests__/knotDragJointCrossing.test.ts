import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shouldStayOnCurrentSegment } from '../SupportPrimitives/Knot/knotUtils';

// Regression cover for the "knot hangs on a joint" bug. When a knot is dragged
// along a shaft that has a joint on it, the per-frame segment picker keeps the
// knot on its current segment when distances are near-equal (anti-flicker). That
// stickiness must NOT apply once the projection saturates at a segment endpoint
// (right at the joint), otherwise the knot can never cross to the neighbour until
// the neighbour beats the current segment by the full stickiness margin — which
// only happens at some camera angles, hence the intermittent "sometimes it lets
// me past" behaviour.

const STICKINESS = 1.05;
const EPS = 1e-3;

describe('shouldStayOnCurrentSegment', () => {
    it('keeps the knot on the current segment when interior and distances are near-equal', () => {
        // Mid-segment, current is slightly farther but within the 5% bias → stay (no flicker).
        assert.strictEqual(shouldStayOnCurrentSegment(0.5, 1.04, 1.0, STICKINESS, EPS), true);
    });

    it('hands off mid-segment when the neighbour is clearly closer (beyond the bias)', () => {
        // Interior but current is much farther than 5% → allow the switch.
        assert.strictEqual(shouldStayOnCurrentSegment(0.5, 1.2, 1.0, STICKINESS, EPS), false);
    });

    it('hands off at the TOP joint end even when distances are a dead tie (the bug)', () => {
        // Projection saturated at t≈1 (knot pushed up to the joint), tie distance.
        // Old code returned true here and pinned the knot; must now return false.
        assert.strictEqual(shouldStayOnCurrentSegment(1.0, 1.0, 1.0, STICKINESS, EPS), false);
        assert.strictEqual(shouldStayOnCurrentSegment(0.9995, 1.0, 1.0, STICKINESS, EPS), false);
    });

    it('hands off at the BOTTOM joint end even on a dead tie', () => {
        // Projection saturated at t≈0 (knot pushed down to the joint).
        assert.strictEqual(shouldStayOnCurrentSegment(0.0, 1.0, 1.0, STICKINESS, EPS), false);
        assert.strictEqual(shouldStayOnCurrentSegment(0.0005, 1.0, 1.0, STICKINESS, EPS), false);
    });

    it('still lets a genuinely closer current segment win in the interior', () => {
        // Current is strictly closest → obviously stay.
        assert.strictEqual(shouldStayOnCurrentSegment(0.5, 0.8, 1.0, STICKINESS, EPS), true);
    });

    it('treats just-inside-the-epsilon as interior', () => {
        // Just past the epsilon boundary → interior, bias applies.
        assert.strictEqual(shouldStayOnCurrentSegment(0.01, 1.04, 1.0, STICKINESS, EPS), true);
        assert.strictEqual(shouldStayOnCurrentSegment(0.99, 1.04, 1.0, STICKINESS, EPS), true);
    });
});
