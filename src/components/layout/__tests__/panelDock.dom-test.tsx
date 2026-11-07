import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';

import { FloatingPanelStack } from '@/components/layout/FloatingPanelStack';
import { FLOATING_LAYOUT_STORAGE_KEY } from '@/components/layout/floatingLayoutPreferences';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';

function Panel({ label }: { label: string }) {
  return (
    <div>
      <div data-panel-drag-handle="true">{label} header</div>
      <div>{label} body</div>
    </div>
  );
}

function stack() {
  return (
    <FloatingPanelStack leftInsetPx={0} railIsColumn={false}>
      <Panel key="a" label="A" />
      <Panel key="b" label="B" />
    </FloatingPanelStack>
  );
}

function pointer(type: string, clientX: number, clientY: number) {
  return new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
}

test('a panel dragged to the left dock stays there across a remount', async () => {
  window.localStorage.clear();

  const tree = await renderWithProviders(stack());
  await settle(20);

  const panel = tree.container.querySelector('[data-panel-id="a"]');
  assert.ok(panel, 'the panel mounted');
  assert.ok(
    tree.container.querySelector('[data-dock="right"] [data-panel-id="a"]'),
    'an unknown panel starts in the right dock',
  );

  const header = panel.querySelector('[data-panel-drag-handle="true"]');
  assert.ok(header, 'the panel has a drag handle');

  // jsdom has no layout, so give the panel the rect it would have on screen.
  // The drop test measures how much of the dragged panel overlaps the dock.
  panel.getBoundingClientRect = () => ({
    x: 400, y: 100, left: 400, top: 100, width: 320, height: 200, right: 720, bottom: 300,
    toJSON: () => ({}),
  }) as DOMRect;

  await act(async () => {
    header.dispatchEvent(pointer('pointerdown', 400, 120));
  });
  await act(async () => {
    window.dispatchEvent(pointer('pointermove', 10, 120));
  });
  await act(async () => {
    window.dispatchEvent(pointer('pointerup', 10, 120));
  });
  await settle(20);

  assert.ok(
    tree.container.querySelector('[data-dock="left"] [data-panel-id="a"]'),
    'the panel moved into the left dock',
  );

  const saved = JSON.parse(window.localStorage.getItem(FLOATING_LAYOUT_STORAGE_KEY) ?? '{}');
  assert.equal(saved.panels?.a?.dock, 'left', 'the placement was persisted');

  await tree.unmount();

  const remounted = await renderWithProviders(stack());
  await settle(20);

  assert.ok(
    remounted.container.querySelector('[data-dock="left"] [data-panel-id="a"]'),
    'the remount restores the left dock placement',
  );

  await remounted.unmount();
  window.localStorage.clear();
});
