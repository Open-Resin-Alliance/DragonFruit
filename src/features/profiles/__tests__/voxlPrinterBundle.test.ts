import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrinterProfile, ProfileStoreState } from '../profileStore';
import { buildVolumeIsSmaller, findPrinterProfileForBundle, toVoxlPrinterBundle } from '../voxlPrinterBundle';
import type { VoxlPrinterBundle } from '@/features/scene/voxl/types';

const profile = (overrides: Partial<PrinterProfile> & { id: string }): PrinterProfile => ({
  name: overrides.id,
  buildVolumeMm: { width: 200, depth: 120, height: 200 },
  display: { resolutionX: 1, resolutionY: 1, outputFormat: 'png' },
  ...overrides,
});

const state = (printerProfiles: PrinterProfile[]): ProfileStoreState => ({
  printerProfiles,
  materialProfiles: [],
  activePrinterProfileId: printerProfiles[0]?.id ?? '',
  activeMaterialProfileId: '',
  activeMaterialProfileIdByPrinterId: {},
});

const bundle = (overrides: Partial<VoxlPrinterBundle['printer']> = {}): VoxlPrinterBundle => ({
  version: 1,
  printer: {
    name: 'Saturn 4 Ultra',
    buildVolumeMm: { width: 218.88, depth: 122.88, height: 220 },
    ...overrides,
  },
  materials: [],
});

test('the bundle carries the whole definition, minus what is not about the printer', () => {
  const source = profile({
    id: 'printer-local-1',
    name: 'Saturn 4 Ultra',
    manufacturer: 'Elegoo',
    officialPresetId: 'elegoo-saturn-4-ultra',
    buildVolumeMm: { width: 218.88, depth: 122.88, height: 220 },
    imageDataUrl: '/printers/saturn-4-ultra.png',
    networkSupport: 'nanodlp',
    network: { discoveryEnabled: true, ipAddress: '192.168.1.40' },
    networkFleet: [{
      id: 'device-1',
      displayName: 'Saturn 4 Ultra',
      mode: 'nanodlp',
      connected: true,
      hostName: 'saturn',
      ipAddress: '192.168.1.40',
      port: 80,
      lastCheckedAt: '2026-10-07T00:00:00.000Z',
    }],
    activeNetworkDeviceId: 'device-1',
  });

  const materials = [{ id: 'material-1', name: 'Standard Grey' }];
  const result = toVoxlPrinterBundle(source, materials);

  assert.deepEqual(result.materials, materials, 'materials travel as exported');
  assert.equal(result.version, 1);
  assert.equal(result.printer.name, 'Saturn 4 Ultra');
  assert.equal(result.printer.officialPresetId, 'elegoo-saturn-4-ultra');
  assert.deepEqual(result.printer.buildVolumeMm, { width: 218.88, depth: 122.88, height: 220 });

  // Session state and the export timestamp stay behind.
  for (const key of ['network', 'networkFleet', 'networkConnection', 'activeNetworkDeviceId', 'exportedAt']) {
    assert.equal(key in result.printer, false, `${key} does not travel`);
    assert.equal(key in result, false, `${key} does not travel`);
  }

  // A factory printer's image is a bundled path every install has.
  assert.equal(result.printer.imageDataUrl, '/printers/saturn-4-ultra.png');
});

test('an uploaded printer photo does not travel, because it is a data URL', () => {
  const uploaded = profile({
    id: 'printer-local-2',
    name: 'My printer',
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  });

  const result = toVoxlPrinterBundle(uploaded, []);

  assert.equal('imageDataUrl' in result.printer, false);
});

test('buildVolumeIsSmaller is true only when an axis is genuinely smaller', () => {
  const recorded = bundle();

  assert.equal(
    buildVolumeIsSmaller(profile({ id: 'small', buildVolumeMm: { width: 100, depth: 120, height: 220 } }), recorded),
    true,
    'narrower',
  );
  assert.equal(
    buildVolumeIsSmaller(profile({ id: 'short', buildVolumeMm: { width: 218.88, depth: 122.88, height: 150 } }), recorded),
    true,
    'shorter',
  );

  assert.equal(
    buildVolumeIsSmaller(profile({ id: 'same', buildVolumeMm: { width: 218.88, depth: 122.88, height: 220 } }), recorded),
    false,
    'identical volumes do not prompt',
  );
  assert.equal(
    buildVolumeIsSmaller(profile({ id: 'bigger', buildVolumeMm: { width: 300, depth: 130, height: 300 } }), recorded),
    false,
    'a bigger printer is not a mismatch',
  );
});

test('a bundle with no volume recorded cannot be compared', () => {
  const volumeLess: VoxlPrinterBundle = { version: 1, printer: { name: 'Unknown' }, materials: [] };

  assert.equal(buildVolumeIsSmaller(profile({ id: 'any' }), volumeLess), false);
});

test('findPrinterProfileForBundle matches the preset, then the local id, then the name', () => {
  const byPreset = profile({ id: 'installed', name: 'Renamed locally', officialPresetId: 'elegoo-saturn-4-ultra' });
  const byId = profile({ id: 'printer-local-1', name: 'Saturn 4 Ultra' });
  const byName = profile({ id: 'named', name: 'Saturn 4 Ultra' });

  assert.equal(
    findPrinterProfileForBundle(bundle({ officialPresetId: 'elegoo-saturn-4-ultra' }), state([byName, byId, byPreset]))?.id,
    'installed',
    'the preset wins over a name that also matches',
  );

  // The preset is not installed, but the id this machine wrote it with is.
  assert.equal(
    findPrinterProfileForBundle(bundle({ id: 'printer-local-1' }), state([byName, byId]))?.id,
    'printer-local-1',
  );

  // Neither identity is known here; the name is the last resort, ignoring case and space.
  assert.equal(
    findPrinterProfileForBundle(bundle({ name: '  saturn 4 ULTRA ' }), state([byName]))?.id,
    'named',
  );
});

test('findPrinterProfileForBundle returns null when this machine has none of the three', () => {
  assert.equal(findPrinterProfileForBundle(bundle({ officialPresetId: 'not-installed' }), state([])), null);
  assert.equal(findPrinterProfileForBundle({ version: 1, printer: {}, materials: [] }, state([profile({ id: 'other' })])), null);
});
