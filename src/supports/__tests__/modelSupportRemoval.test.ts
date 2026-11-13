import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { modelCascadeSeeds, withoutModelSupports } from '../PlacementLogic/SupportModelLinker';
import { IMPORT_PAYLOAD_COLLECTION_ORDER } from '../supportCollections';
import { SUPPORT_TYPES, type SupportCollectionKey } from '../supportTypeRegistry';
import { idsOf, payloadOf, storeIdsAfterRemoving, supportsOf } from './helpers/modelSupportFixtures';

/**
 * Removing a model's supports from the file's arrays and from the store is one
 * rule (ADR-0045). The fixture holds one support of every type, so a new type
 * has to be added here, and the parity test holds the CLI's path to the app's.
 */

describe('removing a model\'s supports', () => {
    it('has a fixture entity for every support type', () => {
        const fixture = supportsOf('m');
        for (const descriptor of SUPPORT_TYPES) {
            const key = descriptor.location.key as keyof typeof fixture;
            assert.ok(fixture[key]?.length, `add a ${descriptor.id} to supportsOf`);
        }
    });

    it('leaves nothing of the removed model and all of the other one', () => {
        const { payload, removed } = withoutModelSupports({
            payload: payloadOf(supportsOf('a'), supportsOf('b')),
            modelIds: ['a'],
        });

        assert.deepEqual(idsOf(payload), idsOf(payloadOf(supportsOf('b'))));
        assert.ok(removed > 0);
    });

    it('keeps the kickstand wrapper of the model that stays, whole', () => {
        const { payload } = withoutModelSupports({
            payload: payloadOf(supportsOf('a'), supportsOf('b')),
            modelIds: ['a'],
        });

        assert.deepEqual(payload.kickstands, supportsOf('b').kickstands);
    });

    it('reads a kickstand whose root and knot live only in its wrapper, as the CLI writes it', () => {
        const a = supportsOf('a');
        a.roots = a.roots.filter((root) => root.id !== 'a-kick-root');
        a.knots = a.knots.filter((entry) => entry.id !== 'a-kick-knot');

        const { payload } = withoutModelSupports({ payload: payloadOf(a), modelIds: ['a'] });

        assert.deepEqual(payload.kickstands, []);
    });

    it('takes a support of another model that hangs off a removed one', () => {
        const a = supportsOf('a');
        const b = supportsOf('b');
        b.branches[0].parentKnotId = 'a-branch-knot';

        const { payload } = withoutModelSupports({ payload: payloadOf(a, b), modelIds: ['a'] });

        assert.deepEqual(idsOf(payload).branches, []);
    });

    it('removes several models in one pass', () => {
        const { payload } = withoutModelSupports({
            payload: payloadOf(supportsOf('a'), supportsOf('b'), supportsOf('c')),
            modelIds: ['a', 'b'],
        });

        assert.deepEqual(idsOf(payload), idsOf(payloadOf(supportsOf('c'))));
    });

    it('leaves optional collections a payload does not have as undefined', () => {
        const input = payloadOf(supportsOf('b'));
        delete input.twigs;
        delete input.kickstands;

        const { payload, removed } = withoutModelSupports({ payload: input, modelIds: ['a'] });

        assert.equal(payload.twigs, undefined);
        assert.equal(payload.kickstands, undefined);
        assert.equal(removed, 0);
    });

    it('does not change its input', () => {
        const input = payloadOf(supportsOf('a'), supportsOf('b'));
        const copy = structuredClone(input);

        withoutModelSupports({ payload: input, modelIds: ['a'] });

        assert.deepEqual(input, copy);
    });

    it('seeds from a model\'s roots too, so an unclaimed root does not stay behind', () => {
        const collections = {
            ...Object.fromEntries(IMPORT_PAYLOAD_COLLECTION_ORDER.map((key) => [key, {}])),
            roots: { orphan: { id: 'orphan', modelId: 'a' } },
        } as unknown as Parameters<typeof modelCascadeSeeds>[0]['collections'];

        assert.deepEqual(
            modelCascadeSeeds({ collections, modelIds: ['a'] }),
            [{ collection: 'roots' satisfies SupportCollectionKey, id: 'orphan' }],
        );
    });

    it('gives the file and the store the same result', () => {
        const input = payloadOf(supportsOf('a'), supportsOf('b'));
        input.branches[1].parentKnotId = 'a-branch-knot';

        const { payload } = withoutModelSupports({ payload: input, modelIds: ['a'] });

        assert.deepEqual(idsOf(payload), storeIdsAfterRemoving(input, ['a']));
    });
});
