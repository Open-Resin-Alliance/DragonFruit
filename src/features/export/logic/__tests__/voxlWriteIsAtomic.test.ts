import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ExportManager } from '../ExportManager';
import { writeFileAtomicUnlocked, type NativeWriteInvoke } from '@/features/slicing/tauri/nativeSlicerBridge';

/**
 * Crash-safe scene-file commit (Ph0.1 sub-phase A, findings N1 + user item 2).
 *
 * The pre-Ph0.1 seam wrote scene bytes straight to the destination and the first
 * chunk truncated it, so a crash mid-write left a truncated `.voxl` with no
 * fallback — for autosave AND for an explicit Ctrl+S overwrite, which share the
 * seam. These tests pin that scene writes never touch the destination until a
 * complete payload is on disk.
 */

type InvokeRecord = { cmd: string; path?: string };

const TEMP_PATH = 'C:/projects/MyPrint.voxl.tmp-4242-0';
const TARGET_PATH = 'C:/projects/MyPrint.voxl';

function createRecordingInvoke(options?: { failChunks?: boolean }): {
  invoke: NativeWriteInvoke;
  calls: InvokeRecord[];
} {
  const calls: InvokeRecord[] = [];

  const invoke = (async (
    cmd: string,
    args?: Record<string, unknown> | ArrayBuffer | Uint8Array,
    opts?: { headers: HeadersInit },
  ) => {
    const headers = (opts?.headers ?? {}) as Record<string, string>;
    const record = args && !(args instanceof Uint8Array) && !(args instanceof ArrayBuffer)
      ? (args as Record<string, string>)
      : {};
    calls.push({
      cmd,
      path: headers['x-mesh-stage-path'] ?? record.path ?? record.tempPath ?? record.targetPath,
    });

    if (cmd === 'scene_file_begin_atomic_write') return TEMP_PATH as never;
    if (cmd === 'append_mesh_stage_chunk' && options?.failChunks) {
      throw new Error('disk full');
    }
    return undefined as never;
  }) as NativeWriteInvoke;

  return { invoke, calls };
}

describe('VOXL writes are committed atomically', () => {
  it('routes scene files, and only scene files, to the atomic writer', () => {
    assert.equal(ExportManager.requiresAtomicCommit('voxl'), true);
    assert.equal(ExportManager.requiresAtomicCommit('VOXL'), true);
    assert.equal(ExportManager.requiresAtomicCommit('stl'), false);
    assert.equal(ExportManager.requiresAtomicCommit('3mf'), false);
  });

  it('stages to a temp and commits, never writing to the destination directly', async () => {
    const { invoke, calls } = createRecordingInvoke();

    await writeFileAtomicUnlocked(invoke, TARGET_PATH, new Uint8Array(10), 4);

    const chunkTargets = calls
      .filter((call) => call.cmd === 'append_mesh_stage_chunk')
      .map((call) => call.path);
    assert.ok(chunkTargets.length > 0, 'no payload was written at all');
    assert.ok(
      chunkTargets.every((path) => path === TEMP_PATH),
      `scene bytes were written straight to the destination: ${chunkTargets.join(', ')}`,
    );

    assert.deepEqual(
      calls.map((call) => call.cmd),
      [
        'scene_file_begin_atomic_write',
        'append_mesh_stage_chunk',
        'append_mesh_stage_chunk',
        'append_mesh_stage_chunk',
        'finish_mesh_stage_write',
        'scene_file_commit_atomic',
      ],
      'the commit must be the last step, after the full payload is on disk',
    );
  });

  it('discards the staging file and never commits when the payload fails', async () => {
    const { invoke, calls } = createRecordingInvoke({ failChunks: true });

    await assert.rejects(
      writeFileAtomicUnlocked(invoke, TARGET_PATH, new Uint8Array(10), 4),
      /disk full/,
    );

    assert.equal(
      calls.some((call) => call.cmd === 'scene_file_commit_atomic'),
      false,
      'a failed write must never reach the destination',
    );
    assert.equal(
      calls.some((call) => call.cmd === 'scene_file_discard_atomic_temp' && call.path === TEMP_PATH),
      true,
      'a failed write left its staging file beside the user project',
    );
  });
});
