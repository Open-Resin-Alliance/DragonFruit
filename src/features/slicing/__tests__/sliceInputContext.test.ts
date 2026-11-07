import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addPrinterProfile,
  getActiveMaterialProfile,
  getProfileStoreSnapshot,
  setActivePrinterProfile,
  updateMaterialProfile,
  type MaterialProfile,
  type PrinterProfile,
} from '@/features/profiles/profileStore';
import { setPrinterReachabilityMap } from '@/features/network/printerReachabilityStore';
import { DEFAULT_SAVED_CURVES } from '../lutCurves';
import { resolveSliceJobAntiAliasing } from '../sliceAntiAliasing';
import {
  SLICING_AA_AUTO_PRESET_STORAGE_KEY,
  SLICING_3DAA_SAVED_CURVES_STORAGE_KEY,
  SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY,
  SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY,
  notifySliceMeshWarmupPreferencesChanged,
  publishSliceMeshWarmupContext,
  readSessionAaOverride,
  readSliceMeshWarmupContext,
  readStoredSliceInputValues,
  resolveSliceMaterialInput,
  subscribeToSliceMeshWarmupContext,
} from '../sliceInputContext';

const resin = {
  id: 'local-resin', name: 'Local resin', layerHeightMm: 0.04,
  normalExposureSec: 2, bottomExposureSec: 20, bottomLayerCount: 6,
} as MaterialProfile;
const remotePrinter = {
  id: 'remote-printer',
  activeNetworkDeviceId: 'device',
  networkConnection: {
    connected: true, ipAddress: 'printer.local', selectedMaterialId: 'remote-resin',
    selectedMaterialName: 'Remote clear resin', selectedMaterialLayerHeightMm: 0.025,
    selectedMaterialNormalExposureSec: 3, selectedMaterialBottomExposureSec: 30,
    selectedMaterialBottomLayerCount: 0,
  },
} as PrinterProfile;
const resolveMaterial = (printerProfile = remotePrinter, reachability = {}, supportsRemoteMaterialProfiles = true) => resolveSliceMaterialInput({
  printerProfile, materialProfile: resin, reachability,
  networkUiAdapter: { supportsRemoteMaterialProfiles }, remoteOfflineLayerHeightMm: 0.08,
});

test('connected remote material supplies the exact job layer height and exposures', () => {
  const resolved = resolveMaterial();
  assert.equal(resolved.materialProfileForSlicing?.name, 'Remote clear resin');
  assert.equal(resolved.effectiveLayerHeightMm, 0.025);
  assert.equal(resolved.materialProfileForSlicing?.normalExposureSec, 3);
  assert.equal(resolved.materialProfileForSlicing?.bottomExposureSec, 30);
  assert.equal(resolved.materialProfileForSlicing?.bottomLayerCount, 0);
  assert.equal(resolved.showRemoteOfflineLayerHeightOverride, false);
});

test('disconnected and unreachable devices use local settings with the saved offline height', () => {
  for (const resolved of [
    resolveMaterial({ ...remotePrinter, networkConnection: { ...remotePrinter.networkConnection!, connected: false } }),
    resolveMaterial(remotePrinter, { device: false }),
    resolveMaterial({ ...remotePrinter, activeNetworkDeviceId: undefined, networkFleet: [
      { id: 'device', ipAddress: ' PRINTER.LOCAL ' },
    ] as PrinterProfile['networkFleet'] }, { device: false }),
  ]) {
    assert.equal(resolved.effectiveMaterialProfile, resin);
    assert.equal(resolved.materialProfileForSlicing?.normalExposureSec, 2);
    assert.equal(resolved.effectiveLayerHeightMm, 0.08);
    assert.equal(resolved.showRemoteOfflineLayerHeightOverride, true);
  }
  assert.equal(resolveMaterial(remotePrinter, { device: false }, false).effectiveLayerHeightMm, 0.04);
  assert.equal(resolveSliceMaterialInput({ printerProfile: remotePrinter, materialProfile: resin, reachability: {},
    networkUiAdapter: null, remoteOfflineLayerHeightMm: 0.08 }).effectiveLayerHeightMm, 0.04);
});

test('missing or invalid remote values preserve local values and clamp the job height', () => {
  const resolved = resolveMaterial({ ...remotePrinter, networkConnection: {
    ...remotePrinter.networkConnection!, selectedMaterialLayerHeightMm: -1,
    selectedMaterialNormalExposureSec: 0, selectedMaterialBottomExposureSec: Number.NaN,
    selectedMaterialBottomLayerCount: -1,
  } });
  assert.equal(resolved.effectiveLayerHeightMm, 0.04);
  assert.equal(resolved.materialProfileForSlicing?.normalExposureSec, 2);
  assert.equal(resolved.materialProfileForSlicing?.bottomExposureSec, 20);
  assert.equal(resolved.materialProfileForSlicing?.bottomLayerCount, 6);
  assert.equal(resolveMaterial({ ...remotePrinter, networkConnection: {
    ...remotePrinter.networkConnection!, selectedMaterialLayerHeightMm: 2,
  } }).effectiveLayerHeightMm, 1);
});

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test('pre-panel context stays exact, invalidates real settings and survives panel navigation', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = Object.assign(new EventTarget(), { localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage() });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  let unsubscribe = () => {};
  try {
    const firstPrinter = addPrinterProfile({ name: 'First warmup printer', antiAliasing: true });
    const material = getActiveMaterialProfile(getProfileStoreSnapshot());
    assert.ok(material);
    const curves = [{ id: 'custom', name: 'Custom', points: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }] }];
    browser.localStorage.setItem(SLICING_AA_AUTO_PRESET_STORAGE_KEY, 'smooth');
    browser.sessionStorage.setItem(SLICING_AA_AUTO_PRESET_STORAGE_KEY, 'raw');
    browser.localStorage.setItem(SLICING_3DAA_SAVED_CURVES_STORAGE_KEY, JSON.stringify(DEFAULT_SAVED_CURVES));
    browser.sessionStorage.setItem(SLICING_3DAA_SAVED_CURVES_STORAGE_KEY, JSON.stringify(curves));
    browser.localStorage.setItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY, '0.075');
    const override = { minimumAaAlphaPercent: 44, antiAliasingSettings: {
      enableOverride: true, mode: '3DAA', zBlendResinType: 'custom', selectedLutCurveId: 'custom', supportTipShrinkPercent: 23,
    } };
    browser.sessionStorage.setItem(SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY, JSON.stringify({ [material.id]: override }));
    const initial = readSliceMeshWarmupContext();
    assert.ok(initial);
    assert.equal(initial.printerProfile.id, firstPrinter);
    assert.equal(initial.antiAliasing.preset, 'smooth');
    assert.deepEqual(initial.antiAliasing.lutCurves, curves);
    assert.equal(readStoredSliceInputValues().offlineLayerHeight, '0.075');
    const actualAa = resolveSliceJobAntiAliasing({ printerProfile: initial.printerProfile, materialProfile: initial.materialProfile,
      layerHeightMm: initial.materialProfile.layerHeightMm, request: initial.antiAliasing });
    const panelAa = resolveSliceJobAntiAliasing({ printerProfile: initial.printerProfile, materialProfile: initial.materialProfile,
      layerHeightMm: initial.materialProfile.layerHeightMm, request: { preset: 'smooth', override: readSessionAaOverride(material), lutCurves: curves } });
    assert.deepEqual(actualAa, panelAa);
    assert.equal(actualAa.supportTipShrinkPercent, 23);
    assert.equal(readSliceMeshWarmupContext(), initial);
    let notifications = 0;
    unsubscribe = subscribeToSliceMeshWarmupContext(() => { notifications += 1; });
    browser.dispatchEvent(new Event('pointermove'));
    browser.dispatchEvent(new Event('selectionchange'));
    assert.equal(notifications, 0);
    setPrinterReachabilityMap({ unrelated: false });
    assert.equal(readSliceMeshWarmupContext(), initial);
    publishSliceMeshWarmupContext({ profileState: getProfileStoreSnapshot(), antiAliasing: initial.antiAliasing,
      remoteOfflineLayerHeightMm: 0.075, targetPlateId: 'batch-first' });
    assert.equal(readSliceMeshWarmupContext()?.targetPlateId, 'batch-first');
    publishSliceMeshWarmupContext(null);
    const afterNavigation = readSliceMeshWarmupContext();
    assert.deepEqual(afterNavigation?.antiAliasing, initial.antiAliasing);
    assert.equal(afterNavigation?.materialProfile, initial.materialProfile);
    browser.localStorage.setItem(SLICING_AA_AUTO_PRESET_STORAGE_KEY, 'sharp');
    notifySliceMeshWarmupPreferencesChanged();
    assert.ok(notifications > 0);
    assert.equal(readSliceMeshWarmupContext()?.antiAliasing.preset, 'sharp');
    publishSliceMeshWarmupContext({ profileState: getProfileStoreSnapshot(), antiAliasing: { preset: 'raw' },
      remoteOfflineLayerHeightMm: 0.09, targetPlateId: 'stale-target' });
    const secondPrinter = addPrinterProfile({ name: 'Second warmup printer' });
    const changed = readSliceMeshWarmupContext();
    assert.equal(changed?.printerProfile.id, secondPrinter);
    assert.equal(changed?.antiAliasing.preset, 'sharp');
    assert.equal(changed?.targetPlateId, undefined);
    setActivePrinterProfile(firstPrinter);
    updateMaterialProfile(material.id, { layerHeightMm: 0.06 });
    assert.notEqual(readSliceMeshWarmupContext(), afterNavigation);
  } finally {
    unsubscribe();
    publishSliceMeshWarmupContext(null);
    setPrinterReachabilityMap({});
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
