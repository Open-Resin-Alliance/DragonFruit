import assert from 'node:assert/strict';
import test from 'node:test';
import { act, Profiler, useEffect, useState } from 'react';

import { FloatingPanelStack, useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';

function CollapsiblePanel({ label }: { label: string }) {
  const [expanded] = useFloatingPanelCollapse(true);
  return (
    <div>
      <div data-panel-drag-handle="true">{label} header</div>
      {expanded ? <div>{label} body</div> : null}
    </div>
  );
}

let rerenderParent: () => void = () => {};

// Like `Home`, which the React Compiler does not memoize (#941): every render
// hands the stack new `children`.
function Parent({ onStackCommit }: { onStackCommit: () => void }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    rerenderParent = () => setTick((value) => value + 1);
  }, []);
  return (
    <Profiler id="stack" onRender={onStackCommit}>
      <FloatingPanelStack railIsColumn={false}>
        <CollapsiblePanel key="a" label={`A${tick}`} />
        <CollapsiblePanel key="b" label="B" />
        <CollapsiblePanel key="c" label="C" />
      </FloatingPanelStack>
    </Profiler>
  );
}

test('a parent re-render does not make the collapsible panels re-register', async () => {
  window.localStorage.clear();
  let commits = 0;
  const tree = await renderWithProviders(<Parent onStackCommit={() => { commits += 1; }} />);
  await settle(20);

  commits = 0;
  const rerenders = 5;
  for (let i = 0; i < rerenders; i += 1) {
    await act(async () => rerenderParent());
  }
  await settle(20);

  // Each re-registration sets the stack's state synchronously from a layout
  // effect, which costs an extra commit. Enough of those chained together is
  // React error #185.
  assert.equal(commits, rerenders, 'one commit per parent render, no re-registration cascade');

  await tree.unmount();
  window.localStorage.clear();
});
