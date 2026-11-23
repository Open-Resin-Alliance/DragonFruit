import assert from 'node:assert/strict';
import test from 'node:test';

import { CommitStormDetector, summarizeFrameGaps } from '@/utils/debug/perfStats';

test('a smooth 60 Hz drag summarises as 60 fps with no stutters', () => {
    const summary = summarizeFrameGaps(Array.from({ length: 120 }, () => 1000 / 60));
    assert.equal(summary.frames, 120);
    assert.equal(Math.round(summary.fps), 60);
    assert.equal(Math.round(summary.p95Ms), 17);
    assert.equal(summary.over50, 0);
    assert.equal(summary.over100, 0);
});

test('a few long frames show up in p95, max and the stutter counts', () => {
    const gaps = [...Array.from({ length: 90 }, () => 16), 60, 70, 80, 120, 130, 140, 150, 160, 170, 180];
    const summary = summarizeFrameGaps(gaps);
    assert.equal(summary.p50Ms, 16);
    assert.equal(summary.p95Ms, 130);
    assert.equal(summary.maxMs, 180);
    assert.equal(summary.over50, 10);
    assert.equal(summary.over100, 7);
});

test('an empty drag summarises to zeros instead of NaN', () => {
    const summary = summarizeFrameGaps([]);
    assert.deepEqual(summary, { frames: 0, fps: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, over50: 0, over100: 0 });
});

test('the commit detector waits for a sustained rate before reporting', () => {
    const detector = new CommitStormDetector({ perSecond: 30, sustainedSeconds: 2, perTask: 20 });
    assert.equal(detector.evaluate(45, 2).report, false, 'one busy second is not a storm');
    assert.deepEqual(detector.evaluate(40, 2), { report: true, reason: 'sustained' });
    assert.equal(detector.evaluate(5, 1).report, false, 'a quiet second resets the count');
    assert.equal(detector.evaluate(45, 2).report, false);
});

test('a burst within one task is reported straight away', () => {
    const detector = new CommitStormDetector({ perSecond: 30, sustainedSeconds: 2, perTask: 20 });
    assert.deepEqual(detector.evaluate(24, 24), { report: true, reason: 'burst' });
});
