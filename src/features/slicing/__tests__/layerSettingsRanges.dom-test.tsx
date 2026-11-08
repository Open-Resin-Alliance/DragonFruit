import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useLayoutEffect, useRef, useState } from 'react';
import { LayerSlider, type LayerSliderRangeBand } from '@/components/controls/LayerSlider';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import { useLingui } from '@lingui/react';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { GOO_FORMAT_DEFINITION } from '../../../../plugins/elegoo/slicing/gooFormatDefinition';
import { CTB_FORMAT_DEFINITION } from '../../../../plugins/ctb/slicing/ctbFormatDefinition';
import { LUMEN_FORMAT_DEFINITION } from '../../../../plugins/lumen/slicing/lumenFormatDefinition';
import { LayerSettingsRangeEditor } from '../components/LayerSettingsRangeEditor';
import type { SlicingFormatDefinition } from '../formats/types';
import { formatLayerSettingsRangeBounds } from '../layerSettingsRangeMessages';
import { compileLayerSettingsRanges, parseLayerSettingsRanges, resolveLayerSettingsRangeBounds, type LayerSettingsRange } from '../layerSettingsRanges';
import { useLayerSettingsRangeColors } from '../useLayerSettingsRangeColors';
import { getProfileLocalMaterialSettingsAdapter } from '@/features/plugins/pluginRegistry';

const initialRanges: LayerSettingsRange[] = [
  { id: 'hidden-arbitrary-id', startLayer: 3, endLayer: 10, settings: { exposureSec: 3 } },
  { id: 'wide-not-a-palette-index', startLayer: 3, endLayer: 10, settings: { exposureSec: 4, liftHeightMm: 8 } },
  { id: 'beyond-current-print', startLayer: 18, endLayer: 20, settings: { exposureSec: 6, liftHeightMm: 9 } },
  { id: 'first-two-printed-layers', startLayer: 1, endLayer: 2, settings: { exposureSec: 10 } },
];

type HarnessState = {
  ranges: readonly LayerSettingsRange[];
  colors: ReadonlyMap<string, string>;
  lower: number;
  upper: number;
  applies: number;
  setRanges(next: readonly LayerSettingsRange[]): void;
  setLayerHeightMm(next: number): void;
  setProfile(format: SlicingFormatDefinition | null, version?: string): void;
};

async function mountHarness({
  ranges = initialRanges,
  totalLayers = 12,
  layerHeightMm = 0.05,
  preview = false,
  format = GOO_FORMAT_DEFINITION as SlicingFormatDefinition | null,
}: { ranges?: readonly LayerSettingsRange[]; totalLayers?: number; layerHeightMm?: number; preview?: boolean; format?: SlicingFormatDefinition | null } = {}) {
  const bridge: { current: HarnessState | null } = { current: null };
  function Harness() {
    const [ownedRanges, setRanges] = useState(() => parseLayerSettingsRanges(ranges));
    const [height, setLayerHeightMm] = useState(layerHeightMm);
    const [profile, setProfile] = useState({ format, version: undefined as string | undefined });
    const [lower, setLower] = useState(preview ? 1 : 0);
    const [upper, setUpper] = useState(Math.max(preview ? 1 : 0, totalLayers));
    const [menuRequest, setMenuRequest] = useState<React.ComponentProps<typeof LayerSettingsRangeEditor>['menuRequest']>(null);
    const applies = useRef(0);
    const colors = useLayerSettingsRangeColors(ownedRanges);
    const fmt = useLocaleFormat();
    const { _ } = useLingui();
    const segments = compileLayerSettingsRanges(ownedRanges, totalLayers, height);
    const bands: LayerSliderRangeBand[] = segments.flatMap((segment) => {
      const color = colors.get(segment.rangeId);
      if (!color || totalLayers === 0) return [];
      const original = ownedRanges.find((range) => range.id === segment.rangeId)!;
      const span = Math.max(1, totalLayers - 1);
      return [{
        id: `${segment.rangeId}:${segment.startLayer}:${segment.endLayer}`,
        bottomPercent: preview ? (totalLayers === 1 ? 0 : 100 * (Math.max(1, segment.startLayer - 0.5) - 1) / span) : 100 * (segment.startLayer - 1) / totalLayers,
        topPercent: preview ? (totalLayers === 1 ? 100 : 100 * (Math.min(totalLayers, segment.endLayer + 0.5) - 1) / span) : 100 * segment.endLayer / totalLayers,
        color,
        label: formatLayerSettingsRangeBounds(_, fmt, original),
      }];
    });
    useLayoutEffect(() => {
      bridge.current = {
        ranges: ownedRanges,
        colors,
        lower,
        upper,
        applies: applies.current,
        setRanges: (next) => setRanges(parseLayerSettingsRanges(next)),
        setLayerHeightMm,
        setProfile: (next, version) => setProfile({ format: next, version }),
      };
    });
    return (
      <>
        <div style={{ height: 240 }}>
          <LayerSlider
            min={preview ? 1 : 0}
            max={Math.max(preview ? 1 : 0, totalLayers)}
            value={upper}
            lowerValue={lower}
            onChange={setUpper}
            onLowerChange={setLower}
            step={1}
            docked
            embedded
            expandToContainer
            rangeBands={bands}
            onRangeContextMenu={(value, position) => setMenuRequest({
              layerNumber: totalLayers === 0 ? null : Math.max(1, Math.min(totalLayers, preview ? Math.round(value) : Math.ceil(value))),
              position,
            })}
          />
        </div>
        <LayerSettingsRangeEditor
          ranges={ownedRanges}
          rangeColors={colors}
          totalLayers={totalLayers}
          layerHeightMm={height}
          format={profile.format}
          formatVersion={profile.version}
          materialSettings={profile.format ? getProfileLocalMaterialSettingsAdapter(profile.format.outputFormat, 'twostage') : null}
          normalExposureSec={2}
          menuRequest={menuRequest}
          onCloseMenu={() => setMenuRequest(null)}
          onApply={(next) => {
            applies.current += 1;
            setRanges(parseLayerSettingsRanges(next));
          }}
        />
      </>
    );
  }
  const tree = await renderWithProviders(<Harness />);
  const rail = tree.container.querySelector<HTMLElement>('[tabindex="0"]');
  assert.ok(rail);
  const measuredRail = rail.querySelector<HTMLElement>('[data-no-drag="true"]');
  assert.ok(measuredRail);
  // happy-dom has no layout engine. Give the real rail a deterministic physical extent.
  for (const element of [rail, measuredRail]) {
    element.getBoundingClientRect = () => new DOMRect(0, 0, 40, 240);
  }
  const state = () => {
    assert.ok(bridge.current);
    return bridge.current;
  };
  const rightClick = async (value: number, mouseupFirst = false) => {
    const min = preview ? 1 : 0;
    const span = Math.max(1, totalLayers - min);
    const y = 240 * (1 - (value - min) / span);
    await act(async () => {
      rail.dispatchEvent(new MouseEvent('mousedown', { button: 2, clientX: 20, clientY: y, bubbles: true, cancelable: true }));
      if (mouseupFirst) rail.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true }));
      rail.dispatchEvent(new MouseEvent('contextmenu', { button: 2, clientX: 20, clientY: y, bubbles: true, cancelable: true }));
      if (!mouseupFirst) rail.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true }));
    });
  };
  return { ...tree, rail, rightClick, state };
}

function dialog() {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(element);
  return element;
}

function menu() {
  const element = document.querySelector<HTMLElement>('[role="menu"][aria-label="Layer settings ranges"]');
  assert.ok(element);
  return element;
}

function button(root: ParentNode, text: string) {
  const element = [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === text);
  assert.ok(element, `button ${text}`);
  return element;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function field(label: string) {
  const input = dialog().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(input, `input ${label}`);
  return input;
}

async function typeValue(label: string, value: string) {
  const input = field(label);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter);
  await act(async () => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function toggle(label: string) {
  const element = dialog().querySelector<HTMLButtonElement>(`[role="switch"][aria-label="Override ${label}"]`);
  assert.ok(element, `override ${label}`);
  await click(element);
}

function savedRows() {
  return [...dialog().querySelectorAll<HTMLElement>('section[aria-label="Saved ranges"] > div')];
}

async function manage(tree: Awaited<ReturnType<typeof mountHarness>>) {
  await tree.rightClick(5);
  await click(button(menu(), 'Manage ranges'));
}

async function escape(target: EventTarget = document) {
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    // This owned-state harness has no Home keyboard bridge. Deliver the same
    // application event consumed by the shared dialog/menu Escape stack.
    if (!event.defaultPrevented) {
      window.dispatchEvent(new CustomEvent('app-hotkey-keydown', { detail: { key: 'Escape' } }));
    }
  });
}

function cssColor(value: string) {
  const element = document.createElement('span');
  element.style.backgroundColor = value;
  return element.style.backgroundColor;
}

function swatchColor(row: HTMLElement) {
  const swatch = row.querySelector<HTMLElement>('span[aria-hidden="true"]');
  assert.ok(swatch);
  return swatch.style.backgroundColor;
}

test('bare scene track adds layers 5–6 without moving either clip thumb, inherits wider motion and exposes every matching range', async () => {
  const tree = await mountHarness();
  try {
    const before = [tree.state().lower, tree.state().upper];
    await tree.rightClick(4.5, true);
    const matchingBefore = [...menu().querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')];
    assert.deepEqual(matchingBefore.map((entry) => entry.textContent?.trim()), ['Layers 3–10', 'Layers 3–10']);
    assert.equal(swatchColor(matchingBefore[0]), cssColor(tree.state().colors.get(initialRanges[1].id)!));
    await click(button(menu(), 'Add range'));
    assert.equal(field('Start layer').value, '5');
    assert.equal(field('End layer').value, '5');
    assert.equal(button(dialog(), 'Apply').disabled, true, 'new drafts do not copy inherited properties');
    await typeValue('End layer', '6');
    await toggle('Exposure');
    assert.equal(field('Exposure').value, '4', 'enabling seeds the compiled wider patch');
    await typeValue('Exposure', '7');
    await click(button(dialog(), 'Apply'));
    const added = tree.state().ranges.at(-1)!;
    assert.ok(added.unit !== 'mm');
    assert.equal(added.startLayer, 5);
    assert.equal(added.endLayer, 6);
    assert.deepEqual(added.settings, { exposureSec: 7 });
    assert.equal(tree.state().applies, 1);
    assert.deepEqual([tree.state().lower, tree.state().upper], before);
    const effective = compileLayerSettingsRanges(tree.state().ranges, 12).find((segment) => segment.startLayer <= 5 && segment.endLayer >= 5);
    assert.deepEqual(effective?.settings, { exposureSec: 7, liftHeightMm: 8 });
    assert.equal(effective?.rangeId, added.id);
    const band = tree.container.querySelector<HTMLElement>('[title="Layers 5–6"]');
    assert.ok(band, 'the real slider paints the newly applied segment');
    assert.equal(cssColor(band.style.background), cssColor(tree.state().colors.get(added.id)!));
    assert.equal(new Set(tree.state().colors.values()).size, tree.state().ranges.length);

    await tree.rightClick(5);
    const matches = [...menu().querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')];
    assert.deepEqual(matches.map((entry) => entry.textContent?.trim()), ['Layers 5–6', 'Layers 3–10', 'Layers 3–10']);
    assert.equal(swatchColor(matches[0]), cssColor(tree.state().colors.get(added.id)!));
    await click(matches[0]);
    const edit = button(menu(), 'Edit');
    assert.equal(swatchColor(edit), cssColor(tree.state().colors.get(added.id)!));
    await click(edit);
    assert.equal(dialog().getAttribute('aria-label'), 'Edit range');
    assert.match(dialog().textContent ?? '', /Ranges apply to the next slice; existing files are unchanged/);
    const rows = savedRows();
    assert.equal(rows.length, 5);
    assert.match(rows[0].textContent ?? '', /Layers 3–10/, 'fully shadowed range remains manageable');
    assert.match(rows[2].textContent ?? '', /Layers 18–20/, 'beyond-EOF range remains manageable');
    rows.forEach((row, index) => assert.equal(swatchColor(row), cssColor(tree.state().colors.get(tree.state().ranges[index].id)!)));
    assert.match(rows.at(-1)?.textContent ?? '', /Editing/);
    await toggle('Lift travel');
    assert.equal(field('Total lift travel').value, '8', 'enabling a nested motion override seeds the inherited wider value');
    await toggle('Lift travel');
    await click(button(dialog(), 'Apply'));
    assert.equal(tree.state().applies, 1, 'applying an unchanged edit creates no action');
    await manage(tree);
    await click(button(savedRows()[0], 'Edit'));
    await toggle('Lift speed');
    assert.equal(field('Lift speed').value, '0', 'uncovered motion uses an explicit zero seed');
    await toggle('Light PWM');
    assert.equal(field('Light PWM').value, '255');
    await click(button(dialog(), 'Cancel'));
    assert.equal(tree.state().applies, 1);
  } finally {
    await tree.unmount();
  }
});

test('Cancel, Escape and backdrop discard drafts; invalid bounds, empty patches and fractional PWM cannot apply', async () => {
  const tree = await mountHarness({ ranges: [] });
  try {
    await tree.rightClick(4.5);
    await click(button(menu(), 'Add range'));
    assert.equal(button(dialog(), 'Apply').disabled, true);
    await toggle('Exposure');
    assert.equal(field('Exposure').value, '2', 'uncovered exposure uses the normal profile');
    await typeValue('End layer', '4');
    assert.equal(button(dialog(), 'Apply').disabled, true);
    assert.match(dialog().querySelector('[role="alert"]')?.textContent ?? '', /start layer must not exceed/);
    await typeValue('End layer', '5');
    await typeValue('Start layer', '5.5');
    assert.equal(button(dialog(), 'Apply').disabled, true);
    await typeValue('Start layer', '0');
    assert.equal(button(dialog(), 'Apply').disabled, true);
    await typeValue('Start layer', '4294967296');
    assert.equal(button(dialog(), 'Apply').disabled, true);
    await typeValue('Start layer', '5');
    await toggle('Light PWM');
    await typeValue('Light PWM', '1.5');
    assert.equal(button(dialog(), 'Apply').disabled, true);
    assert.match(dialog().querySelector('[role="alert"]')?.textContent ?? '', /PWM must be a whole number/);
    await toggle('Light PWM');
    await toggle('Exposure');
    assert.equal(button(dialog(), 'Apply').disabled, true, 'unchecking deletes the property');
    await click(button(dialog(), 'Cancel'));
    assert.equal(tree.state().applies, 0);
    await tree.rightClick(5);
    await click(button(menu(), 'Add range'));
    await toggle('Exposure');
    await escape();
    assert.equal(document.querySelector('[role="dialog"]') === null, true, 'the dialog is dismissed');
    await tree.rightClick(5);
    await click(button(menu(), 'Add range'));
    await toggle('Exposure');
    const backdrop = dialog().parentElement;
    assert.ok(backdrop);
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    assert.equal(document.querySelector('[role="dialog"]') === null, true, 'the dialog is dismissed');
    assert.deepEqual(tree.state().ranges, []);
    assert.equal(tree.state().applies, 0);
  } finally {
    await tree.unmount();
  }
});

test('edits use the latest owned array, preserve order, refuse missing ids and delete one range in one action', async () => {
  const tree = await mountHarness();
  try {
    await manage(tree);
    await click(button(savedRows()[1], 'Edit'));
    await typeValue('Exposure', '7');
    const appended: LayerSettingsRange = { id: 'concurrent-add', startLayer: 11, endLayer: 12, settings: { exposureSec: 12 } };
    const latest = tree.state().ranges.map((range, index) => index === 0 ? { ...range, settings: { exposureSec: 13 } } : range);
    await act(async () => tree.state().setRanges([...latest, appended]));
    await click(button(dialog(), 'Apply'));
    assert.deepEqual(tree.state().ranges.map((range) => range.id), [...initialRanges.map((range) => range.id), appended.id]);
    assert.deepEqual(tree.state().ranges[0].settings, { exposureSec: 13 });
    assert.deepEqual(tree.state().ranges[1].settings, { exposureSec: 7, liftHeightMm: 8 });
    assert.deepEqual(tree.state().ranges.at(-1), appended);
    assert.equal(tree.state().applies, 1);

    await manage(tree);
    await click(button(savedRows()[1], 'Edit'));
    const removedId = tree.state().ranges[1].id;
    await act(async () => tree.state().setRanges(tree.state().ranges.filter((range) => range.id !== removedId)));
    assert.match(dialog().querySelector('[role="alert"]')?.textContent ?? '', /This range no longer exists/);
    assert.equal(button(dialog(), 'Apply').disabled, true);
    await click(button(dialog(), 'Cancel'));
    assert.equal(tree.state().ranges.some((range) => range.id === removedId), false);
    assert.equal(tree.state().applies, 1);
    await manage(tree);
    const beforeDelete = tree.state().ranges;
    await click(button(savedRows()[1], 'Delete'));
    assert.deepEqual(tree.state().ranges, beforeDelete.filter((_, index) => index !== 1));
    assert.equal(tree.state().applies, 2);
    await click(button(dialog(), 'Close'));
    await tree.rightClick(5);
    const submenu = menu().querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    assert.ok(submenu);
    await click(submenu);
    const beforeMenuDelete = tree.state().ranges;
    await click(button(menu(), 'Delete'));
    assert.deepEqual(tree.state().ranges, beforeMenuDelete.filter((range) => range.id !== initialRanges[0].id));
    assert.equal(tree.state().applies, 3);
  } finally {
    await tree.unmount();
  }
});

test('printer switches preserve incompatible values for repair; unsupported formats still permit inspection and deletion', async () => {
  const tree = await mountHarness();
  try {
    await manage(tree);
    await click(button(savedRows()[1], 'Edit'));
    await act(async () => tree.state().setProfile(CTB_FORMAT_DEFINITION, 'v2'));
    assert.equal(field('Total lift travel').value, '8');
    assert.equal(field('Total lift travel').disabled, true);
    assert.equal(field('Exposure').disabled, false);
    assert.equal(button(dialog(), 'Apply').disabled, true);
    const warning = dialog().querySelector('[role="alert"]')?.textContent ?? '';
    assert.match(warning, /CTB \(V2\)/);
    assert.match(warning, /Layers 3–10/);
    assert.match(warning, /Total lift travel/);
    await toggle('Total lift travel');
    assert.equal(button(dialog(), 'Apply').disabled, false, 'another incompatible range must not prevent this range repair');
    await click(button(dialog(), 'Apply'));
    assert.deepEqual(tree.state().ranges[1].settings, { exposureSec: 4 });
    assert.deepEqual(tree.state().ranges[2].settings, { exposureSec: 6, liftHeightMm: 9 }, 'other incompatible patches remain unchanged');
    assert.equal(tree.state().applies, 1);

    await act(async () => tree.state().setProfile(LUMEN_FORMAT_DEFINITION));
    await tree.rightClick(5);
    assert.equal(button(menu(), 'Add range').disabled, true);
    await click(button(menu(), 'Manage ranges'));
    await click(button(savedRows()[2], 'Edit'));
    assert.equal(field('Start layer').disabled, true);
    assert.equal(field('Exposure').disabled, true);
    assert.equal(field('Total lift travel').disabled, true);
    assert.match(dialog().textContent ?? '', /Existing ranges can be inspected or deleted/);
    const before = tree.state().ranges;
    await click(button(savedRows()[2], 'Delete'));
    assert.deepEqual(tree.state().ranges, before.filter((_, index) => index !== 2));
    assert.equal(tree.state().applies, 2);
    assert.equal(dialog().getAttribute('aria-label'), 'Manage ranges');
    await click(button(dialog(), 'Close'));
    await act(async () => tree.state().setProfile(null));
    await tree.rightClick(5);
    assert.equal(button(menu(), 'Add range').disabled, true);
    assert.equal(button(menu(), 'Manage ranges').disabled, false);
  } finally {
    await tree.unmount();
  }
});

test('thumb context edits remain exclusive, subsequent bare gestures and keyboard context menus reach ranges in both rail domains', async () => {
  for (const preview of [false, true]) {
    const tree = await mountHarness({ ranges: [], preview });
    try {
      await tree.rightClick(12, preview);
      assert.equal(document.querySelector('[role="menu"]'), null, 'right-clicking an upper thumb opens only its exact editor');
      const exactInput = tree.container.querySelector<HTMLInputElement>('input');
      assert.ok(exactInput);
      await escape(exactInput);
      assert.equal(tree.container.querySelector('input'), null);
      await tree.rightClick(preview ? 5 : 4.5, !preview);
      await click(button(menu(), 'Add range'));
      assert.equal(field('Start layer').value, '5');
      assert.deepEqual([tree.state().lower, tree.state().upper], [preview ? 1 : 0, 12]);
      await click(button(dialog(), 'Cancel'));
      await act(async () => {
        tree.rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
      });
      await click(button(menu(), 'Add range'));
      assert.equal(field('Start layer').value, '12');
      await click(button(dialog(), 'Cancel'));
      await act(async () => {
        tree.rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
      });
      assert.ok(menu());
      await escape();
    } finally {
      await tree.unmount();
    }
  }
});

test('empty prints retain Manage without matching submenus; one-layer scene and preview bands cover their complete cell', async () => {
  const empty = await mountHarness({ totalLayers: 0 });
  try {
    await empty.rightClick(0.5);
    assert.equal(button(menu(), 'Add range').disabled, true);
    assert.equal(menu().querySelector('button[aria-haspopup="menu"]'), null);
    assert.equal(empty.container.querySelector('[title^="Layers "]'), null);
    await click(button(menu(), 'Manage ranges'));
    assert.equal(savedRows().length, initialRanges.length);
    await click(button(savedRows()[2], 'Delete'));
    assert.equal(empty.state().applies, 1);
  } finally {
    await empty.unmount();
  }
  for (const preview of [false, true]) {
    const single = await mountHarness({ ranges: [{ id: 'one-printed-cell', startLayer: 1, endLayer: 1, settings: { exposureSec: 7 } }], totalLayers: 1, preview });
    try {
      const band = single.container.querySelector<HTMLElement>('[title="Layers 1–1"]');
      assert.ok(band);
      assert.equal(band.style.bottom, '50%', 'the band is centered on the entire single-layer cell');
      assert.match(band.style.height, /100%/, 'the entire cell remains covered with the two-pixel minimum');
      assert.equal(cssColor(band.style.background), cssColor(single.state().colors.get('one-printed-cell')!));
    } finally {
      await single.unmount();
    }
  }
});

test('real range colors remain distinct and shared across bands, menus and Manage in light, dark and colliding custom themes', async () => {
  const root = document.documentElement;
  const previousStyle = root.getAttribute('style');
  const previousTheme = root.getAttribute('data-theme');
  const tree = await mountHarness();
  try {
    for (const theme of [
      { name: 'dark', accent: '#baf72e', success: '#2eb67d', danger: '#e45454' },
      { name: 'light', accent: '#6ab80a', success: '#2eb67d', danger: '#c9302c' },
      { name: 'dark', accent: '#abc', success: '#AABBCC', danger: '#aabbcc' },
    ]) {
      await act(async () => {
        root.setAttribute('data-theme', theme.name);
        root.style.setProperty('--accent-secondary', theme.accent);
        root.style.setProperty('--success', theme.success);
        root.style.setProperty('--danger', theme.danger);
      });
      await settle(20);
      const colors = tree.state().colors;
      assert.equal(colors.size, initialRanges.length);
      assert.equal(new Set(colors.values()).size, initialRanges.length);
      for (const value of colors.values()) assert.match(value, /^#[0-9a-f]{6}$/);
      if (theme.accent === '#abc') assert.equal(colors.get(initialRanges[0].id), '#aabbcc');
      await tree.rightClick(5);
      const matching = [...menu().querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')];
      assert.equal(swatchColor(matching[0]), cssColor(colors.get(initialRanges[1].id)!));
      await click(button(menu(), 'Manage ranges'));
      savedRows().forEach((row, index) => assert.equal(swatchColor(row), cssColor(colors.get(initialRanges[index].id)!)));
      await click(button(dialog(), 'Close'));
      const band = tree.container.querySelector<HTMLElement>('[title="Layers 3–10"]');
      assert.ok(band);
      assert.equal(cssColor(band.style.background), cssColor(colors.get(initialRanges[1].id)!));
      const expected = [...colors.entries()];
      await act(async () => tree.state().setRanges(tree.state().ranges.map((range, index) => index === 1 ? { ...range, settings: { ...range.settings, exposureSec: 11 } } : range)));
      assert.deepEqual([...tree.state().colors.entries()], expected, 'edits without reorder preserve color identity');
      await act(async () => tree.state().setRanges(parseLayerSettingsRanges(JSON.parse(JSON.stringify(tree.state().ranges)))));
      assert.deepEqual([...tree.state().colors.entries()], expected, 'save/load data roundtrips preserve assignment');
    }
  } finally {
    await tree.unmount();
    if (previousStyle === null) root.removeAttribute('style');
    else root.setAttribute('style', previousStyle);
    if (previousTheme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', previousTheme);
  }
});

function overrideSwitch(label: string) {
  const element = dialog().querySelector<HTMLButtonElement>('[role="switch"][aria-label="Override ' + label + '"]');
  assert.ok(element);
  return element;
}

async function selectUnits(unit: 'Layers' | 'mm') {
  const group = dialog().querySelector<HTMLElement>('[role="group"][aria-label="Range units"]');
  assert.ok(group);
  await click(button(group, unit));
}

function matchingLabels() {
  return [...menu().querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')].map((entry) => entry.textContent?.trim() ?? '');
}

test('typing into inherited fields enables only edited overrides; stepping and wheel do the same, while focus and Cancel do not commit', async () => {
  const tree = await mountHarness();
  try {
    await tree.rightClick(5);
    await click(button(menu(), 'Add range'));
    await act(async () => field('Exposure').focus());
    assert.equal(overrideSwitch('Exposure').getAttribute('aria-checked'), 'false');
    assert.equal(field('Exposure').disabled, false);
    assert.equal(button(dialog(), 'Apply').disabled, true, 'focus alone leaves the patch empty');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    assert.ok(setter);
    await act(async () => {
      for (const [label, value] of [['Exposure', '7.25'], ['Total lift travel', '9.5']]) {
        const input = field(label);
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    assert.equal(overrideSwitch('Exposure').getAttribute('aria-checked'), 'true');
    assert.equal(field('Exposure').value, '7.25');
    assert.equal(overrideSwitch('Lift travel').getAttribute('aria-checked'), 'true');
    assert.equal(field('Total lift travel').value, '9.5');
    const speed = field('Lift speed');
    assert.ok(speed.parentElement);
    const increase = speed.parentElement.querySelector<HTMLButtonElement>('button[aria-label="Increase value"]');
    assert.ok(increase);
    await click(increase);
    assert.equal(overrideSwitch('Lift speed').getAttribute('aria-checked'), 'true');
    await act(async () => {
      field('Light PWM').dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }));
    });
    assert.equal(overrideSwitch('Light PWM').getAttribute('aria-checked'), 'true');
    await toggle('Lift travel');
    assert.equal(overrideSwitch('Lift travel').getAttribute('aria-checked'), 'false');
    await click(button(dialog(), 'Apply'));
    assert.deepEqual(tree.state().ranges.at(-1)?.settings, { exposureSec: 7.25, liftSpeedMmMin: 1, lightPwm: 254 });
    assert.equal(tree.state().applies, 1);
    await manage(tree);
    await click(button(savedRows().at(-1)!, 'Edit'));
    await typeValue('Exposure', '8');
    await typeValue('Total lift travel', '12');
    await click(button(dialog(), 'Cancel'));
    assert.deepEqual(tree.state().ranges.at(-1)?.settings, { exposureSec: 7.25, liftSpeedMmMin: 1, lightPwm: 254 });
    assert.equal(tree.state().applies, 1);
  } finally {
    await tree.unmount();
  }
});

test('millimeter bounds persist raw endpoints without layer keys, reopen unchanged, and resolve again when layer height changes', async () => {
  const tree = await mountHarness({ ranges: [] });
  try {
    await tree.rightClick(5);
    await click(button(menu(), 'Add range'));
    await selectUnits('mm');
    await typeValue('Start height', '0.075');
    await typeValue('End height', '0.15');
    await typeValue('Exposure', '6');
    await click(button(dialog(), 'Apply'));
    const added = tree.state().ranges[0];
    assert.ok(added.unit === 'mm');
    assert.deepEqual(added, { id: added.id, unit: 'mm', startMm: 0.075, endMm: 0.15, settings: { exposureSec: 6 } });
    assert.deepEqual(resolveLayerSettingsRangeBounds(added, 0.05), { startLayer: 2, endLayer: 3 });
    assert.ok(tree.container.querySelector('[title^="Height "]'), 'the real slider labels mm ranges in mm');
    await manage(tree);
    await click(button(savedRows()[0], 'Edit'));
    assert.equal(field('Start height').value, '0.075');
    assert.equal(field('End height').value, '0.15');
    await click(button(dialog(), 'Apply'));
    assert.equal(tree.state().applies, 1, 'reopening without changes retains raw mm and creates no action');
    await tree.rightClick(3);
    assert.match(matchingLabels()[0], /^Height .*0.075.*0.15.*mm/);
    await escape();
    await act(async () => tree.state().setLayerHeightMm(0.1));
    assert.deepEqual(resolveLayerSettingsRangeBounds(tree.state().ranges[0], 0.1), { startLayer: 1, endLayer: 1 });
    await tree.rightClick(3);
    assert.deepEqual(matchingLabels(), []);
    await escape();
    await tree.rightClick(1);
    assert.match(matchingLabels()[0], /^Height /);
    await escape();
    assert.deepEqual(tree.state().ranges[0], added, 'profile height changes never rewrite stored endpoints');
    await manage(tree);
    await click(button(savedRows()[0], 'Delete'));
    assert.deepEqual(tree.state().ranges, []);
    assert.equal(tree.state().applies, 2);
  } finally {
    await tree.unmount();
  }
});

test('mixed-unit menus rank resolved spans; inherited values include mm ranges beyond the current print', async () => {
  const ranges: LayerSettingsRange[] = [
    { id: 'height-wide', unit: 'mm', startMm: 0.1, endMm: 1, settings: { exposureSec: 4, liftHeightMm: 8 } },
    { id: 'layer-narrow', startLayer: 3, endLayer: 4, settings: { exposureSec: 7 } },
    { id: 'height-equal-later', unit: 'mm', startMm: 0.15, endMm: 0.2, settings: { exposureSec: 9 } },
    { id: 'height-beyond', unit: 'mm', startMm: 1.5, endMm: 2, settings: { liftHeightMm: 11 } },
  ];
  const tree = await mountHarness({ ranges });
  try {
    await tree.rightClick(3);
    const labels = matchingLabels();
    assert.match(labels[0], /^Height /);
    assert.equal(labels[1], 'Layers 3–4');
    assert.match(labels[2], /^Height /);
    await click(button(menu(), 'Add range'));
    assert.equal(field('Exposure').value, '9');
    assert.equal(field('Total lift travel').value, '8');
    await selectUnits('mm');
    await typeValue('Start height', '1.6');
    await typeValue('End height', '1.8');
    assert.equal(field('Total lift travel').value, '11', 'inheritance resolves original mm bounds beyond EOF');
    await toggle('Lift travel');
    await click(button(dialog(), 'Apply'));
    const added = tree.state().ranges.at(-1)!;
    assert.ok(added.unit === 'mm');
    assert.deepEqual(added.settings, { liftHeightMm: 11, liftHeight2Mm: 0 });
    assert.equal(added.startMm, 1.6);
    await manage(tree);
    assert.equal(savedRows().length, 5);
    assert.match(savedRows()[3].textContent ?? '', /Height /);
  } finally {
    await tree.unmount();
  }
});

test('unit switching preserves grid-aligned printed coverage, stable ids, other fields and latest collection edits', async () => {
  const original: LayerSettingsRange = { id: 'switch-stable-id', startLayer: 3, endLayer: 6, settings: { exposureSec: 4, liftHeightMm: 8 } };
  const tree = await mountHarness({ ranges: [original] });
  try {
    await manage(tree);
    await click(button(savedRows()[0], 'Edit'));
    await selectUnits('mm');
    await typeValue('Exposure', '7');
    const appended: LayerSettingsRange = { id: 'new-mm-from-props', unit: 'mm', startMm: 2, endMm: 3, settings: { exposureSec: 12 } };
    await act(async () => tree.state().setRanges([...tree.state().ranges, appended]));
    await click(button(dialog(), 'Apply'));
    const asMm = tree.state().ranges[0];
    assert.ok(asMm.unit === 'mm');
    assert.equal(asMm.id, original.id);
    assert.equal(asMm.startMm, 3 * 0.05);
    assert.equal(asMm.endMm, 6 * 0.05);
    assert.deepEqual(resolveLayerSettingsRangeBounds(asMm, 0.05), { startLayer: 3, endLayer: 6 });
    assert.deepEqual(asMm.settings, { exposureSec: 7, liftHeightMm: 8 });
    assert.deepEqual(tree.state().ranges[1], appended);
    await manage(tree);
    await click(button(savedRows()[0], 'Edit'));
    await selectUnits('Layers');
    assert.equal(field('Start layer').value, '3');
    assert.equal(field('End layer').value, '6');
    await click(button(dialog(), 'Apply'));
    assert.deepEqual(tree.state().ranges[0], { ...original, settings: { exposureSec: 7, liftHeightMm: 8 } });
    assert.deepEqual(tree.state().ranges[1], appended);
    await manage(tree);
    await click(button(savedRows()[1], 'Edit'));
    await typeValue('Start height', '2.123456');
    await selectUnits('Layers');
    await click(button(dialog(), 'Cancel'));
    assert.deepEqual(tree.state().ranges[1], appended, 'Cancel discards both bound and unit changes');
  } finally {
    await tree.unmount();
  }
});

test('zero and off-grid mm point ranges stay saved even without matching printed layers', async () => {
  const tree = await mountHarness({ ranges: [] });
  try {
    await tree.rightClick(5);
    await click(button(menu(), 'Add range'));
    await selectUnits('mm');
    await typeValue('Start height', '0');
    await typeValue('End height', '0');
    await typeValue('Exposure', '3');
    const group = dialog().querySelector<HTMLElement>('[role="group"][aria-label="Range units"]');
    assert.ok(group);
    assert.equal(button(group, 'Layers').disabled, true, 'an empty physical selection is not fabricated into a layer');
    await click(button(dialog(), 'Apply'));
    assert.deepEqual(tree.state().ranges[0], { id: tree.state().ranges[0].id, unit: 'mm', startMm: 0, endMm: 0, settings: { exposureSec: 3 } });
    assert.deepEqual(compileLayerSettingsRanges(tree.state().ranges, 12, 0.05), []);
    await manage(tree);
    await click(button(savedRows()[0], 'Edit'));
    await typeValue('Start height', '0.075');
    assert.equal(button(dialog(), 'Apply').disabled, true, 'reversed mm bounds cannot apply');
    await typeValue('End height', '0.075');
    await click(button(dialog(), 'Apply'));
    assert.equal(resolveLayerSettingsRangeBounds(tree.state().ranges[0], 0.05), null);
    assert.equal(tree.state().ranges.length, 1, 'off-grid ranges are retained for later profile heights');
    await manage(tree);
    assert.equal(savedRows().length, 1);
    await click(button(savedRows()[0], 'Edit'));
    assert.equal(field('Start height').value, '0.075');
    await click(button(dialog(), 'Cancel'));
  } finally {
    await tree.unmount();
  }
});
