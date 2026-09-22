import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEntitiesByHostKnot } from '../supportPreviewOverlay';
import { hostKnotFieldsFor, SUPPORT_TYPES, type SupportTypeId } from '../../supportTypeRegistry';

/**
 * The parent-knot index, derived from each entity's own type and that type's
 * declared host-knot edges.
 *
 * One rule for every type: a branch and a leaf name one host knot, a brace
 * names two and is indexed under both.
 *
 * Two properties a per-type builder could not state are what these pin:
 *
 * - a type with TWO knot edges is indexed under both, which is why brace needed
 *   its own builder;
 * - the type is read off the entity, so an unstamped entity is skipped rather
 *   than silently indexed under whichever type the caller assumed.
 */

const entity = (id: string, typeId: SupportTypeId, ...pairs: Array<[string, string]>) => {
    const record: Record<string, unknown> = { id, typeId };
    for (const [field, knotId] of pairs) record[field] = knotId;
    return record as { id: string; typeId: SupportTypeId } & Record<string, string>;
};

test('a type with one knot edge is indexed under that knot', () => {
    const map = buildEntitiesByHostKnot([
        entity('b1', 'branch', ['parentKnotId', 'k1']),
        entity('b2', 'branch', ['parentKnotId', 'k1']),
        entity('b3', 'branch', ['parentKnotId', 'k2']),
    ], (b) => b.id);

    assert.deepEqual([...map.keys()].sort(), ['k1', 'k2']);
    assert.deepEqual(map.get('k1'), ['b1', 'b2'], 'both children of one knot, in order');
    assert.deepEqual(map.get('k2'), ['b3']);
});

test('a type with two knot edges is indexed under both', () => {
    // Brace is the type this exists for: it spans two knots, and indexing it
    // under only the first would lose every span that starts elsewhere.
    assert.deepEqual(
        hostKnotFieldsFor('brace' as SupportTypeId),
        ['startKnotId', 'endKnotId'],
        'fixture: brace declares two host knots',
    );

    const map = buildEntitiesByHostKnot([
        entity('span1', 'brace', ['startKnotId', 'k1'], ['endKnotId', 'k2']),
        entity('span2', 'brace', ['startKnotId', 'k2'], ['endKnotId', 'k3']),
    ], (b) => b.id);

    assert.deepEqual(map.get('k1'), ['span1'], 'reached from its start');
    assert.deepEqual(map.get('k2'), ['span1', 'span2'], 'reached from one span end and the next start');
    assert.deepEqual(map.get('k3'), ['span2'], 'reached from its end');
});

test('a type declaring no knot edge yields nothing', () => {
    // Trunk stands on its own root and stump carries its own, so neither is
    // indexed -- and the map is empty rather than keyed on undefined.
    for (const typeId of ['trunk', 'stump'] as SupportTypeId[]) {
        assert.deepEqual(hostKnotFieldsFor(typeId), [], `fixture: ${typeId} has no host knot`);
        const map = buildEntitiesByHostKnot(
            [entity('e1', typeId, ['parentKnotId', 'k1'])],
            (e) => e.id,
        );
        assert.equal(map.size, 0, `${typeId} must not be indexed`);
    }
});

test('a missing or empty knot id is skipped, not keyed', () => {
    // Keying on `undefined` or `''` makes entries no lookup for a real knot id
    // can hit: memory that reads as data.
    const map = buildEntitiesByHostKnot([
        entity('b1', 'branch'),
        entity('b2', 'branch', ['parentKnotId', '']),
        entity('b3', 'branch', ['parentKnotId', 'k1']),
    ], (b) => b.id);

    assert.deepEqual([...map.keys()], ['k1']);
    assert.deepEqual(map.get('k1'), ['b3']);
});

test('an entity whose type cannot be resolved is skipped', () => {
    // The index reads the type off the entity. An entity that lost its type --
    // a whole-store payload restored through `setSnapshot` bypasses the writers
    // that stamp, and the store scan then has nothing to find -- must not be
    // indexed under an assumed type.
    const unstamped = { id: 'b1', parentKnotId: 'k1' } as { id: string; typeId?: SupportTypeId };
    const map = buildEntitiesByHostKnot([unstamped], (b) => b.id);
    assert.equal(map.size, 0, 'an entity with no resolvable type contributes nothing');
});

test('the projector decides what is kept', () => {
    const entities = [entity('b1', 'branch', ['parentKnotId', 'k1'])];
    const kept = buildEntitiesByHostKnot(entities, (b) => b);
    const ids = buildEntitiesByHostKnot(entities, (b) => `id:${b.id}`);

    assert.equal(kept.get('k1')?.[0], entities[0], 'the entity itself, when asked for');
    assert.deepEqual(ids.get('k1'), ['id:b1'], 'whatever the caller projects');
});

test('every type declaring a host knot is indexable', () => {
    // Guards the declaration the rule reads: a type whose edges name a field the
    // registry does not actually carry would index nothing, silently.
    const declaring = SUPPORT_TYPES.filter((descriptor) => hostKnotFieldsFor(descriptor.id).length > 0);
    assert.ok(declaring.length >= 3, 'expected branch, leaf and brace to declare host knots');

    for (const descriptor of declaring) {
        const fields = hostKnotFieldsFor(descriptor.id);
        const pairs = fields.map((field, index) => [field, `k${index}`] as [string, string]);
        const map = buildEntitiesByHostKnot(
            [entity('e1', descriptor.id, ...pairs)],
            (e) => e.id,
        );
        assert.equal(
            map.size,
            fields.length,
            `${descriptor.id} should be indexed once per declared knot edge`,
        );
    }
});
