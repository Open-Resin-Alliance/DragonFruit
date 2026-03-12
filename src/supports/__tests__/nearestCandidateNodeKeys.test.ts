import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNearestCandidateNodeKeys } from '../PlacementLogic/Grid/nearestCandidateNodeKeys';

test('buildNearestCandidateNodeKeys returns the center node first', () => {
    const keys = buildNearestCandidateNodeKeys('10,20', 0);

    assert.deepEqual(keys, ['10,20']);
});

test('buildNearestCandidateNodeKeys expands by square rings around the preferred node', () => {
    const keys = buildNearestCandidateNodeKeys('0,0', 1);

    assert.deepEqual(keys, [
        '0,0',
        '-1,-1',
        '-1,0',
        '-1,1',
        '0,-1',
        '0,1',
        '1,-1',
        '1,0',
        '1,1',
    ]);
});

test('buildNearestCandidateNodeKeys appends later rings after earlier rings', () => {
    const keys = buildNearestCandidateNodeKeys('2,3', 2);

    assert.equal(keys[0], '2,3');
    assert.deepEqual(keys.slice(1, 9), [
        '1,2',
        '1,3',
        '1,4',
        '2,2',
        '2,4',
        '3,2',
        '3,3',
        '3,4',
    ]);
    assert.equal(keys.length, 25);
    assert.ok(keys.indexOf('0,1') > keys.indexOf('1,2'));
});
