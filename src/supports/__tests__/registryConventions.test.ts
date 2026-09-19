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

test('a resolver takes the type id first, or an entity that names its own type', () => {
    // Two legal forms. `f(typeId, entity, ...)` where the caller has no entity
    // yet, and `f(entity, ...)` where the entity carries its own `typeId` --
    // which is what makes a type rename reach the resolver.
    for (const name of ['resolveKnotDiameter', 'inferSupportSettings', 'updateSupportEntity']) {
        const signatures = [
            ...SOURCE.matchAll(new RegExp(`export function ${name}([^(]*)\\(([^)]*)`, 'g')),
        ];
        assert.ok(signatures.length > 0, `${name} not found`);

        for (const [, generic, params] of signatures) {
            const first = params.split(',')[0].trim();
            // The implementation signature takes a union of both legal forms.
            if (/^typeIdOrEntity\b/.test(first)) continue;

            const explicit = /^typeId:\s*SupportTypeId$/.test(first);
            // The entity form constrains its generic to a carrier of `typeId?`.
            const entityForm = /^entity\b/.test(first) && /typeId\?:/.test(generic);
            assert.ok(
                explicit || entityForm,
                `${name}'s first parameter must be \`typeId: SupportTypeId\` or an entity carrying \`typeId?\``,
            );
        }
    }

    // The explicit form stays available for a caller holding a type with no entity yet.
    assert.match(
        SOURCE,
        /export function updateSupportEntity\(\s*typeId: SupportTypeId,/,
        'updateSupportEntity must keep its explicit (typeId, entity) form',
    );
});

test('every derived list is built from SUPPORT_TYPES, not written out', () => {
    // A hand-written list is a place a ninth type silently joins or skips.
    const derived = [
        'MODEL_ID_COLLECTION_KEYS', 'SHAFTED_COLLECTION_KEYS',
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
