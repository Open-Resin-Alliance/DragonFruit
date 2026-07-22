import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

/**
 * CP0 RED HARNESS — R-I1 / R-I2: the islands sideload frame contract
 * (plan: `agents/Claude/STL-import-perf/20260720-Implementation-Plan-islands-sideload-frame-fix.md`).
 *
 * CONTRACT: when the islands scan sideloads the ORIGINAL file
 * (`scan_islands_from_path`), the centre it sends must be the stored import-time
 * `C_pre` — the pre-centring bbox centre in RAW-FILE coordinates — because Rust
 * subtracts it from raw file vertices: `w = M · (v_raw − C_pre)`.
 *
 * TODAY IT SENDS `c` (useIslands.ts, `geom.geometry.boundingBox` → `getCenter`),
 * the POST-centring scene bbox centre. Since `T_center + c = C_pre` exactly, the
 * sideloaded mesh is displaced by `M_linear · T_center` — zero only when the
 * source file happens to be origin-centred, non-zero for the pre-supported plate
 * exports this feature exists to scan.
 *
 * SEAM: CP2 extracts the decision into a pure, injectable resolver
 * `resolveIslandScanFrame` in `src/volumeAnalysis/Islands/islandScanSource.ts`,
 * mirroring what Phase 1 did with `resolveFullResSourceForModel`
 * (`prepareModelGeometry.ts`). A pure function is testable without a React
 * harness; the hook itself is not.
 *
 * WHAT CP2 MUST EXPOSE (so these go green):
 *  - `resolveIslandScanFrame(model)` → `{ filePath, cPre, fingerprint } | null`
 *  - non-null ONLY when a `sourcePath` AND a stored `cPre` are present and the
 *    geometry has not been mutated since import;
 *  - `null` otherwise ⇒ the caller falls back to the client-side scan
 *    (`prepareWorldGeom`), which is already frame-correct. NEVER guess a centre.
 *
 * NOTE ON THE MUTATION CASE: CP1 makes `replaceModelGeometry` DROP the stored
 * `cPre`, so "geometry was mutated since import" reduces to "no `cPre`" at this
 * seam — one condition, asserted by R-I2. This matters because `sourcePath`
 * itself survives mutation (only the split path nulls it), so a hollowed model
 * would otherwise re-read its original un-hollowed file.
 *
 * SKIPPED IN-TREE because they FAIL today by design (red-first, plan §D1) and
 * the pinned `npm test` baseline (251/251) must gain skips only. Red proof:
 * flip `skip` to false locally, run
 * `node --import tsx --test src/volumeAnalysis/Islands/__tests__/islandScanFrame.test.ts`,
 * capture the failure, re-skip. The captured run is quoted in the CP0 AAR.
 */
const RED_SKIP_REASON =
  'red until CP2 (islands sideload consumes the stored C_pre) — un-skip locally for the red proof';

/**
 * Resolved dynamically so this file COMPILES today: `islandScanSource.ts` does
 * not exist until CP2. The specifier is typed `string` so TypeScript does not
 * attempt static module resolution.
 */
const SEAM_MODULE: string = '../islandScanSource';

async function loadResolveIslandScanFrame(): Promise<((model: unknown) => unknown) | null> {
  try {
    const mod = (await import(SEAM_MODULE)) as Record<string, unknown>;
    const fn = mod['resolveIslandScanFrame'];
    return typeof fn === 'function' ? (fn as (model: unknown) => unknown) : null;
  } catch {
    return null;
  }
}

/**
 * An OFF-ORIGIN import, the class that exposes the bug. Mirrors the Rust
 * harness asset exactly (`mesh_minima.rs` `islands_frame_red_harness`):
 *
 *   raw bbox   = (40, 25, 0) .. (60, 31, 12)
 *   C_pre      = (50, 28, 6)      ← full 3-D pre-centring centre  (CORRECT)
 *   T_center   = (50, 25, 6)      ← what import translates by (Y bottom→0)
 *   c          = ( 0,  3, 0)      ← stored post-centring centre   (WRONG, sent today)
 *
 * and `T_center + c === C_pre` holds, as the Rust harness also asserts.
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

test(
  'R-I1: the sideload centre is the stored C_pre, not the scene bbox centre',
  { skip: RED_SKIP_REASON },
  async () => {
    const resolveIslandScanFrame = await loadResolveIslandScanFrame();
    assert.ok(
      resolveIslandScanFrame,
      'CP2 must export resolveIslandScanFrame from islandScanSource.ts',
    );

    const model = buildOffOriginModel();
    const resolved = resolveIslandScanFrame(model) as
      | { filePath?: unknown; cPre?: unknown }
      | null;

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
  },
);

test(
  'R-I2: no stored C_pre (incl. post-mutation) means no sideload — never guess a centre',
  { skip: RED_SKIP_REASON },
  async () => {
    const resolveIslandScanFrame = await loadResolveIslandScanFrame();
    assert.ok(
      resolveIslandScanFrame,
      'CP2 must export resolveIslandScanFrame from islandScanSource.ts',
    );

    // A model imported before CP1, or whose geometry was replaced by a
    // hollow/punch/repair (CP1 drops cPre on replaceModelGeometry). Note the
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
  },
);
