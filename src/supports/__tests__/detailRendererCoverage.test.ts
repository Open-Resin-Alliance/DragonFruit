import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import '../detailRenderer/registerBuiltinDetailRenderers';
import { detailRenderersFor, detailRenderersMissingTypes, type DetailRendererContext } from '../detailRenderer/seam';
import { SUPPORT_TYPES } from '../supportTypeRegistry';

/**
 * Every declared type registers a detail renderer.
 *
 * Each renderer lives in its type's own folder and registers into the seam. A
 * type that reaches the registry without registering would draw nothing, so the
 * load-time completeness check asserts the missing list is empty and a resolved
 * table has a component for every type.
 */

const EMPTY_CONTEXT: DetailRendererContext = {
    roots: {},
    renderKnotsById: {},
    braceRenderKnotsById: {},
    simpleRender: false,
    hideUnselectedKnots: false,
    hidePlateContactPrimitivesEffective: false,
    ghostedBraceIdSet: new Set(),
    ghostOpacityClamped: 1,
    suppressHover: false,
    isInteractable: false,
    debugSectionColorsEnabled: false,
    braceShaftsBySupport: new Map(),
};

test('every support type registers a detail renderer', () => {
    assert.deepEqual(detailRenderersMissingTypes(), []);
});

test('every type resolves to an entry that names a component', () => {
    const entries = detailRenderersFor(EMPTY_CONTEXT);
    for (const descriptor of SUPPORT_TYPES) {
        const entry = entries[descriptor.id];
        assert.ok(entry, `${descriptor.id} has no detail renderer entry`);
        assert.ok(entry.component, `${descriptor.id} names no component`);
    }
});

const SOURCE = readFileSync(new URL('../SupportRenderer.tsx', import.meta.url), 'utf8');

test('the entity prop is derived from the registry, not spelled per type', () => {
    assert.match(
        SOURCE,
        /const entityProp = getSupportTypeDescriptor\(typeId\)\.singular;/,
        'renderDetailFor must derive the entity prop from the registry',
    );
});
