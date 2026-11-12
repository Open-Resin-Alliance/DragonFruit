import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { installLegacyWebKitPolyfills, traceRoundRect } from '../legacyWebKitPolyfills';

function recorder() {
  const calls: Array<[string, ...number[]]> = [];
  return {
    calls,
    moveTo: (x: number, y: number) => void calls.push(['moveTo', x, y]),
    arcTo: (x1: number, y1: number, x2: number, y2: number, r: number) => void calls.push(['arcTo', x1, y1, x2, y2, r]),
    closePath: () => void calls.push(['closePath']),
  };
}

describe('installLegacyWebKitPolyfills', () => {
  it('adds AbortSignal.timeout that aborts with a TimeoutError', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const scope = { AbortSignal: {} as { timeout?: (ms: number) => AbortSignal }, AbortController, DOMException };
    installLegacyWebKitPolyfills(scope);
    const signal = scope.AbortSignal.timeout!(50);
    assert.equal(signal.aborted, false);
    mock.timers.tick(50);
    assert.equal(signal.aborted, true);
    assert.equal((signal.reason as DOMException).name, 'TimeoutError');
    mock.timers.reset();
  });

  it('keeps native implementations', () => {
    const timeout = () => new AbortController().signal;
    const roundRect = () => {};
    const scope = { AbortSignal: { timeout }, AbortController, CanvasRenderingContext2D: { prototype: { roundRect } } };
    installLegacyWebKitPolyfills(scope as never);
    assert.equal(scope.AbortSignal.timeout, timeout);
    assert.equal(scope.CanvasRenderingContext2D.prototype.roundRect, roundRect);
  });

  it('adds roundRect where the context lacks it', () => {
    const prototype: Record<string, unknown> = {};
    installLegacyWebKitPolyfills({ CanvasRenderingContext2D: { prototype } } as never);
    const path = recorder();
    (prototype.roundRect as (...args: number[]) => void).call(path, 0.5, 0.5, 63, 63, 16);
    assert.deepEqual(path.calls[0], ['moveTo', 16.5, 0.5]);
    assert.equal(path.calls.length, 6);
  });
});

describe('traceRoundRect', () => {
  it('scales radii that do not fit', () => {
    const path = recorder();
    traceRoundRect(path, 0, 0, 10, 10, 8);
    assert.deepEqual(path.calls.filter((c) => c[0] === 'arcTo').map((c) => c[5]), [5, 5, 5, 5]);
  });

  it('reads 1–4 radii in border-radius order', () => {
    const path = recorder();
    traceRoundRect(path, 0, 0, 100, 100, [1, 2, 3]);
    // arcs are drawn top-right, bottom-right, bottom-left, top-left
    assert.deepEqual(path.calls.filter((c) => c[0] === 'arcTo').map((c) => c[5]), [2, 3, 2, 1]);
  });
});
