import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

test('every type folder provides the registration the generator looks for', () => {
    // The generator finds each type's registrations by this file name; a type
    // with no such file fills no seam.
    for (const descriptor of SUPPORT_TYPES) {
        const name = folderFor(descriptor.id);
        const registration = `${name[0].toLowerCase()}${name.slice(1)}Registration.ts`;
        const files = readdirSync(path.join(TYPES_DIR, name));
        assert.ok(
            files.includes(registration),
            `${descriptor.id} has no SupportTypes/${name}/${registration}`
            + ' — its per-type registrations would never load',
        );
    }
});

test('every type renderer takes its entity under the name the renderer feeds it', () => {
    // The renderer is handed its entity under a computed key, so TypeScript
    // cannot check the component destructures the same name.
    for (const descriptor of SUPPORT_TYPES) {
        const name = folderFor(descriptor.id);
        const renderer = path.join(TYPES_DIR, name, `${name}Renderer.tsx`);
        if (!existsSync(renderer)) continue;
        const source = readFileSync(renderer, 'utf8');
        // An interface field, a destructured binding, or an aliased one: the
        // prop must arrive under the descriptor's name.
        const destructured = new RegExp(`^\\s*${descriptor.singular}\\s*[:,]`, 'm');
        assert.ok(
            destructured.test(source),
            `${descriptor.id}: ${name}Renderer.tsx does not take its entity as \`${descriptor.singular}\`, `
            + 'which is the prop name the renderer passes it under',
        );
    }
});
