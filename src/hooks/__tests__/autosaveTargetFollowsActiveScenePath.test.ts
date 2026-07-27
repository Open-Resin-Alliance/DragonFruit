import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  resolveAutosavePaths,
  resetAutosavePathCache,
  type AutosaveInvoke,
  type AutosavePaths,
} from '../useSceneAutosave';

/**
 * Autosave target resolution (Ph0.1 sub-phase B, finding N3 + the sidecar policy).
 *
 * Two defects are pinned here:
 *
 *  - **N3.** The hook's `preferredSavePath` was supplied from
 *    `preferredOverwriteScenePathRef.current` — a ref, read during render.
 *    Mutating a ref does not re-render, so the value could be a whole session
 *    stale. That was harmless while autosave wrote to one fixed location; with
 *    sidecars it means a Save As keeps writing the recovery file next to the
 *    *old* project.
 *  - **The module-level path cache**, which pinned the first resolution it ever
 *    saw and so could outlive the project it was resolved for.
 */

const PROJECT_A = 'C:/projects/MyPrint.voxl';
const PROJECT_B = 'D:/archive/MyPrint.voxl';

function sidecarFor(project: string): AutosavePaths {
  const dir = project.slice(0, project.lastIndexOf('/'));
  const stem = project.slice(project.lastIndexOf('/') + 1).replace(/\.voxl$/i, '');
  return {
    voxlPath: `${dir}/${stem}_autosave.voxl`,
    manifestPath: 'C:/appdata/autosave/manifest.json',
    origin: 'sidecar',
    projectPath: project,
    fallbackReason: null,
  };
}

const GENERIC_FALLBACK: AutosavePaths = {
  voxlPath: 'C:/appdata/autosave/scene_autosave.voxl',
  manifestPath: 'C:/appdata/autosave/manifest.json',
  origin: 'recovery-dir',
  projectPath: PROJECT_A,
  fallbackReason: 'parent-unwritable',
};

function recordingInvoke(reply: (preferred: string | null) => AutosavePaths): {
  invoke: AutosaveInvoke;
  requested: (string | null)[];
} {
  const requested: (string | null)[] = [];
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    assert.equal(cmd, 'scene_autosave_get_paths');
    const preferred = (args?.preferredSavePath as string | undefined) ?? null;
    requested.push(preferred);
    return reply(preferred) as never;
  }) as AutosaveInvoke;
  return { invoke, requested };
}

describe('the autosave target follows the active scene path', () => {
  beforeEach(() => {
    resetAutosavePathCache();
  });

  it('re-resolves when the project moves, instead of pinning the first path', async () => {
    const { invoke, requested } = recordingInvoke((preferred) => sidecarFor(preferred ?? PROJECT_A));

    const first = await resolveAutosavePaths(invoke, PROJECT_A);
    assert.equal(first.voxlPath, 'C:/projects/MyPrint_autosave.voxl');

    // Same project: served from cache, no second round-trip.
    await resolveAutosavePaths(invoke, PROJECT_A);
    assert.equal(requested.length, 1, 'an unchanged project should not re-resolve every tick');

    // Save As to a new folder. The sidecar must follow the project.
    const moved = await resolveAutosavePaths(invoke, PROJECT_B);
    assert.equal(
      moved.voxlPath,
      'D:/archive/MyPrint_autosave.voxl',
      'the recovery file is still being written beside the previous project',
    );
    assert.deepEqual(requested, [PROJECT_A, PROJECT_B]);
  });

  it('never caches a fallback, so the sidecar returns when the folder does', async () => {
    let usable = false;
    const { invoke, requested } = recordingInvoke(() => (usable ? sidecarFor(PROJECT_A) : GENERIC_FALLBACK));

    const fellBack = await resolveAutosavePaths(invoke, PROJECT_A);
    assert.equal(fellBack.origin, 'recovery-dir');
    assert.equal(fellBack.fallbackReason, 'parent-unwritable');

    // The share reconnects / the folder becomes writable again.
    usable = true;
    const recovered = await resolveAutosavePaths(invoke, PROJECT_A);
    assert.equal(
      recovered.origin,
      'sidecar',
      'a transient folder failure permanently exiled the autosave to the recovery dir',
    );
    assert.equal(requested.length, 2);
  });

  it('asks for no project at all when the scene is untitled', async () => {
    const { invoke, requested } = recordingInvoke(() => GENERIC_FALLBACK);
    await resolveAutosavePaths(invoke, null);
    assert.deepEqual(requested, [null], 'an untitled scene must not claim a project path');
  });

  /**
   * Source-anchored because the defect is *where the value comes from*, not what
   * the hook does with it: a ref read during render type-checks and behaves
   * identically until the moment it goes stale. `activeSceneFilePath` is state,
   * set on every successful save (`performTopBarSaveScene`) and every scene open
   * (`useImportExportManager`), so React re-renders and the hook sees the move.
   */
  it('is driven by activeSceneFilePath state, not a ref read during render', () => {
    const pageSource = fs.readFileSync(
      path.join(process.cwd(), 'src/app/page.tsx'),
      'utf8',
    );
    const preferred = /preferredSavePath:\s*([^,\n]+)/.exec(pageSource);
    assert.ok(preferred, 'useSceneAutosave no longer receives a preferredSavePath');
    assert.equal(
      preferred[1].trim(),
      'activeSceneFilePath',
      'the autosave target is fed from a render-time ref again (finding N3)',
    );
  });
});
