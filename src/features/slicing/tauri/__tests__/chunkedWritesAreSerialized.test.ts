import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runExclusiveNativeWrite,
  writeChunkedUnlocked,
  type NativeWriteInvoke,
} from '../nativeSlicerBridge';

/**
 * Writer single-flight (Ph0.1 sub-phase A, finding N2).
 *
 * Rust keeps ONE process-global chunk appender. Two chunk sequences to different
 * paths evict each other and re-truncate on every switch-back, so writer A's
 * committed chunks are destroyed and its next chunk lands at offset 0 — both
 * files corrupt, no error. These tests pin that the frontend never emits that
 * interleaving in the first place.
 */

type InvokeRecord = { cmd: string; path?: string; offset?: string };

/**
 * Fake `invoke` that records the command stream and yields to the microtask
 * queue on every call, which is exactly where a real IPC round-trip would let
 * another writer in.
 */
function createRecordingInvoke(): { invoke: NativeWriteInvoke; calls: InvokeRecord[] } {
  const calls: InvokeRecord[] = [];

  const invoke = (async (
    cmd: string,
    args?: Record<string, unknown> | ArrayBuffer | Uint8Array,
    options?: { headers: HeadersInit },
  ) => {
    const headers = (options?.headers ?? {}) as Record<string, string>;
    calls.push({
      cmd,
      path: headers['x-mesh-stage-path']
        ?? (args && !(args instanceof Uint8Array) && !(args instanceof ArrayBuffer)
          ? (args as Record<string, string>).path
          : undefined),
      offset: headers['x-mesh-stage-offset'],
    });
    // Two ticks: enough for an unserialized competitor to interleave.
    await Promise.resolve();
    await Promise.resolve();
    return 0 as never;
  }) as NativeWriteInvoke;

  return { invoke, calls };
}

/** Splits the recorded stream into per-path append runs, in arrival order. */
function appendRuns(calls: InvokeRecord[]): string[] {
  const runs: string[] = [];
  for (const call of calls) {
    if (call.cmd !== 'append_mesh_stage_chunk') continue;
    const path = call.path ?? '<none>';
    if (runs[runs.length - 1] !== path) runs.push(path);
  }
  return runs;
}

describe('native chunked writes are serialized', () => {
  it('does not interleave two overlapping writes to different paths', async () => {
    const { invoke, calls } = createRecordingInvoke();
    const bytes = new Uint8Array(12);

    // Both writes start before either finishes — the real autosave-vs-save race.
    await Promise.all([
      runExclusiveNativeWrite(() => writeChunkedUnlocked(invoke, 'A.voxl', bytes, 4)),
      runExclusiveNativeWrite(() => writeChunkedUnlocked(invoke, 'B.voxl', bytes, 4)),
    ]);

    const runs = appendRuns(calls);
    assert.deepEqual(
      runs,
      ['A.voxl', 'B.voxl'],
      `chunk sequences interleaved — each switch-back re-truncates: ${runs.join(' → ')}`,
    );

    // Each sequence must also be complete and in offset order.
    const perPath = new Map<string, string[]>();
    for (const call of calls) {
      if (call.cmd !== 'append_mesh_stage_chunk') continue;
      const list = perPath.get(call.path!) ?? [];
      list.push(call.offset!);
      perPath.set(call.path!, list);
    }
    assert.deepEqual(perPath.get('A.voxl'), ['0', '4', '8']);
    assert.deepEqual(perPath.get('B.voxl'), ['0', '4', '8']);
  });

  it('keeps serializing after a write rejects', async () => {
    const { invoke, calls } = createRecordingInvoke();
    const failing: NativeWriteInvoke = (async (cmd: string) => {
      if (cmd === 'append_mesh_stage_chunk') throw new Error('disk full');
      return 0 as never;
    }) as NativeWriteInvoke;

    const first = runExclusiveNativeWrite(() =>
      writeChunkedUnlocked(failing, 'A.voxl', new Uint8Array(4), 4),
    );
    const second = runExclusiveNativeWrite(() =>
      writeChunkedUnlocked(invoke, 'B.voxl', new Uint8Array(8), 4),
    );

    await assert.rejects(first, /disk full/);
    await second;

    // A rejected write must not wedge the queue for every later write.
    assert.deepEqual(appendRuns(calls), ['B.voxl']);
  });
});
