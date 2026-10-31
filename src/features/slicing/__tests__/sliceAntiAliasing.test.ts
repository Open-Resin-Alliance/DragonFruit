import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
  buildAutoSupportHaloDefaults,
  computeSupportHaloReferenceRow,
  getAutoSupportHaloResetPatch,
  sanitizeMaterialAntiAliasingSettings,
  type MaterialAntiAliasingSettings,
  type MaterialProfile,
  type PrinterProfile,
} from '@/features/profiles/profileStore';
import { computePhysicalAaConfig } from '../autoAaPhysics';
import { DEFAULT_CLEAR_EXP_100_CURVE, DEFAULT_OPAQUE_EXP_120_230_CURVE, sampleCurveToLut, type SavedCurve } from '../lutCurves';
import { resolveEffectiveAaSettings } from '../resolveEffectiveAaSettings';
import {
  resolvePixelPitchMm,
  resolveSliceAntiAliasing,
  resolveSliceJobAntiAliasing,
  type AaAutoPresetChoice,
  type SliceAntiAliasingInput,
  type SliceAntiAliasingOverride,
} from '../sliceAntiAliasing';
import { assembleSliceJob, buildNativeSliceJob } from '../sliceJobAssembly';
import { MATERIALS, PRINTERS, appMaterial, material } from './helpers/sliceJobFixtures';

/**
 * Pins what `resolveSliceAntiAliasing` decides today, for every printer fixture,
 * auto preset and a set of overrides. Regenerate with `UPDATE_SLICE_AA_GOLDEN=1`
 * only when a change to the decision is intended, and review the diff of the
 * golden file like code.
 */

const GOLDEN_PATH = join(__dirname, 'fixtures/sliceAntiAliasing.golden.json');
const UPDATE = process.env.UPDATE_SLICE_AA_GOLDEN === '1';

const PRESETS: AaAutoPresetChoice[] = ['raw', 'sharp', 'balanced', 'smooth'];

const STEEP_CURVE: SavedCurve = {
  id: 'steep',
  name: 'Steep',
  points: [{ x: 0, y: 0.2 }, { x: 0.5, y: 0.4 }, { x: 1, y: 0.75 }],
};

const override = (settings: Partial<MaterialAntiAliasingSettings>, minimumAaAlphaPercent?: number): SliceAntiAliasingOverride => ({
  antiAliasingSettings: { enableOverride: true, ...settings },
  ...(minimumAaAlphaPercent === undefined ? {} : { minimumAaAlphaPercent }),
});

type Scenario = { label: string; override?: SliceAntiAliasingOverride; materialName?: string };

const SCENARIOS: Scenario[] = [
  { label: 'auto' },
  { label: 'auto, clear resin by name', materialName: 'Water Clear resin' },
  { label: 'override Off', override: override({ mode: 'Off' }) },
  { label: 'override Blur, LUT gray', override: override({ mode: 'Blur', level: '8x', blurBrushRadiusPx: 2 }) },
  {
    label: 'override Blur, minimum gray, custom kernels',
    override: override({
      mode: 'Blur',
      level: '4x',
      blurGraySourceMode: 'minimum',
      useCustomBlurBrushRadius: true,
      blurBrushKernel: 'box',
      blurBrushSigmaX: 1.234,
    }, 40),
  },
  { label: 'override 3DAA, opaque', override: override({ mode: '3DAA', level: '16x', zBlurRadiusLayers: 2, zaaPattern: 'base2' }) },
  { label: 'override 3DAA, clear', override: override({ mode: '3DAA', level: '8x', zBlendResinType: 'clear' }) },
  { label: 'override 3DAA, custom curve', override: override({ mode: '3DAA', level: '32x', zBlendResinType: 'custom', selectedLutCurveId: 'steep' }) },
];

const LIBRARY: SavedCurve[] = [STEEP_CURVE];

function lutSummary(lut: number[] | undefined): unknown {
  if (!lut) return lut;
  const known = new Map([
    [JSON.stringify(sampleCurveToLut(DEFAULT_OPAQUE_EXP_120_230_CURVE)), 'default opaque'],
    [JSON.stringify(sampleCurveToLut(DEFAULT_CLEAR_EXP_100_CURVE)), 'default clear'],
    [JSON.stringify(sampleCurveToLut(STEEP_CURVE.points)), 'steep'],
  ]);
  return known.get(JSON.stringify(lut)) ?? { length: lut.length, sum: lut.reduce((a, b) => a + b, 0) };
}

type Fixture = { printer: PrinterProfile; material: MaterialProfile };
let fixtures: Map<string, Fixture> | null = null;
function fixtureFor(label: string): Fixture {
  if (!fixtures) {
    fixtures = new Map();
    for (const entry of PRINTERS) {
      const printer = entry.appPrinter();
      fixtures.set(entry.label, { printer, material: appMaterial(printer, material(MATERIALS[1])) });
    }
  }
  const fixture = fixtures.get(label);
  assert.ok(fixture, label);
  return fixture;
}

function resolveFor(printerLabel: string, preset: AaAutoPresetChoice, scenario: Scenario) {
  const { printer, material: baseMaterial } = fixtureFor(printerLabel);
  const materialProfile = scenario.materialName ? { ...baseMaterial, name: scenario.materialName } : baseMaterial;
  const resolved = resolveSliceAntiAliasing({
    printerProfile: printer,
    materialProfile,
    override: scenario.override ?? null,
    preset,
    layerHeightMm: materialProfile.layerHeightMm,
    lutCurves: LIBRARY,
  });
  return JSON.parse(JSON.stringify({
    ...resolved.options,
    zBlendCustomLut: lutSummary(resolved.options.zBlendCustomLut),
  })) as Record<string, unknown>;
}

const golden = !UPDATE && existsSync(GOLDEN_PATH)
  ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as Record<string, unknown>
  : {};
const captured: Record<string, unknown> = {};

for (const printer of PRINTERS) {
  for (const preset of PRESETS) {
    for (const scenario of SCENARIOS) {
      const label = `${printer.label}, ${preset}, ${scenario.label}`;
      test(`slice anti-aliasing is unchanged: ${label}`, () => {
        const options = resolveFor(printer.label, preset, scenario);
        captured[label] = options;
        if (UPDATE) return;
        assert.ok(label in golden, `no golden entry for "${label}"; regenerate with UPDATE_SLICE_AA_GOLDEN=1`);
        assert.deepStrictEqual(options, golden[label]);
      });
    }
  }
}

if (UPDATE) {
  test.after(() => {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(captured, null, 2)}\n`);
  });
}

// ── Behaviour, named ──────────────────────────────────────────────────────────

const SATURN_4 = PRINTERS[0].label;

function input(overrides: Partial<SliceAntiAliasingInput> = {}): SliceAntiAliasingInput {
  const { printer, material: materialProfile } = fixtureFor(SATURN_4);
  return {
    printerProfile: printer,
    materialProfile,
    override: null,
    preset: 'balanced',
    layerHeightMm: 0.05,
    lutCurves: LIBRARY,
    ...overrides,
  };
}

test('runs without a window', () => {
  assert.equal(typeof window, 'undefined');
  resolveSliceAntiAliasing(input());
});

test('raw turns anti-aliasing off but still sends the opaque LUT', () => {
  const { options } = resolveSliceAntiAliasing(input({ preset: 'raw' }));
  assert.equal(options.antiAliasingLevel, 'Off');
  assert.equal(options.antiAliasingMode, 'Coverage');
  assert.equal(lutSummary(options.zBlendCustomLut), 'default opaque');
  assert.equal(options.zBlendMaxAlphaPercent, 90);
});

test('a printer that declares antiAliasing false gets none, whatever the override says', () => {
  const { printer } = fixtureFor(SATURN_4);
  const { options } = resolveSliceAntiAliasing(input({
    printerProfile: { ...printer, antiAliasing: false },
    override: override({ mode: '3DAA', level: '16x' }),
  }));
  assert.equal(options.antiAliasingLevel, 'Off');
  assert.equal(options.antiAliasingMode, 'Coverage');
});

test('3DAA maps to the engine mode Vertical2 with the perturb kernel', () => {
  const { options } = resolveSliceAntiAliasing(input({ override: override({ mode: '3DAA', level: '8x' }) }));
  assert.equal(options.antiAliasingMode, 'Vertical2');
  assert.equal(options.antiAliasingLevel, '8x');
  assert.equal(options.zaaKernel, 'perturb');
});

test('quirk: the 3DAA look-back is always the balanced preset\'s', () => {
  const { printer } = fixtureFor(SATURN_4);
  const pitch = resolvePixelPitchMm(printer);
  const balanced = computePhysicalAaConfig('balanced', pitch.x, 0.05, pitch.y).zBlendLookBack;
  for (const preset of ['sharp', 'smooth'] as const) {
    const { options } = resolveSliceAntiAliasing(input({ preset, override: override({ mode: '3DAA', level: '8x' }) }));
    assert.equal(options.zBlendLookBack, balanced, preset);
  }
});

test('quirk: the material\'s own look-back settings never reach the job', () => {
  const plain = resolveSliceAntiAliasing(input({ override: override({ mode: '3DAA', level: '8x' }) })).options;
  const custom = resolveSliceAntiAliasing(input({
    override: override({ mode: '3DAA', level: '8x', zBlendLookBack: 9, useCustomZBlendLookBack: true, zBlendAutoMode: false }),
  })).options;
  assert.equal(custom.zBlendLookBack, plain.zBlendLookBack);
});

test('quirk: in auto mode the blur sigmas still come from the material', () => {
  const { material: base } = fixtureFor(SATURN_4);
  const materialProfile = {
    ...base,
    antiAliasingSettings: { ...base.antiAliasingSettings, blurBrushSigmaX: 2.5, zBlurSigma: 3 },
  } as MaterialProfile;
  const { options, decision } = resolveSliceAntiAliasing(input({ materialProfile }));
  assert.equal(decision.overrideEnabled, false);
  assert.equal(options.blurBrushSigmaX, 2.5);
  assert.equal(options.zBlurSigma, 3);
});

test('a custom curve missing from the library falls back to the opaque LUT, with a warning', () => {
  const { options, warnings } = resolveSliceAntiAliasing(input({
    override: override({ mode: '3DAA', level: '8x', zBlendResinType: 'custom', selectedLutCurveId: 'not-here' }),
  }));
  assert.equal(lutSummary(options.zBlendCustomLut), 'default opaque');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not-here/);
});

test('no warnings when every choice is honoured', () => {
  assert.deepStrictEqual(resolveSliceAntiAliasing(input()).warnings, []);
  assert.deepStrictEqual(resolveSliceAntiAliasing(input({
    override: override({ mode: '3DAA', level: '8x', zBlendResinType: 'custom', selectedLutCurveId: 'steep' }),
  })).warnings, []);
});

test('support tip shrink is passed through; the job decides whether it applies', () => {
  const { options } = resolveSliceAntiAliasing(input({ override: override({ mode: 'Blur', supportTipShrinkPercent: 25 }) }));
  assert.equal(options.antiAliasingMode, 'Blur');
  assert.equal(options.supportTipShrinkPercent, 25);
});

test('LUT plus Blur zeroes the minimum alpha the engine is sent', () => {
  const lut = resolveSliceAntiAliasing(input({ override: override({ mode: 'Blur', level: '4x' }, 40) })).options;
  assert.equal(lut.minimumAaAlphaPercentOverride, 0);
  const minimum = resolveSliceAntiAliasing(input({
    override: override({ mode: 'Blur', level: '4x', blurGraySourceMode: 'minimum' }, 40),
  })).options;
  assert.equal(minimum.minimumAaAlphaPercentOverride, 40);
});

test('sanitizeMaterialAntiAliasingSettings populates Stage 5 Option A calibrated defaults, migrates legacy supportHaloRadiusPx, and clamps Support Halo fields', () => {
  assert.equal(DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS.supportHaloEnabled, false);
  assert.equal(DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS.supportHaloAuto, true);
  assert.equal(DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS.supportHaloRadiusMm, 0.15);
  assert.equal(DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS.supportHaloInverseScalePercent, 100);
  assert.equal(DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS.supportHaloMaxIntensityPercent, 25);
  assert.equal(DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS.supportHaloProfile, 'donut');
  assert.equal(DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS.supportHaloScope, 'tips_only');
  assert.equal(DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS.supportHaloMaxTipDiameterMm, 0.8);

  const defaults = sanitizeMaterialAntiAliasingSettings({});
  assert.equal(defaults.supportHaloEnabled, false);
  assert.equal(defaults.supportHaloAuto, true);
  assert.equal(defaults.supportHaloRadiusMm, 0.15);
  assert.equal(defaults.supportHaloInverseScalePercent, 100);
  assert.equal(defaults.supportHaloMaxIntensityPercent, 25);
  assert.equal(defaults.supportHaloProfile, 'donut');
  assert.equal(defaults.supportHaloScope, 'tips_only');
  assert.equal(defaults.supportHaloMaxTipDiameterMm, 0.8);

  // Legacy supportHaloRadiusPx migration when supportHaloRadiusMm is absent (8 px * 0.025 = 0.20 mm)
  const migratedFromLegacyPx = sanitizeMaterialAntiAliasingSettings({
    supportHaloEnabled: true,
    supportHaloAuto: false,
    supportHaloRadiusPx: 8,
  });
  assert.equal(migratedFromLegacyPx.supportHaloRadiusMm, 0.20);
  assert.equal(migratedFromLegacyPx.supportHaloInverseScalePercent, 100);

  // When supportHaloAuto is true, sanitize forces calibrated auto defaults even if custom fields were passed
  const autoForced = sanitizeMaterialAntiAliasingSettings({
    supportHaloEnabled: true,
    supportHaloAuto: true,
    supportHaloRadiusMm: 0.35,
    supportHaloInverseScalePercent: 40,
    supportHaloMaxIntensityPercent: 80,
    supportHaloProfile: 'linear',
    supportHaloScope: 'full_supports',
    supportHaloMaxTipDiameterMm: 2.0,
  });
  assert.equal(autoForced.supportHaloEnabled, true);
  assert.equal(autoForced.supportHaloAuto, true);
  assert.equal(autoForced.supportHaloRadiusMm, 0.15);
  assert.equal(autoForced.supportHaloInverseScalePercent, 100);
  assert.equal(autoForced.supportHaloMaxIntensityPercent, 25);
  assert.equal(autoForced.supportHaloProfile, 'donut');
  assert.equal(autoForced.supportHaloScope, 'tips_only');
  assert.equal(autoForced.supportHaloMaxTipDiameterMm, 0.8);

  const clampedHigh = sanitizeMaterialAntiAliasingSettings({
    supportHaloEnabled: true,
    supportHaloAuto: false,
    supportHaloRadiusMm: 9.9,
    supportHaloInverseScalePercent: 500,
    supportHaloMaxIntensityPercent: 250,
    supportHaloProfile: 'exponential',
    supportHaloScope: 'full_supports',
    supportHaloMaxTipDiameterMm: 12.5,
  });
  assert.equal(clampedHigh.supportHaloEnabled, true);
  assert.equal(clampedHigh.supportHaloAuto, false);
  assert.equal(clampedHigh.supportHaloRadiusMm, 0.50);
  assert.equal(clampedHigh.supportHaloInverseScalePercent, 200);
  assert.equal(clampedHigh.supportHaloMaxIntensityPercent, 100);
  assert.equal(clampedHigh.supportHaloProfile, 'exponential');
  assert.equal(clampedHigh.supportHaloScope, 'full_supports');
  assert.equal(clampedHigh.supportHaloMaxTipDiameterMm, 5.0);

  const clampedLow = sanitizeMaterialAntiAliasingSettings({
    supportHaloEnabled: false,
    supportHaloAuto: false,
    supportHaloRadiusMm: -0.3,
    supportHaloInverseScalePercent: -50,
    supportHaloMaxIntensityPercent: -15,
    supportHaloProfile: 'invalid-profile',
    supportHaloScope: 'invalid-scope',
    supportHaloMaxTipDiameterMm: 0.01,
  });
  assert.equal(clampedLow.supportHaloEnabled, false);
  assert.equal(clampedLow.supportHaloAuto, false);
  assert.equal(clampedLow.supportHaloRadiusMm, 0.02);
  assert.equal(clampedLow.supportHaloInverseScalePercent, 0);
  assert.equal(clampedLow.supportHaloMaxIntensityPercent, 5);
  assert.equal(clampedLow.supportHaloProfile, 'donut');
  assert.equal(clampedLow.supportHaloScope, 'tips_only');
  assert.equal(clampedLow.supportHaloMaxTipDiameterMm, 0.1);
});

test('getAutoSupportHaloResetPatch and buildAutoSupportHaloDefaults reset all Support Halo parameters without pitch dependency', () => {
  const defaultReset = getAutoSupportHaloResetPatch();
  assert.deepEqual(defaultReset, {
    supportHaloRadiusMm: 0.15,
    supportHaloInverseScalePercent: 100,
    supportHaloMaxIntensityPercent: 25,
    supportHaloProfile: 'donut',
    supportHaloScope: 'tips_only',
    supportHaloMaxTipDiameterMm: 0.8,
  });
  assert.deepEqual(buildAutoSupportHaloDefaults(), defaultReset);
});

test('computeSupportHaloReferenceRow computes exact Option A Inverse Mode (100%) and Fixed Mode (0%) preview metrics', () => {
  const inverseRow020 = computeSupportHaloReferenceRow(0.20, DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS, 0.019, 0.024);
  const inverseRow040 = computeSupportHaloReferenceRow(0.40, DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS, 0.019, 0.024);
  const inverseRow060 = computeSupportHaloReferenceRow(0.60, DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS, 0.019, 0.024);

  assert.equal(inverseRow020.haloRadiusMm, 0.2);
  assert.equal(inverseRow020.totalDiameterMm, 0.6);
  assert.equal(inverseRow020.pixelsX, 11);
  assert.equal(inverseRow020.pixelsY, 8);
  assert.equal(inverseRow020.peakIntensityPercent, 25);
  assert.equal(inverseRow020.peakPwmU8, 161);

  assert.equal(inverseRow040.haloRadiusMm, 0.15);
  assert.equal(inverseRow040.totalDiameterMm, 0.7);
  assert.equal(inverseRow040.pixelsX, 8);
  assert.equal(inverseRow040.pixelsY, 6);
  assert.equal(inverseRow040.peakIntensityPercent, 25);
  assert.equal(inverseRow040.peakPwmU8, 161);

  assert.equal(inverseRow060.haloRadiusMm, 0.075);
  assert.equal(inverseRow060.totalDiameterMm, 0.75);
  assert.equal(inverseRow060.pixelsX, 4);
  assert.equal(inverseRow060.pixelsY, 3);
  assert.equal(inverseRow060.peakIntensityPercent, 13);
  assert.equal(inverseRow060.peakPwmU8, 128);

  const fixedSettings = {
    ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
    supportHaloAuto: false,
    supportHaloRadiusMm: 0.15,
    supportHaloInverseScalePercent: 0,
  };
  const fixedRow020 = computeSupportHaloReferenceRow(0.20, fixedSettings, 0.019, 0.024);
  const fixedRow040 = computeSupportHaloReferenceRow(0.40, fixedSettings, 0.019, 0.024);
  const fixedRow060 = computeSupportHaloReferenceRow(0.60, fixedSettings, 0.019, 0.024);

  for (const row of [fixedRow020, fixedRow040, fixedRow060]) {
    assert.equal(row.haloRadiusMm, 0.15);
    assert.equal(row.pixelsX, 8);
    assert.equal(row.pixelsY, 6);
    assert.equal(row.peakIntensityPercent, 25);
    assert.equal(row.peakPwmU8, 161);
  }
  assert.equal(fixedRow020.totalDiameterMm, 0.5);
  assert.equal(fixedRow040.totalDiameterMm, 0.7);
  assert.equal(fixedRow060.totalDiameterMm, 0.9);
});

test('When supportHaloAuto is true, resolveEffectiveAaSettings, resolveSliceAntiAliasing, and buildNativeSliceJob resolve automatic defaults', () => {
  const { printer, material: baseMaterial } = fixtureFor(SATURN_4);
  const materialProfile: MaterialProfile = {
    ...baseMaterial,
    antiAliasingSettings: {
      ...baseMaterial.antiAliasingSettings,
      supportHaloEnabled: true,
      supportHaloAuto: true,
      // Custom fields should be ignored while supportHaloAuto is true
      supportHaloRadiusMm: 0.35,
      supportHaloInverseScalePercent: 30,
      supportHaloMaxIntensityPercent: 90,
      supportHaloProfile: 'linear',
      supportHaloScope: 'full_supports',
      supportHaloMaxTipDiameterMm: 2.5,
    },
  };

  const effective = resolveEffectiveAaSettings(materialProfile.antiAliasingSettings, 0.05, 0.019, 0.024, 'raw');
  assert.equal(effective.mode, 'Off');
  assert.equal(effective.supportHaloEnabled, true);
  assert.equal(effective.supportHaloAuto, true);
  assert.equal(effective.supportHaloRadiusMm, 0.15);
  assert.equal(effective.supportHaloInverseScalePercent, 100);
  assert.equal(effective.supportHaloMaxIntensityPercent, 25);
  assert.equal(effective.supportHaloProfile, 'donut');
  assert.equal(effective.supportHaloScope, 'tips_only');
  assert.equal(effective.supportHaloMaxTipDiameterMm, 0.8);

  const sliceAa = resolveSliceAntiAliasing(input({
    printerProfile: printer,
    materialProfile,
    preset: 'raw',
  }));
  assert.equal(sliceAa.options.supportHaloEnabled, true);
  assert.equal(sliceAa.options.supportHaloAuto, true);
  assert.equal(sliceAa.options.supportHaloRadiusMm, 0.15);
  assert.equal(sliceAa.options.supportHaloInverseScalePercent, 100);
  assert.equal(sliceAa.options.supportHaloMaxIntensityPercent, 25);
  assert.equal(sliceAa.options.supportHaloProfile, 'donut');
  assert.equal(sliceAa.options.supportHaloScope, 'tips_only');
  assert.equal(sliceAa.options.supportHaloMaxTipDiameterMm, 0.8);

  const assembled12k = assembleSliceJob({
    printerProfile: printer,
    materialProfile,
    scene: { totalLayers: 100, tallestObjectHeightMm: 5, models: [] },
    antiAliasing: { preset: 'raw', override: null },
  });
  const nativeJob12k = buildNativeSliceJob(assembled12k, {
    pngCompressionMode: 'auto',
    aaOnSupportsFallback: false,
    modelTriangleCount: 12,
  });
  assert.equal(nativeJob12k.supportHaloEnabled, true);
  assert.equal(nativeJob12k.supportHaloRadiusMm, 0.15);
  assert.equal(nativeJob12k.supportHaloInverseScalePercent, 100);
  assert.equal(nativeJob12k.supportHaloMaxIntensityPercent, 25);
  assert.equal(nativeJob12k.supportHaloProfile, 'donut');
  assert.equal(nativeJob12k.supportHaloScope, 'tips_only');
  assert.equal(nativeJob12k.supportHaloMaxTipDiameterMm, 0.8);
});

test('Support Halo settings propagate across resolveEffectiveAaSettings, resolveSliceAntiAliasing, resolveSliceJobAntiAliasing, and buildNativeSliceJob even when preset is raw (Off)', () => {
  const { printer, material: baseMaterial } = fixtureFor(SATURN_4);
  const haloOverrides = {
    supportHaloEnabled: true,
    supportHaloAuto: false,
    supportHaloRadiusMm: 0.28,
    supportHaloInverseScalePercent: 75,
    supportHaloMaxIntensityPercent: 65,
    supportHaloProfile: 'gaussian' as const,
    supportHaloScope: 'full_supports' as const,
    supportHaloMaxTipDiameterMm: 0.9,
  };
  const materialProfile: MaterialProfile = {
    ...baseMaterial,
    antiAliasingSettings: {
      ...baseMaterial.antiAliasingSettings,
      ...haloOverrides,
    },
  };

  const effective = resolveEffectiveAaSettings(materialProfile.antiAliasingSettings, 0.05, 0.05, 0.05, 'raw');
  assert.equal(effective.mode, 'Off');
  assert.equal(effective.supportHaloEnabled, true);
  assert.equal(effective.supportHaloAuto, false);
  assert.equal(effective.supportHaloRadiusMm, 0.28);
  assert.equal(effective.supportHaloInverseScalePercent, 75);
  assert.equal(effective.supportHaloMaxIntensityPercent, 65);
  assert.equal(effective.supportHaloProfile, 'gaussian');
  assert.equal(effective.supportHaloScope, 'full_supports');
  assert.equal(effective.supportHaloMaxTipDiameterMm, 0.9);

  const sliceAa = resolveSliceAntiAliasing(input({
    printerProfile: printer,
    materialProfile,
    preset: 'raw',
  }));
  assert.equal(sliceAa.options.antiAliasingLevel, 'Off');
  assert.equal(sliceAa.options.supportHaloEnabled, true);
  assert.equal(sliceAa.options.supportHaloAuto, false);
  assert.equal(sliceAa.options.supportHaloRadiusMm, 0.28);
  assert.equal(sliceAa.options.supportHaloInverseScalePercent, 75);
  assert.equal(sliceAa.options.supportHaloMaxIntensityPercent, 65);
  assert.equal(sliceAa.options.supportHaloProfile, 'gaussian');
  assert.equal(sliceAa.options.supportHaloScope, 'full_supports');
  assert.equal(sliceAa.options.supportHaloMaxTipDiameterMm, 0.9);

  const jobAa = resolveSliceJobAntiAliasing({
    printerProfile: printer,
    materialProfile,
    layerHeightMm: 0.05,
    request: { preset: 'raw', override: null },
  });
  assert.equal(jobAa.antiAliasingLevel, 'Off');
  assert.equal(jobAa.supportHaloEnabled, true);
  assert.equal(jobAa.supportHaloAuto, false);
  assert.equal(jobAa.supportHaloRadiusMm, 0.28);
  assert.equal(jobAa.supportHaloInverseScalePercent, 75);
  assert.equal(jobAa.supportHaloMaxIntensityPercent, 65);
  assert.equal(jobAa.supportHaloProfile, 'gaussian');
  assert.equal(jobAa.supportHaloScope, 'full_supports');
  assert.equal(jobAa.supportHaloMaxTipDiameterMm, 0.9);

  const assembled = assembleSliceJob({
    printerProfile: printer,
    materialProfile,
    scene: { totalLayers: 100, tallestObjectHeightMm: 5, models: [] },
    antiAliasing: { preset: 'raw', override: null },
  });
  const nativeJob = buildNativeSliceJob(assembled, {
    pngCompressionMode: 'auto',
    aaOnSupportsFallback: false,
    modelTriangleCount: 12,
  });
  assert.equal(nativeJob.antiAliasingLevel, 'Off');
  assert.equal(nativeJob.supportHaloEnabled, true);
  assert.equal(nativeJob.supportHaloRadiusMm, 0.28);
  assert.equal(nativeJob.supportHaloInverseScalePercent, 75);
  assert.equal(nativeJob.supportHaloMaxIntensityPercent, 65);
  assert.equal(nativeJob.supportHaloProfile, 'gaussian');
  assert.equal(nativeJob.supportHaloScope, 'full_supports');
  assert.equal(nativeJob.supportHaloMaxTipDiameterMm, 0.9);
});


