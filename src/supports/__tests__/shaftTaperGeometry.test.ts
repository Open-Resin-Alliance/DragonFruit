import assert from 'node:assert/strict';
import test from 'node:test';

import { braceSpanDiameters } from '../SupportTypes/Brace/braceSpanDiameters';
import { quantizeToScale } from '@/utils/math';
import { taperWidthAlong } from '../SupportPrimitives/Shaft/shaftTaperGeometry';
import type { Brace, Knot } from '../types';

const knot = (diameter: number) => ({ diameter }) as Knot;
const brace = (diameter: number) => ({ profile: { diameter } }) as Brace;

test('a taper is shared out across the pieces of a curve', () => {
    // Five points, so four pieces spanning 2mm down to 1mm.
    const widthAt = taperWidthAlong(5, 2, 1);

    assert.equal(widthAt(0), 2);
    assert.equal(widthAt(2), 1.5);
    assert.equal(widthAt(4), 1);
});

test('a shaft with one width reads the same at every point', () => {
    const widthAt = taperWidthAlong(5, 2);

    assert.equal(widthAt(0), 2);
    assert.equal(widthAt(4), 2);
});

test('a single piece runs the whole taper', () => {
    const widthAt = taperWidthAlong(2, 2, 1);

    assert.equal(widthAt(0), 2);
    assert.equal(widthAt(1), 1);
});

test('a brace takes each end from its host knot, capped by the profile', () => {
    // A knot narrower than the profile pulls that end in; the joint offset is 0.1.
    const span = braceSpanDiameters(brace(2), knot(1.2), knot(2.5));

    assert.equal(Math.round(span.startDiameterMm * 1000) / 1000, 1.1);
    assert.equal(span.endDiameterMm, 2, 'the wider knot is capped by the profile');
    assert.equal(span.isTapered, true);
});

test('matching knots leave a brace uniform', () => {
    const span = braceSpanDiameters(brace(2), knot(2.5), knot(2.5));

    assert.equal(span.startDiameterMm, span.endDiameterMm);
    assert.equal(span.isTapered, false);
});


test('a taper ratio scales to both of its end diameters', () => {
    // The bucket's cone is `ratio` over 1; the instance scales it by the body.
    const ratio = quantizeToScale(1.1 / 2.1, 1000);
    const bottomDiameter = 0.5 * 2.1 * 2;
    const topDiameter = (ratio / 2) * 2.1 * 2;

    assert.equal(bottomDiameter, 2.1);
    assert.equal(Math.round(topDiameter * 100) / 100, 1.1);
});

test('shafts sharing a ratio share a bucket, whatever their size', () => {
    const ratioOf = (body: number, end: number) => String(quantizeToScale(end / body, 1000));

    assert.equal(ratioOf(2.1, 1.1), ratioOf(4.2, 2.2), 'twice the size, one bucket');
    assert.notEqual(ratioOf(2.1, 1.1), ratioOf(1.2, 1.1), 'a different taper is its own');
});
