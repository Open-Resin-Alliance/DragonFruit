import assert from 'node:assert/strict';
import test from 'node:test';

import { migrateLegacySupportPayload } from '../importMigrations';
import { getSnapshot, loadFromImportFormat, resetStore } from '../state';
import { SUPPORT_TYPES } from '../supportTypeRegistry';

/**
 * A scene saved under a type's former name stores its entities under the legacy
 * collection key and stamps them with the legacy id. The loader reads the
 * collection key off each descriptor, so without a migration those entities are
 * not found at all -- they load with no error and no entities.
 */

/** The type under test: whichever descriptor declares former names. */
const RENAMED = SUPPORT_TYPES.find((d) => d.renamedFrom?.ids?.length && d.renamedFrom.collectionKeys?.length);
if (!RENAMED) throw new Error('no descriptor declares former names, so there is nothing to migrate');
const STUMP = RENAMED;
const LEGACY_KEY = RENAMED.renamedFrom!.collectionKeys![0]!;
const LEGACY_STAMP = RENAMED.renamedFrom!.ids![0]!;

/** The smallest payload `loadFromImportFormat` accepts, with one entity under `key`. */
function payloadWith(key: string) {
    return {
        version: 1,
        meta: { source: 'test', objectCenter: { x: 0, y: 0, z: 0 } },
        roots: [],
        trunks: [],
        branches: [],
        leaves: [],
        braces: [],
        knots: [],
        [key]: [
            {
                id: 'legacy-stump-1',
                modelId: 'model-a',
                typeId: LEGACY_STAMP,
                rootPos: { x: 1, y: 2, z: 0 },
                rootBaseDiameter: 2,
                rootTopDiameter: 1.6,
                rootHeight: 0.5,
                joint: { id: 'legacy-joint', pos: { x: 1, y: 2, z: 1.1 } },
                segments: [],
                contactCone: {
                    id: 'legacy-cone',
                    pos: { x: 1, y: 2, z: 3 },
                    normal: { x: 0, y: 0, z: -1 },
                    profile: { type: 'disk', lengthMm: 2, contactDiameterMm: 0.3, bodyDiameterMm: 0.8 },
                },
            },
        ],
    } as never;
}

test('a payload with the legacy collection key loads its entity into the current collection', () => {
    resetStore();
    loadFromImportFormat(payloadWith(LEGACY_KEY));

    const stored = getSnapshot()[STUMP.location.key] as Record<string, { typeId?: string }>;
    assert.deepEqual(
        Object.keys(stored),
        ['legacy-stump-1'],
        'the entity must survive the load, under the collection its descriptor names',
    );
    assert.equal(stored['legacy-stump-1']?.typeId, STUMP.id, 'and carry the current type id');
});

test('a payload already using the current key is returned untouched, by identity', () => {
    // Identity matters: callers may hand in a cached document, and rebuilding it
    // on every load would churn identity-compared state.
    const current = { version: 1, [STUMP.location.key]: [{ id: 'a' }] };
    assert.equal(migrateLegacySupportPayload(current), current as never);

    const empty = { version: 1 };
    assert.equal(migrateLegacySupportPayload(empty), empty);
});

test('migration does not mutate the payload it is given', () => {
    const legacy = payloadWith(LEGACY_KEY) as unknown as Record<string, unknown>;
    const before = JSON.stringify(legacy);
    migrateLegacySupportPayload(legacy);
    assert.equal(JSON.stringify(legacy), before, 'the caller keeps its original document');
});

test('migration is idempotent', () => {
    const once = migrateLegacySupportPayload(payloadWith(LEGACY_KEY)) as unknown as Record<string, unknown>;
    const twice = migrateLegacySupportPayload(once) as unknown as Record<string, unknown>;
    assert.equal(twice, once, 'a migrated payload is already current, so it is returned as-is');
    assert.equal(LEGACY_KEY in twice, false, 'and the legacy key does not come back');
});

test('the current key wins when a payload carries both', () => {
    // Written by a build that migrated and then re-saved over a legacy file, so
    // the legacy key is stale residue rather than the newer data.
    const both = {
        ...(payloadWith(LEGACY_KEY) as unknown as Record<string, unknown>),
        [STUMP.location.key]: [{ id: 'current-stump-1' }],
    };
    const migrated = migrateLegacySupportPayload(both) as unknown as Record<string, unknown>;
    const kept = migrated[STUMP.location.key] as Array<{ id: string }>;
    assert.deepEqual(kept.map((e) => e.id), ['current-stump-1'], 'the current array is not overwritten');
    assert.equal(LEGACY_KEY in migrated, false, 'and the stale key is dropped');
});
