import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { modelCascadeSeeds, withoutModelSupports } from '../PlacementLogic/SupportModelLinker';
import { getSnapshot, removeSupportEntitiesForModels, resetStore, setSnapshot } from '../state';
import { IMPORT_PAYLOAD_COLLECTION_ORDER, importPayloadCollections } from '../supportCollections';
import { SUPPORT_TYPES, type SupportCollectionKey } from '../supportTypeRegistry';
import type { DragonfruitImportFormat, SupportState } from '../types';

/**
 * Removing a model's supports from the file's arrays and from the store is one
 * rule (ADR-0045). The fixture holds one support of every type, so a new type
 * has to be added here, and the parity test holds the CLI's path to the app's.
 */

const seg = (id: string) => ({
    id,
    diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: 4 }, diameter: 1 },
});

const knot = (id: string, parentShaftId: string) => ({ id, parentShaftId, pos: { x: 0, y: 0, z: 2 } });

/** One support of every type on `model`, each with the knots and root it needs. */
function supportsOf(model: string) {
    const segment = `${model}-seg`;
    const kickstandRoot = { id: `${model}-kick-root`, modelId: model };
    const kickstandKnot = knot(`${model}-kick-knot`, segment);
    return {
        roots: [{ id: `${model}-root`, modelId: model }, kickstandRoot],
        trunks: [{ id: `${model}-trunk`, modelId: model, rootId: `${model}-root`, segments: [seg(segment)] }],
        branches: [{ id: `${model}-branch`, modelId: model, parentKnotId: `${model}-branch-knot`, segments: [seg(`${model}-branch-seg`)] }],
        leaves: [{ id: `${model}-leaf`, modelId: model, parentKnotId: `${model}-leaf-knot` }],
        twigs: [{ id: `${model}-twig`, modelId: model }],
        sticks: [{ id: `${model}-stick`, modelId: model }],
        braces: [{ id: `${model}-brace`, modelId: model, startKnotId: `${model}-brace-start`, endKnotId: `${model}-brace-end` }],
        stumps: [{ id: `${model}-stump`, modelId: model }],
        knots: [
            knot(`${model}-branch-knot`, segment),
            knot(`${model}-leaf-knot`, segment),
            knot(`${model}-brace-start`, segment),
            knot(`${model}-brace-end`, segment),
            kickstandKnot,
        ],
        kickstands: [{
            root: kickstandRoot,
            hostKnot: kickstandKnot,
            kickstand: {
                id: `${model}-kick`,
                modelId: model,
                rootId: kickstandRoot.id,
                hostKnotId: kickstandKnot.id,
                hostSegmentId: segment,
                segments: [],
            },
        }],
    };
}

function payloadOf(...parts: ReturnType<typeof supportsOf>[]): DragonfruitImportFormat {
    const payload: Record<string, unknown> = {
        version: 1,
        meta: { source: 'test', objectCenter: { x: 0, y: 0, z: 0 } },
    };
    for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
        payload[key] = parts.flatMap((part) => part[key as keyof typeof part] as unknown[]);
    }
    return payload as unknown as DragonfruitImportFormat;
}

const kickstandEntityId = (entry: unknown) => (entry as { kickstand: { id: string } }).kickstand.id;

/** Every id in a payload, per collection, sorted. */
function idsOf(payload: DragonfruitImportFormat): Record<string, string[]> {
    const ids: Record<string, string[]> = {};
    for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
        const list = (payload[key as keyof DragonfruitImportFormat] ?? []) as unknown[];
        ids[key] = list
            .map((entry) => (key === 'kickstands' ? kickstandEntityId(entry) : (entry as { id: string }).id))
            .sort();
    }
    return ids;
}

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

        // Written in directly: the fixture holds ids and edges, not the geometry
        // `loadFromImportFormat` normalises, and the cascade reads only those.
        resetStore();
        const records = Object.fromEntries(IMPORT_PAYLOAD_COLLECTION_ORDER.map((key) => [
            key,
            Object.fromEntries(((input[key as keyof DragonfruitImportFormat] ?? []) as { id: string }[])
                .filter(() => key !== 'kickstands')
                .map((entity) => [entity.id, entity])),
        ]));
        records.kickstands = Object.fromEntries((input.kickstands ?? []).map(({ kickstand }) => [kickstand.id, kickstand]));
        setSnapshot({ ...getSnapshot(), ...records } as SupportState);
        removeSupportEntitiesForModels(['a']);
        const store = importPayloadCollections(getSnapshot());

        const { payload } = withoutModelSupports({ payload: input, modelIds: ['a'] });

        // The store holds kickstands as bare entities, the file in their wrapper.
        const { kickstands, ...rest } = store;
        const storeIds = idsOf({ ...input, ...rest, kickstands: [] } as DragonfruitImportFormat);
        storeIds.kickstands = (kickstands as unknown as { id: string }[]).map((entry) => entry.id).sort();
        assert.deepEqual(idsOf(payload), storeIds);
    });
});
