import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  toNativeMetadataPayload,
  type NativeSolidSliceJobEnvelope,
} from '../tauri/nativeSlicerBridge';

/**
 * Guards the TS→Rust slice-job crossing.
 *
 * The job is retyped either side of a serde boundary with a hand-written mapper
 * between them, and nothing else checks that the two agree. They have not
 * always: `compute_backend` and `bvh_acceleration_enabled` were mapped in TS
 * for months against a Rust struct that never declared them.
 *
 * This asserts against the payload the live mapper *emits*, not against the
 * type it claims to emit — a field can be declared on both sides and still be
 * dropped by the mapper, which is exactly how that bug survived.
 */

const RUST_SOURCE = new URL('../../../../src-tauri/src/main.rs', import.meta.url);

type RustField = { name: string; hasDefault: boolean; aliases: string[] };

/** Pull the field list out of the `SliceJobMetadata` serde struct. */
function parseRustMetadataStruct(): RustField[] {
  const source = readFileSync(RUST_SOURCE, 'utf8');

  const start = source.indexOf('struct SliceJobMetadata {');
  assert.notEqual(start, -1, 'struct SliceJobMetadata not found in src-tauri/src/main.rs');
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, 'unterminated SliceJobMetadata struct');

  const body = source.slice(source.indexOf('{', start) + 1, end);

  const fields: RustField[] = [];
  let pendingDefault = false;
  let pendingAliases: string[] = [];

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('//')) continue;

    if (line.startsWith('#[')) {
      if (/\bdefault\b/.test(line)) pendingDefault = true;
      for (const match of line.matchAll(/alias\s*=\s*"([^"]+)"/g)) {
        pendingAliases.push(match[1]);
      }
      continue;
    }

    const field = /^(?:pub\s+)?([a-z0-9_]+)\s*:/.exec(line);
    if (field) {
      fields.push({ name: field[1], hasDefault: pendingDefault, aliases: pendingAliases });
      pendingDefault = false;
      pendingAliases = [];
    }
  }

  return fields;
}

/** A fully-populated envelope: every optional field set, so nothing is dropped for being absent. */
function completeEnvelope(): NativeSolidSliceJobEnvelope {
  return {
    outputFormat: 'ctb',
    formatVersion: 'v5',
    outputPath: '/tmp/out.ctb',
    sourceWidthPx: 11520,
    sourceHeightPx: 5120,
    widthPx: 11520,
    heightPx: 5120,
    xPackingMode: 'none',
    pngCompressionStrategy: 'balanced',
    antiAliasingLevel: '8x',
    antiAliasingMode: '3DAA',
    blurBrushRadiusPx: 2,
    blurBrushKernel: 'gaussian',
    blurBrushSigma: 0.5,
    blurBrushSigmaX: 0.5,
    blurBrushSigmaY: 0.5,
    zBlurRadiusLayers: 2,
    zBlurKernel: 'box',
    zBlurSigma: 0.5,
    aaOnSupports: true,
    minimumAaAlphaPercent: 50,
    mirrorX: false,
    mirrorY: true,
    zBlendLookBack: 4,
    zBlendMinimumAlphaPercent: 0,
    zBlendMaxAlphaPercent: 90,
    zBlendCustomLut: Array.from({ length: 256 }, (_, i) => i),
    zaaKernel: 'perturb',
    zaaPattern: 'base2',
    zaaDuplicateZ: false,
    modelTriangleCount: 10_000_000,
    containerCompressionLevel: 2,
    buildWidthMm: 218.88,
    buildDepthMm: 122.88,
    layerHeightMm: 0.05,
    totalLayers: 1200,
    exportThumbnailPngBase64: 'iVBORw0KGgo=',
    trianglesXYZ: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    meshEncoding: 'quantized_u16',
    meshQuantization: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
    metadataJson: '{}',
    ditherEnabled: true,
    ditherBitDepth: 3,
    ditherDeviceGamma: 2.2,
  };
}

test('every key the mapper emits is a field Rust declares', () => {
  const rustFields = parseRustMetadataStruct();
  const known = new Set(rustFields.flatMap((f) => [f.name, ...f.aliases]));

  const emitted = Object.keys(toNativeMetadataPayload(completeEnvelope()));
  const orphans = emitted.filter((key) => !known.has(key));

  assert.deepEqual(
    orphans,
    [],
    `mapper emits ${orphans.length} field(s) SliceJobMetadata does not declare — `
      + 'they are dropped at the serde boundary and setting them in the UI does nothing',
  );
});

test('every Rust field without a serde default is one the mapper sends', () => {
  const required = parseRustMetadataStruct().filter((f) => !f.hasDefault);

  const emitted = new Set(Object.keys(toNativeMetadataPayload(completeEnvelope())));
  const missing = required
    .filter((f) => !emitted.has(f.name) && !f.aliases.some((a) => emitted.has(a)))
    .map((f) => f.name);

  assert.deepEqual(
    missing,
    [],
    `SliceJobMetadata requires ${missing.length} field(s) the mapper never sends — `
      + 'deserialization fails at slice time',
  );
});

test('the struct parser actually found the crossing', () => {
  const fields = parseRustMetadataStruct();

  // A guard on the guard: a regex that silently matched nothing would make both
  // assertions above vacuously true.
  assert.ok(fields.length > 30, `parsed only ${fields.length} fields; parser is likely broken`);
  assert.ok(fields.some((f) => f.name === 'output_format'));
  assert.ok(fields.some((f) => f.hasDefault), 'no #[serde(default)] field parsed');
  assert.ok(
    fields.some((f) => f.aliases.includes('blur_brush_sigma')),
    'serde aliases are not being parsed',
  );
});
