import assert from 'node:assert/strict';
import test from 'node:test';
import { act, useEffect, useState, type ComponentProps } from 'react';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { LayerSlider, type LayerSliderRangeBand } from '../LayerSlider';

test('a wheel step lands at once and a jump glides', async () => {
  const ref: { setValue: ((value: number) => void) | null } = { setValue: null };
  function Probe() {
    const [value, setValue] = useState(50);
    useEffect(() => {
      ref.setValue = setValue;
    });
    return (
      <div style={{ height: 400 }}>
        <LayerSlider min={0} max={100} step={1} value={value} onChange={setValue} docked embedded expandToContainer />
      </div>
    );
  }
  const tree = await renderWithProviders(<Probe />);
  const thumb = () => {
    const thumbs = [...tree.container.querySelectorAll<HTMLElement>('div.-translate-y-1\\/2')]
      .filter((el) => el.style.top.endsWith('%'));
    assert.equal(thumbs.length, 1, 'one thumb');
    return thumbs[0];
  };
  // The innermost of the nested no-drag boxes is the rail that takes the wheel.
  const rail = [...tree.container.querySelectorAll<HTMLElement>('[data-no-drag="true"]')].at(-1);
  assert.ok(rail);

  try {
    await act(async () => {
      rail.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
    });
    await settle(20);
    assert.equal(thumb().style.top, '49%', 'the wheel moved it a layer up');
    assert.equal(thumb().style.transition, 'none', 'and it is already there');

    await act(async () => ref.setValue?.(10));
    await settle(20);
    assert.equal(thumb().style.top, '90%');
    assert.match(thumb().style.transition, /^top 170ms/, 'a jump glides');
  } finally {
    await tree.unmount();
  }
});


type RangeRequest = { value: number; position: { x: number; y: number } };

async function mountRangeSlider(props: Partial<ComponentProps<typeof LayerSlider>> = {}) {
  const requests: RangeRequest[] = [];
  const upperChanges: number[] = [];
  const lowerChanges: number[] = [];
  const scrubs: string[] = [];
  const toggles: boolean[] = [];
  const initialLower = 'lowerValue' in props ? props.lowerValue : 2;
  const ref: { setBands?: (bands: readonly LayerSliderRangeBand[]) => void } = {};
  function Probe() {
    const [upper, setUpper] = useState(props.value ?? 8);
    const [lower, setLower] = useState(initialLower);
    const [bands, setBands] = useState(props.rangeBands);
    useEffect(() => { ref.setBands = setBands; });
    return (
      <LayerSlider
        min={0} max={10} step={1} docked embedded expandToContainer
        {...props}
        value={upper}
        lowerValue={lower}
        rangeBands={bands}
        onChange={(next) => { upperChanges.push(next); setUpper(next); }}
        onLowerChange={lower == null ? undefined : (next) => { lowerChanges.push(next); setLower(next); }}
        onScrubStart={() => scrubs.push('start')}
        onScrubEnd={() => scrubs.push('end')}
        onToggleCrossSection={() => toggles.push(true)}
        onRangeContextMenu={'onRangeContextMenu' in props ? props.onRangeContextMenu : (value, position) => requests.push({ value, position })}
      />
    );
  }
  const tree = await renderWithProviders(<Probe />);
  const rail = tree.container.querySelector<HTMLElement>('[tabindex="0"]');
  const track = rail?.querySelector<HTMLElement>('[data-no-drag="true"]');
  assert.ok(rail);
  assert.ok(track);
  track.getBoundingClientRect = () => ({
    x: 100, y: 20, left: 100, right: 124, top: 20, bottom: 420,
    width: 24, height: 400, toJSON: () => ({}),
  });
  const thumbPositions = () => [...track.querySelectorAll<HTMLElement>('div')]
    .filter((element) => element.classList.contains('-translate-y-1/2') && element.style.top.endsWith('%'))
    .map((element) => element.style.top);
  return { ...tree, rail, track, requests, upperChanges, lowerChanges, scrubs, toggles, ref, thumbPositions };
}

async function mouse(target: EventTarget, type: string, clientY: number, button = 2) {
  const event = new MouseEvent(type, { button, clientX: 111, clientY, bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

async function key(target: EventTarget, value: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

test('right-clicking bare track requests the unsnapped layer without changing either clip or scrubbing', async () => {
  const tree = await mountRangeSlider({ allowTrackClickJump: true });
  let bubbled = 0;
  const onBodyContext = () => { bubbled += 1; };
  document.body.addEventListener('contextmenu', onBodyContext);
  try {
    const positions = tree.thumbPositions();
    assert.deepEqual(positions, ['80%', '20%']);
    assert.equal((await mouse(tree.track, 'mousedown', 238)).defaultPrevented, true);
    await mouse(window, 'mousemove', 150);
    const context = await mouse(tree.track, 'contextmenu', 238);
    await mouse(window, 'mouseup', 238);
    assert.equal(context.defaultPrevented, true);
    assert.equal(bubbled, 0);
    assert.equal(tree.requests.length, 1);
    assert.ok(Math.abs(tree.requests[0].value - 4.55) < 1e-10, 'the domain owner receives the continuous boundary, not a snapped layer');
    assert.deepEqual(tree.requests[0].position, { x: 111, y: 238 });
    assert.deepEqual(tree.thumbPositions(), positions);
    assert.deepEqual(tree.upperChanges, []);
    assert.deepEqual(tree.lowerChanges, []);
    assert.deepEqual(tree.scrubs, []);
    assert.deepEqual(tree.toggles, []);
    assert.equal(tree.container.querySelector('input'), null);
  } finally {
    document.body.removeEventListener('contextmenu', onBodyContext);
    await tree.unmount();
  }
});

for (const order of [['mousedown', 'contextmenu', 'mouseup'], ['mousedown', 'mouseup', 'contextmenu']]) {
  for (const thumb of [{ name: 'upper', y: 100, value: '8' }, { name: 'lower', y: 340, value: '2' }]) {
    test(thumb.name + ' right-click opens only exact-value editing with ' + order.join('/'), async () => {
      const tree = await mountRangeSlider();
      try {
        const positions = tree.thumbPositions();
        for (const event of order) await mouse(tree.track, event, thumb.y);
        assert.equal(tree.requests.length, 0, 'the thumb gesture must not open the range menu');
        const inputs = tree.container.querySelectorAll<HTMLInputElement>('input');
        assert.equal(inputs.length, 1);
        assert.equal(inputs[0].value, thumb.value);
        assert.deepEqual(tree.thumbPositions(), positions);
        assert.deepEqual(tree.upperChanges, []);
        assert.deepEqual(tree.lowerChanges, []);
        assert.deepEqual(tree.scrubs, []);
        await key(inputs[0], 'Escape');
        await mouse(tree.track, 'mousedown', 238);
        await mouse(tree.track, 'contextmenu', 238);
        await mouse(window, 'mouseup', 238);
        assert.equal(tree.requests.length, 1, 'a later bare-track gesture must work after either platform order');
        assert.equal(tree.container.querySelector('input'), null);
      } finally {
        await tree.unmount();
      }
    });
  }
}

test('a new right mousedown resets a thumb marker even if its contextmenu never arrived', async () => {
  const tree = await mountRangeSlider();
  try {
    await mouse(tree.track, 'mousedown', 100);
    await mouse(window, 'mouseup', 100);
    assert.ok(tree.container.querySelector('input'));
    await mouse(tree.track, 'mousedown', 238);
    await mouse(window, 'mouseup', 238);
    await mouse(tree.track, 'contextmenu', 238);
    assert.equal(tree.requests.length, 1);
    assert.equal(tree.container.querySelector('input'), null);
    assert.deepEqual(tree.upperChanges, []);
    assert.deepEqual(tree.lowerChanges, []);
    assert.deepEqual(tree.scrubs, []);
  } finally {
    await tree.unmount();
  }
});

test('keyboard range menus bypass and clear thumb handling without changing navigation', async () => {
  const tree = await mountRangeSlider();
  try {
    await mouse(tree.track, 'mousedown', 100);
    await mouse(window, 'mouseup', 100);
    assert.ok(tree.container.querySelector('input'));
    assert.equal((await key(tree.rail, 'F10', true)).defaultPrevented, true);
    assert.deepEqual(tree.requests, [{ value: 8, position: { x: 124, y: 100 } }]);
    assert.equal(tree.container.querySelector('input'), null);
    await mouse(tree.track, 'contextmenu', 220);
    assert.equal(tree.requests.length, 2, 'the keyboard request cleared the old thumb marker');
    assert.equal((await key(tree.rail, 'ContextMenu')).defaultPrevented, true);
    assert.deepEqual(tree.requests[2], { value: 8, position: { x: 124, y: 100 } });
    assert.deepEqual(tree.upperChanges, []);
    assert.deepEqual(tree.lowerChanges, []);
    assert.deepEqual(tree.scrubs, []);
    await key(tree.rail, 'ArrowUp');
    await key(tree.rail, 'ArrowLeft');
    assert.deepEqual(tree.upperChanges, [9, 8]);
    assert.deepEqual(tree.thumbPositions(), ['80%', '20%']);
  } finally {
    await tree.unmount();
  }
});

test('without a range callback bare track remains inert and exact handle editing is unchanged', async () => {
  const tree = await mountRangeSlider({ onRangeContextMenu: undefined });
  try {
    await mouse(tree.track, 'mousedown', 238);
    assert.equal((await mouse(tree.track, 'contextmenu', 238)).defaultPrevented, true);
    await mouse(window, 'mouseup', 238);
    assert.equal(tree.container.querySelector('input'), null);
    assert.equal((await key(tree.rail, 'ContextMenu')).defaultPrevented, false);
    assert.equal((await key(tree.rail, 'F10', true)).defaultPrevented, false);
    await mouse(tree.track, 'mousedown', 100);
    await mouse(tree.track, 'contextmenu', 100);
    await mouse(window, 'mouseup', 100);
    assert.equal(tree.container.querySelector<HTMLInputElement>('input')?.value, '8');
    assert.deepEqual(tree.requests, []);
    assert.deepEqual(tree.upperChanges, []);
    assert.deepEqual(tree.lowerChanges, []);
    assert.deepEqual(tree.scrubs, []);
  } finally {
    await tree.unmount();
  }
});

for (const bounds of [{ min: 0, max: 10 }, { min: 1, max: 10 }, { min: 0, max: 0 }, { min: 0, max: 1 }, { min: 1, max: 1 }]) {
  test('range requests honor ' + bounds.min + '..' + bounds.max + ' rails including empty and one-layer domains', async () => {
    const tree = await mountRangeSlider({ ...bounds, value: bounds.max, lowerValue: undefined });
    try {
      // Contextmenu without a mouse gesture also covers OS-generated requests at
      // either boundary, where a physical right mousedown would edit the thumb.
      await mouse(tree.track, 'contextmenu', 0);
      await mouse(tree.track, 'contextmenu', 440);
      await mouse(tree.track, 'mousedown', 220);
      await mouse(window, 'mouseup', 220);
      await mouse(tree.track, 'contextmenu', 220);
      assert.deepEqual(tree.requests.map((request) => request.value), [bounds.max, bounds.min, (bounds.min + bounds.max) / 2]);
      await key(tree.rail, 'ContextMenu');
      assert.deepEqual(tree.requests[3], {
        value: bounds.max,
        position: { x: 124, y: bounds.max === bounds.min ? 420 : 20 },
      });
      assert.deepEqual(tree.upperChanges, []);
      assert.deepEqual(tree.lowerChanges, []);
      assert.deepEqual(tree.scrubs, []);
      assert.equal(tree.container.querySelector('[data-layer-range-band]'), null);
    } finally {
      await tree.unmount();
    }
  });
}

for (const variant of [
  { name: 'compact minimal', embedded: true, docked: true, compactMinimalRail: true },
  { name: 'minimal', embedded: true, docked: true },
  { name: 'embedded', embedded: true, docked: false },
  { name: 'floating', embedded: false, docked: false },
]) {
  test(variant.name + ' bands remain independent of both clip handles with stable primitive ids', async () => {
    const bands: readonly LayerSliderRangeBand[] = [
      { id: 'wide:1:3', bottomPercent: 0, topPercent: 30, color: '#123456', label: 'Layers 1–10' },
      { id: 'narrow:4:6', bottomPercent: 30, topPercent: 60, color: '#abcdef', label: 'Layers 4–6' },
      { id: 'wide:7:10', bottomPercent: 60, topPercent: 100, color: '#123456', label: 'Layers 1–10' },
      { id: 'tiny:11:11', bottomPercent: 50, topPercent: 50.01, color: '#ff00aa', label: 'Layer 11' },
    ];
    const tree = await mountRangeSlider({ ...variant, rangeBands: bands, dragBatchMode: 'immediate' });
    const painted = () => [...tree.track.querySelectorAll<HTMLElement>('[data-layer-range-band]')];
    try {
      const originalNodes = painted();
      assert.equal(originalNodes.length, bands.length);
      for (let index = 0; index < bands.length; index += 1) {
        const band = bands[index];
        const element = originalNodes[index];
        assert.equal(element.dataset.layerRangeBand, band.id);
        assert.equal(element.getAttribute('aria-label'), band.label);
        assert.equal(element.title, band.label);
      }
      assert.equal(originalNodes[0].style.background, originalNodes[2].style.background);
      assert.notEqual(originalNodes[0].style.background, originalNodes[1].style.background);
      const clipFill = originalNodes[0].previousElementSibling as HTMLElement;
      assert.ok(clipFill);
      assert.equal(clipFill.style.bottom, '20%');
      assert.equal(clipFill.style.height, '60%');
      await key(tree.rail, 'ArrowUp');
      await mouse(tree.track, 'mousedown', 340, 0);
      await mouse(window, 'mousemove', 380, 0);
      await mouse(window, 'mouseup', 380, 0);
      assert.deepEqual(tree.upperChanges, [9]);
      assert.deepEqual(tree.lowerChanges, [1]);
      assert.deepEqual(tree.thumbPositions(), ['90%', '10%']);
      assert.equal(clipFill.style.bottom, '10%');
      assert.equal(clipFill.style.height, '80%');
      assert.deepEqual(painted(), originalNodes, 'clip changes do not replace or filter range drawings');
      await act(async () => tree.ref.setBands?.([...bands].reverse()));
      assert.deepEqual(painted(), [...originalNodes].reverse(), 'keys use the primitive segment id, including separated segments of one range');
      await mouse(tree.track, 'contextmenu', 220);
      assert.equal(tree.requests.length, 1, 'noninteractive bands leave range-menu hit testing on the rail');
    } finally {
      await tree.unmount();
    }
  });
}

test('a single printed layer remains selectable on its degenerate preview rail with saved bands', async () => {
  const tree = await mountRangeSlider({
    min: 1, max: 1, value: 1, lowerValue: undefined,
    rangeBands: [{ id: 'only:1:1', bottomPercent: 0, topPercent: 100, color: '#123456', label: 'Layer 1' }],
  });
  try {
    const band = tree.track.querySelector<HTMLElement>('[data-layer-range-band]');
    assert.ok(band);
    await mouse(tree.track, 'mousedown', 220);
    await mouse(tree.track, 'contextmenu', 220);
    await mouse(window, 'mouseup', 220);
    assert.equal(tree.requests[0].value, 1);
    assert.deepEqual(tree.upperChanges, []);
  } finally {
    await tree.unmount();
  }
});
