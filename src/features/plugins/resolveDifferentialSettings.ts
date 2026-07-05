import type {
    PluginLocalMaterialSettingsAdapterContract,
    LocalMaterialTabSchema,
    LocalMaterialSectionSchema,
    LocalMaterialCardSchema,
    LocalMaterialFieldSchema,
    DifferentialMaterialSettings,
    MaterialSettingsSource,
} from '@/features/plugins/complexPluginContracts';

/**
 * Resolve a (possibly differential) material settings source into a fully
 * resolved adapter contract.
 *
 * - Standalone contracts (no `$inherit`) are returned as-is.
 * - Differential contracts recursively inherit from the named base mode,
 *   then apply `$remove` deletions, then apply `$update` merges.
 *
 * @param rawJson         The raw JSON source for the target mode.
 * @param allModeJsons    Map of mode name → raw JSON source for every mode
 *                        in the same output-format group. Used to resolve
 *                        `$inherit` chains.
 * @param depth           Internal recursion depth for cycle detection.
 */
export function resolveDifferentialMaterialSettings(
    rawJson: MaterialSettingsSource,
    allModeJsons: Record<string, MaterialSettingsSource>,
    depth = 0,
): Omit<PluginLocalMaterialSettingsAdapterContract, 'outputFormat'> {
    // --- Standalone contract (backward compatible) ---
    if (!('$inherit' in rawJson)) {
        return rawJson;
    }

    const diff = rawJson as DifferentialMaterialSettings;

    // --- Cycle detection ---
    if (depth > 50) {
        throw new Error(
            `[resolveDifferentialSettings] Circular \$inherit detected (depth ${depth}). ` +
            `Chain: ... \u2192 ${diff.$inherit}`,
        );
    }

    // --- Resolve the base mode ---
    const baseName = diff.$inherit;
    const baseSource = allModeJsons[baseName];
    if (!baseSource) {
        throw new Error(
            `[resolveDifferentialSettings] Mode "${baseName}" not found in the mode map. ` +
            `Available modes: ${Object.keys(allModeJsons).join(', ')}`,
        );
    }

    // Recursively resolve the base (in case it's also differential)
    const base = resolveDifferentialMaterialSettings(baseSource, allModeJsons, depth + 1);

    // --- Deep clone the base so we don't mutate shared state ---
    const resolved: Omit<PluginLocalMaterialSettingsAdapterContract, 'outputFormat'> = JSON.parse(JSON.stringify(base));

    // --- FIRST: Apply $remove (delete by id/key) ---
    if (diff.$remove) {
        if (diff.$remove.tabs?.length) {
            resolved.tabs = resolved.tabs?.filter(
                (t) => !diff.$remove!.tabs!.includes(t.id),
            );
        }
        if (diff.$remove.sections?.length) {
            resolved.sections = resolved.sections?.filter(
                (s) => !diff.$remove!.sections!.includes(s.id),
            );
        }
        if (diff.$remove.cards?.length) {
            resolved.cards = resolved.cards?.filter(
                (c) => !diff.$remove!.cards!.includes(c.id),
            );
        }
        if (diff.$remove.fields?.length) {
            resolved.fields = resolved.fields?.filter(
                (f) => !diff.$remove!.fields!.includes(f.key),
            );
        }
    }

    // --- SECOND: UPSERT top-level arrays (deep merge if key exists, else append) ---
    if (diff.tabs) {
        resolved.tabs = mergeByIdentity(
            resolved.tabs ?? [],
            diff.tabs,
            (t: LocalMaterialTabSchema) => t.id,
        );
    }
    if (diff.sections) {
        resolved.sections = mergeByIdentity(
            resolved.sections ?? [],
            diff.sections,
            (s: LocalMaterialSectionSchema) => s.id,
        );
    }
    if (diff.cards) {
        resolved.cards = mergeByIdentity(
            resolved.cards ?? [],
            diff.cards,
            (c: LocalMaterialCardSchema) => c.id,
        );
    }
    if (diff.fields) {
        resolved.fields = mergeByIdentity(
            resolved.fields ?? [],
            diff.fields,
            (f: LocalMaterialFieldSchema) => f.key,
        );
    }

    // Ensure fields is never undefined (it's required on the contract)
    if (!resolved.fields) {
        resolved.fields = [];
    }

    return resolved;
}

/**
 * Merge an array of items with an array of updates.
 * Items in `updates` whose identity key matches an existing item replace it;
 * items with new keys are appended.
 */
function mergeByIdentity<T>(
    existing: T[],
    updates: T[],
    getKey: (item: T) => string,
): T[] {
    const keyed = new Map<string, T>();
    for (const item of existing) {
        keyed.set(getKey(item), item);
    }
    for (const item of updates) {
        const key = getKey(item);
        const existingItem = keyed.get(key);
        if (existingItem) {
            // Deep merge — only specified properties override the inherited item
            keyed.set(key, deepMerge(existingItem, item));
        } else {
            keyed.set(key, item);
        }
    }
    return Array.from(keyed.values());
}

/**
 * Recursively merge `source` properties into `target`.
 * Arrays are replaced, not merged. Plain objects are deep-merged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(target: any, source: any): any {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
        return source;
    }
    const result = { ...target };
    for (const key of Object.keys(source)) {
        const srcVal = source[key];
        const tgtVal = result[key];
        if (
            srcVal !== null && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
            tgtVal !== null && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
        ) {
            result[key] = deepMerge(tgtVal, srcVal);
        } else {
            result[key] = srcVal;
        }
    }
    return result;
}
