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
    navigationView: false,
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

test('simplified render skips every type that does not draw its own simplified form', () => {
    // A type drawn only by its detail renderer kept drawing solid geometry
    // under simplified render by not checking the flag. The seam now decides,
    // so a new type inherits the skip rather than having to remember it.
    const entries = detailRenderersFor({ ...EMPTY_CONTEXT, simpleRender: true });
    for (const descriptor of SUPPORT_TYPES) {
        const entry = entries[descriptor.id];
        assert.ok(entry, `${descriptor.id} resolves an entry`);
        if (entry.drawsSimplified) continue;
        assert.equal(
            entry.skip?.({ entity: { id: 'probe' } as never, isSelected: true, isBatchable: false }),
            true,
            `${descriptor.id} must be skipped under simplified render`,
        );
    }
});

test('an entry keeps its own skip when simplified render is off', () => {
    // The seam only adds its own reason to skip, and only under simplified
    // render, so this pins that a selected support still draws normally.
    const entries = detailRenderersFor(EMPTY_CONTEXT);
    const entity = { id: 'probe' } as never;
    const drawsWhenSelected = SUPPORT_TYPES.filter((descriptor) =>
        entries[descriptor.id]?.skip?.({ entity, isSelected: true, isBatchable: false }) === false);
    assert.ok(drawsWhenSelected.length > 0, 'a selected support still draws when not simplified');
});

test('the navigation view keeps a selected support whole while the rest is lines', () => {
    // Hiding the simple views' solids structurally took this exception with it,
    // so a selected support vanished instead of showing the primitives it was
    // selected to inspect. Every type draws when it is the selection; nothing
    // else in the view does.
    const entity = { id: 'probe' } as never;
    const entries = detailRenderersFor({ ...EMPTY_CONTEXT, simpleRender: true, navigationView: true });
    for (const descriptor of SUPPORT_TYPES) {
        const entry = entries[descriptor.id];
        assert.ok(entry, `${descriptor.id} resolves an entry`);
        assert.equal(
            entry.skip?.({ entity, isSelected: true, isBatchable: false }),
            false,
            `${descriptor.id} must be drawn when it is selected in the navigation view`,
        );
        assert.equal(
            entry.skip?.({ entity, isSelected: false, isBatchable: false }),
            true,
            `${descriptor.id} must stay lines when it is not selected`,
        );
    }
});
