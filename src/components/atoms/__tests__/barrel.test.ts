import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * The atoms barrel is the one component module graph the unit tests import
 * (settings tests pull it in through `profileFormAtoms`, for example), and the
 * test runner transpiles with esbuild only: it cannot run the Lingui macro
 * transform, and `@lingui/core/macro` throws by design when executed
 * untransformed.
 *
 * So every module the barrel re-exports has to stay macro-free. A macro module
 * that gets barrelled does not fail its own test, it fails whatever unrelated
 * test happens to import the barrel, with a "macro is being executed outside the
 * context of compilation" error. This test turns that into a direct failure
 * naming the barrel.
 */
describe('atoms barrel', () => {
  it('loads without a macro (no Lingui macro reachable from it)', async () => {
    // Dynamic on purpose, and the only way this test can do its job: a static
    // import would be evaluated while this *file* loads, so a macro in the barrel
    // would surface as an unlabelled suite crash instead of the named failure this
    // test exists to produce.
    const atoms = await import('@/components/atoms');

    assert.ok(atoms.Button, 'Button should be exported');
    assert.ok(atoms.SettingRow, 'SettingRow should be exported');
    assert.ok(atoms.SegmentedControl, 'SegmentedControl should be exported');
    assert.ok(
      !('PanelCollapseToggle' in atoms),
      'PanelCollapseToggle needs the catalog, so it is imported directly and must not be barrelled',
    );
  });
});
