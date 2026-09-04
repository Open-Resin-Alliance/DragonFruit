import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_UI_SCALE,
  MAX_UI_SCALE,
  DEFAULT_UI_SCALE,
  UI_SCALE_PRESETS,
  normalizeUiScale,
  getSavedUiScale,
} from './uiScalePreference';

describe('normalizeUiScale', () => {
  it('clamps values below the custom minimum to MIN_UI_SCALE', () => {
    assert.equal(normalizeUiScale(0.1), MIN_UI_SCALE);
    assert.equal(normalizeUiScale(0), MIN_UI_SCALE);
    assert.equal(normalizeUiScale(-2), MIN_UI_SCALE);
  });

  it('clamps values above the custom maximum to MAX_UI_SCALE', () => {
    assert.equal(normalizeUiScale(10), MAX_UI_SCALE);
    assert.equal(normalizeUiScale(999), MAX_UI_SCALE);
  });

  it('accepts arbitrary finite values within range (custom scale)', () => {
    assert.equal(normalizeUiScale(1.37), 1.37);
    assert.equal(normalizeUiScale(0.25), MIN_UI_SCALE);
    assert.equal(normalizeUiScale(4), MAX_UI_SCALE);
    assert.equal(normalizeUiScale(1), 1);
  });

  it('still accepts every preset quick-pick', () => {
    for (const preset of UI_SCALE_PRESETS) {
      assert.equal(normalizeUiScale(preset), preset);
    }
  });

  it('falls back to the default for non-finite or non-number input', () => {
    assert.equal(normalizeUiScale(NaN), DEFAULT_UI_SCALE);
    assert.equal(normalizeUiScale(Infinity), DEFAULT_UI_SCALE);
    assert.equal(normalizeUiScale('87'), DEFAULT_UI_SCALE);
    assert.equal(normalizeUiScale(null), DEFAULT_UI_SCALE);
    assert.equal(normalizeUiScale(undefined), DEFAULT_UI_SCALE);
    assert.equal(normalizeUiScale({}), DEFAULT_UI_SCALE);
  });

  it('keeps every preset within the custom range bounds', () => {
    for (const preset of UI_SCALE_PRESETS) {
      assert.ok(preset >= MIN_UI_SCALE && preset <= MAX_UI_SCALE);
    }
  });
});

describe('getSavedUiScale (no window in node)', () => {
  it('returns the default outside a browser environment', () => {
    assert.equal(getSavedUiScale(), DEFAULT_UI_SCALE);
  });
});
