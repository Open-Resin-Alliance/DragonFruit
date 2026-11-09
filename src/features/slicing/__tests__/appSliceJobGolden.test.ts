import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { SliceExportOrchestratorOptions } from '../sliceExportOrchestrator';
import { captureAppSliceJob, cubeModel, type CapturedSliceJob } from './helpers/captureAppSliceJob';
import { MATERIALS, PRINTERS, appMaterial, comparableMetadata, material, type PrinterFixture } from './helpers/sliceJobFixtures';

/**
 * The exact job the app hands the native slicer, pinned per printer and material.
 *
 * This guards moves of the job assembly: the jobs must come out identical before
 * and after. Regenerate with `UPDATE_SLICE_JOB_GOLDEN=1` only when a change to
 * the job is intended, and review the diff of the golden file like code.
 */

const GOLDEN_PATH = join(__dirname, 'fixtures/appSliceJobs.golden.json');
const UPDATE = process.env.UPDATE_SLICE_JOB_GOLDEN === '1';

type GoldenCase = {
  label: string;
  printer: PrinterFixture;
  materialIndex: number;
  extraOptions?: Partial<SliceExportOrchestratorOptions>;
};

const printerByLabel = (prefix: string) => {
  const printer = PRINTERS.find((entry) => entry.label.startsWith(prefix));
  assert.ok(printer, `no printer fixture starts with ${prefix}`);
  return printer;
};

const CASES: GoldenCase[] = [
  ...PRINTERS.flatMap((printer) => MATERIALS.map((fixture, materialIndex) => ({
    label: `${printer.label}, material ${fixture.label}`,
    printer,
    materialIndex,
  }))),
  // The panel's settings travel through the same job; pin a few so a move cannot
  // drop or reorder them silently.
  {
    label: '3DAA with support tip shrink, Saturn 4 Ultra 16K',
    printer: printerByLabel('Saturn 4 Ultra 16K (.ctb'),
    materialIndex: 0,
    extraOptions: {
      antiAliasing: {
        preset: 'balanced',
        override: {
          antiAliasingSettings: { enableOverride: true, mode: '3DAA', level: '8x', zaaPattern: 'halton', supportTipShrinkPercent: 20 },
          minimumAaAlphaPercent: 10,
        },
      },
    },
  },
  {
    label: 'Blur with a thumbnail, Athena II 16K 8-bit',
    printer: printerByLabel('Athena II 16K 8-bit'),
    materialIndex: 1,
    extraOptions: {
      antiAliasing: {
        preset: 'balanced',
        override: {
          antiAliasingSettings: {
            enableOverride: true, mode: 'Blur', level: '4x', blurBrushRadiusPx: 2, useCustomBlurBrushRadius: true, blurBrushKernel: 'box',
          },
        },
      },
      exportThumbnailPng: new Uint8Array([137, 80, 78, 71]),
    },
  },
  {
    label: 'panel dithering override, Saturn 4',
    printer: printerByLabel('Saturn 4 (.goo'),
    materialIndex: 0,
    extraOptions: { ditherEnabled: false, ditherBitDepth: 5, ditherDeviceGamma: 1.8 },
  },
];

function comparable(job: CapturedSliceJob): unknown {
  return JSON.parse(JSON.stringify({ ...job, metadata_json: comparableMetadata(job.metadata_json) }));
}

const captured = new Map<string, unknown>();

async function jobFor(entry: GoldenCase): Promise<unknown> {
  if (!captured.has(entry.label)) {
    const printerProfile = entry.printer.appPrinter();
    const job = await captureAppSliceJob({
      models: [cubeModel('golden-cube', 10)],
      printerProfile,
      materialProfile: appMaterial(printerProfile, material(MATERIALS[entry.materialIndex])),
      extraOptions: entry.extraOptions,
    });
    captured.set(entry.label, comparable(job));
  }
  return captured.get(entry.label);
}

const golden = !UPDATE && existsSync(GOLDEN_PATH)
  ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as Record<string, unknown>
  : {};

for (const entry of CASES) {
  test(`the app's slice job is unchanged: ${entry.label}`, async () => {
    const job = await jobFor(entry);
    if (UPDATE) return;
    assert.ok(entry.label in golden, `no golden job for "${entry.label}"; regenerate with UPDATE_SLICE_JOB_GOLDEN=1`);
    assert.deepStrictEqual(job, golden[entry.label]);
  });
}

if (UPDATE) {
  test.after(() => {
    const out = Object.fromEntries(CASES.map((entry) => [entry.label, captured.get(entry.label)]));
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(out, null, 2)}\n`);
  });
}
