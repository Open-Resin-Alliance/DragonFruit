/**
 * Shipped auto-support defaults that an existing install has to follow.
 *
 * **Scope: the auto-support block of a shipped profile, and nothing else.**
 *
 * The `autoSupport` settings block is persisted whole, so every key an install
 * ever wrote carries a *value*, and loading is `{ ...codeDefaults, ...stored }`:
 * a stored value wins forever, so a default changed in code reaches new installs
 * only. `areaPerSupportMm2` moving 8 to 10 left a factory profile pinned at 8,
 * and that difference is indistinguishable from a stale profile.
 *
 * That is what this table fixes, for the one place a *shipped* value lives: the
 * `autoSupport` block of a factory preset. The inference is "a stored key equal
 * to `from` holds a value this app shipped":
 *
 * - A stored key equal to `from` moves to `to`.
 * - Any other value is a design decision and is left alone.
 *
 * **What this table must never reach.** The live `support-settings` block is the
 * user's own configuration, so the same inference is wrong there: a user who
 * deliberately picks a value that happens to equal a retired default is not
 * "untouched", and rewriting it on load silently discards the choice — the value
 * is replaced before the user can save it, so the studio cannot keep the setting
 * at all. The same is true of the studio's own sections (`autoBracing`, tip,
 * shaft, roots, grid): a shipped default moving there is a code change the
 * studio owner has to decide how to land, not something a table may apply to a
 * user's saved block. Presets the user made, or saved their settings into, are
 * theirs for the same reason.
 *
 * It generalizes the rule `presets.ts` already applies by hand for one key
 * family (`migrateLegacyPresetAutoSupport`), so the next auto-support default
 * change needs no new one-off. Adding an entry is deliberate and reviewable: it
 * is the record of an auto-support default having moved, and the test beside this
 * module fails if an entry's `to` drifts from the value the code actually ships.
 *
 * The alternative — freezing a full defaults snapshot per version and diffing —
 * needs no entries, but hides the decision inside a 200-key blob instead of one
 * line per changed key. The table is the smaller thing to review.
 *
 * The preset blob carries the batch it was written at (`supportDefaultsVersion`);
 * a blob without one is version 0, which gets every entry.
 */
import type { AutoSupportSettings } from '../autoSupport/settings';

/**
 * An auto-support leaf whose shipped default changed. `key` is checked against
 * `AutoSupportSettings`, so a renamed key breaks the build rather than silently
 * migrating nothing.
 */
export type AutoSupportDefaultMigration = {
    /** Batch number. A blob written at version N receives every entry above N. */
    version: number;
    /** The leaf in the `autoSupport` block. */
    key: keyof AutoSupportSettings;
    /** The value the app shipped for this leaf before this batch. */
    from: AutoSupportSettings[keyof AutoSupportSettings];
    /** The value it ships now. */
    to: AutoSupportSettings[keyof AutoSupportSettings];
};

/**
 * Every shipped auto-support default change, oldest batch first.
 *
 * Version 1 — the auto-support sizing terms (`leafFanMaxAngleDeg` c2234f2,
 * `areaPerSupportMm2` 893ffea). A factory profile that materialized the old
 * numbers would otherwise keep them while the band-derived sizing around them
 * moved on.
 *
 * A default that a *constraint* already forces needs no entry: `leafFanRadiusMm`
 * moved 5 to 8 with `MIN_LEAF_FAN_RADIUS_MM`, and `normalizeAutoSupportSettings`
 * clamps any stored 5 up to that floor on every load, so an entry here would only
 * describe work the clamp has already done.
 */
export const AUTO_SUPPORT_DEFAULT_MIGRATIONS: readonly AutoSupportDefaultMigration[] = [
    { version: 1, key: 'leafFanMaxAngleDeg', from: 60, to: 45 },
    { version: 1, key: 'areaPerSupportMm2', from: 8, to: 10 },
];

/** The batch a save stamps into the blob it writes. */
export const CURRENT_AUTO_SUPPORT_DEFAULTS_VERSION = AUTO_SUPPORT_DEFAULT_MIGRATIONS.reduce(
    (highest, migration) => Math.max(highest, migration.version),
    0,
);

/** The wire field the persisted preset blob carries the batch under. */
export const SUPPORT_DEFAULTS_VERSION_KEY = 'supportDefaultsVersion';

/**
 * The version a parsed blob was written at. Absent, or not a number, is 0: the
 * blob predates the stamp, so every entry applies.
 */
export function readWrittenDefaultsVersion(blob: unknown): number {
    if (blob !== null && typeof blob === 'object' && SUPPORT_DEFAULTS_VERSION_KEY in blob) {
        const value = (blob as Record<string, unknown>)[SUPPORT_DEFAULTS_VERSION_KEY];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return 0;
}

/**
 * Apply every entry newer than the version the block was written at, to the
 * `autoSupport` block of a shipped profile. A value that is not the old default
 * is left exactly as it is, and the input is never mutated: a migrated block is a
 * copy, so a caller that rejects the result has changed nothing.
 *
 * `options.skip` holds keys the profile *states* rather than inherits — a factory
 * preset that sets its own density, for instance. The inference above ("equals the
 * old default" means "shipped") only holds for a value nobody claims, so a stated
 * key is never migrated.
 */
export function applyAutoSupportDefaultMigrations(
    block: Partial<AutoSupportSettings> | undefined,
    writtenAtVersion: number,
    options: { skip?: ReadonlySet<string> } = {},
): Partial<AutoSupportSettings> | undefined {
    if (block === null || typeof block !== 'object') return block;

    const due = AUTO_SUPPORT_DEFAULT_MIGRATIONS.filter(
        (migration) => migration.version > writtenAtVersion && !options.skip?.has(migration.key),
    );
    if (due.length === 0) return block;

    let migrated = { ...block } as Record<string, unknown>;
    for (const migration of due) {
        if (migrated[migration.key] !== migration.from) continue;
        migrated = { ...migrated, [migration.key]: migration.to };
    }
    return migrated as Partial<AutoSupportSettings>;
}