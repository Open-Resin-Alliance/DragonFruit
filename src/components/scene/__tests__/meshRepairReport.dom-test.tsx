import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MeshRepairReportModal } from '@/components/scene/MeshRepairReportModal';
import type { MeshHealthReport } from '@/utils/meshRepair';
import type { MeshRepairReportEntry } from '@/features/scene/useSceneCollectionManager';
import { withProviders } from '@/utils/__tests__/helpers/renderDom';

const reactGlobals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

function analysis(triangleCount: number, signedVolume: number) {
  return {
    triangle_count: triangleCount,
    vertex_count: triangleCount / 2,
    non_manifold_edges: 0,
    non_manifold_vertices: 0,
    boundary_edges: 0,
    boundary_loops: 0,
    inconsistent_edges: 0,
    degenerate_triangles: 0,
    duplicate_triangles: 0,
    component_count: 1,
    self_intersections: 0,
    signed_volume: signedVolume,
    is_watertight: true,
    timings_ms: { topology_ms: 0, self_intersections_ms: 0, components_ms: 0, total_ms: 0 },
  };
}

/** The reported run: `Gusano_de_Dune_70%.stl` came back rebuilt into a solid, 596,293 to 603,772. */
function entry(rebuilt: boolean): MeshRepairReportEntry {
  const report = {
    version: 1,
    source_path: null,
    pre: analysis(rebuilt ? 596293 : 1000, rebuilt ? 37293 : 10),
    post: analysis(rebuilt ? 603772 : 1000, rebuilt ? 44909 : 10),
    steps: [],
    likely_support_geometry: false,
    residual_issues: [],
    parts: [],
    fully_repaired: true,
    rebuilt,
    cancelled: false,
    total_ms: 15466.8,
  } as unknown as MeshHealthReport;
  return { id: 'm1', modelName: 'Gusano_de_Dune_70%.stl', report };
}

function render(element: React.ReactElement) {
  // The dialog portals into `document.body` and the portal outlives `unmount`, so a test that renders
  // after another would otherwise read the first one's text along with its own.
  document.body.innerHTML = '';
  reactGlobals.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(withProviders(element));
  });
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// The dialog portals into `document.body`, so the lookups go there.
const text = (): string => document.body.textContent ?? '';

test('a rebuilt repair says so in the title and the summary', () => {
  const view = render(
    <MeshRepairReportModal reports={[entry(true)]} presentation="optimistic" onDismiss={() => undefined} />,
  );
  const shown = text();
  assert.ok(
    shown.includes('Repair Complete: Rebuild'),
    `the title does not name the rebuild: ${shown.slice(0, 200)}`,
  );
  assert.ok(
    shown.includes('rebuilt this mesh into a solid'),
    `the summary does not say what happened: ${shown.slice(0, 200)}`,
  );
  // Grouping separators are the running locale's business, so the digits are what is asserted.
  assert.ok(
    /Rebuilt the surface into a solid: 603[.,\u202f]?772 triangles from 596[.,\u202f]?293/.test(shown),
    `the summary does not count it: ${shown.slice(0, 300)}`,
  );
  view.unmount();
});

test('a plain repair does not mention a rebuild', () => {
  const view = render(
    <MeshRepairReportModal reports={[entry(false)]} presentation="optimistic" onDismiss={() => undefined} />,
  );
  const shown = text();
  assert.ok(shown.includes('Repair Complete'), `no headline: ${shown.slice(0, 200)}`);
  assert.ok(
    !shown.toLowerCase().includes('rebuild'),
    `a plain repair mentions a rebuild: ${shown.slice(0, 300)}`,
  );
  view.unmount();
});
