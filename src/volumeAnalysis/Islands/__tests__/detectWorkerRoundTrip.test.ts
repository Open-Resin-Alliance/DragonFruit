import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Box3, BufferAttribute, BufferGeometry } from 'three';
import { DEFAULT_DETECT_OPTIONS, detectIslands, installInProcessWorkers } from '../../../../scripts/bench-island-scan';
import { detectVoxelIslands } from '../detect';
import { disposeEventLoopChannel } from '@/utils/yieldToEventLoop';

// The layer loop in `sliceCandidateLayers` talks to its workers one round trip
// per layer. These tests pin the two ways that loop used to fail: a host that
// answers synchronously (the Node harness) stacked one frame set per layer, and
// a worker that failed left the scan waiting forever.

type Listener = (event: { data?: unknown; message?: string; error?: unknown }) => void;

function boxTriangles(out: number[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  const quads: number[][][] = [
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
  ];
  for (const [a, b, c, d] of quads) out.push(...a, ...b, ...c, ...a, ...c, ...d);
}

/** A 3 mm column `heightMm` tall, with a loose 1 mm cube near the top: one real island. */
function tallColumnWithIsland(heightMm: number): BufferGeometry {
  const tris: number[] = [];
  boxTriangles(tris, -1.5, -1.5, 0, 1.5, 1.5, heightMm);
  boxTriangles(tris, 4, -0.5, heightMm - 3, 5, 0.5, heightMm - 2);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(tris), 3));
  return geometry;
}

test('a worker asked for a layer before init answers with an error instead of staying silent', async () => {
  await installInProcessWorkers();
  const WorkerCtor = (globalThis as unknown as { Worker: new () => Worker }).Worker;
  const worker = new WorkerCtor();
  const reply = new Promise<unknown>((resolve) => {
    worker.addEventListener('message', (e: MessageEvent) => resolve(e.data));
  });
  worker.postMessage({ type: 'layer', z: 1, layerHeightMm: 0.05, gridRef: {}, opts: {} });
  const data = (await reply) as { type?: string };
  assert.equal(data.type, 'error');
  worker.terminate();
});

test('a scan of 2000 layers on the in-process workers finishes and finds the island', { timeout: 60_000 }, async () => {
  const heightMm = 60;
  const islands = await detectIslands(tallColumnWithIsland(heightMm), {
    ...DEFAULT_DETECT_OPTIONS,
    layerHeightMm: 0.03,
  });
  const loose = islands.filter((island) => Math.abs(island.baseZ - (heightMm - 3)) < 0.5);
  assert.equal(loose.length, 1, `expected the loose cube as an island, got z = ${islands.map((i) => i.baseZ.toFixed(2)).join(', ')}`);
});

function withFakeWorker(reply: (listeners: { message: Set<Listener>; error: Set<Listener> }) => void): () => void {
  const globals = globalThis as unknown as { Worker?: unknown };
  const previous = globals.Worker;
  globals.Worker = function FakeWorker() {
    const listeners = { message: new Set<Listener>(), error: new Set<Listener>() };
    return {
      postMessage: (message: { type?: string }) => {
        if (message.type === 'layer') queueMicrotask(() => reply(listeners));
      },
      addEventListener: (type: 'message' | 'error', listener: Listener) => listeners[type]?.add(listener),
      removeEventListener: (type: 'message' | 'error', listener: Listener) => listeners[type]?.delete(listener),
      terminate: () => {
        listeners.message.clear();
        listeners.error.clear();
      },
    };
  };
  return () => {
    globals.Worker = previous;
  };
}

function scanSmallBox(): Promise<unknown> {
  const geometry = tallColumnWithIsland(5);
  geometry.computeBoundingBox();
  return detectVoxelIslands(
    {
      positions: geometry.getAttribute('position').array as Float32Array,
      bbox: (geometry.boundingBox as Box3).clone(),
    },
    0.05,
    {
      pxMm: DEFAULT_DETECT_OPTIONS.pxMm,
      supportBufferMm: DEFAULT_DETECT_OPTIONS.supportBufferMm,
      connectivity: DEFAULT_DETECT_OPTIONS.connectivity,
      minAreaMm2: DEFAULT_DETECT_OPTIONS.minAreaMm2,
    },
  );
}

test('a worker that answers with an error message fails the scan', { timeout: 10_000 }, async () => {
  const restore = withFakeWorker((listeners) => {
    for (const listener of [...listeners.message]) listener({ data: { type: 'error', message: 'boom' } });
  });
  try {
    await assert.rejects(scanSmallBox(), /island scan worker: boom/);
  } finally {
    restore();
  }
});

test('a worker that throws fails the scan', { timeout: 10_000 }, async () => {
  const restore = withFakeWorker((listeners) => {
    for (const listener of [...listeners.error]) listener({ message: 'crashed', error: new Error('worker crashed') });
  });
  try {
    await assert.rejects(scanSmallBox(), /worker crashed/);
  } finally {
    restore();
  }
});

test('release the event loop channel', () => {
  disposeEventLoopChannel();
});
