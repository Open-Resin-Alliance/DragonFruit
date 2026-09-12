import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { SUPPORT_TYPES } from '../supportTypeRegistry';

/**
 * Every declared type has a detail renderer entry.
 *
 * `SupportRenderer` used to hold eight hand-written `renderXList.map(...)`
 * blocks; they are one `detailRenderers` table and one `renderDetailFor` loop
 * now. Nothing mounts the component in tests, so this reads the source: a
 * ninth type that reaches the registry without a table entry would draw
 * nothing, silently, and no other check would notice.
 */

const SOURCE = readFileSync(new URL('../SupportRenderer.tsx', import.meta.url), 'utf8');

/** The table body, so a match cannot come from an unrelated part of the file. */
function detailRendererTable(): string {
    const start = SOURCE.indexOf('const detailRenderers = useMemo(');
    assert.ok(start > 0, 'the detailRenderers table is gone -- this test needs rewriting');
    const end = SOURCE.indexOf('const renderDetailFor', start);
    assert.ok(end > start, 'renderDetailFor no longer follows the table');
    return SOURCE.slice(start, end);
}

test('every support type has an entry in the detail renderer table', () => {
    const table = detailRendererTable();

    for (const descriptor of SUPPORT_TYPES) {
        assert.match(
            table,
            new RegExp(`^\\s{8}${descriptor.id}:\\s*\\{`, 'm'),
            `${descriptor.id} has no detailRenderers entry, so it would render nothing`,
        );
    }
});

test('every type is drawn by the render loop', () => {
    // The table alone is not enough: the JSX has to call for each type, since
    // ordering against the batched-shaft passes is still explicit.
    for (const descriptor of SUPPORT_TYPES) {
        assert.ok(
            SOURCE.includes(`renderDetailFor('${descriptor.id}')`),
            `${descriptor.id} is never passed to renderDetailFor`,
        );
    }
});

test('each entry names a component and the prop it takes its entity under', () => {
    const table = detailRendererTable();

    for (const descriptor of SUPPORT_TYPES) {
        const entry = table.slice(table.indexOf(`\n        ${descriptor.id}: {`));
        const body = entry.slice(0, entry.indexOf('\n        },'));

        assert.match(body, /component:\s*\w+Renderer/, `${descriptor.id} names no component`);
        assert.match(body, /entityProp:\s*'[a-z]+'/, `${descriptor.id} declares no entityProp`);
    }
});

