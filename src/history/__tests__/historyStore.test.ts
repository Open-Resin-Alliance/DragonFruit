import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  pushHistory,
  undo,
  redo,
  clearHistory,
  registerHistoryHandler,
  getUndoCount,
  getRedoCount,
} from '../historyStore';

const ACTION = { type: 'test:action', payload: { value: 1 } } as const;

describe('historyStore', () => {
  const cleanups: Array<() => void> = [];
  const originalWarn = console.warn;

  beforeEach(() => {
    clearHistory();
    console.warn = () => {};
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    console.warn = originalWarn;
  });

  function register(type: string, handler: Parameters<typeof registerHistoryHandler>[1]) {
    cleanups.push(registerHistoryHandler(type, handler));
  }

  it('moves an entry from undo to redo when a handler applies it', () => {
    register(ACTION.type, () => true);
    pushHistory(ACTION);

    undo();

    assert.equal(getUndoCount(), 0);
    assert.equal(getRedoCount(), 1);
  });

  it('does not treat a void-returning handler as a decline', () => {
    register(ACTION.type, () => {});
    pushHistory(ACTION);

    undo();

    assert.equal(getUndoCount(), 0);
    assert.equal(getRedoCount(), 1);
  });

  // no-handler: transient (registration can lag the push) — keep the entry.
  it('keeps the entry when no handler is registered', () => {
    pushHistory(ACTION);

    undo();

    assert.equal(getUndoCount(), 1, 'entry must not be discarded');
    assert.equal(getRedoCount(), 0, 'unapplied entry must not become redoable');
  });

  it('replays an entry once its handler registers late', () => {
    pushHistory(ACTION);
    undo();
    assert.equal(getUndoCount(), 1, 'still pending while unhandled');

    register(ACTION.type, () => true);
    undo();

    assert.equal(getUndoCount(), 0);
    assert.equal(getRedoCount(), 1);
  });

  it('keeps the entry when redo finds no handler', () => {
    const unregister = registerHistoryHandler(ACTION.type, () => true);
    pushHistory(ACTION);
    undo();
    assert.equal(getRedoCount(), 1);

    unregister();
    redo();

    assert.equal(getRedoCount(), 1, 'entry must not be discarded');
    assert.equal(getUndoCount(), 0);
  });

  // declined: a handler ran but refused — unrecoverable, so discard it.
  it('discards the entry when a handler declines it', () => {
    register(ACTION.type, () => false);
    pushHistory(ACTION);

    undo();

    assert.equal(getUndoCount(), 0, 'unrecoverable entry must not be retained');
    assert.equal(getRedoCount(), 0, 'declined entry must not become redoable');
  });

  it('does not let a declined entry block undo of entries beneath it', () => {
    register('good', () => true);
    register('bad', () => false);
    pushHistory({ type: 'good', payload: {} });
    pushHistory({ type: 'bad', payload: {} }); // now on top

    undo(); // pops 'bad' → declined → discarded, not pushed back
    assert.equal(getUndoCount(), 1, 'the good entry is still reachable');

    undo(); // pops 'good' → applied
    assert.equal(getUndoCount(), 0);
    assert.equal(getRedoCount(), 1);
  });

  it('discards a redo entry when its handler declines', () => {
    let accepts = true;
    register(ACTION.type, () => accepts);
    pushHistory(ACTION);
    undo(); // applied → sits on redo stack
    assert.equal(getRedoCount(), 1);

    accepts = false;
    redo(); // declined → discarded

    assert.equal(getRedoCount(), 0);
    assert.equal(getUndoCount(), 0);
  });
});
