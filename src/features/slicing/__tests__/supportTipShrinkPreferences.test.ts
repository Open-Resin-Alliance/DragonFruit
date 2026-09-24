import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
  addMaterialProfile,
  addPrinterProfile,
  getProfileStoreSnapshot,
  updateMaterialProfile,
  type MaterialAntiAliasingSettings,
} from '@/features/profiles/profileStore';

test('material AA tip shrink defaults, clamps, and persists independently of AA override', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage, sessionStorage: localStorage, dispatchEvent: () => true },
  });

  try {
    const printerId = addPrinterProfile({ name: 'Shrink test printer' });
    const legacySettings = { ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS } as Record<string, unknown>;
    delete legacySettings.supportTipShrinkPercent;
    const materialId = addMaterialProfile(printerId, {
      name: 'Shrink test material',
      antiAliasingSettings: legacySettings as MaterialAntiAliasingSettings,
    });
    const settings = () => getProfileStoreSnapshot().materialProfiles.find((profile) => profile.id === materialId)!.antiAliasingSettings;
    const setPercent = (percent: number) => updateMaterialProfile(materialId, {
      antiAliasingSettings: { ...settings(), supportTipShrinkPercent: percent },
    });

    assert.equal(settings().supportTipShrinkPercent, 10);
    assert.equal(settings().enableOverride, false);
    for (const [input, expected] of [[0, 0], [25, 25], [-5, 0], [101, 90], [NaN, 10]]) {
      setPercent(input);
      assert.equal(settings().supportTipShrinkPercent, expected);
      assert.equal(settings().enableOverride, false);
      const persisted = JSON.parse(storage.get('dragonfruit-profiles-v1')!) as {
        state: { materialProfiles: Array<{ id: string; antiAliasingSettings: MaterialAntiAliasingSettings }> };
      };
      assert.equal(persisted.state.materialProfiles.find((profile) => profile.id === materialId)?.antiAliasingSettings.supportTipShrinkPercent, expected);
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
