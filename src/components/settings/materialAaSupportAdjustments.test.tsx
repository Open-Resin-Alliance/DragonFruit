import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS } from '@/features/profiles/profileStore';
import { MaterialAntiAliasingSection, type MaterialDraft } from './profileFormAtoms';

test('Support Adjustments stay available with Custom Settings and Override Auto off', () => {
  for (const mode of ['Blur', 'Off'] as const) {
    const draft = {
      antiAliasingSettings: {
        ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
        enableCustomSettings: false,
        enableOverride: false,
        mode,
      },
      layerHeightMm: 0.05,
    } as MaterialDraft;
    const html = renderToStaticMarkup(<MaterialAntiAliasingSection draft={draft} onChange={() => {}} />);
    for (const label of ['Support Adjustments', 'Apply AA to Support Geometry', '3DAA tip shrink (%)', 'Tip Compensation Offset Mode']) {
      assert.ok(html.includes(label), `${label} visible for Auto preset with saved mode ${mode}`);
    }
    assert.ok(html.includes('Automatic'), 'tip compensation defaults to Auto');
  }
});
