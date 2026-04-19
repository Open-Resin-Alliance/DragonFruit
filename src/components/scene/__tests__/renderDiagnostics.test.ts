import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordFrame,
  recordInvalidation,
  getRenderStats,
  subscribeToRenderStats,
  resetRenderStats,
} from '../renderDiagnostics';

describe('renderDiagnostics', () => {
  beforeEach(() => {
    resetRenderStats(0);
  });

  it('increments totalRenders on recordFrame', () => {
    recordFrame(0);
    recordFrame(10);
    recordFrame(20);
    assert.equal(getRenderStats().totalRenders, 3);
  });

  it('computes rendersPerSec after the window closes', () => {
    // Eight frames across a 1-second window (t=0..600 then t=1000 closes).
    for (let i = 0; i < 7; i++) recordFrame(i * 100);
    recordFrame(1000);
    const stats = getRenderStats();
    assert.equal(stats.rendersPerSec, 8);
    assert.equal(stats.totalRenders, 8);
  });

  it('tracks invalidations independently', () => {
    recordFrame(0);
    recordInvalidation(5);
    recordInvalidation(10);
    const stats = getRenderStats();
    assert.equal(stats.invalidations, 2);
    assert.equal(stats.totalRenders, 1);
  });

  it('notifies subscribers after the emit-throttle window elapses', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeToRenderStats((stats) => {
      seen.push(stats.totalRenders);
    });

    recordFrame(0);       // emits (first call after reset, lastEmitAt=0, now=0, diff=0 → no emit yet)
    recordFrame(50);      // 50ms later — still under 100ms throttle
    recordFrame(150);     // 150ms — passes throttle → emit
    recordFrame(200);     // under throttle again
    recordFrame(300);     // passes throttle → emit

    unsubscribe();
    assert.ok(seen.length >= 2, `expected at least 2 emits, got ${seen.length}`);
  });

  it('allows unsubscribe to stop notifications', () => {
    let count = 0;
    const unsubscribe = subscribeToRenderStats(() => { count++; });
    recordFrame(0);
    recordFrame(200);
    unsubscribe();
    const countBefore = count;
    recordFrame(400);
    recordFrame(600);
    assert.equal(count, countBefore);
  });

  it('reset clears counters and emits zeroed snapshot', () => {
    recordFrame(0);
    recordFrame(10);
    recordInvalidation(20);

    const seen: number[] = [];
    subscribeToRenderStats((stats) => { seen.push(stats.totalRenders); });

    resetRenderStats(1000);

    assert.equal(getRenderStats().totalRenders, 0);
    assert.equal(getRenderStats().invalidations, 0);
    assert.deepEqual(seen, [0]);
  });
});
