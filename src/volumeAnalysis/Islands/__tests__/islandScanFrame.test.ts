import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { resolveIslandScanFrame } from '../islandScanSource';

/**
 * R-I1 / R-I2 — regression lock for the islands sideload frame contract
 * (plan: `agents/Claude/STL-import-perf/20260720-Implementation-Plan-islands-sideload-frame-fix.md`).
 *
 * Landed RED at CP0 (captured run: 2 tests, 0 pass, 2 fail — quoted in
 * `20260720-AAR-islands-CP0-red-harness.md`); GREEN since CP2 implemented
 * `resolveIslandScanFrame` and routed `useIslands` through it.
 *
 * CONTRACT: when the islands scan sideloads the ORIGINAL file
 * (`scan_islands_from_path`), the centre it sends must be the stored
 * import-time `C_pre` — the pre-centring bbox centre in RAW-FILE coordinates —
 * because Rust subtracts it from raw file vertices: `w = M · (v_raw − C_pre)`.
 *
 * THE BUG THIS LOCKS OUT: sending the POST-centring scene bbox centre `c`
 * instead. Since `T_center + c = C_pre` exactly, that displaces the sideloaded
 * scan by `M_linear · T_center` — zero only when the source file happens to be
 * origin-centred, non-zero for the pre-supported plate exports this feature
 * exists to scan. The Rust half of the contract (the displacement magnitude,
 * on a generated off-origin STL) is pinned by
 * `mesh_minima.rs::islands_frame_red_harness`.
 *
 * NEVER-GUESS: absent a trustworthy `cPre` — pre-fix imports, VOXL reloads
 * without a persisted datum, or any geometry REPLACED since import
 * (`replaceModelGeometry` drops `cPre`; `sourcePath` deliberately survives
 * mutation, so the path alone must never authorize a re-read) — the resolver
 * returns `null` and the scan falls back to the client-side path
 * (`prepareWorldGeom`), which is frame-correct by construction.
 */

/**
 * An OFF-ORIGIN import, the class that exposes the bug. Mirrors the Rust
 * harness asset (`mesh_minima.rs` `islands_frame_red_harness`):
 *
 *   raw bbox   = (40, 25, 0) .. (60, 31, 12)
 *   C_pre      = (50, 28, 6)      ← full 3-D pre-centring centre  (CORRECT)
 *   T_center   = (50, 25, 6)      ← what import translates by (Y bottom→0)
 *   c          = ( 0,  3, 0)      ← stored post-centring centre   (WRONG)
 *
 * and `T_center + c === C_pre` holds, as the Rust harness asserts.
 */
const C_PRE: [number, number, number] = [50, 28, 6];
const SCENE_CENTER = new THREE.Vector3(0, 3, 0);

function buildOffOriginModel(options?: { withCPre?: boolean }) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-10, 0, -6, 10, 0, -6, 10, 6, 6], 3),
  );
  return {
    id: 'off-origin-plate',
    name: 'pre-supported-plate.stl',
    sourcePath: 'X:/fixtures/pre-supported-plate.stl',
    visible: true,
    geometry: {
      geometry,
      bbox: new THREE.Box3(new THREE.Vector3(-10, 0, -6), new THREE.Vector3(10, 6, 6)),
      center: SCENE_CENTER.clone(),
      size: new THREE.Vector3(20, 6, 12),
      flatteningPlanes: [],
      ...(options?.withCPre === false ? {} : { cPre: C_PRE }),
    },
    transform: {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  };
}

test('R-I1: the sideload centre is the stored C_pre, not the scene bbox centre', () => {
  const model = buildOffOriginModel();
  const resolved = resolveIslandScanFrame(model);

  assert.ok(resolved, 'an off-origin model with a sourcePath and a stored cPre must resolve');
  assert.equal(resolved.filePath, model.sourcePath);

  assert.deepEqual(
    resolved.cPre,
    C_PRE,
    'the sideload must subtract the stored import-time C_pre from RAW file '
      + 'coordinates (w = M · (v_raw − C_pre))',
  );

  // The specific defect: sending the post-centring scene centre displaces the
  // whole scan by M_linear · T_center.
  assert.notDeepEqual(
    resolved.cPre,
    [SCENE_CENTER.x, SCENE_CENTER.y, SCENE_CENTER.z],
    'must NOT send model.geometry.center — that is the post-centring scene '
      + 'centre and is only valid against scene geometry, not raw file coords',
  );
});

test('R-I2: no stored C_pre (incl. post-mutation) means no sideload — never guess a centre', () => {
  // A model imported before the datum existed, or whose geometry was replaced
  // by a hollow/punch/repair (replaceModelGeometry drops cPre). Note the
  // sourcePath is still present — that is exactly the trap: it survives
  // mutation, so presence of a path must NOT by itself authorize a re-read.
  const mutated = buildOffOriginModel({ withCPre: false });

  assert.equal(
    resolveIslandScanFrame(mutated),
    null,
    'without a trustworthy C_pre the scan must fall back to the client-side '
      + 'path (prepareWorldGeom, already frame-correct) rather than sideload '
      + 'the original file with a guessed centre',
  );
});

test('R-I2b: no sourcePath means no sideload even with a stored C_pre', () => {
  const model = buildOffOriginModel();
  assert.equal(resolveIslandScanFrame({ ...model, sourcePath: null }), null);
  assert.equal(resolveIslandScanFrame({ ...model, sourcePath: '   ' }), null);
});
