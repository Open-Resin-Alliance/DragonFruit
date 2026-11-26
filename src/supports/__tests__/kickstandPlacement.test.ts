import assert from 'node:assert/strict';
import test from 'node:test';

const React = require('react');
const r3f = require('@react-three/fiber');

// Mock window and other DOM elements needed by KickstandPlacementController
const registeredListeners: { [type: string]: Array<(e: any) => void> } = {};
global.window = {
  addEventListener: (type: string, listener: (e: any) => void) => {
    if (!registeredListeners[type]) {
      registeredListeners[type] = [];
    }
    registeredListeners[type].push(listener);
  },
  removeEventListener: (type: string, listener: (e: any) => void) => {
    if (registeredListeners[type]) {
      registeredListeners[type] = registeredListeners[type].filter(l => l !== listener);
    }
  },
  dispatchEvent: (event: any) => {
    const listeners = registeredListeners[event.type] || [];
    for (const listener of listeners) {
      listener(event);
    }
    return true;
  }
} as any;

if (typeof (global as any).CustomEvent === 'undefined') {
  (global as any).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, options?: { detail?: any }) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
}

// Override React hooks so they behave synchronously outside of a renderer
React.useEffect = (effect: () => (void | (() => void)), deps?: any[]) => {
  effect();
};
React.useCallback = (fn: any, deps?: any[]) => fn;
React.useMemo = (fn: any, deps?: any[]) => fn();
React.useRef = (initialValue?: any) => ({ current: initialValue });
React.useSyncExternalStore = (subscribe: any, getSnapshot: any) => getSnapshot();
React.useContext = (context: any) => {
  return {
    getHotkey: (key: string) => ''
  };
};
React.useState = (initialValue: any) => [
  typeof initialValue === 'function' ? initialValue() : initialValue,
  () => {}
];

// Mock react-three-fiber hooks
const mockDomElement = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
const mockThreeState = {
  camera: {
    position: { x: 0, y: 0, z: 10 },
  },
  gl: {
    domElement: mockDomElement,
  },
  pointer: { x: 0, y: 0 },
  raycaster: {
    ray: {
      origin: { x: 0, y: 0, z: 10 },
      direction: { x: 0, y: 0, z: -1 },
    },
    setFromCamera: () => {},
  },
};
r3f.useThree = () => mockThreeState as any;
r3f.useFrame = () => {};

// Now import the controller and stores
import { KickstandPlacementController } from '../SupportTypes/Kickstand/KickstandPlacementController';
import { kickstandPlacementStore } from '../SupportTypes/Kickstand/kickstandPlacementState';
import { readKickstands } from './helpers/kickstandFixture';
import { addSupportEntity, getSnapshot, resetStore, resetKickstandsInState } from '../state';

test('Kickstand click-commit tests', async (t) => {
  await t.test('succeeds on click-commit with valid preview', () => {
    resetStore();
    resetKickstandsInState();
    kickstandPlacementStore.reset();

    // Render the controller to register event listeners
    KickstandPlacementController();

    // Prepare a mock previewBuild and previewData
    const mockPreviewBuild = {
      kickstand: {
        id: 'kickstand-test-id',
        modelId: 'model-1',
        rootId: 'root-test-id',
        hostKnotId: 'knot-test-id',
        hostSegmentId: 'seg-test-id',
        hostMinT: 0,
        segments: [],
        profile: {
          bodyDiameterMm: 0.8,
          terminalStartDiameterMm: 0.8,
          terminalEndDiameterMm: 1.2,
        },
      },
      root: {
        id: 'root-test-id',
        modelId: 'model-1',
        transform: {
          pos: { x: 5, y: 5, z: 0 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 2,
        diskHeight: 0.4,
        coneHeight: 0.7,
      },
      hostKnot: {
        id: 'knot-test-id',
        parentShaftId: 'seg-test-id',
        t: 0.5,
        pos: { x: 5, y: 5, z: 10 },
        diameter: 1.2,
      },
    };

    const mockPreviewTarget = {
      segmentId: 'seg-test-id',
      supportKind: 'trunk' as const,
      modelId: 'model-1',
      t: 0.5,
      pos: { x: 5, y: 5, z: 10 },
      diameterMm: 1.2,
      minT: 0,
      rootPos: { x: 5, y: 5, z: 0 },
    };

    const mockPreviewData = {
      id: 'kickstand-test-id',
      modelId: 'model-1',
      kind: 'kickstand' as const,
      error: undefined,
    };

    // Set preview state in store
    kickstandPlacementStore.setHotkeyActive(true);
    kickstandPlacementStore.setPreview(
      mockPreviewTarget,
      mockPreviewBuild as any,
      mockPreviewData as any
    );

    // Trigger click event
    const clickEvent = {
      type: 'click',
      target: mockDomElement,
      stopPropagation: () => {},
      preventDefault: () => {},
    };
    window.dispatchEvent(clickEvent as any);

    // Verify the kickstand and its primitives reach the store
    const kickstandSnapshot = readKickstands();
    assert.ok(kickstandSnapshot.kickstands['kickstand-test-id'], 'Expected kickstand to be added');
    assert.ok(kickstandSnapshot.roots['root-test-id'], 'Expected the root to be added');
    assert.ok(kickstandSnapshot.knots['knot-test-id'], 'Expected the knot to be added');

    const supportSnapshot = getSnapshot();
    assert.ok(supportSnapshot.roots['root-test-id'], 'Expected root to be added to supportStore');
    assert.ok(supportSnapshot.knots['knot-test-id'], 'Expected knot to be added to supportStore');
  });

  await t.test('aborts and does not commit on occupied preview (TOO_CLOSE_TO_EXISTING error)', () => {
    resetStore();
    resetKickstandsInState();
    kickstandPlacementStore.reset();

    // Render the controller to register event listeners
    KickstandPlacementController();

    // Prepare a mock previewBuild and previewData
    const mockPreviewBuild = {
      kickstand: {
        id: 'kickstand-test-id-2',
        modelId: 'model-1',
        rootId: 'root-test-id-2',
        hostKnotId: 'knot-test-id-2',
        hostSegmentId: 'seg-test-id-2',
        hostMinT: 0,
        segments: [],
        profile: {
          bodyDiameterMm: 0.8,
          terminalStartDiameterMm: 0.8,
          terminalEndDiameterMm: 1.2,
        },
      },
      root: {
        id: 'root-test-id-2',
        modelId: 'model-1',
        transform: {
          pos: { x: 5, y: 5, z: 0 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 2,
        diskHeight: 0.4,
        coneHeight: 0.7,
      },
      hostKnot: {
        id: 'knot-test-id-2',
        parentShaftId: 'seg-test-id-2',
        t: 0.5,
        pos: { x: 5, y: 5, z: 10 },
        diameter: 1.2,
      },
    };

    const mockPreviewTarget = {
      segmentId: 'seg-test-id-2',
      supportKind: 'trunk' as const,
      modelId: 'model-1',
      t: 0.5,
      pos: { x: 5, y: 5, z: 10 },
      diameterMm: 1.2,
      minT: 0,
      rootPos: { x: 5, y: 5, z: 0 },
    };

    // previewData contains error: 'TOO_CLOSE_TO_EXISTING'
    const mockPreviewData = {
      id: 'kickstand-test-id-2',
      modelId: 'model-1',
      kind: 'kickstand' as const,
      error: 'TOO_CLOSE_TO_EXISTING' as const,
    };

    // Set preview state in store
    kickstandPlacementStore.setHotkeyActive(true);
    kickstandPlacementStore.setPreview(
      mockPreviewTarget,
      mockPreviewBuild as any,
      mockPreviewData as any
    );

    // Trigger click event
    const clickEvent = {
      type: 'click',
      target: mockDomElement,
      stopPropagation: () => {},
      preventDefault: () => {},
    };
    window.dispatchEvent(clickEvent as any);

    // Verify kickstand was NOT added
    const kickstandSnapshot = readKickstands();
    assert.equal(kickstandSnapshot.kickstands['kickstand-test-id-2'], undefined, 'Expected kickstand NOT to be added');
  });

  await t.test('falls back to finding nearest unoccupied grid cell when target cell is occupied', () => {
    resetStore();
    resetKickstandsInState();
    kickstandPlacementStore.reset();

    // Enable grid and set spacing to 2mm
    const { updateGridSettings } = require('../Settings/state');
    updateGridSettings({ enabled: true, spacingMm: 2.0 });

    // Place an existing root at { x: 4, y: 4, z: 0 } which is close to proposed { x: 5, y: 5, z: 0 }
    // Both snap to { x: 4, y: 4, z: 0 } on a 2mm grid.
    const { addRoot, addTrunk } = require('../state');
    addRoot({
      id: 'existing-root-id',
      modelId: 'model-1',
      transform: {
        pos: { x: 4, y: 4, z: 0 },
        rot: { x: 0, y: 0, z: 0, w: 1 },
      },
      diameter: 2,
      diskHeight: 0.4,
      coneHeight: 0.7,
    });

    // Also add the host trunk root so we don't collide with that. Let's make it Root at { x: 0, y: 0, z: 0 }.
    addRoot({
      id: 'host-root-id',
      modelId: 'model-1',
      transform: {
        pos: { x: 0, y: 0, z: 0 },
        rot: { x: 0, y: 0, z: 0, w: 1 },
      },
      diameter: 2,
      diskHeight: 0.4,
      coneHeight: 0.7,
    });

    addSupportEntity('trunk', {
      id: 'host-trunk-id',
      modelId: 'model-1',
      rootId: 'host-root-id',
      segments: [
        {
          id: 'seg-test-id-3',
          diameter: 1.2,
          type: 'straight' as const,
        }
      ]
    });

    // Render the controller to register event listeners with updated state
    KickstandPlacementController();

    // Prepare mock preview target and build
    // The proposed rootPos is { x: 5, y: 5, z: 0 } which snaps to { x: 4, y: 4, z: 0 } (same as existing-root-id).
    const mockPreviewBuild = {
      kickstand: {
        id: 'kickstand-test-id-3',
        modelId: 'model-1',
        rootId: 'root-test-id-3',
        hostKnotId: 'knot-test-id-3',
        hostSegmentId: 'seg-test-id-3',
        hostMinT: 0,
        segments: [],
        profile: {
          bodyDiameterMm: 0.8,
          terminalStartDiameterMm: 0.8,
          terminalEndDiameterMm: 1.2,
        },
      },
      root: {
        id: 'root-test-id-3',
        modelId: 'model-1',
        transform: {
          pos: { x: 4, y: 4, z: 0 },
        },
        diameter: 2,
        diskHeight: 0.4,
        coneHeight: 0.7,
      },
      hostKnot: {
        id: 'knot-test-id-3',
        parentShaftId: 'seg-test-id-3',
        t: 0.5,
        pos: { x: 0, y: 0, z: 10 },
        diameter: 1.2,
      },
    };

    const mockPreviewTarget = {
      segmentId: 'seg-test-id-3',
      supportKind: 'trunk' as const,
      modelId: 'model-1',
      t: 0.5,
      pos: { x: 0, y: 0, z: 10 },
      diameterMm: 1.2,
      minT: 0,
      rootPos: { x: 4, y: 4, z: 0 },
    };

    // previewData contains error: 'TOO_CLOSE_TO_EXISTING'
    const mockPreviewData = {
      id: 'kickstand-test-id-3',
      modelId: 'model-1',
      kind: 'kickstand' as const,
      error: 'TOO_CLOSE_TO_EXISTING' as const,
    };

    // Set preview state in store
    kickstandPlacementStore.setHotkeyActive(true);
    kickstandPlacementStore.setPreview(
      mockPreviewTarget,
      mockPreviewBuild as any,
      mockPreviewData as any
    );

    // Trigger click event
    const clickEvent = {
      type: 'click',
      target: mockDomElement,
      stopPropagation: () => {},
      preventDefault: () => {},
    };
    window.dispatchEvent(clickEvent as any);

    // Verify kickstand was added
    const kickstandSnapshot = readKickstands();
    const kickstandIds = Object.keys(kickstandSnapshot.kickstands);
    assert.equal(kickstandIds.length, 1, 'Expected exactly one kickstand to be added');
    const addedKickstand = kickstandSnapshot.kickstands[kickstandIds[0]];
    assert.ok(addedKickstand, 'Expected kickstand to be added');

    // And verify its root position has shifted to the nearest unoccupied grid root (not at { x: 4, y: 4 })
    const addedRoot = kickstandSnapshot.roots[addedKickstand.rootId];
    assert.ok(addedRoot, 'Expected root to be added');
    assert.ok(addedRoot.transform.pos.x !== 4 || addedRoot.transform.pos.y !== 4, 'Expected root to have moved away from (4,4)');
    updateGridSettings({ enabled: false, spacingMm: 2.0 });
  });
});

import * as THREE from 'three';
import { computeBoundsTree } from 'three-mesh-bvh';
import { generateRequiredKickstands } from '../SupportTypes/Kickstand/kickstandStabiliser';
import { buildAutoBracedSnapshot } from '../autoBracing/autoBrace';
import { createDefaultAutoBracingSettings } from '../autoBracing/settings';
import { clearMeshesForAutoBrace, registerMeshForAutoBrace } from '../autoBracing/meshGeometryStore';
import { axisSeparationDeg, normalizeAxisAngleRad } from '../autoBracing/twoAxisDetection';
import { createEmptySupportCollections } from '../supportTypeRegistry';
import { updateGridSettings } from '../Settings/state';
import type { SupportState } from '../types';

function createTallTrunkSnapshot(modelId: string, topZ = 30): SupportState {
  const snapshot: SupportState = {
    ...createEmptySupportCollections(),
    selectedId: null,
    selectedCategory: null,
    hoveredId: null,
    hoveredCategory: 'none',
    interactionWarning: null,
  };
  snapshot.roots['root-main'] = {
    id: 'root-main',
    modelId,
    transform: {
      pos: { x: 0, y: 0, z: 0 },
      rot: { x: 0, y: 0, z: 0, w: 1 },
    },
    diameter: 3,
    diskHeight: 0.5,
    coneHeight: 0.5,
  };
  snapshot.trunks['trunk-main'] = {
    id: 'trunk-main',
    typeId: 'trunk',
    modelId,
    rootId: 'root-main',
    segments: [
      {
        id: 'seg-main',
        diameter: 1.0,
        topJoint: {
          id: 'joint-main',
          pos: { x: 0, y: 0, z: topZ },
          diameter: 1.2,
        },
      },
    ],
  };
  return snapshot;
}

function buildCourtyardWallGeometry(innerHalfExtentLocal: number, outerHalfExtentLocal: number, zMinLocal: number, zMaxLocal: number): THREE.BufferGeometry {
  const wallThickness = outerHalfExtentLocal - innerHalfExtentLocal;
  const wallSpan = outerHalfExtentLocal * 2;
  const zHeight = zMaxLocal - zMinLocal;
  const zCenter = (zMinLocal + zMaxLocal) / 2;
  const centerOffset = innerHalfExtentLocal + wallThickness / 2;

  const east = new THREE.BoxGeometry(wallThickness, wallSpan, zHeight);
  east.translate(centerOffset, 0, zCenter);
  const west = new THREE.BoxGeometry(wallThickness, wallSpan, zHeight);
  west.translate(-centerOffset, 0, zCenter);
  const north = new THREE.BoxGeometry(wallSpan, wallThickness, zHeight);
  north.translate(0, centerOffset, zCenter);
  const south = new THREE.BoxGeometry(wallSpan, wallThickness, zHeight);
  south.translate(0, -centerOffset, zCenter);

  const nonIndexed = [east, west, north, south].map((g) => g.toNonIndexed());
  const arrays = nonIndexed.map((g) => g.getAttribute('position').array as Float32Array);
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const arr of arrays) {
    merged.set(arr, offset);
    offset += arr.length;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  out.computeVertexNormals();
  computeBoundsTree.call(out);
  return out;
}

test('generateRequiredKickstands places orthogonal kickstands when grid spacingMm <= 2.0 mm (1.5mm and 2.0mm)', () => {
  try {
    clearMeshesForAutoBrace();
    for (const spacingMm of [1.5, 2.0]) {
      const snapshot = createTallTrunkSnapshot(`model-grid-${spacingMm}`, 30);
      const settings = createDefaultAutoBracingSettings();
      const built = generateRequiredKickstands(
        snapshot,
        { kickstands: {}, roots: {}, knots: {} },
        settings,
        [],
        { enabled: true, spacingMm },
      );

      assert.equal(built.length, 2, `Expected 2 orthogonal kickstands for ${spacingMm}mm grid, got ${built.length}`);
      const angles: number[] = [];
      for (const ks of built) {
        const rx = ks.root.transform.pos.x;
        const ry = ks.root.transform.pos.y;
        const dist = Math.hypot(rx, ry);
        assert.ok(dist > 2.0, `Expected root distance > 2.0mm for ${spacingMm}mm grid, got ${dist}`);
        angles.push(normalizeAxisAngleRad(Math.atan2(ry, rx)));
      }
      assert.ok(
        axisSeparationDeg(angles[0], angles[1]) >= 45,
        `Expected orthogonal axes (>=45 deg), got ${axisSeparationDeg(angles[0], angles[1])}`,
      );

      updateGridSettings({ enabled: true, spacingMm });
      const autoResult = buildAutoBracedSnapshot(snapshot, settings);
      assert.equal(Object.keys(autoResult.snapshot.kickstands).length, 2, `Expected buildAutoBracedSnapshot to keep 2 kickstands at ${spacingMm}mm grid`);
      assert.ok(autoResult.generatedBraceCount > 0, `Expected ladder braces on kickstands at ${spacingMm}mm grid`);
    }
  } finally {
    updateGridSettings({ enabled: false, spacingMm: 2.0 });
    clearMeshesForAutoBrace();
  }
});

test('generateRequiredKickstands falls back across outer rings, non-cardinal slots, and continuous radial placement when grid nodes are occupied', () => {
  try {
    clearMeshesForAutoBrace();
    const spacingMm = 3.0;
    const settings = { ...createDefaultAutoBracingSettings(), maxBraceLengthMm: 6.5 };
    const snapshot = createTallTrunkSnapshot('model-grid-fallback', 30);

    // Occupy ALL grid nodes in [-2..2] x [-2..2] within 6.5mm so continuous radial fallback must engage
    let idx = 0;
    for (let gx = -3; gx <= 3; gx++) {
      for (let gy = -3; gy <= 3; gy++) {
        if (gx === 0 && gy === 0) continue;
        // Occupy grid nodes with tiny dummy roots only at exact grid intersections? No, occupiedRootPositions enforces 2.0mm radius.
        // Instead, put existing kickstand roots on every grid node on a 6.0mm grid (maxBraceLengthMm = 6.5 -> kMin=1, kMax=2: (±6,0),(0,±6),(±6,±6)).
        void idx;
      }
    }

    const coarseSpacing = 6.0;
    for (let gx = -2; gx <= 2; gx++) {
      for (let gy = -2; gy <= 2; gy++) {
        if (gx === 0 && gy === 0) continue;
        idx += 1;
        snapshot.roots[`occ-${idx}`] = {
          id: `occ-${idx}`,
          modelId: 'model-grid-fallback',
          transform: {
            pos: { x: gx * coarseSpacing, y: gy * coarseSpacing, z: 0 },
            rot: { x: 0, y: 0, z: 0, w: 1 },
          },
          diameter: 2,
          diskHeight: 0.4,
          coneHeight: 0.7,
        };
      }
    }

    // Every grid node at 6.0mm spacing is occupied, leaving continuous annulus (2.0mm .. 3.9mm) open!
    updateGridSettings({ enabled: true, spacingMm: coarseSpacing });
    const result = buildAutoBracedSnapshot(snapshot, settings);
    assert.equal(Object.keys(result.snapshot.kickstands).length, 2, 'Expected 2 continuous-fallback kickstands when all grid slots are occupied');
    assert.ok(result.generatedBraceCount > 0, 'Expected continuous-fallback kickstands to receive ladder braces in grid mode');
    void spacingMm;
  } finally {
    updateGridSettings({ enabled: false, spacingMm: 2.0 });
    clearMeshesForAutoBrace();
  }
});

test('checkSlantedCollision uses world-mm clearance on 0.25x and 4x scaled BVH meshes', () => {
  try {
    const settings = { ...createDefaultAutoBracingSettings(), maxBraceLengthMm: 6.25 };

    // 1) 0.25x scale: world walls at |x|,|y| in [5.8, 12.0]mm => local [23.2, 48.0].
    // Drop at 5.0mm has world distance 0.8mm < radius (1.5mm), while local distance is 3.2 > 1.5!
    clearMeshesForAutoBrace();
    const snapshotDownscaled = createTallTrunkSnapshot('model-scale-025', 30);
    const geom025 = buildCourtyardWallGeometry(23.2, 48.0, 4.0, 120.0);
    registerMeshForAutoBrace('model-scale-025', geom025, new THREE.Matrix4().makeScale(0.25, 0.25, 0.25));

    const built025 = generateRequiredKickstands(
      snapshotDownscaled,
      { kickstands: {}, roots: {}, knots: {} },
      settings,
      [],
      { enabled: false, spacingMm: 2.0 },
    );
    assert.equal(
      built025.length,
      0,
      `Expected 0 kickstands on 0.25x mesh with 0.8mm world clearance (< 1.5mm radius), got ${built025.length}`,
    );

    // 2) 4x scale: world walls at |x|,|y| in [7.0, 16.0]mm => local [1.75, 4.0].
    // Drop at 5.0mm has world distance 2.0mm > radius (1.5mm), while local distance is 0.5 < 1.5!
    clearMeshesForAutoBrace();
    const snapshotUpscaled = createTallTrunkSnapshot('model-scale-4x', 30);
    const geom4x = buildCourtyardWallGeometry(1.75, 4.0, 0.5, 8.0);
    registerMeshForAutoBrace('model-scale-4x', geom4x, new THREE.Matrix4().makeScale(4, 4, 4));

    const built4x = generateRequiredKickstands(
      snapshotUpscaled,
      { kickstands: {}, roots: {}, knots: {} },
      settings,
      [],
      { enabled: false, spacingMm: 2.0 },
    );
    assert.equal(
      built4x.length,
      2,
      `Expected 2 kickstands on 4x mesh with 2.0mm world clearance (> 1.5mm radius), got ${built4x.length}`,
    );
  } finally {
    clearMeshesForAutoBrace();
  }
});

test('checkSlantedCollision detects world-space collision under anisotropic scale (1, 10, 1) when closer local face is non-colliding in world space', () => {
  const decoyBox = new THREE.BoxGeometry(3.0, 0.3, 10.0);
  // Local Y spans [0.5, 0.8] -> world Y spans [5.0, 8.0] (> 1.5mm clearance from y=0, but local distance = 0.5)
  decoyBox.translate(0, 0.65, 7.0);

  const collidingBox = new THREE.BoxGeometry(2.0, 0.4, 10.0);
  // Local X spans [1.0, 3.0] -> world X spans [1.0, 3.0] (1.0mm < 1.5mm clearance from x=0, while local distance = 1.0 > 0.5)
  collidingBox.translate(2.0, 0, 7.0);

  const nonIndexed = [decoyBox, collidingBox].map((g) => g.toNonIndexed());
  const arrays = nonIndexed.map((g) => g.getAttribute('position').array as Float32Array);
  const merged = new Float32Array(arrays[0].length + arrays[1].length);
  merged.set(arrays[0], 0);
  merged.set(arrays[1], arrays[0].length);

  const anisotropicGeom = new THREE.BufferGeometry();
  anisotropicGeom.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  anisotropicGeom.computeVertexNormals();
  computeBoundsTree.call(anisotropicGeom);

  try {
    clearMeshesForAutoBrace();
    const settings = { ...createDefaultAutoBracingSettings(), maxBraceLengthMm: 6.25 };
    const snapshot = createTallTrunkSnapshot('model-scale-anisotropic', 30);
    // Place trunk at (-5, 0, 0) so its +X drop leg (dropDist = 5.0mm) lands along (0, 0, z)
    snapshot.roots['root-main'].transform.pos.x = -5;
    snapshot.trunks['trunk-main'].segments[0].topJoint!.pos.x = -5;

    registerMeshForAutoBrace(
      'model-scale-anisotropic',
      anisotropicGeom,
      new THREE.Matrix4().makeScale(1, 10, 1),
    );

    const built = generateRequiredKickstands(
      snapshot,
      { kickstands: {}, roots: {}, knots: {} },
      settings,
      [],
      { enabled: false, spacingMm: 2.0 },
    );

    assert.equal(built.length, 2, `Expected 2 orthogonal kickstands, got ${built.length}`);
    const xAxisKickstand = built.find((ks) => Math.abs(ks.root.transform.pos.y) < 1e-3);
    assert.ok(xAxisKickstand, 'Expected an X-axis kickstand');
    assert.ok(
      xAxisKickstand.root.transform.pos.x < -5,
      `Expected +X slant leg at x=0 (1.0mm from x_world=1.0mm wall) to be rejected and routed to -X (x=-10), got x=${xAxisKickstand.root.transform.pos.x}`,
    );
  } finally {
    clearMeshesForAutoBrace();
    decoyBox.dispose();
    collidingBox.dispose();
    anisotropicGeom.dispose();
  }
});

