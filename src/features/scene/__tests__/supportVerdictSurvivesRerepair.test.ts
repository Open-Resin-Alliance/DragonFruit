import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { MeshRepairOptions } from '@/utils/meshRepair';

/**
 * Ph1(e) — the reclassification fix, frontend half.
 *
 * `likely_support_geometry` is derived from a component-shaped heuristic. The
 * first repair's own manifold batch-union fuses each group into a single solid,
 * so a second repair sees two components where the first saw dozens; the
 * classifier's gates fail and — because every Rust-side `repair()` starts a
 * fresh report — the verdict silently downgrades to `false`. The Rust latch
 * (`assume_support_geometry`) only helps if the frontend actually forwards the
 * verdict the model already holds, which is what these pin.
 *
 * The transport itself is covered Rust-side by
 * `classification_survives_two_repairs` (mesh-repair) and
 * `repair_options_carry_the_frontend_support_verdict` (src-tauri). The chain
 * here is source-anchored: `repairModelInPlace` and `processGeometry`'s native
 * branch both require a live Tauri `invoke`, so there is no seam to call.
 */

function read(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), 'utf8');
}

test('MeshRepairOptions exposes the support-verdict seed', () => {
  // Type-level: the option must exist and be optional-boolean, or the two
  // source anchors below would be pinning a silently-dropped field.
  const options: MeshRepairOptions = { assumeSupportGeometry: true };
  assert.equal(options.assumeSupportGeometry, true);

  const source = read('src/utils/meshRepair.ts');
  assert.match(
    source,
    /assumeSupportGeometry\?:\s*boolean/,
    'MeshRepairOptions must declare assumeSupportGeometry',
  );
});

test('the repair path forwards the seed to the native engine', () => {
  const source = read('src/hooks/useStlGeometry.ts');
  const call = source.slice(
    source.indexOf('await repairFromGeometry('),
    source.indexOf('await repairFromGeometry(') + 700,
  );
  assert.ok(call.length > 0, 'repairFromGeometry call site not found — re-anchor this test');
  assert.match(
    call,
    /assumeSupportGeometry:\s*options\.assumeSupportGeometry === true/,
    'processGeometry drops the caller\'s support verdict before invoking repair',
  );
});

test('a manual re-repair seeds from the model\'s existing report', () => {
  const source = read('src/features/scene/useSceneCollectionManager.ts');
  const start = source.indexOf('const repairModelInPlace = useCallback(');
  assert.notEqual(start, -1, 'repairModelInPlace not found — re-anchor this test');
  const body = source.slice(start, start + 2200);

  assert.match(
    body,
    /nativeRepairReport\?\.likely_support_geometry === true/,
    'repairModelInPlace must read the verdict the model already holds',
  );
  assert.match(
    body,
    /assumeSupportGeometry/,
    'repairModelInPlace must pass the verdict into processGeometry, or the '
    + 'support section identity is lost on every re-repair',
  );
});
