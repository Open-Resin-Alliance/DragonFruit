import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Sidecar lifecycle rules (Ph0.1 sub-phase B, user items 5 and 6).
 *
 * These are source-anchored on purpose. The rules are about *which call sites*
 * may delete a recovery payload, and the failure they guard against — deleting
 * one call site too many — is invisible to a behavioural test of any single
 * function: every individual deletion is correct in isolation. What must be
 * pinned is the set.
 *
 * The deletion gate itself (`is_deletable_autosave_payload`, which is what stops
 * any of these ever reaching the user's project) is tested for real in
 * `src-tauri/src/main.rs`.
 */

function readSource(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
}

/** Extracts a `const <name> = React.useCallback(...)` body by brace matching. */
function extractCallback(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = React.useCallback(`);
  assert.notEqual(start, -1, `${name} no longer exists — the deletion rules moved`);
  let depth = 0;
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

describe('the autosave sidecar is deleted only when nothing would be lost', () => {
  const page = readSource('src/app/page.tsx');

  /**
   * **The binding safety rule.** A user who closes the app and declines to save
   * has still not agreed to lose their autosaved copy. Exiting cleanly with
   * unsaved changes must RETAIN the sidecar; only an exit with nothing
   * outstanding may delete it.
   */
  it('retains the sidecar when a clean exit still has unsaved changes', () => {
    const discardAndClose = extractCallback(page, 'handleDiscardAndCloseProgram');
    assert.equal(
      discardAndClose.includes('clearAutosave'),
      false,
      'closing without saving deletes the recovery copy — the user loses the work they declined to save',
    );

    const requestClose = extractCallback(page, 'handleRequestProgramClose');
    const unsavedBranch = requestClose.slice(
      requestClose.indexOf('hasUnsavedSceneChangesRef.current'),
      requestClose.indexOf('return;'),
    );
    assert.equal(
      unsavedBranch.includes('clearAutosave'),
      false,
      'the unsaved-changes branch must open the modal, never delete the payload',
    );
    assert.equal(
      requestClose.includes('clearAutosave'),
      true,
      'a clean exit with nothing outstanding should not leave a stale _autosave.voxl behind',
    );
  });

  /**
   * **Save As cleanup (item 6).** The sidecar beside the project the user just
   * moved away from is an orphan implying unsaved work that does not exist.
   * Deleting it is safe only because the save it follows has already succeeded.
   */
  it('deletes the sidecar beside the previous project after a successful Save As', () => {
    const save = extractCallback(page, 'performTopBarSaveScene');

    assert.ok(
      /const previousScenePath = activeSceneFilePath/.test(save),
      'the previous project path is no longer captured, so Save As cannot clean up after itself',
    );
    assert.ok(
      save.includes('deleteAutosaveSidecarForProject(previousScenePath)'),
      'a successful Save As orphans the sidecar beside the old project',
    );

    // The deletion must sit after a confirmed save, keyed on the path actually
    // having changed — never on the plain overwrite path.
    const deletion = save.indexOf('deleteAutosaveSidecarForProject');
    const guard = save.lastIndexOf('previousScenePath !== nextActiveScenePath', deletion);
    assert.notEqual(guard, -1, 'the sidecar is deleted even when the project did not move');
    assert.ok(
      save.lastIndexOf('const nextActiveScenePath', deletion) !== -1,
      'the cleanup must run after the save resolved a new path, not before',
    );
  });

  /** Restore and explicit discard are the other two moments deletion is safe. */
  it('clears the payload after a successful restore and on an explicit discard', () => {
    const restore = extractCallback(page, 'handleAutosaveRestore');
    const discard = extractCallback(page, 'handleAutosaveDiscard');

    assert.ok(
      /if \(restored\) \{\s*await clearAutosave\(\);/.test(restore),
      'the payload must only be cleared once the restore has actually succeeded',
    );
    assert.ok(discard.includes('clearAutosave'), 'an explicit discard should remove the payload');
  });

  /** `clearAutosave` is the only seam that deletes, and it must ask for it. */
  it('routes every deletion through the manifest seam with deletePayload set', () => {
    const hook = readSource('src/hooks/useSceneAutosave.ts');
    const clear = hook.slice(hook.indexOf('const clearAutosave'));
    assert.ok(
      /writeManifest\([\s\S]*?\{\s*deletePayload:\s*true\s*\}\s*\)/.test(clear),
      'clearAutosave marks the manifest clean but leaves the payload on disk',
    );
  });
});
