import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
    MODEL_ID_COLLECTION_KEYS,
    SUPPORT_COLLECTION_KEYS,
    SUPPORT_TYPES,
} from '../supportTypeRegistry';

/**
 * The registry is meant to be the ONE place a support type is declared: adding a
 * ninth type should mean adding a descriptor to SUPPORT_TYPES and nothing else.
 *
 * Every walk that hand-writes the collection list instead is a place that type
 * would be silently skipped -- and each has shipped as a bug. `applyZShift`
 * missed sticks; the knot-host resolver missed sticks; SupportModelLinker missed
 * anchors, so deleting a model orphaned them; the render lookup missed anchors,
 * so nothing could resolve which support an anchor segment belonged to.
 *
 * These tests fail when a new hand-written list appears, which is the only way
 * this property survives contact with future edits.
 */

const SRC = path.join(process.cwd(), 'src');

/** Collection names as they appear in SupportState. */
const COLLECTION_NAMES = [...SUPPORT_COLLECTION_KEYS];

/** Files allowed to name collections explicitly, with why. */
const ALLOWED = new Map<string, string>([
    // The registry itself declares them.
    ['supports/supportTypeRegistry.ts', 'declares the types'],
    // Primitives that are not support types still need naming somewhere.
    ['supports/supportCollections.ts', 'documents scope in comments'],
    // The store implements per-type behaviour; the walks it drives are derived,
    // but the individual add/remove/update functions are legitimately per-type.
    ['supports/state.ts', 'per-type store operations'],
    // The import/export payload shape is a wire contract, not a walk.
    ['supports/types.ts', 'payload shape'],
    ['features/scene/voxl/codec.ts', 'disk format'],
    ['features/scene/voxl/types.ts', 'disk format'],
    ['features/export/logic/supportExportReconstruction.ts', 'builds the export payload, a wire shape'],
    // History payloads carry the entities a single undo restores, not a walk.
    ['features/supports/useSupportInteractionManager.ts', 'history action payloads'],
]);

// Other suites create and delete temp files under src/ while this walk runs, so
// a path can vanish between readdir and stat. Skipping those keeps this test from
// failing for reasons that have nothing to do with what it checks.
function walkFiles(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }

    for (const entry of entries) {
        const full = path.join(dir, entry);
        let isDirectory: boolean;
        try {
            isDirectory = statSync(full).isDirectory();
        } catch {
            continue;
        }

        if (isDirectory) {
            if (entry === '__tests__' || entry === 'node_modules') continue;
            walkFiles(full, out);
            continue;
        }
        if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
}

/** Reads a file, or null when it vanished mid-walk (see walkFiles). */
function readSourceOrSkip(file: string): string | null {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

test('every declared support type has a distinct collection key', () => {
    const keys = SUPPORT_TYPES.map((d) => d.location.key);
    assert.equal(new Set(keys).size, keys.length, 'two types share a collection');
});

test('the modelId walk covers every declared type', () => {
    for (const descriptor of SUPPORT_TYPES) {
        if (!descriptor.carriesModelId) continue;
        assert.ok(
            MODEL_ID_COLLECTION_KEYS.includes(descriptor.location.key),
            `${descriptor.id} carries a modelId but is not in MODEL_ID_COLLECTION_KEYS`,
        );
    }
});

test('no new hand-written Pick<SupportState, ...> collection lists', () => {
    // A Pick naming five or more collections is a walk that should be derived.
    // Any Pick<...> whose key union names collections, not just Pick<SupportState>:
    // a hand-written list is a hand-written list whatever it narrows.
    const pickPattern = /Pick<[\s\S]*?,\s*((?:'[a-zA-Z]+'\s*\|\s*)+'[a-zA-Z]+')\s*>/g;
    const offenders: string[] = [];

    for (const file of walkFiles(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        if (ALLOWED.has(rel)) continue;

        const source = readSourceOrSkip(file);
        if (source === null) continue;
        for (const match of source.matchAll(pickPattern)) {
            const named = match[1];
            if (!named) continue;
            const count = COLLECTION_NAMES.filter((key) => named.includes(`'${key}'`)).length;
            if (count >= 5) offenders.push(`${rel}: Pick<SupportState, ${named.trim()}>`);
        }
    }

    assert.deepEqual(
        offenders,
        [],
        'Derive these from SUPPORT_COLLECTION_KEYS instead of listing collections:\n  '
        + offenders.join('\n  '),
    );
});

test('no new hand-written object literals over every collection', () => {
    // Five or more `collection: {}` / `collection: state.collection` entries in one
    // literal is a collection walk spelled out by hand. The threshold is five, not
    // three: a history payload or the three-key kickstand view legitimately names a
    // few collections without being a walk over all of them.
    const offenders: string[] = [];

    for (const file of walkFiles(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        if (ALLOWED.has(rel)) continue;

        const source = readSourceOrSkip(file);
        if (source === null) continue;
        const lines = source.split('\n');
        let run = 0;
        let runStart = 0;
        for (let i = 0; i < lines.length; i++) {
            const isCollectionEntry = COLLECTION_NAMES.some((key) =>
                new RegExp(`^\\s*${key}\\s*:\\s*(\\{\\s*\\}|[A-Za-z_$][\\w$.]*\\.${key})\\s*,?\\s*$`).test(lines[i]));
            if (isCollectionEntry) {
                if (run === 0) runStart = i + 1;
                run++;
                continue;
            }
            if (run >= 5) offenders.push(`${rel}:${runStart} (${run} collections listed)`);
            run = 0;
        }
        if (run >= 5) offenders.push(`${rel}:${runStart} (${run} collections listed)`);
    }

    assert.deepEqual(
        offenders,
        [],
        'Build these with createEmptySupportCollections() or a SUPPORT_COLLECTION_KEYS loop:\n  '
        + offenders.join('\n  '),
    );
});
