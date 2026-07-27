import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * D7 — "Split to bodies" copies the WHOLE-FILE `sourcePath` onto every body.
 *
 * `splitImportGroup` builds each body from `source.splitBodies[i]` but keeps
 * `sourcePath: source.sourcePath`, so every one of N bodies claims the entire
 * multi-body 3MF as its own full-resolution source. It is inert only because
 * 3MF never receives a `cPre` today — Ph8 gives 3MF a native load path, a
 * `cPre` and a splice contract, at which point each body would splice the whole
 * file's geometry over itself.
 *
 * The correct treatment already exists ~120 lines away in `splitSupports`,
 * which sets `sourcePath: null` on both halves because the split geometry no
 * longer matches anything on disk. Port it, do not design it (directive #22:
 * only D7 is ours; D2–D6 are flagged to the original author).
 *
 * Source-anchored: `splitImportGroup` is a `useCallback` closed over React
 * state inside a 5 000-line hook with no exported seam, and the fix is
 * precisely a source-level property (which literal is assigned to `sourcePath`).
 */

const MANAGER = path.join(process.cwd(), 'src/features/scene/useSceneCollectionManager.ts');

function readCallbackBody(name: string, windowChars: number): string {
  const source = readFileSync(MANAGER, 'utf8');
  const start = source.indexOf(`const ${name} = useCallback(`);
  assert.notEqual(start, -1, `${name} was not found — re-anchor this test`);
  // Bounded window: long enough to cover the model construction, short enough
  // that it cannot bleed into an unrelated callback.
  return source.slice(start, start + windowChars);
}

test('split-to-bodies parts do not inherit the whole-file sourcePath (D7)', () => {
  const body = readCallbackBody('splitImportGroup', 1400);

  assert.doesNotMatch(
    body,
    /sourcePath:\s*source\.sourcePath/,
    'every split body claims the whole multi-body file as its full-resolution '
    + 'source — inert today only because 3MF has no cPre, and a critical bug the '
    + 'moment Ph8 gives it one (D7)',
  );
  assert.match(
    body,
    /sourcePath:\s*null/,
    'split bodies must clear sourcePath, matching splitSupports',
  );
});

test('splitSupports remains the reference treatment', () => {
  // The port target. If this ever regresses, the D7 fix above lost its model.
  const body = readCallbackBody('splitSupports', 5200);
  const assignments = body.match(/sourcePath:\s*[^,\n]+/g) ?? [];
  assert.ok(assignments.length > 0, 'splitSupports no longer assigns sourcePath — re-anchor');
  for (const assignment of assignments) {
    assert.match(assignment, /sourcePath:\s*null/, `splitSupports regressed: ${assignment}`);
  }
});
