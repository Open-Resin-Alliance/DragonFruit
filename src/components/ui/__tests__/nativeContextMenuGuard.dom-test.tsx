import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeContextMenuGuard } from '../NativeContextMenuGuard';

/** Right-clicks `target` and reports whether the webview would still open its own menu. */
function nativeMenuOpens(target: Element, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init });
  return target.dispatchEvent(event);
}

test('the native context menu only opens on text fields, selected text, or with Alt held', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let ownMenuOpened = 0;
  await act(async () => {
    root.render(
      <>
        <NativeContextMenuGuard />
        <div data-testid="chrome" />
        <input data-testid="field" />
        <div
          data-testid="own-menu"
          onContextMenu={(event) => {
            event.preventDefault();
            ownMenuOpened += 1;
          }}
        />
      </>,
    );
  });
  const chrome = container.querySelector('[data-testid="chrome"]')!;
  const field = container.querySelector('[data-testid="field"]')!;
  const ownMenu = container.querySelector('[data-testid="own-menu"]')!;

  assert.equal(nativeMenuOpens(chrome), false, 'plain app chrome');
  assert.equal(nativeMenuOpens(chrome, { altKey: true }), true, 'Alt + right-click');
  assert.equal(nativeMenuOpens(field), true, 'text field');
  assert.equal(nativeMenuOpens(ownMenu), false, 'component menu');
  assert.equal(ownMenuOpened, 1, 'the component still gets its right-click');

  await act(async () => root.unmount());
  assert.equal(nativeMenuOpens(chrome), true, 'guard removed on unmount');
  container.remove();
});
