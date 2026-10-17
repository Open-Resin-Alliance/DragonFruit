import assert from 'node:assert/strict';
import test from 'node:test';
import { act, useEffect, useState } from 'react';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { LayerSlider } from '../LayerSlider';

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
