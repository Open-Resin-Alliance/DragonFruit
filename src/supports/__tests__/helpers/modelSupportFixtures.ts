import { getSnapshot, removeSupportEntitiesForModels, resetStore, setSnapshot } from '../../state';
import { IMPORT_PAYLOAD_COLLECTION_ORDER } from '../../supportCollections';
import type { DragonfruitImportFormat, SupportState } from '../../types';

/** Scenes for the model-removal tests: ids and edges, which is all a cascade reads. */

export const seg = (id: string) => ({
    id,
    diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: 4 }, diameter: 1 },
});

export const knot = (id: string, parentShaftId: string) => ({ id, parentShaftId, pos: { x: 0, y: 0, z: 2 } });

/** One support of every type on `model`, each with the knots and root it needs. */
export function supportsOf(model: string) {
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

export function payloadOf(...parts: ReturnType<typeof supportsOf>[]): DragonfruitImportFormat {
    const payload: Record<string, unknown> = {
        version: 1,
        meta: { source: 'test', objectCenter: { x: 0, y: 0, z: 0 } },
    };
    for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
        payload[key] = parts.flatMap((part) => part[key as keyof typeof part] as unknown[]);
    }
    return payload as unknown as DragonfruitImportFormat;
}

export const kickstandEntityId = (entry: unknown) => (entry as { kickstand: { id: string } }).kickstand.id;

/** Every id in a payload, per collection, sorted. */
export function idsOf(payload: DragonfruitImportFormat): Record<string, string[]> {
    const ids: Record<string, string[]> = {};
    for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
        const list = (payload[key as keyof DragonfruitImportFormat] ?? []) as unknown[];
        ids[key] = list
            .map((entry) => (key === 'kickstands' ? kickstandEntityId(entry) : (entry as { id: string }).id))
            .sort();
    }
    return ids;
}

/**
 * The same removal through the store, as ids per collection. Written in directly:
 * the fixtures hold no geometry for `loadFromImportFormat` to normalise.
 */
export function storeIdsAfterRemoving(payload: DragonfruitImportFormat, modelIds: string[]): Record<string, string[]> {
    resetStore();
    const records = Object.fromEntries(IMPORT_PAYLOAD_COLLECTION_ORDER
        .filter((key) => key !== 'kickstands')
        .map((key) => [key, Object.fromEntries(
            ((payload[key as keyof DragonfruitImportFormat] ?? []) as { id: string }[])
                .map((entity) => [entity.id, entity]),
        )])) as Record<string, Record<string, unknown>>;
    records.kickstands = {};
    for (const { root, hostKnot, kickstand } of payload.kickstands ?? []) {
        records.kickstands[kickstand.id] = kickstand;
        records.roots[root.id] = root;
        records.knots[hostKnot.id] = hostKnot;
    }
    setSnapshot({ ...getSnapshot(), ...records } as unknown as SupportState);
    removeSupportEntitiesForModels(modelIds);

    const after = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    return Object.fromEntries(IMPORT_PAYLOAD_COLLECTION_ORDER.map((key) => [key, Object.keys(after[key]).sort()]));
}
