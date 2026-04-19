import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DEMAND_FRAMELOOP_SETTINGS,
  normalizeDemandFrameloopSettings,
  resolveDemandFrameloop,
} from '../demandFrameloopPreferences';

describe('demandFrameloopPreferences', () => {
  describe('normalizeDemandFrameloopSettings', () => {
    it('returns defaults for null or non-object input', () => {
      assert.deepEqual(normalizeDemandFrameloopSettings(null), DEFAULT_DEMAND_FRAMELOOP_SETTINGS);
      assert.deepEqual(normalizeDemandFrameloopSettings('invalid'), DEFAULT_DEMAND_FRAMELOOP_SETTINGS);
      assert.deepEqual(normalizeDemandFrameloopSettings(undefined), DEFAULT_DEMAND_FRAMELOOP_SETTINGS);
    });

    it('accepts all three values for preference', () => {
      assert.equal(normalizeDemandFrameloopSettings({ preference: true }).preference, true);
      assert.equal(normalizeDemandFrameloopSettings({ preference: false }).preference, false);
      assert.equal(normalizeDemandFrameloopSettings({ preference: null }).preference, null);
    });

    it('coerces unexpected preference values to null', () => {
      assert.equal(normalizeDemandFrameloopSettings({ preference: 'yes' }).preference, null);
      assert.equal(normalizeDemandFrameloopSettings({ preference: 1 }).preference, null);
    });

    it('defaults diagnostics overlay to false', () => {
      assert.equal(normalizeDemandFrameloopSettings({}).showDiagnosticsOverlay, false);
      assert.equal(normalizeDemandFrameloopSettings({ showDiagnosticsOverlay: 'sure' }).showDiagnosticsOverlay, false);
      assert.equal(normalizeDemandFrameloopSettings({ showDiagnosticsOverlay: true }).showDiagnosticsOverlay, true);
    });
  });

  describe('resolveDemandFrameloop', () => {
    it('platform default is always (OFF) when preference is null and no env override', () => {
      assert.equal(resolveDemandFrameloop({ preference: null, showDiagnosticsOverlay: false }), 'always');
    });

    it('respects user force-on', () => {
      assert.equal(resolveDemandFrameloop({ preference: true, showDiagnosticsOverlay: false }), 'demand');
    });

    it('respects user force-off', () => {
      assert.equal(resolveDemandFrameloop({ preference: false, showDiagnosticsOverlay: false }), 'always');
    });

    it('env override true forces demand regardless of preference', () => {
      assert.equal(
        resolveDemandFrameloop({ preference: false, showDiagnosticsOverlay: false }, true),
        'demand',
      );
      assert.equal(
        resolveDemandFrameloop({ preference: null, showDiagnosticsOverlay: false }, '1'),
        'demand',
      );
    });

    it('env override false forces always regardless of preference', () => {
      assert.equal(
        resolveDemandFrameloop({ preference: true, showDiagnosticsOverlay: false }, false),
        'always',
      );
      assert.equal(
        resolveDemandFrameloop({ preference: true, showDiagnosticsOverlay: false }, '0'),
        'always',
      );
    });

    it('ignores undefined env override and falls through to preference', () => {
      assert.equal(
        resolveDemandFrameloop({ preference: true, showDiagnosticsOverlay: false }, undefined),
        'demand',
      );
    });
  });
});
