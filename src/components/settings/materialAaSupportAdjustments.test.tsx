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
        tipOffsetMode: 'disabled',
        mode,
      },
      layerHeightMm: 0.05,
    } as MaterialDraft;
    const html = renderToStaticMarkup(<MaterialAntiAliasingSection draft={draft} onChange={() => {}} />);
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
    return renderToStaticMarkup(<MaterialAntiAliasingSection draft={draft} onChange={() => {}} />);
  };

  assert.ok(!render('manual', false).includes('Compensation Distance (mm)'));
  assert.ok(!render('auto', true).includes('Compensation Distance (mm)'));
  assert.ok(!render('disabled', true).includes('Compensation Distance (mm)'));
  const manual = render('manual', true);
  assert.ok(manual.includes('Compensation Distance (mm)'));
  assert.ok(manual.includes('value="0.125"'), 'manual input shows the saved distance');
});
