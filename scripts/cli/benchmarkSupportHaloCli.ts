#!/usr/bin/env npx tsx
/**
 * Support Halo CLI Baseline Slicing Benchmark Suite (Stage 6)
 *
 * Runs the 10-AA-configuration × 2-Halo-state (20-run) benchmark matrix on `cube.voxl`
 * using `scripts/dragonfruit-ts-cli.ts scene slice` and records detailed wall-clock,
 * CPU, and per-stage performance metrics.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const TS_CLI = resolve(REPO_ROOT, 'scripts', 'dragonfruit-ts-cli.ts');
const DEFAULT_VOXL = resolve(REPO_ROOT, '..', 'agents', 'ag', 'support-halo', 'cube.voxl');
const DEFAULT_PRINTER = resolve(
  REPO_ROOT,
  'scripts',
  'bench',
  'printers',
  'saturn_4_ultra_16k-bundle.json',
);

interface BenchCaseSpec {
  id: string;
  label: string;
  cliArgs: string[];
}

const AA_CASES: BenchCaseSpec[] = [
  {
    id: 'raw',
    label: 'raw (No AA / Coverage Off)',
    cliArgs: ['--aa-preset', 'raw'],
  },
  {
    id: 'sharp',
    label: 'sharp (Auto Preset)',
    cliArgs: ['--aa-preset', 'sharp'],
  },
  {
    id: 'balanced',
    label: 'balanced (Auto Preset)',
    cliArgs: ['--aa-preset', 'balanced'],
  },
  {
    id: 'smooth',
    label: 'smooth (Auto Preset)',
    cliArgs: ['--aa-preset', 'smooth'],
  },
  {
    id: '2daa-2x',
    label: '2DAA 2x (Custom Override)',
    cliArgs: ['--aa-mode', '2DAA', '--aa-level', '2x', '--blur-radius-px', '1'],
  },
  {
    id: '2daa-4x',
    label: '2DAA 4x (Custom Override)',
    cliArgs: ['--aa-mode', '2DAA', '--aa-level', '4x', '--blur-radius-px', '2'],
  },
  {
    id: '2daa-8x',
    label: '2DAA 8x (Custom Override)',
    cliArgs: ['--aa-mode', '2DAA', '--aa-level', '8x', '--blur-radius-px', '2'],
  },
  {
    id: '3daa-2x',
    label: '3DAA 2x (Custom Override)',
    cliArgs: [
      '--aa-mode',
      '3DAA',
      '--aa-level',
      '2x',
      '--blur-radius-px',
      '1',
      '--z-blur-radius-layers',
      '1',
      '--z-blend-lookback',
      '1',
    ],
  },
  {
    id: '3daa-4x',
    label: '3DAA 4x (Custom Override)',
    cliArgs: [
      '--aa-mode',
      '3DAA',
      '--aa-level',
      '4x',
      '--blur-radius-px',
      '2',
      '--z-blur-radius-layers',
      '2',
      '--z-blend-lookback',
      '2',
    ],
  },
  {
    id: '3daa-16x',
    label: '3DAA 16x (Custom Override)',
    cliArgs: [
      '--aa-mode',
      '3DAA',
      '--aa-level',
      '16x',
      '--blur-radius-px',
      '3',
      '--z-blur-radius-layers',
      '2',
      '--z-blend-lookback',
      '3',
    ],
  },
];

export interface BenchRunRecord {
  caseId: string;
  caseLabel: string;
  haloState: 'off' | 'on';
  cliArgs: string[];
  totalCliMs: number;
  sliceWallMs: number;
  layersPerSecond: number;
  layers: number;
  modelTriangles: number;
  supportTriangles: number;
  totalTriangles: number;
  indexBuildMs: number;
  renderWallMs: number;
  renderCpuMs: number;
  haloSupportMergeCpuMs: number;
  supportMergeStageMs: number;
  encodeSupportMergeMs: number;
  postBlurCpuMs: number;
  postBlurStageMs: number;
  encodeBlurMs: number;
  encodeDitherMs: number;
  encodeSsaaDownsampleMs: number;
  zBlendMs: number;
  zBlendBackwardMs: number;
  zBlendForwardMs: number;
  crossBlendMs: number;
  tailRemapMs: number;
  encodeFormatMs: number;
  encodePngMs: number;
  archiveEncodeMs: number;
  outputBytes: number;
  peakRssMb: number;
  dither: unknown;
  antiAliasing: unknown;
  supportHalo: unknown;
}

function nsToMs(ns: unknown): number {
  return typeof ns === 'number' && Number.isFinite(ns) ? ns / 1e6 : 0;
}

function runSingleCase(
  voxlPath: string,
  printerPath: string,
  scratchDir: string,
  spec: BenchCaseSpec,
  haloState: 'off' | 'on',
): BenchRunRecord {
  const outPath = join(scratchDir, `${spec.id}-${haloState}.ctb`);
  const haloArgs = haloState === 'on' ? ['--support-halo'] : ['--no-support-halo'];
  const fullArgs = [
    '--expose-gc',
    './node_modules/tsx/dist/cli.mjs',
    TS_CLI,
    'scene',
    'slice',
    voxlPath,
    '--o',
    outPath,
    '--printer',
    printerPath,
    ...spec.cliArgs,
    ...haloArgs,
    '--json',
  ];

  const t0 = performance.now();
  try {
    const stdout = execFileSync(process.execPath, fullArgs, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const totalCliMs = performance.now() - t0;
    const parsed = JSON.parse(stdout);
    const perf = parsed.perf ?? {};
    const fileBytes = existsSync(outPath) ? statSync(outPath).size : 0;

    const supportMergeStageMs = nsToMs(perf.support_merge_ns);
    const encodeSupportMergeMs = nsToMs(perf.encode_support_merge_ns);
    const postBlurStageMs = nsToMs(perf.post_blur_ns);
    const encodeBlurMs = nsToMs(perf.encode_blur_ns);
    const encodeDitherMs = nsToMs(perf.encode_dither_ns);
    const zBlendBackwardMs = nsToMs(perf.z_blend_backward_ns);
    const zBlendForwardMs = nsToMs(perf.z_blend_forward_ns);
    const crossBlendMs = nsToMs(perf.cross_blend_ns);

    return {
      caseId: spec.id,
      caseLabel: spec.label,
      haloState,
      cliArgs: [...spec.cliArgs, ...haloArgs],
      totalCliMs: parsed._perf?.elapsed_ms ?? totalCliMs,
      sliceWallMs:
        typeof parsed.wall_s === 'number'
          ? parsed.wall_s * 1000
          : nsToMs(perf.total_ns),
      layersPerSecond: parsed.layers_per_second ?? 0,
      layers: parsed.layers ?? 0,
      modelTriangles: parsed.scene?.model_triangles ?? 0,
      supportTriangles: parsed.scene?.support_triangles ?? 0,
      totalTriangles: parsed.scene?.total_triangles ?? 0,
      indexBuildMs: nsToMs(perf.index_build_ns),
      renderWallMs: nsToMs(perf.render_wall_ns),
      renderCpuMs: nsToMs(perf.render_ns),
      haloSupportMergeCpuMs: supportMergeStageMs + encodeSupportMergeMs,
      supportMergeStageMs,
      encodeSupportMergeMs,
      postBlurCpuMs: postBlurStageMs + encodeBlurMs + encodeDitherMs,
      postBlurStageMs,
      encodeBlurMs,
      encodeDitherMs,
      encodeSsaaDownsampleMs: nsToMs(perf.encode_ssaa_downsample_ns),
      zBlendMs: zBlendBackwardMs + zBlendForwardMs + crossBlendMs,
      zBlendBackwardMs,
      zBlendForwardMs,
      crossBlendMs,
      tailRemapMs: nsToMs(perf.tail_remap_ns),
      encodeFormatMs: nsToMs(perf.encode_format_ns),
      encodePngMs: nsToMs(perf.encode_png_ns),
      archiveEncodeMs: nsToMs(perf.archive_encode_ns),
      outputBytes: fileBytes || parsed.artifact_bytes || parsed.output_bytes || 0,
      peakRssMb: (parsed.resources?.peak_rss_bytes ?? 0) / 1048576,
      dither: parsed.dither ?? null,
      antiAliasing: parsed.anti_aliasing ?? null,
      supportHalo: parsed.support_halo ?? null,
    };
  } finally {
    try {
      rmSync(outPath, { force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let voxlPath = DEFAULT_VOXL;
  let printerPath = DEFAULT_PRINTER;
  let outJsonPath: string | null = null;
  let filterIds: Set<string> | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--voxl' && args[i + 1]) {
      voxlPath = resolve(args[++i]);
    } else if (args[i] === '--printer' && args[i + 1]) {
      printerPath = resolve(args[++i]);
    } else if (args[i] === '--out' && args[i + 1]) {
      outJsonPath = resolve(args[++i]);
    } else if (args[i] === '--cases' && args[i + 1]) {
      filterIds = new Set(
        args[++i]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  }

  if (!existsSync(voxlPath)) {
    throw new Error(`VOXL file not found: ${voxlPath}`);
  }
  if (!existsSync(printerPath)) {
    throw new Error(`Printer bundle not found: ${printerPath}`);
  }

  const scratchDir = mkdtempSync(join(tmpdir(), 'df-halo-bench-'));
  try {
    const selectedCases = filterIds
      ? AA_CASES.filter((c) => filterIds!.has(c.id))
      : AA_CASES;

    console.error(
      `[bench] Warmup run (raw, no-support-halo) on ${voxlPath} with ${printerPath}...`,
    );
    runSingleCase(voxlPath, printerPath, scratchDir, AA_CASES[0], 'off');

    const records: BenchRunRecord[] = [];
    for (const spec of selectedCases) {
      for (const haloState of ['off', 'on'] as const) {
        console.error(
          `[bench] Running ${spec.id} (halo=${haloState}) [${records.length + 1}/${selectedCases.length * 2}]...`,
        );
        const rec = runSingleCase(voxlPath, printerPath, scratchDir, spec, haloState);
        records.push(rec);
        console.error(
          `  -> slice_wall=${rec.sliceWallMs.toFixed(1)}ms | render_wall=${rec.renderWallMs.toFixed(1)}ms | halo_merge_cpu=${rec.haloSupportMergeCpuMs.toFixed(1)}ms | lps=${rec.layersPerSecond.toFixed(1)}`,
        );
      }
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      voxlPath,
      printerPath,
      records,
    };

    if (outJsonPath) {
      writeFileSync(outJsonPath, JSON.stringify(summary, null, 2), 'utf-8');
      console.error(`[bench] Wrote JSON results to ${outJsonPath}`);
    } else {
      console.log(JSON.stringify(summary, null, 2));
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
