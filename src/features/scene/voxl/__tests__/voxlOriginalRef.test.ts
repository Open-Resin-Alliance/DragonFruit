import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  parseVoxlDocumentV2,
  readSidecarFileBytes,
  resolveOriginalRefSidecar,
  serializeVoxlDocumentV2,
} from '../codec-v2';
import type { VoxlMeshRef } from '../types';
import { meshLike, testInput, withFrozenClock } from './voxlTestSupport';

const PREVIEW_MESH = meshLike(1, 1024);

describe('VOXL originalRef Sidecar Resolution & Serialization', () => {
  test('serializes and parses originalRef sidecar reference in V2 document', async () => {
    await withFrozenClock(async () => {
      const originalRef: VoxlMeshRef = {
        mode: 'external-file',
        fileName: 'sidecars/my_model_orig.stl',
        uncompressedSizeBytes: 543210,
        sha256: 'a'.repeat(64),
      };

      const input = testInput(['m0']);
      input.models[0].originalRef = originalRef;

      const meshBytesMap = new Map<number, Uint8Array>([[0, PREVIEW_MESH]]);
      const bin = await serializeVoxlDocumentV2(
        input,
        meshBytesMap,
        undefined,
        { embedOriginalMesh: false },
      );

      const parsed = parseVoxlDocumentV2(bin);
      assert.equal(parsed.document.models.length, 1);
      const parsedModel = parsed.document.models[0];
      assert.ok(parsedModel.originalRef, 'parsed model must carry originalRef');
      assert.equal(parsedModel.originalRef.mode, 'external-file');
      assert.equal(parsedModel.originalRef.fileName, 'sidecars/my_model_orig.stl');
      assert.equal(parsedModel.originalRef.uncompressedSizeBytes, 543210);
      assert.equal(parsedModel.originalRef.sha256, 'a'.repeat(64));
    });
  });

  test('resolveOriginalRefSidecar resolves relative path relative to .voxl project path', () => {
    const ref: VoxlMeshRef = {
      mode: 'external-file',
      fileName: 'models/my_part_orig.stl',
    };

    // Windows project path
    const resolvedWin = resolveOriginalRefSidecar(ref, 'C:/Users/aaron/Projects/my_scene.voxl');
    assert.equal(resolvedWin, 'C:/Users/aaron/Projects/models/my_part_orig.stl');

    // POSIX project path
    const resolvedPosix = resolveOriginalRefSidecar(ref, '/home/user/projects/my_scene.voxl');
    assert.equal(resolvedPosix, '/home/user/projects/models/my_part_orig.stl');

    // Simple filename in same directory
    const simpleRef: VoxlMeshRef = {
      mode: 'external-file',
      fileName: 'part_orig.stl',
    };
    const resolvedSameDir = resolveOriginalRefSidecar(simpleRef, 'C:/Projects/my_scene.voxl');
    assert.equal(resolvedSameDir, 'C:/Projects/part_orig.stl');
  });

  test('resolveOriginalRefSidecar preserves absolute sidecar file paths', () => {
    const winAbsRef: VoxlMeshRef = {
      mode: 'external-file',
      fileName: 'D:/Assets/HighRes/part_orig.stl',
    };
    const resolvedWinAbs = resolveOriginalRefSidecar(winAbsRef, 'C:/Projects/my_scene.voxl');
    assert.equal(resolvedWinAbs, 'D:/Assets/HighRes/part_orig.stl');

    const posixAbsRef: VoxlMeshRef = {
      mode: 'external-file',
      fileName: '/var/data/part_orig.stl',
    };
    const resolvedPosixAbs = resolveOriginalRefSidecar(posixAbsRef, '/home/user/projects/my_scene.voxl');
    assert.equal(resolvedPosixAbs, '/var/data/part_orig.stl');
  });

  test('resolveOriginalRefSidecar returns null for invalid or non-external references', () => {
    assert.equal(resolveOriginalRefSidecar(undefined, 'C:/Projects/my_scene.voxl'), null);

    const embeddedChunkRef: VoxlMeshRef = { mode: 'embedded-chunk', chunkIndex: 0 };
    assert.equal(resolveOriginalRefSidecar(embeddedChunkRef, 'C:/Projects/my_scene.voxl'), null);

    const emptyFileRef: VoxlMeshRef = { mode: 'external-file', fileName: '' };
    assert.equal(resolveOriginalRefSidecar(emptyFileRef, 'C:/Projects/my_scene.voxl'), null);
  });

  test('readSidecarFileBytes returns null gracefully when sidecar file is unreadable or missing', async () => {
    const nonExistentPath = 'X:/invalid_path_does_not_exist_12345/missing.stl';
    const bytes = await readSidecarFileBytes(nonExistentPath);
    assert.equal(bytes, null, 'must return null when file does not exist');
  });
});
