import assert from 'node:assert/strict';
import test from 'node:test';
import { rleEncode, rleEncodeLabels } from '@/volumeAnalysis/IslandScan/rle';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { buildVolumeHierarchy } from '@/volumeAnalysis/IslandVolumes/buildVolumeHierarchy';
import { buildUnsupportedVolumes, planAutoSupportContacts } from '../contactPlanner';
import { AUTO_SUPPORT_PRESETS } from '../presets';

function scanFromLayers(layers: number[][], width: number, height: number): ScanResults {
  return {
    grid: { originX: -2, originZ: -3, width, height, px_mm: 1 },
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

test('treats two volumes that later merge as two support roots', () => {
  const scan = scanFromLayers([
    [1, 0, 0, 1],
    [1, 1, 1, 1],
  ], 4, 1);
  const hierarchy = buildVolumeHierarchy(scan, { minOverlapPx: 1, overlapNeighborhoodPx: 0 });

  const volumes = buildUnsupportedVolumes(scan, 0.05, hierarchy);

  assert.equal(volumes.length, 2);
});

test('does not create a new support root when one volume splits', () => {
  const scan = scanFromLayers([
    [1, 1, 1, 1],
    [1, 0, 0, 1],
  ], 4, 1);
  const hierarchy = buildVolumeHierarchy(scan, { minOverlapPx: 1, overlapNeighborhoodPx: 0 });

  const volumes = buildUnsupportedVolumes(scan, 0.05, hierarchy);

  assert.equal(volumes.length, 1);
});

test('selects deterministic sparse contacts and respects the global cap', () => {
  const scan = scanFromLayers([
    [1, 1, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1],
  ], 8, 1);
  const settings = {
    ...AUTO_SUPPORT_PRESETS.normal,
    contactSpacingMm: 2,
    minBaseAreaMm2: 0,
    minVolumeMm3: 0,
    minHeightMm: 0,
    maxContactsPerVolume: 8,
    maxTotalContacts: 2,
  };

  const first = planAutoSupportContacts({ scan, scanMinZ: 4, layerHeightMm: 1, settings });
  const second = planAutoSupportContacts({ scan, scanMinZ: 4, layerHeightMm: 1, settings });

  assert.deepEqual(first.contacts, second.contacts);
  assert.equal(first.contacts.length, 2);
  assert.deepEqual(first.contacts.map((contact) => contact.position.z), [4.5, 4.5]);
});

test('reports a volume as covered when existing tips exclude every base pixel', () => {
  const scan = scanFromLayers([[1, 1]], 2, 1);
  const settings = {
    ...AUTO_SUPPORT_PRESETS.normal,
    minBaseAreaMm2: 0,
    minVolumeMm3: 0,
    minHeightMm: 0,
  };
  const uncovered = planAutoSupportContacts({ scan, scanMinZ: 0, layerHeightMm: 1, settings });
  assert.equal(uncovered.contacts.length, 1);

  const plan = planAutoSupportContacts({
    scan,
    scanMinZ: 0,
    layerHeightMm: 1,
    settings,
    exclusions: [{ ...uncovered.contacts[0].position, radiusMm: 5 }],
  });

  assert.equal(plan.contacts.length, 0);
  assert.deepEqual(plan.coveredVolumeIds, [uncovered.contacts[0].volumeId]);
  assert.equal(plan.ignoredVolumeIds.length, 0);
});

test('keeps planning contacts on pixels outside exclusion zones', () => {
  const scan = scanFromLayers([
    [1, 1, 1, 1, 1, 1, 1, 1],
  ], 8, 1);
  const settings = {
    ...AUTO_SUPPORT_PRESETS.normal,
    contactSpacingMm: 2,
    minBaseAreaMm2: 0,
    minVolumeMm3: 0,
    minHeightMm: 0,
    maxContactsPerVolume: 8,
    maxTotalContacts: 8,
  };
  const uncovered = planAutoSupportContacts({ scan, scanMinZ: 0, layerHeightMm: 1, settings });
  const excludedContact = uncovered.contacts[0];

  const plan = planAutoSupportContacts({
    scan,
    scanMinZ: 0,
    layerHeightMm: 1,
    settings,
    exclusions: [{ ...excludedContact.position, radiusMm: 1.2 }],
  });

  assert.ok(plan.contacts.length > 0);
  assert.equal(plan.coveredVolumeIds.length, 0);
  for (const contact of plan.contacts) {
    const dx = contact.position.x - excludedContact.position.x;
    const dy = contact.position.y - excludedContact.position.y;
    assert.ok(dx * dx + dy * dy >= 1.2 * 1.2);
  }
});

test('volume filter restricts planning and tags retry contact ids', () => {
  const scan = scanFromLayers([[1, 0, 0, 1]], 4, 1);
  const settings = {
    ...AUTO_SUPPORT_PRESETS.normal,
    minBaseAreaMm2: 0,
    minVolumeMm3: 0,
    minHeightMm: 0,
  };
  const full = planAutoSupportContacts({ scan, scanMinZ: 0, layerHeightMm: 1, settings });
  assert.equal(full.contacts.length, 2);
  const keptVolumeId = full.contacts[0].volumeId;

  const filtered = planAutoSupportContacts({
    scan,
    scanMinZ: 0,
    layerHeightMm: 1,
    settings,
    volumeIdFilter: new Set([keptVolumeId]),
    contactIdSuffix: ':retry',
  });

  assert.equal(filtered.contacts.length, 1);
  assert.equal(filtered.contacts[0].volumeId, keptVolumeId);
  assert.ok(filtered.contacts[0].id.endsWith(':retry'));
});

test('filters insignificant volumes before allocating contacts', () => {
  const scan = scanFromLayers([[1, 0, 0, 1]], 4, 1);
  const settings = {
    ...AUTO_SUPPORT_PRESETS.normal,
    minBaseAreaMm2: 2,
    minVolumeMm3: 0,
    minHeightMm: 0,
  };

  const plan = planAutoSupportContacts({ scan, scanMinZ: 0, layerHeightMm: 1, settings });

  assert.equal(plan.contacts.length, 0);
  assert.equal(plan.ignoredVolumeIds.length, 2);
});
