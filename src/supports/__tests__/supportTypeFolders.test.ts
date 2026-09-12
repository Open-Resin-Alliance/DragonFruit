import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { SUPPORT_TYPES } from '../supportTypeRegistry';

/**
 * A registered type owns a folder under SupportTypes/, and that folder is the
 * only place outside the registry allowed to name it. A type registered without
 * one has nowhere legitimate to put its renderer, so its per-type code ends up
 * scattered -- the exact failure this refactor exists to remove.
 */

const TYPES_DIR = path.join(process.cwd(), 'src', 'supports', 'SupportTypes');

/** `trunk` -> `Trunk`. The folder convention. */
const folderFor = (id: string) => id[0].toUpperCase() + id.slice(1);

test('every registered type has its own SupportTypes folder', () => {
    for (const descriptor of SUPPORT_TYPES) {
        const dir = path.join(TYPES_DIR, folderFor(descriptor.id));
        assert.ok(existsSync(dir), `${descriptor.id} has no folder at SupportTypes/${folderFor(descriptor.id)}`);
    }
});

test('every type folder belongs to a registered type', () => {
    // `shared` holds cross-type helpers and is not a type.
    const registered = new Set(SUPPORT_TYPES.map((d) => folderFor(d.id)));
    const folders = readdirSync(TYPES_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'shared')
        .map((entry) => entry.name);

    for (const folder of folders) {
        assert.ok(registered.has(folder), `SupportTypes/${folder} has no registered type`);
    }
});

test('every type folder provides a renderer', () => {
    // The renderer slot in §3 dispatches on this, so a missing one is a gap
    // that surfaces as a type silently not drawing.
    for (const descriptor of SUPPORT_TYPES) {
        const name = folderFor(descriptor.id);
        const files = readdirSync(path.join(TYPES_DIR, name));
        assert.ok(
            files.some((f) => f === `${name}Renderer.tsx`),
            `${descriptor.id} has no ${name}Renderer.tsx`,
        );
    }
});
