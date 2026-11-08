import assert from 'node:assert/strict';
import test from 'node:test';
import { repairFromPath, repairPartsFromPath } from '../meshRepair';

test('native repair tokens accompany positions but never enter durable health reports', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  let meshToken: unknown = 37;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      document: {},
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === 'mesh_repair_read_positions') return new Uint8Array(positions.buffer);
          assert.ok(command === 'mesh_repair_from_path' || command === 'mesh_repair_parts_from_path');
          return JSON.stringify({
            version: 1,
            post: { triangle_count: 1 },
            slice_mesh_token: meshToken,
          });
        },
      },
    },
  });
  try {
    for (const repair of [repairFromPath, repairPartsFromPath]) {
      meshToken = 37;
      const result = await repair('part.stl');
      assert.ok(result);
      assert.equal(result.meshToken, 37);
      assert.deepEqual(result.positions, positions);
      assert.equal(result.report.post.triangle_count, 1);
      assert.equal('slice_mesh_token' in result.report, false);
      assert.equal(JSON.stringify(result.report).includes('slice_mesh_token'), false);
      for (meshToken of [undefined, 0, -1, 1.5, 0x100000000, '37']) {
        const fallback = await repair('part.stl');
        assert.ok(fallback);
        assert.equal(fallback.meshToken, undefined);
        assert.equal('slice_mesh_token' in fallback.report, false);
      }
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
