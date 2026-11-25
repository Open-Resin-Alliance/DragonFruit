import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useEditorToasts, type UseEditorToastsOptions } from '@/features/notifications/useEditorToasts';

type Toasts = ReturnType<typeof useEditorToasts>;

function Harness({ options, onRender }: { options: UseEditorToastsOptions; onRender: (t: Toasts) => void }) {
  onRender(useEditorToasts(options));
  return null;
}

const idle: UseEditorToastsOptions = {
  isSceneSaveInProgress: false,
  isPreSliceSceneSaveInProgress: false,
  isAutosaving: false,
  sceneImportReport: null,
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let latest: Toasts | null = null;
  const render = async (options: UseEditorToastsOptions) => {
    await act(async () => {
      root.render(<Harness options={options} onRender={(t) => { latest = t; }} />);
    });
  };
  const toasts = () => {
    assert.ok(latest);
    return latest;
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { render, toasts, unmount };
}

// Well past the fade (220 ms), well short of the 2 s minimum.
const AFTER_FADE_MS = 450;

test('the saving toast leaves as soon as its save shows "Saved to"', async () => {
  const { render, toasts, unmount } = await mount();
  await render({ ...idle, isSceneSaveInProgress: true });
  assert.equal(toasts().isSaveToastVisible, true);

  await act(async () => toasts().handleExportSuccess('/tmp/scene.voxl'));
  await render(idle);
  await act(() => wait(AFTER_FADE_MS));
  assert.equal(toasts().isSaveToastVisible, false);
  await unmount();
});

test('without a "Saved to" toast the saving toast keeps its minimum', async () => {
  const { render, toasts, unmount } = await mount();
  await render({ ...idle, isAutosaving: true });
  await render(idle);
  await act(() => wait(AFTER_FADE_MS));
  assert.equal(toasts().isSaveToastVisible, true);
  await unmount();
});

test('an earlier save\'s "Saved to" toast does not cut a later autosave short', async () => {
  const { render, toasts, unmount } = await mount();
  await render(idle);
  await act(async () => toasts().handleExportSuccess('/tmp/scene.voxl'));
  await act(() => wait(5));
  await render({ ...idle, isAutosaving: true });
  await render(idle);
  await act(() => wait(AFTER_FADE_MS));
  assert.equal(toasts().isSaveToastVisible, true);
  await unmount();
});
