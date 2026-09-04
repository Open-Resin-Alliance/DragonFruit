import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeGatedPluginIds,
  EXPERIMENTS_ENABLED_STORAGE_KEY,
  EXPERIMENTS_MANIFEST,
  EXPERIMENTS_OPT_OUT_MARKER,
  getEnabledExperimentIds,
  getExperimentDefinition,
  getExperimentDefinitions,
  getExperimentOverrides,
  getGatedPluginIdsForDisabledExperiments,
  isExperimentEnabled,
  resolveExperimentEnabled,
  setExperimentEnabled,
  type ExperimentDefinition,
} from '@/features/experiments/experimentsRegistry';
import complexPluginAllowlist from '@/config/complex-plugin-allowlist.json';
import { getBuiltinComplexPluginDefinitions } from '@/features/plugins/builtinComplexPlugins';

test('experiments.json manifest declares version 1 with a non-empty experiments array', () => {
  assert.equal(EXPERIMENTS_MANIFEST.version, 1);
  assert.ok(Array.isArray(EXPERIMENTS_MANIFEST.experiments));
  assert.ok(EXPERIMENTS_MANIFEST.experiments.length > 0, 'expected at least one declared experiment');
});

test('experiment definitions expose non-empty ids, names and descriptions with valid status', () => {
  const definitions = getExperimentDefinitions();
  const seen = new Set<string>();

  for (const definition of definitions) {
    assert.ok(definition.id.trim().length > 0, `experiment "${definition.id}" must have an id`);
    assert.ok(definition.name.trim().length > 0, `experiment "${definition.id}" must have a name`);
    assert.ok(definition.description.trim().length > 0, `experiment "${definition.id}" must have a description`);
    assert.ok(typeof definition.defaultEnabled === 'boolean', `experiment "${definition.id}" must declare defaultEnabled`);
    assert.ok(!seen.has(definition.id), `duplicate experiment id "${definition.id}"`);
    seen.add(definition.id);
  }
});

test('plugin getter never returns a plugin gated behind a disabled experiment', () => {
  // No window → isExperimentEnabled returns defaultEnabled, so gated experiments
  // (e.g. chitubox-import) are treated as disabled. This invariant holds whether
  // or not the plugin submodules are checked out (CI runs without them).
  const gatedIds = getGatedPluginIdsForDisabledExperiments();
  for (const definition of getBuiltinComplexPluginDefinitions()) {
    assert.ok(!gatedIds.has(definition.id), `gated plugin "${definition.id}" leaked through the getter`);
  }
});

test('every gatedPlugins id references a declared builtin complex plugin', () => {
  // Checked against the declared allowlist (complete regardless of which plugin
  // submodules are checked out), not the submodule-dependent generated registry.
  const allowlist = new Set(complexPluginAllowlist.builtinComplexPlugins.map((entry) => entry.id));

  for (const definition of getExperimentDefinitions()) {
    for (const pluginId of definition.gatedPlugins ?? []) {
      assert.ok(allowlist.has(pluginId), `experiment "${definition.id}" gates unknown plugin "${pluginId}"`);
    }
  }
});

test('chitubox-import experiment is off by default and resolves via getExperimentDefinition', () => {
  const definition = getExperimentDefinition('chitubox-import');
  assert.ok(definition, 'expected chitubox-import experiment to be declared');
  assert.equal(definition.defaultEnabled, false);
  assert.ok(definition.gatedPlugins?.includes('chitubox-import'));
  assert.equal(isExperimentEnabled('chitubox-import'), false, 'no window / no saved override -> defaultEnabled');
});

test('isExperimentEnabled returns false for unknown experiment ids', () => {
  assert.equal(isExperimentEnabled('does-not-exist'), false);
});

test('getEnabledExperimentIds reflects default-enabled experiments when no window', () => {
  const enabled = getEnabledExperimentIds();
  assert.ok(Array.isArray(enabled));
  // chitubox-import is off by default, so nothing is enabled without a window.
  assert.ok(!enabled.includes('chitubox-import'));
  for (const id of enabled) {
    assert.equal(isExperimentEnabled(id), true);
  }
});

test('getExperimentOverrides is empty when there is no window / no saved state', () => {
  assert.deepEqual(getExperimentOverrides(), {});
});

test('computeGatedPluginIds collects gated plugins of disabled experiments only', () => {
  const experiments: ExperimentDefinition[] = [
    { id: 'alpha', name: 'Alpha', description: 'a', defaultEnabled: false, gatedPlugins: ['plugin-a', 'plugin-b'] },
    { id: 'beta', name: 'Beta', description: 'b', defaultEnabled: true, gatedPlugins: ['plugin-c'] },
    { id: 'gamma', name: 'Gamma', description: 'c', defaultEnabled: false },
  ];

  const disabledOnly = computeGatedPluginIds(experiments, (id) => id === 'beta');
  assert.deepEqual([...disabledOnly].sort(), ['plugin-a', 'plugin-b']);

  const allEnabled = computeGatedPluginIds(experiments, () => true);
  assert.equal(allEnabled.size, 0);
});

test('resolveExperimentEnabled implements the promotion contract', () => {
  const def = (defaultEnabled: boolean): ExperimentDefinition => ({
    id: 'example',
    name: 'Example',
    description: 'example',
    defaultEnabled,
  });

  const disabled = def(false);
  const promoted = def(true);

  // default-disabled experiment: absent follows the default, `true` opts in
  assert.equal(resolveExperimentEnabled(disabled, {}), false);
  assert.equal(resolveExperimentEnabled(disabled, { example: true }), true);

  // promoted (default-enabled) experiment: everyone is enabled unless they
  // explicitly opted out of the promoted state with the opt-out marker
  assert.equal(resolveExperimentEnabled(promoted, {}), true);
  assert.equal(resolveExperimentEnabled(promoted, { example: true }), true);
  assert.equal(resolveExperimentEnabled(promoted, { example: EXPERIMENTS_OPT_OUT_MARKER }), false);
});

function installMockWindow(initialRaw: string | null): void {
  let stored = initialRaw;
  const mockWindow = {
    localStorage: {
      getItem: (key: string) => (key === EXPERIMENTS_ENABLED_STORAGE_KEY ? stored : null),
      setItem: (key: string, value: string) => {
        if (key === EXPERIMENTS_ENABLED_STORAGE_KEY) stored = value;
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  (globalThis as unknown as Record<string, unknown>).window = mockWindow;
}

function removeMockWindow(): void {
  delete (globalThis as unknown as Record<string, unknown>).window;
}

test('toggling a default-disabled experiment on stores true and syncs an override', () => {
  installMockWindow(null);
  try {
    setExperimentEnabled('chitubox-import', true);
    assert.equal(isExperimentEnabled('chitubox-import'), true);
    assert.deepEqual(getExperimentOverrides(), { 'chitubox-import': true });
  } finally {
    removeMockWindow();
  }
});

test('toggling a default-disabled experiment back off removes the override', () => {
  installMockWindow(null);
  try {
    setExperimentEnabled('chitubox-import', true);
    setExperimentEnabled('chitubox-import', false);
    assert.equal(isExperimentEnabled('chitubox-import'), false);
    assert.deepEqual(getExperimentOverrides(), {});
  } finally {
    removeMockWindow();
  }
});

test('a stale false in storage behaves like no saved value', () => {
  // `false` predates the promotion contract; it must be dropped so the
  // experiment follows its manifest default instead of being pinned off.
  installMockWindow(JSON.stringify({ 'chitubox-import': false }));
  try {
    assert.equal(isExperimentEnabled('chitubox-import'), false); // default is false
    assert.deepEqual(getExperimentOverrides(), {});
  } finally {
    removeMockWindow();
  }
});
