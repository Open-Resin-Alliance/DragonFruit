import assert from 'node:assert/strict';
import test from 'node:test';

import {
    memberDepartureAngleFromVerticalDeg,
    segmentAngleFromVerticalDeg,
} from '../PlacementLogic/smartPlacementSearchUtils';

/**
 * The two angle helpers answer different questions, and using the wrong one
 * silently refuses every member: `segmentAngleFromVerticalDeg` describes a
 * *descending* chain segment (socket to base), while a branch or leaf leaves
 * its knot going *up*. Feeding an ascending segment to the descending helper
 * returns Infinity, which reads as "infinitely shallow" at the gate.
 */
test('the descending chain helper and the member departure helper are not interchangeable', () => {
    const knot = { x: 0, y: 0, z: 5 };
    // A member leaving its host at 45°: 1mm out for every 1mm up.
    const firstJoint = { x: 1, y: 0, z: 6 };

    assert.equal(memberDepartureAngleFromVerticalDeg(knot, firstJoint), 45);

    // The descending helper measures drop, and a rising segment has none.
    assert.equal(segmentAngleFromVerticalDeg(knot, firstJoint), Number.POSITIVE_INFINITY);

    // Descending by the same geometry, it agrees.
    const base = { x: 1, y: 0, z: 4 };
    assert.equal(segmentAngleFromVerticalDeg(knot, base), 45);
});

test('member departure measures the shaft, not the chord', () => {
    // A knot and a tip whose chord is steep, with a first joint out laterally
    // and barely above the knot: what a member looks like leaving a host it
    // cannot leave vertically, which is the shape the chord gate waves through.
    const knot = { x: 0, y: 0, z: 5 };
    const tip = { x: 2, y: 0, z: 9.9 };
    const chordDeg = (Math.atan2(tip.z - knot.z, Math.hypot(tip.x, tip.y)) * 180) / Math.PI;

    const firstJoint = { x: 3.2, y: 0, z: 5.4 };
    const departureDeg = memberDepartureAngleFromVerticalDeg(knot, firstJoint);
    assert.ok(departureDeg > chordDeg,
        `the shaft leaves at ${departureDeg.toFixed(1)}° from vertical, shallower than its ${chordDeg.toFixed(1)}° chord`);
});
