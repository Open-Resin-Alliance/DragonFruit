import assert from 'node:assert/strict';
import test from 'node:test';
import type * as THREE from 'three';
import { rleEncode, rleEncodeLabels } from '@/volumeAnalysis/IslandScan/rle';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { routeRepairSupports, runAutoSupportPlan } from '../autoSupportRunner';
import { AUTO_SUPPORT_PRESETS } from '../presets';
import type { routeAutoSupportContacts } from '../routePlanner';
import type { routeStickFallback } from '../stickFallback';
import type { AutoSupportContactCandidate, PlannedAutoSupport } from '../types';

function scanFromLayers(layers: number[][], width: number, height: number): ScanResults {
  return {
    grid: { originX: 0, originZ: 0, width, height, px_mm: 1 },
    layers: layers.map((values) => ({
      islandMaskRle: rleEncode(Uint8Array.from(values), width, height),
      islandCount: 0,
      islandLabels: rleEncodeLabels(Int32Array.from(values), width, height),
    })),
    firstHit: new Int16Array(width * height),
    lastHit: new Int16Array(width * height),
    baseFootprint: new Uint8Array(width * height),
    baseLabels: new Int32Array(width * height),
    compBase: new Int16Array(1),
    compTop: new Int16Array(1),
    islands: [],
    islandLabelsPerLayer: [],
  };
}

type PlannedTrunk = Extract<PlannedAutoSupport, { kind: 'trunk' }>;
type PlannedStick = Extract<PlannedAutoSupport, { kind: 'stick' }>;

function plannedSupport(contact: AutoSupportContactCandidate): PlannedAutoSupport {
  return {
    kind: 'trunk',
    contact,
    root: { id: `root-${contact.id}` } as PlannedTrunk['root'],
    trunk: {
      id: `trunk-${contact.id}`,
      contactCone: { pos: { ...contact.position } },
    } as PlannedTrunk['trunk'],
    supportData: {} as PlannedTrunk['supportData'],
  };
}

function plannedStick(contact: AutoSupportContactCandidate): PlannedAutoSupport {
  return {
    kind: 'stick',
    contact,
    stick: {
      id: `stick-${contact.id}`,
      contactConeA: { pos: { ...contact.position } },
      contactConeB: { pos: { ...contact.position, z: contact.position.z - 3 } },
    } as PlannedStick['stick'],
    supportData: {} as PlannedStick['supportData'],
  };
}

type RouteContacts = typeof routeAutoSupportContacts;
type RouteSticks = typeof routeStickFallback;

const FAKE_MESH = {} as THREE.Mesh;

const failSticks: RouteSticks = async ({ contacts }) => ({
  supports: [],
  failures: contacts.map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'no_surface' as const })),
});

const SETTINGS = {
  ...AUTO_SUPPORT_PRESETS.normal,
  contactSpacingMm: 2,
  minBaseAreaMm2: 0,
  minVolumeMm3: 0,
  minHeightMm: 0,
  maxContactsPerVolume: 2,
  maxTotalContacts: 10,
};

test('routes heavy volumes with structural overrides', async () => {
  // Left strip: 3 layers × 8 px = 24 mm³ (structural at threshold 20).
  // Right cell: 1 px on one layer = 1 mm³ (standard).
  const scan = scanFromLayers([
    [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
  ], 11, 1);
  const waves: Array<{ volumeIds: number[]; hasOverrides: boolean }> = [];

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: { ...SETTINGS, structuralVolumeMm3: 20 },
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts: async ({ contacts, overrides }) => {
      waves.push({ volumeIds: [...new Set(contacts.map((contact) => contact.volumeId))], hasOverrides: overrides !== undefined });
      return { supports: contacts.map(plannedSupport), failures: [] };
    },
    routeSticks: failSticks,
  });

  assert.equal(preview.unresolvedVolumeIds.length, 0);
  assert.equal(waves.length, 2);
  assert.equal(waves[0].hasOverrides, false);
  assert.equal(waves[1].hasOverrides, true);
  assert.equal(waves[1].volumeIds.length, 1);
  assert.ok(!waves[0].volumeIds.includes(waves[1].volumeIds[0]));
});

test('retries unresolved volumes with fresh contacts and merges both waves', async () => {
  const scan = scanFromLayers([
    [1, 1, 1, 1, 0, 0, 1, 1, 1, 1],
  ], 10, 1);
  const routedWaves: AutoSupportContactCandidate[][] = [];
  const routeContacts: RouteContacts = async ({ contacts, progressPhase }) => {
    routedWaves.push(contacts);
    if (progressPhase === 'route') {
      const [firstVolumeId] = [contacts[0].volumeId];
      return {
        supports: contacts
          .filter((contact) => contact.volumeId === firstVolumeId)
          .map(plannedSupport),
        failures: contacts
          .filter((contact) => contact.volumeId !== firstVolumeId)
          .map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'COLLISION_WITH_MODEL' as const })),
      };
    }
    return { supports: contacts.map(plannedSupport), failures: [] };
  };

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts,
    routeSticks: failSticks,
  });

  assert.equal(routedWaves.length, 2);
  const retriedVolumeIds = new Set(routedWaves[1].map((contact) => contact.volumeId));
  assert.equal(retriedVolumeIds.size, 1);
  assert.ok(routedWaves[1].every((contact) => contact.id.includes(':retry')));
  assert.equal(preview.unresolvedVolumeIds.length, 0);
  assert.equal(preview.supports.length, routedWaves[0].length / 2 + routedWaves[1].length);
  assert.deepEqual(preview.failureReasonCounts, {});
});

test('reports volumes as unresolved when both waves fail', async () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  const routeContacts: RouteContacts = async ({ contacts }) => ({
    supports: [],
    failures: contacts.map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'no_surface' as const })),
  });

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts,
    routeSticks: failSticks,
  });

  assert.equal(preview.supports.length, 0);
  assert.equal(preview.unresolvedVolumeIds.length, 1);
  assert.ok((preview.failureReasonCounts.no_surface ?? 0) >= 1);
});

test('skips the retry wave when the contact budget is exhausted', async () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  const waves: AutoSupportContactCandidate[][] = [];
  const routeContacts: RouteContacts = async ({ contacts }) => {
    waves.push(contacts);
    return {
      supports: [],
      failures: contacts.map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'no_surface' as const })),
    };
  };

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: { ...SETTINGS, maxTotalContacts: 1 },
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts,
    routeSticks: failSticks,
  });

  // Wave 1 plus the detail rescue re-attempt of the same contact — but no
  // ':retry' second wave, since the contact budget is exhausted.
  assert.equal(waves.length, 2);
  assert.ok(waves.flat().every((contact) => !contact.id.includes(':retry')));
  assert.equal(preview.attemptedContactCount, 1);
  assert.equal(preview.unresolvedVolumeIds.length, 1);
});

test('counts volumes fully covered by existing tips without routing them', async () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  let routedContactCount = 0;
  const routeContacts: RouteContacts = async ({ contacts }) => {
    routedContactCount += contacts.length;
    return { supports: contacts.map(plannedSupport), failures: [] };
  };

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    existingTipPoints: [{ x: 1, y: -0.5, z: 10.5 }],
    routeContacts,
    routeSticks: failSticks,
  });

  assert.equal(routedContactCount, 0);
  assert.equal(preview.coveredVolumeCount, 1);
  assert.equal(preview.eligibleVolumeCount, 0);
  assert.equal(preview.supports.length, 0);
});

test('falls back to on-model sticks for volumes trunks cannot route', async () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  const failTrunks: RouteContacts = async ({ contacts }) => ({
    supports: [],
    failures: contacts.map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'COLLISION_WITH_MODEL' as const })),
  });
  const stickWaves: AutoSupportContactCandidate[][] = [];
  const routeSticks: RouteSticks = async ({ contacts }) => {
    stickWaves.push(contacts);
    return { supports: contacts.map(plannedStick), failures: [] };
  };

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts: failTrunks,
    routeSticks,
  });

  assert.equal(stickWaves.length, 1);
  assert.equal(preview.unresolvedVolumeIds.length, 0);
  assert.ok(preview.supports.length > 0);
  assert.ok(preview.supports.every((support) => support.kind === 'stick'));
  assert.deepEqual(preview.failureReasonCounts, {});
});

test('does not attempt sticks for volumes trunks already resolved', async () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  let stickCalls = 0;
  const routeSticks: RouteSticks = async ({ contacts }) => {
    stickCalls += 1;
    return { supports: [], failures: contacts.map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'no_surface' as const })) };
  };

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts: async ({ contacts }) => ({ supports: contacts.map(plannedSupport), failures: [] }),
    routeSticks,
  });

  assert.equal(stickCalls, 0);
  assert.equal(preview.unresolvedVolumeIds.length, 0);
});

test('rescues detail volumes with slim overrides after full-size stages fail', async () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  const trunkOverrides: Array<object | undefined> = [];
  const stickOverrides: Array<object | undefined> = [];
  const routeContacts: RouteContacts = async ({ contacts, overrides }) => {
    trunkOverrides.push(overrides);
    return {
      supports: [],
      failures: contacts.map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'COLLISION_WITH_MODEL' as const })),
    };
  };
  const routeSticks: RouteSticks = async ({ contacts, overrides }) => {
    stickOverrides.push(overrides);
    if (!overrides) {
      return {
        supports: [],
        failures: contacts.map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'COLLISION_WITH_MODEL' as const })),
      };
    }
    return { supports: contacts.map(plannedStick), failures: [] };
  };

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts,
    routeSticks,
  });

  assert.deepEqual(trunkOverrides.map((entry) => entry !== undefined), [false, false, true]);
  assert.deepEqual(stickOverrides.map((entry) => entry !== undefined), [false, true]);
  assert.equal(preview.unresolvedVolumeIds.length, 0);
  assert.ok(preview.supports.every((support) => support.kind === 'stick'));
  assert.deepEqual(preview.failureReasonCounts, {});
});

test('classifies volumes rejected only by tip spacing as covered, not unresolved', async () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  const crowd: RouteContacts = async ({ contacts }) => ({
    supports: [],
    failures: contacts.map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'tip_spacing' as const })),
  });

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts: crowd,
    routeSticks: async ({ contacts }) => ({
      supports: [],
      failures: contacts.map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'tip_spacing' as const })),
    }),
  });

  assert.equal(preview.unresolvedVolumeIds.length, 0);
  assert.equal(preview.coveredVolumeCount, 1);
  assert.deepEqual(preview.failureReasonCounts, {});
});

test('routes surface-fill samples without affecting region reporting', async () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  const surfaceContacts: AutoSupportContactCandidate[] = [
    { id: 'surface:0', volumeId: -1, position: { x: 5, y: 5, z: 14 } },
    { id: 'surface:1', volumeId: -1, position: { x: 9, y: 5, z: 14 } },
  ];

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts: async ({ contacts }) => ({ supports: contacts.map(plannedSupport), failures: [] }),
    routeSticks: failSticks,
    sampleSurface: () => surfaceContacts,
  });

  assert.equal(preview.supports.length, 1 + surfaceContacts.length);
  assert.equal(preview.eligibleVolumeCount, 1);
  assert.equal(preview.unresolvedVolumeIds.length, 0);
  assert.deepEqual(preview.failureReasonCounts, {});
});

test('surface-fill failures fall back to sticks and stay non-blocking', async () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  const surfaceContacts: AutoSupportContactCandidate[] = [
    { id: 'surface:0', volumeId: -1, position: { x: 5, y: 5, z: 14 } },
  ];
  let stickContactsSeen: AutoSupportContactCandidate[] = [];

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts: async ({ contacts }) => ({
      supports: contacts.filter((contact) => contact.volumeId !== -1).map(plannedSupport),
      failures: contacts
        .filter((contact) => contact.volumeId === -1)
        .map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'COLLISION_WITH_MODEL' as const })),
    }),
    routeSticks: async ({ contacts }) => {
      stickContactsSeen = contacts;
      return { supports: contacts.map(plannedStick), failures: [] };
    },
    sampleSurface: () => surfaceContacts,
  });

  assert.deepEqual(stickContactsSeen.map((contact) => contact.id), ['surface:0']);
  assert.equal(preview.supports.length, 2);
  assert.equal(preview.unresolvedVolumeIds.length, 0);
  assert.deepEqual(preview.failureReasonCounts, {});
});

test('repair routing walks the rescue ladder and keeps only real failures pending', async () => {
  const contacts: AutoSupportContactCandidate[] = [
    { id: 'repair:1:0', volumeId: 1, position: { x: 0, y: 0, z: 5 } },
    { id: 'repair:2:0', volumeId: 2, position: { x: 9, y: 0, z: 5 } },
    { id: 'repair:3:0', volumeId: 3, position: { x: 0, y: 9, z: 5 } },
  ];
  const trunkWaves: string[][] = [];
  const stickWaves: string[][] = [];

  const supports = await routeRepairSupports({
    contacts,
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts: async ({ contacts: waveContacts }) => {
      trunkWaves.push(waveContacts.map((contact) => contact.id));
      return {
        // First trunk stage: only volume 1 routes; volume 2 is crowded, volume 3 collides.
        supports: waveContacts.filter((contact) => contact.volumeId === 1).map(plannedSupport),
        failures: waveContacts
          .filter((contact) => contact.volumeId !== 1)
          .map((contact) => ({
            contactId: contact.id,
            volumeId: contact.volumeId,
            reason: contact.volumeId === 2 ? 'tip_spacing' as const : 'COLLISION_WITH_MODEL' as const,
          })),
      };
    },
    routeSticks: async ({ contacts: waveContacts }) => {
      stickWaves.push(waveContacts.map((contact) => contact.id));
      return { supports: waveContacts.map(plannedStick), failures: [] };
    },
  });

  assert.deepEqual(trunkWaves[0], ['repair:1:0', 'repair:2:0', 'repair:3:0']);
  // tip_spacing (volume 2) is adjacent coverage — only the collision (volume 3) advances.
  assert.deepEqual(stickWaves[0], ['repair:3:0']);
  assert.equal(supports.length, 2);
});

test('produces identical previews for identical inputs', async () => {
  const scan = scanFromLayers([
    [1, 1, 1, 0, 1, 1],
    [1, 1, 1, 1, 1, 1],
  ], 6, 1);
  const routeContacts: RouteContacts = async ({ contacts }) => ({
    supports: contacts.filter((_, index) => index % 2 === 0).map(plannedSupport),
    failures: contacts
      .filter((_, index) => index % 2 === 1)
      .map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'tip_spacing' as const })),
  });

  const run = () => runAutoSupportPlan({
    scan,
    scanMinZ: 10,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts,
    routeSticks: failSticks,
  });

  const [first, second] = [await run(), await run()];
  assert.deepEqual(
    first.supports.map((support) => support.contact),
    second.supports.map((support) => support.contact),
  );
  assert.deepEqual(first.unresolvedVolumeIds, second.unresolvedVolumeIds);
  assert.deepEqual(first.failureReasonCounts, second.failureReasonCounts);
});
