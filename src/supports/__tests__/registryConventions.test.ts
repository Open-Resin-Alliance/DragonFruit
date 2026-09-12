import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as registry from '../supportTypeRegistry';

/**
 * One way to ask each question.
 *
 * The registry exports 14 lists and 17 functions, and several coincide today.
 * Without a convention, each new consumer invents its own accessor and the
 * surface sprawls. These pin the shape rules from AGENTS.md.
 */

const SOURCE = readFileSync(
    path.join(process.cwd(), 'src', 'supports', 'supportTypeRegistry.ts'),
    'utf8',
);

test('every registration slot takes the type id first, named typeId', () => {
    const registrars = [...SOURCE.matchAll(/export function (register\w+)[^(]*\(\s*(\w+):\s*(\w+)/g)];
    assert.ok(registrars.length >= 4, 'expected to find the register* slots');

    for (const [, name, param, type] of registrars) {
        if (type === 'SupportCollectionKey') {
            // Collection-keyed slots exist because roots and knots are not types.
            assert.equal(param, 'key', `${name} should name its collection parameter "key"`);
            continue;
        }
        assert.equal(param, 'typeId', `${name} should name its first parameter "typeId"`);
        assert.equal(type, 'SupportTypeId', `${name} should take a SupportTypeId first`);
    }
});

test('generic resolvers take the type id first, named typeId', () => {
    for (const name of ['resolveKnotDiameter', 'inferSupportSettings', 'updateSupportEntity']) {
        const match = SOURCE.match(new RegExp(`export function ${name}[^(]*\\(\\s*(\\w+):\\s*(\\w+)`));
        assert.ok(match, `${name} not found`);
        assert.equal(match[1], 'typeId', `${name} should name its first parameter "typeId"`);
        assert.equal(match[2], 'SupportTypeId', `${name} should take a SupportTypeId first`);
    }
});

test('every derived list is built from SUPPORT_TYPES, not written out', () => {
    // A hand-written list is a place a ninth type silently joins or skips.
    const derived = [
        'MODEL_ID_COLLECTION_KEYS', 'MODEL_ID_TYPES', 'SHAFTED_COLLECTION_KEYS',
        'SUPPORT_COLLECTION_KEYS', 'SUPPORT_STATE_COLLECTIONS', 'SUPPORT_STATE_TYPES',
        'EDITABLE_SUPPORT_TYPES', 'SUPPORT_GRAPH_NODES',
    ];

    for (const name of derived) {
        const start = SOURCE.indexOf(`export const ${name}`);
        assert.ok(start !== -1, `${name} not found`);
        const body = SOURCE.slice(start, SOURCE.indexOf('\n\n', start));
        assert.match(
            body,
            /SUPPORT_TYPES|SUPPORT_STATE_TYPES|SUPPORT_PRIMITIVE_COLLECTIONS/,
            `${name} does not derive from the registry`,
        );
    }
});

test('the lists that coincide today still answer different questions', () => {
    // Identical contents are data, not duplication -- collapsing them would
    // recreate the subtraction bug in reverse. This documents the overlap so a
    // future divergence is a deliberate change, not a surprise.
    const keys = (value: unknown): string[] =>
        (value as { key?: string; id?: string }[]).map((entry) =>
            typeof entry === 'string' ? entry : entry.key ?? entry.id ?? '?');

    assert.deepEqual(
        [...registry.SUPPORT_COLLECTION_KEYS].sort(),
        keys(registry.SUPPORT_GRAPH_NODES).sort(),
    );
    assert.deepEqual(
        [...registry.MODEL_ID_COLLECTION_KEYS].sort(),
        keys(registry.SUPPORT_STATE_COLLECTIONS).sort(),
    );
});
