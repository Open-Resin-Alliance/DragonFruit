import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useLayoutEffect, useState } from 'react';
import { renderWithProviders } from '@/utils/__tests__/helpers/renderDom';
import { GOO_FORMAT_DEFINITION } from '../../../../plugins/elegoo/slicing/gooFormatDefinition';
import { CTB_FORMAT_DEFINITION } from '../../../../plugins/ctb/slicing/ctbFormatDefinition';
import { ANYCUBIC_AFF_FORMAT_DEFINITION } from '../../../../plugins/anycubic/slicing/affFormatDefinition';
import { LayerSettingsRangeEditor } from '../components/LayerSettingsRangeEditor';
import { parseLayerSettingsRanges, type LayerPrintSettingsPatch, type LayerSettingsRange } from '../layerSettingsRanges';
import type { SlicingFormatDefinition } from '../formats/types';
import GOO_PLUGIN from '../../../../plugins/elegoo/pluginDefinition';
import CTB_PLUGIN from '../../../../plugins/ctb/pluginDefinition';
import ANYCUBIC_PLUGIN from '../../../../plugins/anycubic/pluginDefinition';

function materialSettings(format: SlicingFormatDefinition, mode: string) {
  const plugin = format.outputFormat === GOO_FORMAT_DEFINITION.outputFormat ? GOO_PLUGIN
    : format.outputFormat === CTB_FORMAT_DEFINITION.outputFormat ? CTB_PLUGIN : ANYCUBIC_PLUGIN;
  return plugin.localMaterialSettingsByOutputAndMode?.[format.outputFormat]?.[mode]
    ?? plugin.localMaterialSettingsByOutput?.[format.outputFormat] ?? null;
}

const MOTION = {
  liftHeightMm: 8, liftHeight2Mm: 2, liftSpeedMmMin: 60, liftSpeed2MmMin: 180,
  retractSpeedMmMin: 180, retractSpeed2MmMin: 60,
};
const PAIRS = [
  ['Lift travel', 'Total lift travel', 'Stage 2 lift travel', '8', '2'],
  ['Lift speed', 'Lift speed', 'Stage 2 lift speed', '60', '180'],
  ['Retract speed', 'Retract speed', 'Stage 2 retract speed', '180', '60'],
] as const;

function dialog(): HTMLElement {
  const value = document.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(value, 'range dialog is open');
  return value;
}
function button(root: ParentNode, label: string): HTMLButtonElement {
  const value = [...root.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === label);
  assert.ok(value, 'button exists: ' + label);
  return value;
}
function row(label: string): HTMLElement {
  const value = [...dialog().querySelectorAll<HTMLElement>('[role="group"]')].find((entry) => entry.getAttribute('aria-label') === label);
  assert.ok(value, 'motion row exists: ' + label);
  return value;
}
function input(label: string): HTMLInputElement {
  const value = [...dialog().querySelectorAll<HTMLInputElement>('input')].find((entry) => entry.getAttribute('aria-label') === label);
  assert.ok(value, 'input exists: ' + label);
  return value;
}
function toggle(label: string): HTMLButtonElement {
  const value = row(label).querySelector<HTMLButtonElement>('[role="switch"]');
  assert.ok(value, 'shared toggle exists: ' + label);
  return value;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function type(label: string, value: string) {
  const element = input(label);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter);
  await act(async () => {
    element.focus();
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mountEditor(settings: LayerPrintSettingsPatch = { exposureSec: 7 }, format: SlicingFormatDefinition = GOO_FORMAT_DEFINITION, mode = 'twostage') {
  let bridge: { ranges: LayerSettingsRange[]; applies: number; request(): void; setProfile(format: SlicingFormatDefinition, mode: string): void } | undefined;
  function Harness() {
    const [ranges, setRanges] = useState(() => parseLayerSettingsRanges([
      { id: 'wide', startLayer: 1, endLayer: 100, settings: { ...MOTION, exposureSec: 4 } },
      { id: 'narrow', startLayer: 4, endLayer: 6, settings },
    ]));
    const [request, setRequest] = useState<{ layerNumber: number; position: { x: number; y: number } } | null>({ layerNumber: 5, position: { x: 10, y: 10 } });
    const [applies, setApplies] = useState(0);
    const [profile, setProfile] = useState({ format, mode });
    useLayoutEffect(() => {
      bridge = { ranges, applies, request: () => setRequest({ layerNumber: 5, position: { x: 10, y: 10 } }), setProfile: (next, nextMode) => setProfile({ format: next, mode: nextMode }) };
    });
    return <LayerSettingsRangeEditor ranges={ranges} rangeColors={new Map([['wide', '#123456'], ['narrow', '#abcdef']])} totalLayers={12} layerHeightMm={0.05} format={profile.format} materialSettings={materialSettings(profile.format, profile.mode)} normalExposureSec={2} menuRequest={request} onCloseMenu={() => setRequest(null)} onApply={(next) => {
      setRanges(parseLayerSettingsRanges(next));
      setApplies((count) => count + 1);
    }} />;
  }
  const tree = await renderWithProviders(<Harness />);
  const state = () => {
    assert.ok(bridge);
    return bridge;
  };
  const edit = async () => {
    if (!document.querySelector('[role="menu"]')) await act(async () => state().request());
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    assert.ok(menu);
    await click(button(menu, 'Manage ranges'));
    const saved = dialog().querySelector<HTMLElement>('[aria-label="Saved ranges"]');
    assert.ok(saved);
    const edits = [...saved.querySelectorAll<HTMLButtonElement>('button')].filter((entry) => entry.textContent?.trim() === 'Edit');
    assert.equal(edits.length, 2);
    await click(edits[1]);
  };
  await edit();
  return { ...tree, state, edit, current: () => state().ranges.find((range) => range.id === 'narrow')! };
}

test('motion pairs share one semantic row and toggle while typing preserves companion inheritance', async () => {
  const tree = await mountEditor();
  try {
    for (const [label, first, second] of PAIRS) {
      assert.equal(row(label).contains(input(first)), true);
      assert.equal(row(label).contains(input(second)), true);
      assert.equal(row(label).querySelectorAll('[role="switch"]').length, 1);
      assert.equal(toggle(label).getAttribute('aria-checked'), 'false');
    }
    await type('Lift speed', '90');
    assert.equal(toggle('Lift speed').getAttribute('aria-checked'), 'true');
    assert.equal(input('Stage 2 lift speed').value, '180');
    await click(button(dialog(), 'Apply'));
    assert.deepEqual(tree.current().settings, { exposureSec: 7, liftSpeedMmMin: 90 });
    assert.equal(Object.hasOwn(tree.current().settings, 'liftSpeed2MmMin'), false);
    assert.equal(tree.state().applies, 1);
  } finally { await tree.unmount(); }
});

test('explicit shared toggles seed both supported values and clear only their pair', async () => {
  const tree = await mountEditor();
  try {
    for (const [label, first, second, firstValue, secondValue] of PAIRS) {
      await click(toggle(label));
      assert.equal(input(first).value, firstValue);
      assert.equal(input(second).value, secondValue);
    }
    await click(button(dialog(), 'Apply'));
    assert.deepEqual(tree.current().settings, { exposureSec: 7, ...MOTION });
    await tree.edit();
    await click(toggle('Lift travel'));
    await click(button(dialog(), 'Apply'));
    const expected: LayerPrintSettingsPatch = { exposureSec: 7, ...MOTION };
    delete expected.liftHeightMm;
    delete expected.liftHeight2Mm;
    assert.deepEqual(tree.current().settings, expected);
    assert.equal(tree.state().applies, 2);
  } finally { await tree.unmount(); }
});

test('opening and cancelling a partial motion pair never materializes its inherited companion', async () => {
  const tree = await mountEditor({ exposureSec: 7, liftHeightMm: 10 });
  try {
    assert.equal(toggle('Lift travel').getAttribute('aria-checked'), 'true');
    assert.equal(input('Stage 2 lift travel').value, '2');
    await click(button(dialog(), 'Apply'));
    assert.equal(tree.state().applies, 0);
    assert.deepEqual(tree.current().settings, { exposureSec: 7, liftHeightMm: 10 });
    await tree.edit();
    await type('Stage 2 lift travel', '3');
    await click(button(dialog(), 'Cancel'));
    assert.deepEqual(tree.current().settings, { exposureSec: 7, liftHeightMm: 10 });
    assert.equal(tree.state().applies, 0);
  } finally { await tree.unmount(); }
});

test('profile modes and encoder capabilities both prevent unsupported companions', async (t) => {
  for (const [format, mode, label, supportedField, unsupportedLabel, expected] of [
    [CTB_FORMAT_DEFINITION, 'simple', 'Lift speed', 'Lift speed', 'Stage 2 lift speed', { exposureSec: 7, liftSpeedMmMin: 60 }],
    [ANYCUBIC_AFF_FORMAT_DEFINITION, 'twostage', 'Total lift travel', 'Total lift travel', 'Stage 2 lift travel', { exposureSec: 7, liftHeightMm: 8 }],
  ] as const) {
    await t.test(format.displayName, async () => {
      const tree = await mountEditor({ exposureSec: 7 }, format, mode);
      try {
        assert.equal([...row(label).querySelectorAll('input')].some((entry) => entry.getAttribute('aria-label') === unsupportedLabel), false);
        assert.equal(input(supportedField).disabled, false);
        await click(toggle(label));
        await click(button(dialog(), 'Apply'));
        assert.deepEqual(tree.current().settings, expected);
      } finally { await tree.unmount(); }
    });
  }
});

test('incompatible stored fields are read-only and independently removable without dropping other fields', async () => {
  const v2: SlicingFormatDefinition = { ...CTB_FORMAT_DEFINITION, formatVersions: [{ value: 'v2', label: 'V2', isDefault: true, layerSettingsFields: ['exposureSec', 'lightOffDelaySec'] }] };
  const tree = await mountEditor({ exposureSec: 7, liftHeightMm: 8, liftHeight2Mm: 2 }, v2);
  try {
    assert.equal(input('Total lift travel').disabled, true);
    assert.equal(input('Stage 2 lift travel').disabled, true);
    await click(toggle('Total lift travel'));
    await click(toggle('Stage 2 lift travel'));
    await click(button(dialog(), 'Apply'));
    assert.deepEqual(tree.current().settings, { exposureSec: 7 });
  } finally { await tree.unmount(); }
});


test('changing material mode updates editable controls without rewriting sparse stored values', async () => {
  const stored = { exposureSec: 7, liftHeight2Mm: 3, liftSpeedMmMin: 90 };
  const tree = await mountEditor(stored);
  try {
    assert.equal(input('Stage 2 lift travel').disabled, false);
    await act(async () => tree.state().setProfile(GOO_FORMAT_DEFINITION, 'simple'));
    assert.equal(input('Stage 2 lift travel').disabled, true);
    assert.equal(input('Stage 2 lift travel').value, '3');
    assert.equal(input('Lift speed').disabled, false);
    assert.deepEqual(tree.current().settings, stored);
    await click(button(dialog(), 'Apply'));
    assert.equal(tree.state().applies, 0);
    await tree.edit();
    await act(async () => tree.state().setProfile(GOO_FORMAT_DEFINITION, 'tilting'));
    assert.equal(input('Lift speed').disabled, true);
    assert.equal(input('Exposure').disabled, false);
    assert.equal([...dialog().querySelectorAll('input')].some((entry) => entry.getAttribute('aria-label') === 'Total lift travel'), false);
    await act(async () => tree.state().setProfile(GOO_FORMAT_DEFINITION, 'twostage'));
    assert.equal(input('Stage 2 lift travel').disabled, false);
    assert.equal(input('Stage 2 lift travel').value, '3');
    await click(button(dialog(), 'Apply'));
    assert.deepEqual(tree.current().settings, stored);
    assert.equal(tree.state().applies, 0);
  } finally { await tree.unmount(); }
});

test('mode-hidden overrides can be removed without clearing other sparse fields', async () => {
  const tree = await mountEditor({ exposureSec: 7, liftHeight2Mm: 3, liftSpeedMmMin: 90 }, GOO_FORMAT_DEFINITION, 'simple');
  try {
    assert.equal(input('Stage 2 lift travel').disabled, true);
    await click(toggle('Stage 2 lift travel'));
    assert.equal([...dialog().querySelectorAll('input')].some((entry) => entry.getAttribute('aria-label') === 'Stage 2 lift travel'), false);
    await click(button(dialog(), 'Apply'));
    assert.deepEqual(tree.current().settings, { exposureSec: 7, liftSpeedMmMin: 90 });
    assert.equal(tree.state().applies, 1);
  } finally { await tree.unmount(); }
});
