import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { createProxySupportTint } from '../SupportProxyMeshLayer';
import { MARQUEE_CANDIDATE_TINT_FACTOR } from '@/utils/marqueeCandidateTint';

const BASE = new THREE.Color('#9a9a9a');
const ACTIVE = new THREE.Color('#c8752a');

function tint(overrides: Partial<Parameters<typeof createProxySupportTint>[0]> = {}) {
  return createProxySupportTint({
    selectedModelIds: new Set<string>(),
    hoverModelId: null,
    marqueeCandidateModelIds: [],
    baseColor: BASE,
    activeColor: ACTIVE,
    hoverStrength: 0.35,
    ...overrides,
  });
}

describe('proxy support tint', () => {
  it('gives an untouched model the base colour', () => {
    const color = tint()('model-a');

    assert.ok(color.equals(BASE));
  });

  it('gives a selected model the active colour', () => {
    const color = tint({ selectedModelIds: new Set(['model-a']) })('model-a');

    assert.ok(color.equals(ACTIVE));
  });

  it('moves a hovered model part way from the base to the active colour', () => {
    const color = tint({ hoverModelId: 'model-a' })('model-a');
    const expected = BASE.clone().lerp(ACTIVE, 0.35);

    assert.ok(color.equals(expected), `${color.getHexString()} should be ${expected.getHexString()}`);
    assert.ok(!color.equals(BASE) && !color.equals(ACTIVE));
  });

  it('tints a marquee candidate less far than the hovered model', () => {
    const hovered = tint({ hoverModelId: 'model-a' })('model-a');
    const candidate = tint({ marqueeCandidateModelIds: ['model-a'] })('model-a');
    const expected = BASE.clone().lerp(ACTIVE, 0.35 * MARQUEE_CANDIDATE_TINT_FACTOR);

    assert.ok(candidate.equals(expected));
    assert.ok(!candidate.equals(hovered));
  });

  it('leaves a selected model the active colour while it is hovered', () => {
    // A tint over an already-active support was the thing that made a hovered
    // support look different from its neighbours.
    const color = tint({
      selectedModelIds: new Set(['model-a']),
      hoverModelId: 'model-a',
      marqueeCandidateModelIds: ['model-a'],
    })('model-a');

    assert.ok(color.equals(ACTIVE));
  });

  it('gives a primitive with no model the base colour', () => {
    assert.ok(tint({ hoverModelId: 'model-a' })(undefined).equals(BASE));
  });
});
