import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@/i18n';
import {
  addMaterialProfile,
  addPrinterProfileFromPreset,
  DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
  getLibraryPrinterPresets,
  getProfileStoreSnapshot,
} from '@/features/profiles/profileStore';
import {
  EXPERIMENTS_ENABLED_STORAGE_KEY,
  isExperimentEnabled,
  setExperimentEnabled,
  subscribeToExperiments,
} from '@/features/experiments/experimentsRegistry';
import { installFakeWindow } from '@/utils/__tests__/helpers/fakeWindow';
import { toggleExperimentWithSideEffects } from './ExperimentsSettingsTab';
import { MaterialAntiAliasingSection, type MaterialDraft } from './profileFormAtoms';

test('Support Adjustments stay available with Custom Settings and Override Auto off', () => {
  for (const mode of ['Blur', 'Off'] as const) {
    const draft = {
      antiAliasingSettings: {
        ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
        enableCustomSettings: false,
        enableOverride: false,
        tipOffsetMode: 'disabled',
        mode,
      },
      layerHeightMm: 0.05,
    } as MaterialDraft;
    const html = renderToStaticMarkup(<I18nProvider i18n={i18n}><MaterialAntiAliasingSection draft={draft} onChange={() => {}} /></I18nProvider>);
    for (const label of ['Support Adjustments', 'Apply AA to Support Geometry', '3DAA tip shrink (%)', 'Tip Compensation Offset Mode']) {
      assert.ok(html.includes(label), `${label} visible for Auto preset with saved mode ${mode}`);
    }
    assert.ok(html.includes('Automatic'), 'saved Disabled appears as effective Auto while override is off');
    assert.ok(html.includes('Display Offset in Viewport'), 'Auto offset can still be displayed');
    const selector = html.match(/<button[^>]*aria-label="Tip Compensation Offset Mode"[^>]*>/);
    assert.ok(selector);
    assert.match(selector[0], /\sdisabled(?:=|(?=\s|>))/);
  }
});

test('Compensation Distance is editable only for Manual with Override Auto enabled', () => {
  const render = (tipOffsetMode: 'auto' | 'disabled' | 'manual', overrideEnabled: boolean) => {
    const draft = {
      antiAliasingSettings: {
        ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
        enableCustomSettings: overrideEnabled,
        enableOverride: overrideEnabled,
        tipOffsetMode,
        tipOffsetMm: 0.125,
      },
      layerHeightMm: 0.05,
    } as MaterialDraft;
    return renderToStaticMarkup(<I18nProvider i18n={i18n}><MaterialAntiAliasingSection draft={draft} onChange={() => {}} /></I18nProvider>);
  };

  assert.ok(!render('manual', false).includes('Compensation Distance (mm)'));
  assert.ok(!render('auto', true).includes('Compensation Distance (mm)'));
  assert.ok(!render('disabled', true).includes('Compensation Distance (mm)'));
  const manual = render('manual', true);
  assert.ok(manual.includes('Compensation Distance (mm)'));
  assert.ok(manual.includes('value="0.125"'), 'manual input shows the saved distance');
});

test('Support Contact Halo and its nested controls are hidden when support-halo experiment is off and visible when on', () => {
  const draftWithHaloOn: MaterialDraft = {
    antiAliasingSettings: {
      ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
      supportHaloEnabled: true,
      supportHaloAuto: true,
    },
    layerHeightMm: 0.05,
  } as MaterialDraft;

  // 1. Default (experiment off): Support Contact Halo and nested controls must be hidden
  const htmlWhenExperimentOff = renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <MaterialAntiAliasingSection draft={draftWithHaloOn} onChange={() => {}} />
    </I18nProvider>,
  );
  assert.ok(htmlWhenExperimentOff.includes('Support Adjustments'));
  assert.ok(htmlWhenExperimentOff.includes('Apply AA to Support Geometry'));
  assert.ok(
    !htmlWhenExperimentOff.includes('Support Contact Halo'),
    'Support Contact Halo toggle must be hidden when support-halo experiment is disabled',
  );
  assert.ok(
    !htmlWhenExperimentOff.includes('Automatic Halo Settings'),
    'Automatic Halo Settings must be hidden when support-halo experiment is disabled',
  );

  // 2. When support-halo experiment is enabled: Support Contact Halo and nested controls are rendered
  let storedExperiments: string | null = null;
  const restoreWindow = installFakeWindow({
    localStorage: {
      getItem: (key: string) => (key === EXPERIMENTS_ENABLED_STORAGE_KEY ? storedExperiments : null),
      setItem: (key: string, value: string) => {
        if (key === EXPERIMENTS_ENABLED_STORAGE_KEY) storedExperiments = value;
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });

  try {
    setExperimentEnabled('support-halo', true);
    const htmlWhenExperimentOn = renderToStaticMarkup(
      <I18nProvider i18n={i18n}>
        <MaterialAntiAliasingSection draft={draftWithHaloOn} onChange={() => {}} />
      </I18nProvider>,
    );
    assert.ok(
      htmlWhenExperimentOn.includes('Support Contact Halo'),
      'Support Contact Halo toggle must be visible when support-halo experiment is enabled',
    );
    assert.ok(
      htmlWhenExperimentOn.includes('Automatic Halo Settings'),
      'Automatic Halo Settings must be visible when support-halo experiment and supportHaloEnabled are true',
    );
    assert.ok(
      htmlWhenExperimentOn.includes('Halo Radius @ 0.40mm Tip (mm)'),
      'Halo Radius @ 0.40mm Tip (mm) must be visible when support-halo experiment is enabled',
    );
  } finally {
    restoreWindow();
  }
});

test('toggleExperimentWithSideEffects updates profileStore and sessionStorage AA overrides before firing subscribeToExperiments listeners', () => {
  const localStore = new Map<string, string>();
  const sessionStore = new Map<string, string>();
  const events = new EventTarget();

  const restoreWindow = installFakeWindow({
    localStorage: {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStore.set(key, value);
      },
      removeItem: (key: string) => {
        localStore.delete(key);
      },
    },
    sessionStorage: {
      getItem: (key: string) => sessionStore.get(key) ?? null,
      setItem: (key: string, value: string) => {
        sessionStore.set(key, value);
      },
      removeItem: (key: string) => {
        sessionStore.delete(key);
      },
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });

  try {
    const presets = getLibraryPrinterPresets();
    assert.ok(presets.length > 0, 'expected printer presets');
    const printerId = addPrinterProfileFromPreset(presets[0]!.presetId);
    const materialId = addMaterialProfile(printerId, { name: 'Live SlicingPanel Sync Material' });

    const sessionOverrideKey = 'dragonfruit.slicing.sessionAaOverrideByMaterial.v1';
    sessionStore.set(
      sessionOverrideKey,
      JSON.stringify({
        [materialId]: {
          minimumAaAlphaPercent: 35,
          antiAliasingSettings: {
            ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
            supportHaloEnabled: false,
            supportHaloAuto: false,
          },
        },
      }),
    );

    type SyncObservation = {
      experimentEnabled: boolean;
      profileSupportHaloEnabled: boolean | undefined;
      sessionOverrideSupportHaloEnabled: boolean | undefined;
    };
    const observations: SyncObservation[] = [];

    const unsubscribe = subscribeToExperiments(() => {
      const parsedSession = JSON.parse(sessionStore.get(sessionOverrideKey) ?? '{}') as Record<
        string,
        { antiAliasingSettings?: { supportHaloEnabled?: boolean } }
      >;
      const profile = getProfileStoreSnapshot().materialProfiles.find((entry) => entry.id === materialId);
      observations.push({
        experimentEnabled: isExperimentEnabled('support-halo'),
        profileSupportHaloEnabled: profile?.antiAliasingSettings.supportHaloEnabled,
        sessionOverrideSupportHaloEnabled: parsedSession[materialId]?.antiAliasingSettings?.supportHaloEnabled,
      });
    });

    try {
      toggleExperimentWithSideEffects('support-halo', true);
      assert.equal(observations.length, 1);
      assert.deepEqual(observations[0], {
        experimentEnabled: true,
        profileSupportHaloEnabled: true,
        sessionOverrideSupportHaloEnabled: true,
      });

      toggleExperimentWithSideEffects('support-halo', false);
      assert.equal(observations.length, 2);
      assert.deepEqual(observations[1], {
        experimentEnabled: false,
        profileSupportHaloEnabled: false,
        sessionOverrideSupportHaloEnabled: false,
      });
    } finally {
      unsubscribe();
    }
  } finally {
    restoreWindow();
  }
});
