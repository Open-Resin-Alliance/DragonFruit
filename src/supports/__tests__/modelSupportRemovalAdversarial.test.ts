import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { modelCascadeSeeds, withoutModelSupports } from '../PlacementLogic/SupportModelLinker';
import { removeSupportEntitiesForModels, resetStore } from '../state';
import { IMPORT_PAYLOAD_COLLECTION_ORDER } from '../supportCollections';
import { SUPPORT_TYPES } from '../supportTypeRegistry';
import type { DragonfruitImportFormat } from '../types';
import { idsOf, kickstandEntityId, knot, payloadOf, seg, storeIdsAfterRemoving, supportsOf } from './helpers/modelSupportFixtures';

/**
 * Attempts to break a model removal: scenes the fixture in
 * `modelSupportRemoval.test.ts` does not reach, files in odd shapes, and a seeded
 * random walk over the support graph. Each case states what must still hold.
 */

const remove = (payload: DragonfruitImportFormat, ...modelIds: string[]) =>
    withoutModelSupports({ payload, modelIds });

const asPayload = (parts: Record<string, unknown>) => ({
    ...payloadOf(),
    ...parts,
}) as unknown as DragonfruitImportFormat;

describe('model removal: ownership that crosses models', () => {
    it('does not take a root another model\'s trunk still stands on', () => {
        // A root whose stamp disagrees with its owner: the trunk is what counts.
        const b = supportsOf('b');
        b.roots[0].modelId = 'a';

        const { payload } = remove(payloadOf(b), 'a');

        assert.ok(payload.roots.some((root) => root.id === 'b-root'), 'the trunk would lose its root');
    });

    it('does not take a root a kickstand of another model still owns', () => {
        const b = supportsOf('b');
        b.roots[1].modelId = 'a';
        b.kickstands[0].root.modelId = 'a';

        const { payload } = remove(payloadOf(b), 'a');

        assert.ok(payload.roots.some((root) => root.id === 'b-kick-root'));
        assert.equal(payload.kickstands?.length, 1);
    });

    it('still takes a root of the model whose trunk goes, whatever the root is stamped', () => {
        const a = supportsOf('a');
        a.roots[0].modelId = 'someone-else';

        const { payload } = remove(payloadOf(a), 'a');

        assert.deepEqual(idsOf(payload).roots, []);
    });

    it('takes a brace of the other model that ends on the removed shaft, and keeps its far knot', () => {
        const a = supportsOf('a');
        const b = supportsOf('b');
        b.braces[0].endKnotId = 'a-brace-end';

        const input = payloadOf(a, b);
        const { payload } = remove(input, 'a');

        assert.deepEqual(idsOf(payload).braces, []);
        assert.ok(idsOf(payload).knots.includes('b-brace-start'), 'that knot rides a shaft nobody removed');
        assert.deepEqual(idsOf(payload), storeIdsAfterRemoving(input, ['a']));
    });

    it('takes a kickstand of the other model hosted on the removed shaft, wrapper and all', () => {
        const a = supportsOf('a');
        const b = supportsOf('b');
        b.kickstands[0].kickstand.hostSegmentId = 'a-seg';
        b.kickstands[0].hostKnot.parentShaftId = 'a-seg';
        b.knots = b.knots.map((entry) => (entry.id === 'b-kick-knot' ? { ...entry, parentShaftId: 'a-seg' } : entry));

        const input = payloadOf(a, b);
        const { payload } = remove(input, 'a');

        assert.deepEqual(payload.kickstands, []);
        assert.deepEqual(idsOf(payload), storeIdsAfterRemoving(input, ['a']));
    });

    it('follows a chain of branches across three models', () => {
        const a = supportsOf('a');
        const b = supportsOf('b');
        const c = supportsOf('c');
        b.branches[0].parentKnotId = 'a-branch-knot';
        c.knots.push(knot('c-on-b', 'b-branch-seg'));
        c.branches[0].parentKnotId = 'c-on-b';

        const input = payloadOf(a, b, c);
        const { payload } = remove(input, 'a');

        assert.deepEqual(idsOf(payload).branches, []);
        assert.deepEqual(idsOf(payload), storeIdsAfterRemoving(input, ['a']));
    });

    it('survives a cycle of branches hanging off each other', () => {
        const a = supportsOf('a');
        a.branches[0].parentKnotId = 'loop-knot';
        a.knots.push(knot('loop-knot', 'a-branch-seg'));

        const input = payloadOf(a, supportsOf('b'));
        assert.deepEqual(idsOf(remove(input, 'a').payload), idsOf(payloadOf(supportsOf('b'))));
    });
});

describe('model removal: ids that fight the code', () => {
    it('handles an id with a colon, which the cascade uses as its separator', () => {
        const a = supportsOf('a');
        a.twigs[0].id = 'twig:with:colons';

        assert.deepEqual(idsOf(remove(payloadOf(a), 'a').payload).twigs, []);
    });

    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        it(`handles an entity called ${id}`, () => {
            const a = supportsOf('a');
            const b = supportsOf('b');
            a.twigs[0].id = id;
            a.roots[0].id = id;
            a.trunks[0].rootId = id;

            const { payload } = remove(payloadOf(a, b), 'a');

            assert.deepEqual(idsOf(payload), idsOf(payloadOf(b)));
        });
    }

    it('does not mistake a model called __proto__ for a missing one', () => {
        const { payload } = remove(payloadOf(supportsOf('__proto__'), supportsOf('b')), '__proto__');

        assert.deepEqual(idsOf(payload), idsOf(payloadOf(supportsOf('b'))));
    });

    it('does not take supports of a model whose id only starts the same', () => {
        const { payload, removed } = remove(payloadOf(supportsOf('model-10')), 'model-1');

        assert.equal(removed, 0);
        assert.deepEqual(idsOf(payload), idsOf(payloadOf(supportsOf('model-10'))));
    });

    it('treats a segment id two models both use as one host, as the store does', () => {
        // Copies that kept their segment ids: seen in scenes written by hand.
        const a = supportsOf('a');
        const b = supportsOf('b');
        b.trunks[0].segments = [seg('a-seg')];

        const input = payloadOf(a, b);

        assert.deepEqual(idsOf(remove(input, 'a').payload), storeIdsAfterRemoving(input, ['a']));
    });
});

describe('model removal: files in odd shapes', () => {
    it('reads a payload with no knots, roots or anything else', () => {
        const input = { version: 1, meta: {} } as unknown as DragonfruitImportFormat;

        assert.deepEqual(remove(input, 'a'), { payload: input, removed: 0 });
    });

    it('moves a type stored under a former collection key', () => {
        const legacyKey = SUPPORT_TYPES.flatMap((d) => d.renamedFrom?.collectionKeys ?? [])[0];
        if (!legacyKey) return;
        const input = { ...payloadOf(supportsOf('a')), [legacyKey]: [{ id: 'old', modelId: 'a' }] } as DragonfruitImportFormat;
        const key = SUPPORT_TYPES.find((d) => d.renamedFrom?.collectionKeys?.includes(legacyKey))?.location.key;
        delete (input as unknown as Record<string, unknown>)[key as string];

        const { payload } = remove(input, 'a');

        assert.ok(!JSON.stringify(payload).includes('"id":"old"'), 'a legacy entity stayed behind');
    });

    it('reads a kickstand with no wrapper root or knot left', () => {
        const a = supportsOf('a');
        const entry = a.kickstands[0] as unknown as Record<string, unknown>;
        delete entry.root;
        delete entry.hostKnot;

        const { payload } = remove(payloadOf(a), 'a');

        assert.deepEqual(payload.kickstands, []);
    });

    it('skips a null in a collection instead of dying on it', () => {
        const a = supportsOf('a') as unknown as Record<string, unknown[]>;
        a.twigs.push(null);
        a.kickstands.push(null);

        const { payload } = remove(payloadOf(a as never), 'a');

        assert.deepEqual(payload.twigs?.filter(Boolean), []);
    });

    it('keeps fields it does not know about', () => {
        const input = { ...payloadOf(supportsOf('a')), futureField: { keep: true } } as DragonfruitImportFormat;

        const { payload } = remove(input, 'a');

        assert.deepEqual((payload as unknown as { futureField: unknown }).futureField, { keep: true });
        assert.deepEqual(payload.meta, input.meta);
    });

    it('keeps the order of what stays, which the export goldens compare', () => {
        const input = payloadOf(supportsOf('c'), supportsOf('a'), supportsOf('b'));

        const { payload } = remove(input, 'a');

        assert.deepEqual(
            payload.knots.map((entry) => entry.id),
            input.knots.filter((entry) => !entry.id.startsWith('a-')).map((entry) => entry.id),
        );
    });

    it('hands back the same object when nothing goes', () => {
        const input = payloadOf(supportsOf('b'));

        assert.equal(remove(input, 'a').payload, input);
    });

    it('agrees with the store when a wrapper\'s knot differs from the one in `knots`', () => {
        const a = supportsOf('a');
        const b = supportsOf('b');
        // The store's loader lets the wrapper win, so the walk has to as well.
        b.kickstands[0].hostKnot = { ...b.kickstands[0].hostKnot, parentShaftId: 'a-seg' };

        const input = payloadOf(a, b);

        assert.deepEqual(idsOf(remove(input, 'a').payload), storeIdsAfterRemoving(input, ['a']));
    });
});

describe('model removal: arguments', () => {
    it('does nothing for no model ids', () => {
        const input = payloadOf(supportsOf('a'));

        assert.deepEqual(remove(input), { payload: input, removed: 0 });
    });

    it('takes any iterable, once through', () => {
        function* ids() { yield 'a'; yield 'a'; yield 'b'; }

        const { payload } = withoutModelSupports({
            payload: payloadOf(supportsOf('a'), supportsOf('b'), supportsOf('c')),
            modelIds: ids(),
        });

        assert.deepEqual(idsOf(payload), idsOf(payloadOf(supportsOf('c'))));
    });

    it('is the same as removing the models one after the other', () => {
        const input = payloadOf(supportsOf('a'), supportsOf('b'), supportsOf('c'));

        const together = remove(input, 'a', 'b').payload;
        const apart = remove(remove(input, 'a').payload, 'b').payload;

        assert.deepEqual(idsOf(together), idsOf(apart));
    });

    it('takes nothing the second time', () => {
        const once = remove(payloadOf(supportsOf('a'), supportsOf('b')), 'a').payload;

        assert.deepEqual(remove(once, 'a'), { payload: once, removed: 0 });
    });

    it('never seeds from knots, which name no model', () => {
        const collections = Object.fromEntries(
            IMPORT_PAYLOAD_COLLECTION_ORDER.map((key) => [key, {}]),
        ) as unknown as Parameters<typeof modelCascadeSeeds>[0]['collections'];
        (collections.knots as unknown as Record<string, unknown>).k = { id: 'k', modelId: 'a' };

        assert.deepEqual(modelCascadeSeeds({ collections, modelIds: ['a'] }), []);
    });
});

/**
 * Ids per collection with kickstand wrappers opened, as the store holds them: a
 * CLI-written file keeps a kickstand's root and knot only inside the wrapper.
 */
function unwrappedIdsOf(payload: DragonfruitImportFormat): Record<string, string[]> {
    const ids = idsOf(payload);
    for (const { root, hostKnot } of payload.kickstands ?? []) {
        ids.roots.push(root.id);
        ids.knots.push(hostKnot.id);
    }
    ids.roots = [...new Set(ids.roots)].sort();
    ids.knots = [...new Set(ids.knots)].sort();
    return ids;
}

/** Small seeded generator, so a failing scene comes back from its seed alone. */
function mulberry32(seed: number) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A random support forest over `modelCount` models, with edges between them. */
function randomScene(seed: number, modelCount = 4): DragonfruitImportFormat {
    const random = mulberry32(seed);
    const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
    const models = Array.from({ length: modelCount }, (_, index) => `m${index}`);
    const parts: Record<string, Record<string, unknown>[]> = Object.fromEntries(
        IMPORT_PAYLOAD_COLLECTION_ORDER.map((key) => [key, []]),
    );
    const segments: string[] = [];
    let next = 0;
    const id = (prefix: string) => `${prefix}-${next++}`;
    const newKnot = () => {
        const entry = knot(id('knot'), pick(segments));
        parts.knots.push(entry);
        return entry.id;
    };

    for (let i = 0; i < 2 + random() * 6; i++) {
        const modelId = pick(models);
        const rootId = id('root');
        const segment = id('seg');
        segments.push(segment);
        // Now and then a root stamped with the wrong model.
        parts.roots.push({ id: rootId, modelId: random() < 0.1 ? pick(models) : modelId });
        parts.trunks.push({ id: id('trunk'), modelId, rootId, segments: [seg(segment)] });
    }

    for (let i = 0; i < 5 + random() * 30; i++) {
        const modelId = pick(models);
        const roll = random();
        if (roll < 0.25) {
            const segment = id('seg');
            parts.branches.push({ id: id('branch'), modelId, parentKnotId: newKnot(), segments: [seg(segment)] });
            segments.push(segment);
        } else if (roll < 0.4) {
            parts.leaves.push({ id: id('leaf'), modelId, parentKnotId: newKnot() });
        } else if (roll < 0.55) {
            parts.braces.push({ id: id('brace'), modelId, startKnotId: newKnot(), endKnotId: newKnot() });
        } else if (roll < 0.65) {
            parts.twigs.push({ id: id('twig'), modelId });
        } else if (roll < 0.75) {
            parts.sticks.push({ id: id('stick'), modelId });
        } else if (roll < 0.85) {
            parts.stumps.push({ id: id('stump'), modelId });
        } else {
            const root = { id: id('root'), modelId };
            const hostKnot = knot(id('knot'), pick(segments));
            // The app also writes both into their own arrays, the CLI does not.
            if (random() < 0.5) {
                parts.roots.push(root);
                parts.knots.push(hostKnot);
            }
            parts.kickstands.push({
                root,
                hostKnot,
                kickstand: {
                    id: id('kick'),
                    modelId,
                    rootId: root.id,
                    hostKnotId: hostKnot.id,
                    hostSegmentId: hostKnot.parentShaftId,
                    segments: [],
                },
            });
        }
    }
    return asPayload(parts);
}

/** Every reference a survivor makes, so a dangling one is caught by name. */
function danglingReferences(payload: DragonfruitImportFormat): string[] {
    const wrappers = payload.kickstands ?? [];
    const roots = new Set([...payload.roots.map((root) => root.id), ...wrappers.map((build) => build.root.id)]);
    const knots = new Set([...payload.knots.map((entry) => entry.id), ...wrappers.map((build) => build.hostKnot.id)]);
    const segments = new Set(
        [...payload.trunks, ...payload.branches].flatMap((shaft) => shaft.segments.map((segment) => segment.id)),
    );

    const dangling: string[] = [];
    for (const trunk of payload.trunks) if (!roots.has(trunk.rootId)) dangling.push(`${trunk.id}.rootId`);
    for (const branch of payload.branches) if (!knots.has(branch.parentKnotId)) dangling.push(`${branch.id}.parentKnotId`);
    for (const leaf of payload.leaves) if (!knots.has(leaf.parentKnotId)) dangling.push(`${leaf.id}.parentKnotId`);
    for (const brace of payload.braces) {
        if (!knots.has(brace.startKnotId)) dangling.push(`${brace.id}.startKnotId`);
        if (!knots.has(brace.endKnotId)) dangling.push(`${brace.id}.endKnotId`);
    }
    for (const entry of payload.knots) {
        if (!segments.has(entry.parentShaftId)) dangling.push(`${entry.id}.parentShaftId`);
    }
    for (const { kickstand, hostKnot } of wrappers) {
        if (!segments.has(hostKnot.parentShaftId)) dangling.push(`${kickstand.id} host knot`);
    }
    return dangling;
}

const SCENES = 300;

describe(`model removal: ${SCENES} random scenes`, () => {
    const eachScene = (check: (input: DragonfruitImportFormat, removedModels: string[], seed: number) => void) => {
        for (let seed = 1; seed <= SCENES; seed++) {
            const random = mulberry32(seed * 7919);
            const removedModels = ['m0', 'm1', 'm2', 'm3'].filter(() => random() < 0.4);
            check(randomScene(seed), removedModels.length > 0 ? removedModels : ['m0'], seed);
        }
    };

    it('agrees with the store', () => {
        eachScene((input, models, seed) => {
            assert.deepEqual(unwrappedIdsOf(remove(input, ...models).payload), storeIdsAfterRemoving(input, models), `seed ${seed}`);
        });
        resetStore();
    });

    it('leaves nothing stamped with a removed model on anything but a claimed root', () => {
        eachScene((input, models, seed) => {
            const { payload } = remove(input, ...models);
            for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
                if (key === 'knots' || key === 'kickstands' || key === 'roots') continue;
                const left = (payload[key as keyof DragonfruitImportFormat] as { id: string; modelId?: string }[])
                    .filter((entity) => models.includes(entity.modelId ?? ''));
                assert.deepEqual(left.map((entity) => entity.id), [], `seed ${seed}, ${key}`);
            }
            assert.deepEqual(
                (payload.kickstands ?? []).filter((build) => models.includes(build.kickstand.modelId)).map(kickstandEntityId),
                [],
                `seed ${seed}`,
            );
        });
    });

    it('leaves no survivor pointing at something that went', () => {
        eachScene((input, models, seed) => {
            assert.deepEqual(danglingReferences(remove(input, ...models).payload), [], `seed ${seed}`);
        });
    });

    it('leaves every survivor exactly as it was', () => {
        eachScene((input, models, seed) => {
            const { payload } = remove(input, ...models);
            for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
                const before = (input[key as keyof DragonfruitImportFormat] ?? []) as unknown[];
                const after = (payload[key as keyof DragonfruitImportFormat] ?? []) as unknown[];
                for (const survivor of after) {
                    assert.ok(before.includes(survivor), `seed ${seed}, ${key}: a survivor was rewritten`);
                }
            }
        });
    });

    it('does not care what order the file lists things in', () => {
        eachScene((input, models, seed) => {
            const shuffled = { ...input } as unknown as Record<string, unknown[]>;
            for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
                shuffled[key] = [...shuffled[key]].reverse();
            }
            assert.deepEqual(
                idsOf(remove(shuffled as unknown as DragonfruitImportFormat, ...models).payload),
                idsOf(remove(input, ...models).payload),
                `seed ${seed}`,
            );
        });
    });

    it('takes nothing more on a second pass', () => {
        eachScene((input, models, seed) => {
            const once = remove(input, ...models).payload;
            assert.equal(remove(once, ...models).removed, 0, `seed ${seed}`);
        });
    });
});

describe('model removal: scale', () => {
    it('clears 60 000 supports in well under a second per ten thousand', () => {
        const parts = Array.from({ length: 2_000 }, (_, index) => supportsOf(`m${index % 20}-${index}`));
        const input = payloadOf(...parts);
        const modelIds = parts.slice(0, 1_000).map((part) => part.twigs[0].modelId);

        const started = performance.now();
        const { removed } = remove(input, ...modelIds);
        const elapsed = performance.now() - started;

        assert.ok(removed > 10_000);
        assert.ok(elapsed < 3_000, `took ${Math.round(elapsed)} ms`);
    });

    it('walks a branch chain 5 000 deep without overflowing the stack', () => {
        const a = supportsOf('a');
        let shaft = 'a-seg';
        for (let i = 0; i < 5_000; i++) {
            a.knots.push(knot(`deep-knot-${i}`, shaft));
            shaft = `deep-seg-${i}`;
            a.branches.push({ id: `deep-${i}`, modelId: i === 0 ? 'a' : 'b', parentKnotId: `deep-knot-${i}`, segments: [seg(shaft)] });
        }

        const { payload } = remove(payloadOf(a), 'a');

        assert.deepEqual(idsOf(payload).branches, []);
    });
});

describe('model removal: the store', () => {
    it('is not left holding a root another model\'s trunk stands on', () => {
        const b = supportsOf('b');
        b.roots[0].modelId = 'a';
        const input = payloadOf(b);

        assert.ok(storeIdsAfterRemoving(input, ['a']).roots.includes('b-root'));
        resetStore();
        assert.equal(removeSupportEntitiesForModels(['a']), 0);
    });
});
