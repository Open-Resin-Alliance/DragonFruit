import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAvailableProfileNetworkModes,
  getProfileMonitoringUiAdapter,
  getProfileNetworkUiAdapter,
  installExternalProfilePlugin,
  uninstallExternalProfilePlugin,
} from '../pluginRegistry';
import type { PluginManifest } from '../pluginRegistry';

/**
 * A package declares the mode it hosts; the renderer turns that into the same
 * adapter shape the compiled plugins register, so the Network Support list and
 * every network panel work without shipping webview code.
 */
const PLUGIN_ID = 'test.declared-network';
const MODE = 'test-declared-net';

const manifest: PluginManifest = {
  schemaVersion: 1,
  id: PLUGIN_ID,
  name: 'Declared Network',
  version: '1.0.0',
  network: {
    pluginId: PLUGIN_ID,
    mode: MODE,
    displayName: 'Test Network',
    hostnames: ['test.local'],
    operations: { connect: 'test/connect', printerData: 'test/bitdepth' },
  },
};

const modeEntry = () => getAvailableProfileNetworkModes().find((entry) => entry.mode === MODE);

const remoteSchema = {
  primaryFields: [
    { key: 'exposureSec', label: 'Exposure (s)', defaultValue: 2.5, kind: 'number' as const, aliases: [] },
  ],
  basicSections: [{ id: 'print', title: 'Print', keys: ['exposureSec'] }],
  advancedSections: [],
};

test('a declared mode appears in the network support list with its own name', () => {
  assert.equal(modeEntry(), undefined, 'absent before the install');

  installExternalProfilePlugin(manifest);
  try {
    const entry = modeEntry();
    assert.ok(entry, 'the mode is listed');
    assert.equal(entry.displayName, 'Test Network');
    assert.equal(entry.pluginId, PLUGIN_ID);

    const adapter = getProfileNetworkUiAdapter(MODE);
    assert.ok(adapter);
    assert.equal(adapter.operations.connect, 'test/connect');
    assert.equal(adapter.operations.discover, 'discover', 'undeclared names fall back to the protocol names');
    assert.equal(adapter.operations.printerData, 'test/bitdepth');
    assert.deepEqual(adapter.defaultLocalHostnames, ['test.local']);
    assert.equal(adapter.supportsRemoteMaterialProfiles, false);
  } finally {
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }

  assert.equal(modeEntry(), undefined, 'the mode is withdrawn with the plugin');
  assert.equal(getProfileNetworkUiAdapter(MODE), null);
});

test('a declared mode parses the shared status payload', () => {
  installExternalProfilePlugin(manifest);
  try {
    const monitoring = getProfileMonitoringUiAdapter(MODE);
    assert.equal(monitoring.available, true);
    assert.equal(monitoring.operations?.status, 'status');

    const snapshot = monitoring.parseStatusPayload({
      connected: true,
      stateText: 'Printing',
      isPrinting: true,
      progressPct: 42.5,
      currentLayer: 12,
      totalLayers: 300,
      jobName: 'bracelet',
      etaSec: '90',
    });
    assert.equal(snapshot.connected, true);
    assert.equal(snapshot.stateText, 'Printing');
    assert.equal(snapshot.isPrinting, true);
    assert.equal(snapshot.progressPct, 42.5);
    assert.equal(snapshot.currentLayer, 12);
    assert.equal(snapshot.totalLayers, 300);
    assert.equal(snapshot.jobName, 'bracelet');
    assert.equal(snapshot.etaSec, 90, 'numeric strings are coerced');

    const malformed = monitoring.parseStatusPayload({ connected: 'yes', progressPct: 'nope', stateText: 5 });
    assert.equal(malformed.connected, false);
    assert.equal(malformed.progressPct, null);
    assert.equal(malformed.stateText, '');
  } finally {
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});

test('a compiled mode cannot be taken over by a package', () => {
  const builtinMode = getAvailableProfileNetworkModes()
    .map((entry) => entry.mode)
    .find((mode) => mode !== MODE);
  assert.ok(builtinMode, 'a built-in mode exists');

  const before = getProfileNetworkUiAdapter(builtinMode!);
  installExternalProfilePlugin({
    ...manifest,
    network: { ...manifest.network!, mode: builtinMode! },
  });
  try {
    assert.equal(getProfileNetworkUiAdapter(builtinMode!), before, 'the compiled adapter stays registered');
    assert.equal(getAvailableProfileNetworkModes().filter((entry) => entry.mode === builtinMode).length, 1);
  } finally {
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});

test('a declared mode turns on on-device materials only when it describes them', () => {
  installExternalProfilePlugin(manifest);
  try {
    const adapter = getProfileNetworkUiAdapter(MODE);
    assert.ok(adapter);
    assert.equal(adapter.supportsRemoteMaterialProfiles, false);
    assert.deepEqual(adapter.primaryEditFields, []);
  } finally {
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }

  installExternalProfilePlugin({
    ...manifest,
    network: { ...manifest.network!, remoteMaterials: remoteSchema },
  });
  try {
    const adapter = getProfileNetworkUiAdapter(MODE);
    assert.ok(adapter);
    assert.equal(adapter.supportsRemoteMaterialProfiles, true);
    assert.deepEqual(adapter.primaryEditFields.map((field) => field.key), ['exposureSec']);
    assert.deepEqual(adapter.basicSections.map((section) => section.id), ['print']);
    assert.equal(adapter.resolveEditDraftFromMeta({ exposureSec: 3 }).exposureSec, '3');
  } finally {
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});

test('a declared mode carries its monitoring policy, clamped to the documented bounds', () => {
  installExternalProfilePlugin({
    ...manifest,
    network: {
      ...manifest.network!,
      monitoring: {
        busyResponseGraceMs: 45_000,
        inconclusiveReachabilityMaxPolls: 900,
        supportsWebcamStreamSlotReset: true,
      },
    },
  });
  try {
    const monitoring = getProfileMonitoringUiAdapter(MODE);
    assert.deepEqual(monitoring.getMonitoringUiPolicy?.(), {
      busyResponseGraceMs: 45_000,
      inconclusiveReachabilityMaxPolls: 100,
      supportsWebcamStreamSlotReset: true,
    });
  } finally {
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }

  assert.equal(getProfileMonitoringUiAdapter(MODE).getMonitoringUiPolicy, undefined);
});
