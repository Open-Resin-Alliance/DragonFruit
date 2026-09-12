import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { ANATOMY_PREVIEW_KINDS } from '../Settings/AnatomyPreview/anatomyPreviews';
import { SUPPORT_KINDS, kindDrawsOwnPreview, type SupportKind } from '../Settings/supportKindState';

/**
 * The anatomy canvas mounts a kind's own preview from a table and falls through
 * to `TrunkPreview` otherwise. The table and `drawsOwnPreview` are two
 * statements of one fact: a kind in one and not the other either renders
 * nothing or renders twice.
 */

const CANVAS = readFileSync(
    new URL('../Settings/AnatomyPreview/SupportAnatomyPreviewCanvas.tsx', import.meta.url),
    'utf8',
);

test('the table covers exactly the kinds that draw their own preview', () => {
    const declared = (Object.keys(SUPPORT_KINDS) as SupportKind[]).filter(kindDrawsOwnPreview);

    assert.deepEqual([...ANATOMY_PREVIEW_KINDS].sort(), declared.sort());
});

test('a kind drawing its own preview is not also drawn as a trunk', () => {
    // The fallback is the negation of the table, so overlap would double draw.
    for (const kind of ANATOMY_PREVIEW_KINDS) {
        assert.equal(kindDrawsOwnPreview(kind), true, `${kind} has a preview but would also render as a trunk`);
    }
});

test('the canvas mounts previews from the table, not by name', () => {
    assert.match(CANVAS, /ANATOMY_PREVIEWS\[activeKind\]/, 'the canvas no longer resolves from the table');

    for (const component of ['RaftPreview', 'GridPreview', 'BracePreview']) {
        assert.ok(
            !CANVAS.includes(`<${component}`),
            `${component} is mounted by name again; it should come from the table`,
        );
    }
});

test('TrunkPreview stays the mounted fallback', () => {
    // It is the default for every kind without an entry, so it is not a table
    // entry and must remain mounted directly.
    assert.ok(CANVAS.includes('<TrunkPreview'), 'the trunk fallback is gone');
    assert.match(CANVAS, /!kindDrawsOwnPreview\(activeKind\)/, 'the fallback no longer guards on the flag');
});
