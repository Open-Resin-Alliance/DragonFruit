import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlacementStore } from '../interaction/shared/placement/placementStore';

/**
 * The placement store primitive.
 *
 * All four placement stores are built on this, so a bug here is four bugs --
 * and it arrived with a single adopter and no test of its own. These pin the
 * contract the stores depend on: notification, and what a reset keeps.
 */

interface Probe {
    flag: boolean;
    value: number;
    other: string;
}

const initial = (): Probe => ({ flag: false, value: 0, other: 'start' });

test('a write notifies every subscriber, and unsubscribing stops it', () => {
    const store = createPlacementStore(initial());
    let a = 0;
    let b = 0;
    const offA = store.subscribe(() => { a += 1; });
    store.subscribe(() => { b += 1; });

    store.write({ ...store.read(), value: 1 });
    assert.equal(a, 1);
    assert.equal(b, 1);

    offA();
    store.write({ ...store.read(), value: 2 });
    assert.equal(a, 1, 'the unsubscribed listener heard nothing');
    assert.equal(b, 2);
});

test('write accepts a function of the current state', () => {
    const store = createPlacementStore(initial());
    store.write((current) => ({ ...current, value: current.value + 5 }));
    assert.equal(store.getSnapshot().value, 5);
});

test('the snapshot is the live state, not a copy', () => {
    const store = createPlacementStore(initial());
    const next = { ...store.read(), value: 9 };
    store.write(next);
    assert.equal(store.getSnapshot(), next, 'subscribers see the object that was written');
});

test('a write always notifies, even when the values are unchanged', () => {
    // The stores guard their own writes per field, deliberately: what counts as
    // "changed" is per-type (a brace compares its preview structurally, branch
    // and leaf compare theirs by reference). A guard in here would override them.
    const store = createPlacementStore(initial());
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });

    store.write({ ...store.read() });
    assert.equal(notifications, 1);
});

test('resetPreserving restores the initial state but keeps the named fields', () => {
    const store = createPlacementStore(initial());
    store.write({ flag: true, value: 7, other: 'changed' });

    store.resetPreserving('flag');
    assert.deepEqual(store.getSnapshot(), { flag: true, value: 0, other: 'start' });
});

test('resetPreserving keeps several fields', () => {
    const store = createPlacementStore(initial());
    store.write({ flag: true, value: 7, other: 'changed' });

    store.resetPreserving('flag', 'other');
    assert.deepEqual(store.getSnapshot(), { flag: true, value: 0, other: 'changed' });
});

test('a reset that would change nothing notifies nobody', () => {
    // The whole reason the primitive has this method rather than letting each
    // store spread `initialState`: a reset fires from release handlers and
    // frame loops, and an idle store must not churn every subscriber.
    const store = createPlacementStore(initial());
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });

    store.resetPreserving('flag');
    assert.equal(notifications, 0, 'an already-initial store is a no-op');

    store.write({ ...store.read(), value: 3 });
    assert.equal(notifications, 1);

    store.resetPreserving('flag');
    assert.equal(notifications, 2, 'a real reset does notify');
});

test('resetPreserving compares by reference, so a changed object counts as a change', () => {
    // Shallow on purpose: these states hold object references (a snap target, a
    // preview, a hover point) and comparing into them is the setter's job.
    const store = createPlacementStore(initial());
    const nested = { flag: true, value: 0, other: 'start' };
    store.write(nested);
    store.resetPreserving();
    assert.equal(store.getSnapshot().flag, false);
});
