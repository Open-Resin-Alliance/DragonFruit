import assert from 'node:assert/strict';
import test from 'node:test';
import { act, StrictMode, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import type { LayerSettingsRange } from '../layerSettingsRanges';
import { useLayerSettingsRangeColors } from '../useLayerSettingsRangeColors';

const RANGES: LayerSettingsRange[] = ['not-a-uuid', 'range/with:punctuation', '四', 'arbitrary fourth id'].map((id, index) => ({
  id,
  startLayer: index + 1,
  endLayer: index + 10,
  settings: { exposureSec: index + 2 },
}));
const TOKENS = ['--accent-secondary', '--success', '--danger'] as const;

function assertDistinct(colors: ReadonlyMap<string, string>, ranges: readonly LayerSettingsRange[]) {
  assert.deepEqual([...colors.keys()], ranges.map((range) => range.id));
  for (const value of colors.values()) assert.match(value, /^#[0-9a-f]{6}$/);
  assert.equal(new Set(colors.values()).size, ranges.length, 'all final quantized RGB colors differ');
}

function generatedColor(k: number, light: boolean): string {
  const cycle = Math.floor(k / 360);
  return `#${new THREE.Color().setHSL(
    ((k + 1) * 0.6180339887498949) % 1,
    0.65 + 0.20 * ((cycle * 0.6180339887498949) % 1),
    (light ? 0.35 : 0.55) + (light ? 0.15 : 0.20) * ((cycle * 0.4142135623730951) % 1),
    THREE.SRGBColorSpace,
  ).getHexString(THREE.SRGBColorSpace)}`;
}

async function mountColors(initial: readonly LayerSettingsRange[]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const snapshots: ReadonlyMap<string, string>[] = [];
  let current: ReadonlyMap<string, string> = new Map();
  function Probe({ ranges }: { ranges: readonly LayerSettingsRange[] }) {
    const colors = useLayerSettingsRangeColors(ranges);
    useLayoutEffect(() => {
      current = colors;
      snapshots.push(colors);
    }, [colors]);
    return <output>{JSON.stringify([...colors])}</output>;
  }
  async function render(ranges: readonly LayerSettingsRange[]) {
    await act(async () => root.render(<StrictMode><Probe ranges={ranges} /></StrictMode>));
  }
  await render(initial);
  return {
    colors: () => current,
    snapshots,
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function changeTheme(change: () => void) {
  await act(async () => {
    change();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function installThemeEnvironment(legacy = false) {
  const html = document.documentElement;
  const previousStyle = html.getAttribute('style');
  const previousTheme = html.getAttribute('data-theme');
  const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  const Observer = globalThis.MutationObserver;
  const connected = new Set<MutationObserver>();
  let disconnects = 0;
  class ObservedMutationObserver extends Observer {
    override observe(target: Node, options?: MutationObserverInit) {
      connected.add(this);
      super.observe(target, options);
    }
    override disconnect() {
      connected.delete(this);
      disconnects += 1;
      super.disconnect();
    }
  }
  globalThis.MutationObserver = ObservedMutationObserver;
  const listeners = new Set<() => void>();
  let systemLight = false;
  const mediaQuery = {
    get matches() { return systemLight; },
    addEventListener: legacy ? undefined : (_type: string, callback: () => void) => listeners.add(callback),
    removeEventListener: legacy ? undefined : (_type: string, callback: () => void) => listeners.delete(callback),
    addListener: (callback: () => void) => listeners.add(callback),
    removeListener: (callback: () => void) => listeners.delete(callback),
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => {
      assert.equal(query, '(prefers-color-scheme: light)');
      return mediaQuery;
    },
  });
  html.removeAttribute('style');
  html.setAttribute('data-theme', 'dark');
  return {
    html,
    listeners,
    connected,
    disconnects: () => disconnects,
    tokens(values: readonly string[]) {
      TOKENS.forEach((token, index) => html.style.setProperty(token, values[index]));
    },
    system(light: boolean) {
      systemLight = light;
      for (const listener of listeners) listener();
    },
    restore() {
      if (previousStyle === null) html.removeAttribute('style');
      else html.setAttribute('style', previousStyle);
      if (previousTheme === null) html.removeAttribute('data-theme');
      else html.setAttribute('data-theme', previousTheme);
      if (matchMediaDescriptor) Object.defineProperty(window, 'matchMedia', matchMediaDescriptor);
      else Reflect.deleteProperty(window, 'matchMedia');
      globalThis.MutationObserver = Observer;
    },
  };
}

test('range colors follow persisted order, normalize preferred RGB and survive edits and reloads', async () => {
  const environment = installThemeEnvironment();
  let tree: Awaited<ReturnType<typeof mountColors>> | undefined;
  try {
    environment.tokens(['#ABC', '#234567', '#FEDCBA']);
    tree = await mountColors(RANGES);
    assert.equal(tree.snapshots[0].size, 0, 'there is no common-color initial fallback');
    assertDistinct(tree.colors(), RANGES);
    assert.deepEqual([...tree.colors().values()].slice(0, 3), ['#aabbcc', '#234567', '#fedcba']);
    const original = tree.colors();
    const edited = RANGES.map((range) => ({ ...range, startLayer: 7, endLayer: 30, settings: { exposureSec: 11 } }));
    await tree.render(edited);
    assert.equal(tree.colors(), original, 'editing without changing ids/order does not reallocate');
    await tree.render([...edited]);
    assert.equal(tree.colors(), original, 'an unrelated parent rerender does not reallocate');
    const saved: LayerSettingsRange[] = JSON.parse(JSON.stringify(edited));
    const expected = [...original];
    await tree.unmount();
    tree = await mountColors(saved);
    assert.deepEqual([...tree.colors()], expected, 'save/load reproduces the same theme/order allocation');
    await tree.render(saved.slice(1));
    assertDistinct(tree.colors(), saved.slice(1));
    assert.equal(tree.colors().get(saved[1].id), '#aabbcc', 'deletion may reassign by array position');
    await tree.render([...saved].reverse());
    assertDistinct(tree.colors(), [...saved].reverse());
    assert.equal(tree.colors().get(saved[3].id), '#aabbcc', 'order, not arbitrary id hashing, controls assignment');
  } finally {
    await tree?.unmount();
    environment.restore();
  }
});

test('light, dark and coincident custom tokens stay distinct and quantized collisions advance the generator', async () => {
  const environment = installThemeEnvironment();
  let tree: Awaited<ReturnType<typeof mountColors>> | undefined;
  try {
    environment.tokens(['#ABC', '#AABBCC', '#aabbcc']);
    tree = await mountColors(RANGES);
    assertDistinct(tree.colors(), RANGES);
    assert.deepEqual([...tree.colors().values()], ['#aabbcc', generatedColor(0, false), generatedColor(1, false), generatedColor(2, false)]);
    await changeTheme(() => environment.html.setAttribute('data-theme', 'light'));
    assertDistinct(tree.colors(), RANGES);
    assert.deepEqual([...tree.colors().values()], ['#aabbcc', generatedColor(0, true), generatedColor(1, true), generatedColor(2, true)]);
    await changeTheme(() => environment.tokens([generatedColor(0, true), 'not-a-color', '#1234']));
    assertDistinct(tree.colors(), RANGES);
    assert.deepEqual([...tree.colors().values()], [generatedColor(0, true), generatedColor(1, true), generatedColor(2, true), generatedColor(3, true)]);
    await changeTheme(() => environment.tokens(['', 'unsupported', '#1234']));
    const many = Array.from({ length: 375 }, (_, index) => ({ ...RANGES[0], id: `arbitrary:${index}` }));
    await tree.render(many);
    assertDistinct(tree.colors(), many);
    const expected: string[] = [];
    for (let k = 0; expected.length < many.length; k += 1) {
      const color = generatedColor(k, true);
      if (!expected.includes(color)) expected.push(color);
    }
    assert.deepEqual([...tree.colors().values()], expected, 'cycles past 360 use the specified saturation/lightness formula');
  } finally {
    await tree?.unmount();
    environment.restore();
  }
});

for (const legacy of [false, true]) {
  test(`OS theme changes and ${legacy ? 'legacy' : 'modern'} theme observers clean up on unmount`, async () => {
    const environment = installThemeEnvironment(legacy);
    let tree: Awaited<ReturnType<typeof mountColors>> | undefined;
    try {
      environment.tokens(['', '', '']);
      environment.html.removeAttribute('data-theme');
      tree = await mountColors(RANGES);
      assertDistinct(tree.colors(), RANGES);
      assert.equal(tree.colors().get(RANGES[0].id), generatedColor(0, false));
      assert.equal(environment.listeners.size, 1, 'StrictMode leaves only the live media listener');
      assert.equal(environment.connected.size, 1, 'StrictMode leaves only the live root observer');
      await changeTheme(() => environment.system(true));
      assertDistinct(tree.colors(), RANGES);
      assert.equal(tree.colors().get(RANGES[0].id), generatedColor(0, true));
      await changeTheme(() => environment.html.setAttribute('data-theme', 'dark'));
      assert.equal(tree.colors().get(RANGES[0].id), generatedColor(0, false));
      const explicitColors = tree.colors();
      await changeTheme(() => environment.system(false));
      assert.equal(tree.colors(), explicitColors, 'explicit data-theme wins over OS events');
      const disconnects = environment.disconnects();
      await tree.unmount();
      tree = undefined;
      assert.equal(environment.listeners.size, 0);
      assert.equal(environment.connected.size, 0);
      assert.ok(environment.disconnects() > disconnects);
      await changeTheme(() => {
        environment.html.setAttribute('data-theme', 'light');
        environment.system(true);
      });
    } finally {
      await tree?.unmount();
      environment.restore();
    }
  });
}
