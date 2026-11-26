import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { createRoot } from 'react-dom/client';
import Home from '@/app/page';
import type { HistoryOrigin } from '@/history/types';
import { clearHistory, peekUndo, pushHistory, registerHistoryHandler, undo } from '@/history/historyStore';
import { withProviders } from '@/utils/__tests__/helpers/renderDom';

const reactGlobals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PROBE = 'test:origin-probe';

const CUBE_STL = `solid cube
${[
  [[0, 0, 0], [10, 0, 0], [10, 10, 0]], [[0, 0, 0], [10, 10, 0], [0, 10, 0]],
  [[0, 0, 10], [10, 10, 10], [10, 0, 10]], [[0, 0, 10], [0, 10, 10], [10, 10, 10]],
  [[0, 0, 0], [10, 0, 10], [10, 0, 0]], [[0, 0, 0], [0, 0, 10], [10, 0, 10]],
  [[0, 10, 0], [10, 10, 0], [10, 10, 10]], [[0, 10, 0], [10, 10, 10], [0, 10, 10]],
  [[0, 0, 0], [0, 10, 0], [0, 10, 10]], [[0, 0, 0], [0, 10, 10], [0, 0, 10]],
  [[10, 0, 0], [10, 10, 10], [10, 10, 0]], [[10, 0, 0], [10, 0, 10], [10, 10, 10]],
].map((tri) => `facet normal 0 0 0
outer loop
${tri.map((v) => `vertex ${v.join(' ')}`).join('\n')}
endloop
endfacet`).join('\n')}
endsolid cube
`;

// The importer reads the dropped file back through a `blob:` URL, which happy-dom's fetch
// refuses; the URL is Node's, so Node can resolve it.
const domFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const blob = url.startsWith('blob:') ? resolveObjectURL(url) : undefined;
  return blob ? new Response(await blob.arrayBuffer()) : domFetch(input, init);
}) as typeof fetch;

/** Drops cubes on the editor, the way a user adds models; an empty scene is held in Prepare. */
async function dropCube(container: HTMLElement, count = 1) {
  const target = Array.from(container.querySelectorAll('div')).find((element) => {
    const propsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
    return propsKey && typeof (element as unknown as Record<string, { onDrop?: unknown }>)[propsKey].onDrop === 'function';
  });
  assert.ok(target, 'the editor takes drops');
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', {
    value: {
      files: Array.from({ length: count }, (_, i) => new File([CUBE_STL], `cube-${i}.stl`, { type: 'model/stl' })),
      types: ['Files'],
    },
  });
  target.dispatchEvent(drop);
}

/** Where the page says the user is: the origin it stamps on a fresh entry. */
function currentOrigin(): HistoryOrigin | undefined {
  pushHistory({ type: PROBE, payload: null, description: { id: PROBE } });
  const origin = peekUndo()?.origin;
  clearHistory();
  return origin;
}

/** The tool part of an origin, without the selection that rides along. */
function toolOf(origin: HistoryOrigin | undefined) {
  return origin && { appMode: origin.appMode, transformMode: origin.transformMode };
}

async function undoEntryFrom(origin: HistoryOrigin) {
  clearHistory();
  pushHistory({ type: PROBE, payload: null, description: { id: PROBE }, origin });
  undo();
  await wait(200);
}

test('undo goes back to the tool an entry was made in', async (t) => {
  // Not `act`, for the reason the page smoke test gives.
  const actEnvironment = reactGlobals.IS_REACT_ACT_ENVIRONMENT;
  reactGlobals.IS_REACT_ACT_ENVIRONMENT = false;
  const unregister = registerHistoryHandler(PROBE, () => true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    root.render(withProviders(<Home />));
    await wait(500);
    assert.deepEqual(toolOf(currentOrigin()), { appMode: 'prepare', transformMode: 'select' });
    await dropCube(container);
    await wait(1500);

    await t.test('a tool in another workspace', async () => {
      await undoEntryFrom({ appMode: 'support', transformMode: 'hollowing' });
      assert.deepEqual(toolOf(currentOrigin()), { appMode: 'support', transformMode: 'hollowing' });
    });

    await t.test('support blocker painting', async () => {
      await undoEntryFrom({ appMode: 'prepare', transformMode: 'select' });
      await undoEntryFrom({ appMode: 'support', transformMode: 'supportBlockers' });
      assert.deepEqual(toolOf(currentOrigin()), { appMode: 'support', transformMode: 'supportBlockers' });
    });

    await t.test('the model an entry was made on, with the camera on it', async () => {
      await undoEntryFrom({ appMode: 'prepare', transformMode: 'select' });
      const first = currentOrigin()?.selection?.activeModelId;
      assert.ok(first, 'the dropped cube is selected');
      // A single drop keeps the model being worked on; two in one go select both.
      await dropCube(container, 2);
      await wait(2500);
      const dropped = currentOrigin()?.selection?.modelIds ?? [];
      assert.equal(dropped.length, 2, 'the two new cubes are selected');
      assert.ok(!dropped.includes(first), 'and the first one is not');

      let framed = 0;
      const onFit = () => { framed += 1; };
      window.addEventListener('camera-fit-request', onFit);
      try {
        const editOnFirst = { appMode: 'prepare', transformMode: 'select', selection: { activeModelId: first, modelIds: [first] } };
        await undoEntryFrom(editOnFirst);
        assert.deepEqual(currentOrigin()?.selection, { activeModelId: first, modelIds: [first] });
        assert.equal(framed, 1, 'the camera frames the model it went back to');

        await undoEntryFrom(editOnFirst);
        assert.equal(framed, 1, 'an undo on the model already selected leaves the camera alone');
      } finally {
        window.removeEventListener('camera-fit-request', onFit);
      }
    });
  } finally {
    root.unmount();
    container.remove();
    unregister();
    clearHistory();
    reactGlobals.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  }
});
