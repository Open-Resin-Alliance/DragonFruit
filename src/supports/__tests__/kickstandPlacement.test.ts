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
import { getKickstandSnapshot, resetKickstandStore } from '../SupportTypes/Kickstand/kickstandStore';
import { getSnapshot, resetStore } from '../state';

test('Kickstand click-commit tests', async (t) => {
  await t.test('succeeds on click-commit with valid preview', () => {
    resetStore();
    resetKickstandStore();
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

    // Trigger shaft-click event
    const event = new CustomEvent('shaft-click', {
      detail: {
        segmentId: 'seg-test-id',
        intersection: {},
      },
    });
    window.dispatchEvent(event);

    // Verify kickstand is added to kickstandStore and supportStore
    const kickstandSnapshot = getKickstandSnapshot();
    assert.ok(kickstandSnapshot.kickstands['kickstand-test-id'], 'Expected kickstand to be added');
    assert.ok(kickstandSnapshot.roots['root-test-id'], 'Expected root to be added to kickstandStore');
    assert.ok(kickstandSnapshot.knots['knot-test-id'], 'Expected knot to be added to kickstandStore');

    const supportSnapshot = getSnapshot();
    assert.ok(supportSnapshot.roots['root-test-id'], 'Expected root to be added to supportStore');
    assert.ok(supportSnapshot.knots['knot-test-id'], 'Expected knot to be added to supportStore');
  });

  await t.test('aborts and does not commit on occupied preview (TOO_CLOSE_TO_EXISTING error)', () => {
    resetStore();
    resetKickstandStore();
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

    // Trigger shaft-click event
    const event = new CustomEvent('shaft-click', {
      detail: {
        segmentId: 'seg-test-id-2',
        intersection: {},
      },
    });
    window.dispatchEvent(event);

    // Verify kickstand was NOT added
    const kickstandSnapshot = getKickstandSnapshot();
    assert.equal(kickstandSnapshot.kickstands['kickstand-test-id-2'], undefined, 'Expected kickstand NOT to be added');
  });
});
