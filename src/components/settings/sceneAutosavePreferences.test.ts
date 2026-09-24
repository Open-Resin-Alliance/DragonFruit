import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  getSceneAutosaveSettingsSnapshot,
  saveSceneAutosaveSettings,
  SCENE_AUTOSAVE_SETTINGS_STORAGE_KEY,
} from './sceneAutosavePreferences';

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let raw: string | null = null;

beforeEach(() => {
  raw = null;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => (key === SCENE_AUTOSAVE_SETTINGS_STORAGE_KEY ? raw : null),
        setItem: (key: string, value: string) => {
          assert.equal(key, SCENE_AUTOSAVE_SETTINGS_STORAGE_KEY);
          raw = value;
        },
      },
      dispatchEvent: () => true,
    },
  });
});

afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('scene autosave cooldown preferences', () => {
  it('defaults legacy settings to a 30 second cooldown', () => {
    raw = JSON.stringify({ enabled: true, recoveryPromptEnabled: true, debounceMs: 30_000, capMs: 120_000 });
    assert.equal(getSceneAutosaveSettingsSnapshot().cooldownMs, 30_000);
  });

  it('persists a configured cooldown in milliseconds and reloads it', () => {
    saveSceneAutosaveSettings({ cooldownMs: 45_000 });
    assert.equal(JSON.parse(raw ?? '{}').cooldownMs, 45_000);
    assert.equal(getSceneAutosaveSettingsSnapshot().cooldownMs, 45_000);
  });

  it('clamps cooldown and keeps the continuous-edit cap above it and debounce', () => {
    raw = JSON.stringify({ cooldownMs: 10, debounceMs: 40_000, capMs: 60_000 });
    assert.equal(getSceneAutosaveSettingsSnapshot().cooldownMs, 15_000);

    raw = JSON.stringify({ cooldownMs: 999_999_999, debounceMs: 800_000, capMs: 60_000 });
    const settings = getSceneAutosaveSettingsSnapshot();
    assert.equal(settings.cooldownMs, 900_000);
    assert.equal(settings.debounceMs, 800_000);
    assert.equal(settings.capMs, 900_000);
  });
});
