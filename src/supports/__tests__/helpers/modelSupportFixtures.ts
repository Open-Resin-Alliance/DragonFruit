import { getSnapshot, loadFromImportFormat, removeSupportEntitiesForModels } from '../../state';
import { IMPORT_PAYLOAD_COLLECTION_ORDER } from '../../supportCollections';
import type { DragonfruitImportFormat } from '../../types';

/** Scenes for the model-removal tests: ids and edges, which is all a cascade reads. */

export const seg = (id: string) => ({
    id,
    diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: 4 }, diameter: 1 },
});

export const knot = (id: string, parentShaftId: string) => ({ id, parentShaftId, pos: { x: 0, y: 0, z: 2 } });

export const root = (id: string, modelId: string) => ({ id, modelId, transform: { pos: { x: 0, y: 0, z: 0 } } });

/** One support of every type on `model`, each with the knots and root it needs. */
export function supportsOf(model: string) {
    const segment = `${model}-seg`;
    const kickstandRoot = root(`${model}-kick-root`, model);
    const kickstandKnot = knot(`${model}-kick-knot`, segment);
    return {
        roots: [root(`${model}-root`, model), kickstandRoot],
        trunks: [{ id: `${model}-trunk`, modelId: model, rootId: `${model}-root`, segments: [seg(segment)] }],
        branches: [{ id: `${model}-branch`, modelId: model, parentKnotId: `${model}-branch-knot`, segments: [seg(`${model}-branch-seg`)] }],
        leaves: [{ id: `${model}-leaf`, modelId: model, parentKnotId: `${model}-leaf-knot` }],
        twigs: [{ id: `${model}-twig`, modelId: model, segments: [seg(`${model}-twig-seg`)] }],
        sticks: [{ id: `${model}-stick`, modelId: model, segments: [seg(`${model}-stick-seg`)] }],
        braces: [{ id: `${model}-brace`, modelId: model, startKnotId: `${model}-brace-start`, endKnotId: `${model}-brace-end` }],
        stumps: [{ id: `${model}-stump`, modelId: model, segments: [seg(`${model}-stump-seg`)] }],
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

/** Every id in the store, per collection, sorted. */
function storeIds(): Record<string, string[]> {
    const after = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    return Object.fromEntries(IMPORT_PAYLOAD_COLLECTION_ORDER.map((key) => [key, Object.keys(after[key]).sort()]));
}

/** Opens `payload` in the store as the app does, without the loader's log line per scene. */
function openInStore(payload: DragonfruitImportFormat): void {
    const log = console.log;
    console.log = () => {};
    try {
        loadFromImportFormat(payload);
    } finally {
        console.log = log;
    }
}

/** The ids the store holds after the app opens `payload`. */
export function storeIdsAfterLoading(payload: DragonfruitImportFormat): Record<string, string[]> {
    openInStore(payload);
    return storeIds();
}

/** The same removal in the app: open `payload`, then remove the models from the store. */
export function storeIdsAfterRemoving(payload: DragonfruitImportFormat, modelIds: string[]): Record<string, string[]> {
    openInStore(payload);
    removeSupportEntitiesForModels(modelIds);
    return storeIds();
}
