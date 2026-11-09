import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MeshRepairModals, type MeshRepairModalsProps } from '@/components/organisms/modals/MeshRepairModals';
import { withProviders } from '@/utils/__tests__/helpers/renderDom';

const reactGlobals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

/** Only what the dialog reads while it runs: the run itself is driven by its caller. */
function sceneFixture(): MeshRepairModalsProps['scene'] {
  return {
    models: [{ id: 'm1', name: 'plate.stl' }],
    meshRepairReports: [],
    dismissMeshRepairReports: () => undefined,
    repairModelsInPlace: async () => true,
  } as unknown as MeshRepairModalsProps['scene'];
}

function props(overrides: Partial<MeshRepairModalsProps> = {}): MeshRepairModalsProps {
  return {
    isManualRepairing: false,
    manualRepairModelIds: ['m1'],
    autoStartRepair: false,
    setAutoStartRepair: () => undefined,
    scene: sceneFixture(),
    setIsManualRepairing: () => undefined,
    setManualRepairModelIds: () => undefined,
    setShowDamagedModelDialog: () => undefined,
    showDamagedModelDialog: false,
    ...overrides,
  };
}

function render(element: React.ReactElement) {
  reactGlobals.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(withProviders(element));
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// The dialog portals into `document.body`, so the lookups go there.
const buttonLabels = (): string[] =>
  Array.from(document.body.querySelectorAll('button'))
    .map((button) => (button.textContent ?? '').trim())
    .filter((label) => label.length > 0);

test('a manual repair offers Stop alone while it runs', () => {
  const view = render(<MeshRepairModals {...props({ isManualRepairing: true })} />);
  const labels = buttonLabels();
  assert.ok(labels.includes('Stop'), `no Stop button: ${labels.join(' | ')}`);
  assert.ok(
    !labels.some((label) => label.includes('Repair')),
    `Repair is still offered beside Stop while the run is under way: ${labels.join(' | ')}`,
  );
  view.unmount();
});

test('a manual repair offers both actions before it starts', () => {
  const view = render(<MeshRepairModals {...props()} />);
  const labels = buttonLabels();
  assert.ok(
    labels.includes('Keep Original') && labels.includes('Repair'),
    `expected Keep Original and Repair: ${labels.join(' | ')}`,
  );
  view.unmount();
});
