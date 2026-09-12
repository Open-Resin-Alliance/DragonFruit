import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseVoxlBinaryV2 } from '@/features/scene/voxl/codec-v2';
import { loadFromImportFormat, getSnapshot, resetStore } from '@/supports/state';
import { SUPPORT_TYPES } from '@/supports/supportTypeRegistry';
import type { DragonfruitImportFormat, SupportState } from '@/supports/types';

/**
 * Real scenes to run export against.
 *
 * `lysdiag/` sits outside the repo and is not committed, so every test using
 * these must skip when a file is absent and the suite still passes without it.
 *
 * Real files rather than generated ones because they carry arrangements a
 * hand-built fixture does not: hundreds of braces, knots on knots, and the
 * type spread an actual print needs.
 */

const FIXTURE_DIR = join(process.cwd(), '..', 'lysdiag');

/**
 * The scenes the export goldens run against.
 *
 * Two, because one is not enough: `lance` is the wider scene but has no anchors
 * and no kickstands, which are the two types hand-written per-type blocks most
 * often omit. `criosphinx` carries both.
 */
export const VOXL_FIXTURES = {
    lance: 'Lance, head, small shields (1)_DF_Scene.voxl',
    criosphinx: 'CriosphinxHead_DF_Scene22.voxl',
} as const;

export type VoxlFixtureName = keyof typeof VOXL_FIXTURES;

export const voxlFixturePath = (name: VoxlFixtureName) => join(FIXTURE_DIR, VOXL_FIXTURES[name]);

/** Whether one local-only fixture is present on this machine. */
export function hasVoxlFixture(name: VoxlFixtureName): boolean {
    return existsSync(voxlFixturePath(name));
}

/** The fixture names present here, so a partial checkout still runs what it can. */
export function availableVoxlFixtures(): VoxlFixtureName[] {
    return (Object.keys(VOXL_FIXTURES) as VoxlFixtureName[]).filter(hasVoxlFixture);
}

/** The support payload a fixture carries, straight out of its SUPP chunk. */
export function readVoxlSupportPayload(name: VoxlFixtureName): DragonfruitImportFormat {
    const bytes = new Uint8Array(readFileSync(voxlFixturePath(name)));
    const parsed = parseVoxlBinaryV2(bytes);
    return parsed.document.supports as DragonfruitImportFormat;
}

/** A fixture loaded into the real store, as opening the file would leave it. */
export function loadVoxlFixtureIntoStore(name: VoxlFixtureName): SupportState {
    resetStore();
    loadFromImportFormat(readVoxlSupportPayload(name));
    return getSnapshot();
}

/** How many of each collection the loaded fixture holds. */
export function describeFixture(state: SupportState): Record<string, number> {
    const counts: Record<string, number> = {
        roots: Object.keys(state.roots).length,
        knots: Object.keys(state.knots).length,
    };
    for (const descriptor of SUPPORT_TYPES) {
        counts[descriptor.location.key] = Object.keys(state[descriptor.location.key] ?? {}).length;
    }
    return counts;
}

/** Every model id the fixture's supports belong to. */
export function fixtureModelIds(state: SupportState): string[] {
    const ids = new Set<string>();
    for (const descriptor of SUPPORT_TYPES) {
        const collection = state[descriptor.location.key] as unknown as Record<string, { modelId?: string }>;
        for (const entity of Object.values(collection ?? {})) {
            if (entity.modelId) ids.add(entity.modelId);
        }
    }
    return Array.from(ids).sort();
}
