import assert from 'node:assert/strict';
import test from 'node:test';

import '../state';
import '../detailRenderer/registerBuiltinDetailRenderers';
import { detailRenderersFor } from '../detailRenderer/seam';
import { SUPPORT_TYPES } from '../supportTypeRegistry';
import { supportIsDrawnSelected, typeHasBatchedMarqueeOverlay } from '../SupportRenderer';

/**
 * A support marked selected by any route is drawn as selected.
 *
 * `supportIsDrawnSelected` decides this alone, because a detail renderer dims
 * anything it does not consider selected, overwriting the colour it was handed.
 */

test('a bulk-selected support is drawn as selected', () => {
    // Past MULTI_SELECTION_DETAIL_THRESHOLD the per-type sets are empty by
    // design, so the set cannot be what says a support is selected.
    assert.equal(
        supportIsDrawnSelected({ inSelectedSet: false, bulkSelected: true, marqueePreview: false }),
        true,
    );
});

test('a support marked by no route is not drawn as selected', () => {
    assert.equal(
        supportIsDrawnSelected({ inSelectedSet: false, bulkSelected: false, marqueePreview: false }),
        false,
        'an unmarked support must stay dimmable',
    );
});

test('each route on its own is enough to be drawn as selected', () => {
    // The three routes are independent: a small selection, a bulk selection, and
    // a live drag. Any one of them marks the support selected.
    for (const route of ['inSelectedSet', 'bulkSelected', 'marqueePreview'] as const) {
        const input = { inSelectedSet: false, bulkSelected: false, marqueePreview: false, [route]: true };
        assert.equal(
            supportIsDrawnSelected(input),
            true,
            `${route} alone should mark the support selected`,
        );
    }
});

/**
 * Every type can show that a marquee drag has caught it, by one of two routes:
 * the batched instanced overlay (whatever the batched passes carry), or its own
 * detail renderer. A type with neither is caught and selected while showing
 * nothing.
 *
 * The overlay route is per view: a simple view has no detail renderers left, so
 * a type the passes carry only there has to take it.
 */

const EMPTY_CONTEXT = {
    roots: {},
    renderKnotsById: {},
    braceRenderKnotsById: {},
    simpleRender: false,
    navigationView: false,
    hideUnselectedKnots: false,
    hidePlateContactPrimitivesEffective: false,
    ghostedBraceIdSet: new Set<string>(),
    ghostOpacityClamped: 1,
    suppressHover: false,
    isInteractable: false,
    debugSectionColorsEnabled: false,
    braceShaftsBySupport: new Map(),
} as never;

test('every type is previewed by a batched overlay or by its own detail renderer', () => {
    const entries = detailRenderersFor(EMPTY_CONTEXT);

    for (const descriptor of SUPPORT_TYPES) {
        const hasOverlay = typeHasBatchedMarqueeOverlay(descriptor.id, false);
        const hasDetailRenderer = Boolean(entries[descriptor.id]);

        assert.ok(
            hasOverlay || hasDetailRenderer,
            `${descriptor.id} has no batched overlay and no detail renderer, `
            + 'so nothing would show that a marquee drag caught it',
        );
    }
});

test('the types with no batched overlay are exactly the ones the detail route serves', () => {
    // Pins the measured partition, so a type that LOSES its batching flags is
    // noticed: it moves into this list and starts relying on the detail route.
    const withoutOverlay = SUPPORT_TYPES
        .filter((descriptor) => !typeHasBatchedMarqueeOverlay(descriptor.id, false))
        .map((descriptor) => descriptor.id)
        .sort();

    assert.deepEqual(
        withoutOverlay,
        ['brace', 'stump'],
        'the set of types relying on the detail route changed',
    );
});

test('a simple view moves a type the passes carry there onto the overlay route', () => {
    // The stump draws through no batched pass in the full view, where its own
    // renderer is what the marquee colours. A simple view skips that renderer,
    // and carries the stump through the cone and root passes, so the overlay is
    // the only route left to it.
    assert.equal(typeHasBatchedMarqueeOverlay('stump', false), false);
    assert.equal(typeHasBatchedMarqueeOverlay('stump', true), true);
    assert.equal(typeHasBatchedMarqueeOverlay('brace', true), false, 'brace keeps its own curve batch');
});
