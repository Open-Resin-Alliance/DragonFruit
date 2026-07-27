import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { normalizeMeshHealthReportForTest } from '@/utils/meshRepair';

/**
 * Ph1 CP3 — the UNKNOWN contract, end to end.
 *
 * `minimal_analysis` (the classify-only tier) computes no topology whatsoever
 * and returned a hardcoded `is_watertight: false`. A reader cannot tell that
 * apart from a measured "this mesh has holes", and the report modal duly
 * rendered "Watertight: no" for perfectly closed meshes. Rust now transports
 * `is_watertight_measured`; when it is false the verdict must become `null`
 * and render as an em dash.
 *
 * The rule generalises: an unmeasured field is never 0 and never false.
 */

function report(analysis: Record<string, unknown>) {
  return normalizeMeshHealthReportForTest({
    version: 1,
    pre: analysis,
    post: analysis,
    steps: [],
    residual_issues: [],
    fully_repaired: true,
    total_ms: 1,
  });
}

test('an unmeasured watertight verdict is transported as UNKNOWN, not "no"', () => {
  const unmeasured = report({ is_watertight: false, is_watertight_measured: false });
  assert.equal(
    unmeasured.post.is_watertight,
    null,
    'a tier that computed no topology must not report a watertight VERDICT',
  );
});

test('a measured watertight verdict is preserved in both directions', () => {
  assert.equal(
    report({ is_watertight: true, is_watertight_measured: true }).post.is_watertight,
    true,
  );
  assert.equal(
    report({ is_watertight: false, is_watertight_measured: true }).post.is_watertight,
    false,
    'a MEASURED "not watertight" must stay false — UNKNOWN must not swallow real defects',
  );
});

test('payloads predating the measured flag are treated as measured', () => {
  // Every pre-Ph1 payload came from `analyze` / `analyze_lightweight`, both of
  // which always ran the topology tier. Absence of the flag therefore means
  // "measured", not "unknown" — the opposite reading would blank out every
  // stored report.
  assert.equal(report({ is_watertight: true }).post.is_watertight, true);
  assert.equal(report({ is_watertight: false }).post.is_watertight, false);
});

test('the report modal renders UNKNOWN as an em dash, never as "no"', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src/components/scene/MeshRepairReportModal.tsx'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /analysis\.is_watertight \? 'yes' : 'no'/,
    'the modal collapses UNKNOWN into "no" — the exact trap this contract exists to close',
  );
  assert.match(source, /function formatWatertight\(value: boolean \| null\)/);
  assert.match(
    source,
    /if \(value === null\) return '—';/,
    'UNKNOWN must render as an em dash',
  );
});
