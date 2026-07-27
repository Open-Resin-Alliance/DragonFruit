import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  AutosaveFailureTracker,
  decideAutosaveGate,
  AUTOSAVE_FAILURE_NOTIFY_THRESHOLD,
} from '../useSceneAutosave';

/**
 * Failure honesty and contention policy (Ph0.1 sub-phase D3 + D4).
 *
 * **N4.** Autosave failures were swallowed with a `console.warn`, and the
 * manifest was written only on success. An autosave that had been failing for an
 * hour presented as a stale "unsaved changes from <time>" prompt with no signal
 * at all — and that is precisely the surface the 4 GiB guard fails into. A
 * failure must now leave a durable record (`last_error`, with `saved_at` still
 * pointing at the last *successful* payload) and tell the user.
 *
 * **D4.** Sub-phase A's single-flight lock made an overlapping write SAFE; this
 * decides whether it is worth attempting at all. The policy is explicit here
 * rather than implied by control flow, because the interesting half is not
 * "when do we skip" but "when we skip, does the dirtiness survive". Work done
 * during a suppressed window that is silently forgotten is data loss with extra
 * steps.
 */

describe('autosave failure honesty (N4)', () => {
  test('a failure is recorded and leaves the last successful timestamp alone', () => {
    const tracker = new AutosaveFailureTracker();
    tracker.recordSuccess('2026-07-26T10:00:00.000Z');

    const outcome = tracker.recordFailure(new Error('This scene exceeds the VOXL 4 GB limit.'));

    assert.equal(outcome.consecutiveFailures, 1);
    assert.equal(tracker.lastError, 'This scene exceeds the VOXL 4 GB limit.');
    assert.equal(
      tracker.lastSuccessAt,
      '2026-07-26T10:00:00.000Z',
      'a failed tick must not advance the timestamp recovery shows the user',
    );
  });

  test('the user is told after two consecutive failures, and only once', () => {
    const tracker = new AutosaveFailureTracker();

    assert.equal(tracker.recordFailure(new Error('disk full')).shouldNotifyUser, false,
      'one transient failure must not interrupt the user');
    assert.equal(AUTOSAVE_FAILURE_NOTIFY_THRESHOLD, 2);

    const second = tracker.recordFailure(new Error('disk full'));
    assert.equal(second.consecutiveFailures, 2);
    assert.equal(second.shouldNotifyUser, true, 'a persistently failing autosave must surface');

    assert.equal(
      tracker.recordFailure(new Error('disk full')).shouldNotifyUser,
      false,
      'a 30 s tick must not spam the same failure forever',
    );
  });

  test('a success clears the streak, so the next outage notifies again', () => {
    const tracker = new AutosaveFailureTracker();
    tracker.recordFailure(new Error('a'));
    tracker.recordFailure(new Error('b'));
    tracker.recordSuccess('2026-07-26T10:00:00.000Z');

    assert.equal(tracker.lastError, null, 'a successful write must clear the recorded error');
    assert.equal(tracker.recordFailure(new Error('c')).shouldNotifyUser, false);
    assert.equal(tracker.recordFailure(new Error('d')).shouldNotifyUser, true);
  });

  test('a non-Error rejection still yields a readable message', () => {
    const tracker = new AutosaveFailureTracker();
    tracker.recordFailure('scene_autosave_write_manifest task failed');
    assert.equal(tracker.lastError, 'scene_autosave_write_manifest task failed');
  });
});

describe('autosave contention policy (D4)', () => {
  const base = {
    enabled: true,
    desktop: true,
    suppressedUntil: 0,
    now: 1_000,
    modelCount: 3,
    navigationBusy: false,
    forced: false,
  };

  test('a quiet desktop scene with models runs', () => {
    assert.deepEqual(decideAutosaveGate(base), { action: 'run' });
  });

  test('a suppressed window DEFERS and keeps the scene dirty', () => {
    const decision = decideAutosaveGate({ ...base, suppressedUntil: 5_000 });
    assert.equal(decision.action, 'defer');
    assert.equal(decision.reason, 'suppressed');
    assert.equal(
      decision.retainDirty,
      true,
      'edits made during a long operation were being forgotten rather than deferred',
    );
  });

  test('camera navigation defers rather than competing for the main thread', () => {
    const decision = decideAutosaveGate({ ...base, navigationBusy: true });
    assert.equal(decision.action, 'defer');
    assert.equal(decision.reason, 'navigation');
    assert.equal(decision.retainDirty, true);
  });

  test('a forced flush overrides navigation but never suppression', () => {
    assert.equal(decideAutosaveGate({ ...base, navigationBusy: true, forced: true }).action, 'run');
    assert.equal(
      decideAutosaveGate({ ...base, suppressedUntil: 5_000, forced: true }).action,
      'run',
      'an explicit flush (quit, Ctrl+S handoff) must not be blocked by a suppression window',
    );
  });

  test('an empty scene skips and drops the dirtiness — there is nothing to lose', () => {
    const decision = decideAutosaveGate({ ...base, modelCount: 0 });
    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'empty-scene');
    assert.equal(decision.retainDirty, false);
  });

  test('a disabled autosave skips but RETAINS dirtiness for when it is re-enabled', () => {
    const decision = decideAutosaveGate({ ...base, enabled: false });
    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'disabled');
    assert.equal(
      decision.retainDirty,
      true,
      'turning autosave off and on again must not lose the edits made in between',
    );
  });

  test('the browser build skips permanently', () => {
    const decision = decideAutosaveGate({ ...base, desktop: false });
    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'not-desktop');
    assert.equal(decision.retainDirty, false);
  });
});
