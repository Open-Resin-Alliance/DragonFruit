import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from '../Tooltip';

// WebKit before 16.4 sends no mouse events to a disabled control, so the
// wrapper never hears `mouseleave` when the pointer leaves a disabled trigger.
test('a tooltip on a disabled trigger closes once the pointer moves off it, without a mouseleave', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Tooltip content="Hollow the model first" anchor="trigger">
        <button type="button" disabled />
      </Tooltip>,
    );
  });
  const wrapper = container.querySelector('span')!;
  const button = container.querySelector('button')!;
  wrapper.getBoundingClientRect = () => ({ left: 10, top: 10, right: 60, bottom: 60, width: 50, height: 50, x: 10, y: 10, toJSON: () => ({}) });
  const isOpen = () => document.body.textContent?.includes('Hollow the model first') ?? false;

  await act(async () => {
    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body, clientX: 30, clientY: 30 }));
  });
  assert.equal(isOpen(), true, 'opens on hover');

  await act(async () => {
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 40 }));
  });
  assert.equal(isOpen(), true, 'stays open while the pointer is over the trigger');

  await act(async () => {
    document.body.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200, clientY: 30 }));
  });
  assert.equal(isOpen(), false, 'closes when the pointer is outside the trigger');

  await act(async () => root.unmount());
  container.remove();
});
