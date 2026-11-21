import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatColor, mixSrgb, parseColor, rewriteColorMix, type Rgba } from '../legacyColorMix';

const theme: Record<string, string> = {
  '--accent': '#ec2a77',
  '--surface-1': '#1c1d21',
  '--border-subtle': 'rgba(255, 255, 255, 0.12)',
  '--alias': 'var(--accent)',
  '--mixed': 'color-mix(in srgb, var(--accent), white 50%)',
};
const lookup = (name: string) => theme[name];

function channels(text: string): Rgba {
  const parsed = parseColor(text);
  assert.ok(parsed, `not a colour: ${text}`);
  return parsed;
}

function assertClose(actual: Rgba, expected: Rgba) {
  for (const key of ['r', 'g', 'b'] as const) assert.ok(Math.abs(actual[key] - expected[key]) <= 0.5, `${key}: ${actual[key]} vs ${expected[key]}`);
  assert.ok(Math.abs(actual.a - expected.a) <= 0.001, `a: ${actual.a} vs ${expected.a}`);
}

describe('mixSrgb', () => {
  const red = { r: 255, g: 0, b: 0, a: 1 };
  const blue = { r: 0, g: 0, b: 255, a: 1 };

  it('splits evenly without percentages and gives the rest of 100% to a missing one', () => {
    assertClose(mixSrgb(red, undefined, blue, undefined)!, { r: 127.5, g: 0, b: 127.5, a: 1 });
    assertClose(mixSrgb(red, undefined, blue, 0.25)!, { r: 191.25, g: 0, b: 63.75, a: 1 });
  });

  it('scales a pair over 100% and fades a pair under it', () => {
    assertClose(mixSrgb(red, 0.6, blue, 0.6)!, { r: 127.5, g: 0, b: 127.5, a: 1 });
    assertClose(mixSrgb(red, 0.2, blue, 0.2)!, { r: 127.5, g: 0, b: 127.5, a: 0.4 });
  });

  it('mixes with premultiplied alpha, so transparent only fades the colour', () => {
    assertClose(mixSrgb(red, undefined, { r: 0, g: 0, b: 0, a: 0 }, 0.8)!, { r: 255, g: 0, b: 0, a: 0.2 });
  });

  it('rejects percentages outside 0–100% and a pair adding up to zero', () => {
    assert.equal(mixSrgb(red, 1.2, blue, undefined), null);
    assert.equal(mixSrgb(red, 0, blue, 0), null);
  });
});

describe('rewriteColorMix', () => {
  it('replaces a mix of theme variables with the colour it computes to', () => {
    const out = rewriteColorMix('color-mix(in srgb, var(--accent), var(--surface-1) 76%)', lookup)!;
    assertClose(channels(out), { r: 0.24 * 236 + 0.76 * 28, g: 0.24 * 42 + 0.76 * 29, b: 0.24 * 119 + 0.76 * 33, a: 1 });
  });

  it('keeps the rest of the value, and handles several mixes in it', () => {
    const out = rewriteColorMix('0 0 0 3px color-mix(in srgb, var(--accent), transparent 82%) inset, 0 1px color-mix(in srgb, white 50%, black)', lookup);
    assert.equal(out, '0 0 0 3px rgba(236, 42, 119, 0.18) inset, 0 1px rgb(128, 128, 128)');
  });

  it('follows variables that hold variables or other mixes, and var() fallbacks', () => {
    assert.equal(rewriteColorMix('color-mix(in srgb, var(--alias) 100%, black)', lookup), 'rgb(236, 42, 119)');
    assert.equal(rewriteColorMix('color-mix(in srgb, var(--mixed) 100%, black)', lookup), 'rgb(246, 149, 187)');
    assert.equal(rewriteColorMix('color-mix(in srgb, var(--missing, #ffffff) 100%, black)', lookup), 'rgb(255, 255, 255)');
  });

  it('takes the percentage before the colour too, and nested mixes', () => {
    assert.equal(rewriteColorMix('color-mix(in srgb, 100% color-mix(in srgb, white, black), #f00 0%)', lookup), 'rgb(128, 128, 128)');
  });

  it('mixes translucent tokens by their alpha', () => {
    const out = rewriteColorMix('color-mix(in srgb, var(--accent), var(--border-subtle) 38%)', lookup)!;
    const a = 0.62 + 0.38 * 0.12;
    assertClose(channels(out), { r: (0.62 * 236 + 0.38 * 0.12 * 255) / a, g: (0.62 * 42 + 0.38 * 0.12 * 255) / a, b: (0.62 * 119 + 0.38 * 0.12 * 255) / a, a });
  });

  it('gives up on what it cannot compute, so the caller keeps the original', () => {
    assert.equal(rewriteColorMix('color-mix(in oklab, red, blue)', lookup), null);
    assert.equal(rewriteColorMix('color-mix(in srgb, var(--unknown), blue)', lookup), null);
    assert.equal(rewriteColorMix('color-mix(in srgb, hsl(0 100% 50%), blue)', lookup), null);
    assert.equal(rewriteColorMix('color-mix(in srgb, red, blue', lookup), null);
  });

  it('leaves values without a mix alone', () => {
    assert.equal(rewriteColorMix('1px solid var(--accent)', lookup), '1px solid var(--accent)');
  });
});

describe('parseColor', () => {
  it('reads hex in all four lengths and both rgb() syntaxes', () => {
    assert.deepEqual(parseColor('#f80'), { r: 255, g: 136, b: 0, a: 1 });
    assert.deepEqual(parseColor('#ff880080'), { r: 255, g: 136, b: 0, a: 128 / 255 });
    assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
    assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  });

  it('formats opaque colours as rgb() and the rest as rgba()', () => {
    assert.equal(formatColor({ r: 1.4, g: 2.6, b: 3, a: 1 }), 'rgb(1, 3, 3)');
    assert.equal(formatColor({ r: 1, g: 2, b: 3, a: 0.12345 }), 'rgba(1, 2, 3, 0.123)');
  });
});
