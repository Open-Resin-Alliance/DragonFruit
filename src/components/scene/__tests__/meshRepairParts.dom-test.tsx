import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MeshRepairConfirmModal } from '@/components/scene/MeshRepairConfirmModal';
import { withProviders } from '@/utils/__tests__/helpers/renderDom';
import type { MeshRepairConfirmPrompt } from '@/features/scene/useSceneCollectionManager';

const reactGlobals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

function promptFixture(overrides: Partial<MeshRepairConfirmPrompt> = {}): MeshRepairConfirmPrompt {
  return {
    fileName: 'plate.stl',
    canRepairParts: true,
    analysis: {
      triangle_count: 656922,
      vertex_count: 300000,
      non_manifold_edges: 0,
      non_manifold_vertices: 0,
      boundary_edges: 0,
      boundary_loops: 0,
      inconsistent_edges: 1389,
      degenerate_triangles: 0,
      duplicate_triangles: 0,
      component_count: 25,
      self_intersections: 45214,
      signed_volume: 1,
      is_watertight: true,
      timings_ms: { topology_ms: 0, self_intersections_ms: 0, components_ms: 0, total_ms: 0 },
    },
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
    click: (node: Element) => {
      act(() => {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// The dialog portals into `document.body`, so the lookups go there rather than into the container
// the test mounted.
const findButton = (label: string): HTMLButtonElement => {
  const found = Array.from(document.body.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(label),
  );
  assert.ok(found, `no button labelled "${label}": ${document.body.textContent?.slice(0, 400)}`);
  return found as HTMLButtonElement;
};

test('the repair confirmation offers the part-by-part repair for a plate', () => {
  const calls: string[] = [];
  const view = render(
    <MeshRepairConfirmModal
      prompt={promptFixture()}
      onRepair={() => calls.push('repair')}
      onRepairParts={() => calls.push('repair_parts')}
      onLoadAsIs={() => calls.push('load_as_is')}
      onCancelImport={() => calls.push('cancel')}
    />,
  );

  const partsButton = findButton('Repair parts separately');
  assert.match(
    document.body.textContent ?? '',
    /25 separate shells/,
    'the dialog says what the file is before offering the choice',
  );
  view.click(partsButton);
  assert.deepEqual(calls, ['repair_parts']);
  view.unmount();
});

test('a single-object import is not offered the part-by-part repair', () => {
  const calls: string[] = [];
  const view = render(
    <MeshRepairConfirmModal
      prompt={promptFixture({
        canRepairParts: false,
        analysis: { ...promptFixture().analysis, component_count: 1 },
      })}
      onRepair={() => calls.push('repair')}
      onRepairParts={() => calls.push('repair_parts')}
      onLoadAsIs={() => calls.push('load_as_is')}
      onCancelImport={() => calls.push('cancel')}
    />,
  );

  assert.equal(
    Array.from(document.body.querySelectorAll('button')).some((b) =>
      (b.textContent ?? '').includes('Repair parts separately')),
    false,
    'one object is not a plate',
  );
  view.click(findButton('Repair'));
  assert.deepEqual(calls, ['repair']);
  view.unmount();
});
