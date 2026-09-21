import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MODEL_ID_COLLECTION_KEYS,
    SUPPORT_COLLECTION_KEYS,
    SUPPORT_TYPES,
} from '../supportTypeRegistry';
import { IMPORT_PAYLOAD_COLLECTION_ORDER } from '../supportCollections';

/**
 * The registry is the one place a support type is declared: a walk that
 * hand-writes the collection list instead silently skips a type added later.
 */

test('every declared support type has a distinct collection key', () => {
    const keys = SUPPORT_TYPES.map((d) => d.location.key);
    assert.equal(new Set(keys).size, keys.length, 'two types share a collection');
});

test('the export payload carries every collection the registry declares', () => {
    // `IMPORT_PAYLOAD_COLLECTION_ORDER` is written out because the payload's key
    // order is part of the wire format (serialised exports are compared
    // byte-for-byte, and hashed). Writing an order out means a new type could be
    // forgotten -- which is exactly how an export asked to omit supports used to
    // keep its stumps. This is what makes the stated order safe.
    const declared = new Set(SUPPORT_COLLECTION_KEYS);
    const listed = new Set(IMPORT_PAYLOAD_COLLECTION_ORDER);

    assert.deepEqual(
        SUPPORT_COLLECTION_KEYS.filter((key) => !listed.has(key)),
        [],
        'these collections are missing from IMPORT_PAYLOAD_COLLECTION_ORDER, so an export would drop them',
    );
    assert.deepEqual(
        IMPORT_PAYLOAD_COLLECTION_ORDER.filter((key) => !declared.has(key)),
        [],
        'IMPORT_PAYLOAD_COLLECTION_ORDER names collections the registry does not declare',
    );
    assert.equal(
        listed.size,
        IMPORT_PAYLOAD_COLLECTION_ORDER.length,
        'IMPORT_PAYLOAD_COLLECTION_ORDER lists a collection twice',
    );
});

test('the modelId walk covers every declared type', () => {
    for (const descriptor of SUPPORT_TYPES) {
        assert.ok(
            MODEL_ID_COLLECTION_KEYS.includes(descriptor.location.key),
            `${descriptor.id} is a support type but is not in MODEL_ID_COLLECTION_KEYS`,
        );
    }
});
