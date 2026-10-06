import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeStagePathHeader,
  writeChunkedUnlocked,
  writeFileAtomicUnlocked,
  type NativeWriteInvoke,
} from '../nativeSlicerBridge';

/**
 * Non-ASCII destination paths (Ph0.1 regression).
 *
 * The destination travels to Rust in the `x-mesh-stage-path` IPC header, and
 * HTTP header values are visible ASCII only: `HeaderValue::to_str` rejects every
 * byte outside 0x20-0x7E. A project under `…\Tatsächliche Dokumente\` therefore
 * failed on its first chunk, and the export fallback chain turned that into a
 * browser download of the scene file with a success toast — the user picked a
 * destination, was told it was saved, and nothing was there.
 *
 * These tests pin the wire contract: whatever the path contains, the header is
 * ASCII and decodes back to it byte for byte.
 */

const UMLAUT_PATH = 'C:\Users\Someone\Tatsächliche Dokumente\Füße & Hände.voxl';
const CJK_PATH = '/home/someone/プロジェクト/场景.voxl';

function isAscii(value: string): boolean {
  return [...value].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code <= 0x7e;
  });
}

/** Records the raw header values exactly as they would go over IPC. */
function createHeaderRecorder(tempPath = 'C:\tmp\scene.voxl.tmp-1-0'): {
  invoke: NativeWriteInvoke;
  headerPaths: string[];
} {
  const headerPaths: string[] = [];

  const invoke = (async (
    cmd: string,
    _args?: unknown,
    options?: { headers: HeadersInit },
  ) => {
    const headers = (options?.headers ?? {}) as Record<string, string>;
    const raw = headers['x-mesh-stage-path'];
    if (raw !== undefined) headerPaths.push(raw);
    if (cmd === 'scene_file_begin_atomic_write') return tempPath as never;
    return 0 as never;
  }) as NativeWriteInvoke;

  return { invoke, headerPaths };
}

describe('x-mesh-stage-path header encoding', () => {
  it('encodes to visible ASCII and round-trips', () => {
    for (const path of [UMLAUT_PATH, CJK_PATH]) {
      const encoded = encodeStagePathHeader(path);
      assert.ok(isAscii(encoded), `header value must be visible ASCII: ${encoded}`);
      assert.equal(decodeURIComponent(encoded), path);
    }
  });

  it('leaves a plain ASCII path recoverable', () => {
    const path = 'C:\projects\scene.voxl';
    assert.ok(isAscii(encodeStagePathHeader(path)));
    assert.equal(decodeURIComponent(encodeStagePathHeader(path)), path);
  });

  it('sends an ASCII header for a chunked write to a non-ASCII path', async () => {
    const { invoke, headerPaths } = createHeaderRecorder();

    await writeChunkedUnlocked(invoke, UMLAUT_PATH, new Uint8Array(8), 4);

    assert.equal(headerPaths.length, 2);
    for (const raw of headerPaths) {
      assert.ok(isAscii(raw), `header value must be visible ASCII: ${raw}`);
      assert.equal(decodeURIComponent(raw), UMLAUT_PATH);
    }
  });

  it('sends an ASCII header for an atomic write staged beside a non-ASCII target', async () => {
    const tempPath = `${UMLAUT_PATH}.tmp-1234-0`;
    const { invoke, headerPaths } = createHeaderRecorder(tempPath);

    await writeFileAtomicUnlocked(invoke, UMLAUT_PATH, new Uint8Array(4), 4);

    assert.ok(headerPaths.length > 0);
    for (const raw of headerPaths) {
      assert.ok(isAscii(raw), `header value must be visible ASCII: ${raw}`);
      // The staging file is a sibling of the target, so it inherits the
      // non-ASCII directory — encoding it is what the real bug turned on.
      assert.equal(decodeURIComponent(raw), tempPath);
    }
  });
});
