import assert from 'node:assert/strict';
import test from 'node:test';
import type * as THREE from 'three';
import { rleEncode, rleEncodeLabels } from '@/volumeAnalysis/IslandScan/rle';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { runAutoSupportPlan } from '../autoSupportRunner';
import { AUTO_SUPPORT_PRESETS } from '../presets';
import type { routeAutoSupportContacts } from '../routePlanner';
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

function plannedSupport(contact: AutoSupportContactCandidate): PlannedAutoSupport {
  return {
    contact,
    root: { id: `root-${contact.id}` } as PlannedAutoSupport['root'],
    trunk: {
      id: `trunk-${contact.id}`,
      contactCone: { pos: { ...contact.position } },
    } as PlannedAutoSupport['trunk'],
    supportData: {} as PlannedAutoSupport['supportData'],
  };
}

type RouteContacts = typeof routeAutoSupportContacts;

const FAKE_MESH = {} as THREE.Mesh;

const SETTINGS = {
  ...AUTO_SUPPORT_PRESETS.normal,
  contactSpacingMm: 2,
  minBaseAreaMm2: 0,
  minVolumeMm3: 0,
  minHeightMm: 0,
  maxContactsPerVolume: 2,
  maxTotalContacts: 10,
};

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
    scanMinZ: 0,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts,
  });

  assert.equal(routedWaves.length, 2);
  const retriedVolumeIds = new Set(routedWaves[1].map((contact) => contact.volumeId));
  assert.equal(retriedVolumeIds.size, 1);
  assert.ok(routedWaves[1].every((contact) => contact.id.includes(':retry')));
  assert.equal(preview.unresolvedVolumeIds.length, 0);
  assert.equal(preview.supports.length, routedWaves[0].length / 2 + routedWaves[1].length);
  assert.equal(preview.failureReasonCounts.COLLISION_WITH_MODEL, routedWaves[0].length / 2);
});

test('reports volumes as unresolved when both waves fail', async () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  const routeContacts: RouteContacts = async ({ contacts }) => ({
    supports: [],
    failures: contacts.map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'no_surface' as const })),
  });

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 0,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts,
  });

  assert.equal(preview.supports.length, 0);
  assert.equal(preview.unresolvedVolumeIds.length, 1);
  assert.ok((preview.failureReasonCounts.no_surface ?? 0) >= 1);
});

test('skips the retry wave when the contact budget is exhausted', async () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  let calls = 0;
  const routeContacts: RouteContacts = async ({ contacts }) => {
    calls += 1;
    return {
      supports: [],
      failures: contacts.map((contact) => ({ contactId: contact.id, volumeId: contact.volumeId, reason: 'no_surface' as const })),
    };
  };

  const preview = await runAutoSupportPlan({
    scan,
    scanMinZ: 0,
    layerHeightMm: 1,
    preset: 'normal',
    settings: { ...SETTINGS, maxTotalContacts: 1 },
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts,
  });

  assert.equal(calls, 1);
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
    scanMinZ: 0,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    existingTipPoints: [{ x: 1, y: -0.5, z: 0.5 }],
    routeContacts,
  });

  assert.equal(routedContactCount, 0);
  assert.equal(preview.coveredVolumeCount, 1);
  assert.equal(preview.eligibleVolumeCount, 0);
  assert.equal(preview.supports.length, 0);
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
    scanMinZ: 0,
    layerHeightMm: 1,
    preset: 'normal',
    settings: SETTINGS,
    modelId: 'model',
    mesh: FAKE_MESH,
    routeContacts,
  });

  const [first, second] = [await run(), await run()];
  assert.deepEqual(
    first.supports.map((support) => support.contact),
    second.supports.map((support) => support.contact),
  );
  assert.deepEqual(first.unresolvedVolumeIds, second.unresolvedVolumeIds);
  assert.deepEqual(first.failureReasonCounts, second.failureReasonCounts);
});
