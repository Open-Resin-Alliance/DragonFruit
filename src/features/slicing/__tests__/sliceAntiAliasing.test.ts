import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { MaterialAntiAliasingSettings, MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { computePhysicalAaConfig } from '../autoAaPhysics';
import { DEFAULT_CLEAR_EXP_100_CURVE, DEFAULT_OPAQUE_EXP_120_230_CURVE, sampleCurveToLut, type SavedCurve } from '../lutCurves';
import {
  resolvePixelPitchMm,
  resolveSliceAntiAliasing,
  type AaAutoPresetChoice,
  type SliceAntiAliasingInput,
  type SliceAntiAliasingOverride,
} from '../sliceAntiAliasing';
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
