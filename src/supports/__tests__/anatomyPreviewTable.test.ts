import assert from 'node:assert/strict';
import test from 'node:test';

// Loading the previews is what registers them, exactly as the sidebar's import
// graph does at runtime.
import '../Settings/AnatomyPreview/PreviewTypes/Raft/RaftPreview';
import '../Settings/AnatomyPreview/PreviewTypes/Grid/GridPreview';
import '../Settings/AnatomyPreview/PreviewTypes/Brace/BracePreview';
import { anatomyPreviewFor, hasOwnAnatomyPreview } from '../Settings/anatomyPreviewRegistry';
import { SIDEBAR_PANELS, typePanelFacts } from '../Settings/sidebarPanels';
import { SUPPORT_TYPES } from '../supportTypeRegistry';

/**
 * The anatomy preview registration.
 *
 * A panel draws its own preview when it registered one, so a registration
 * cannot disagree with itself. These hold the properties that follow from it.
 */

test('a panel that registered a preview is reported as drawing its own', () => {
    for (const panel of SIDEBAR_PANELS) {
        assert.equal(
            hasOwnAnatomyPreview(panel),
            anatomyPreviewFor(panel) !== null,
            `${panel}: the flag and the registry must answer the same thing`,
        );
    }
});

test('the panels with their own preview are the ones that registered one', () => {
    // Raft, grid and stick have bespoke previews; everything else falls through
    // to the generic renderer. This is the set the sidebar relies on.
    const own = SIDEBAR_PANELS.filter(hasOwnAnatomyPreview);
    assert.deepEqual(own, ['stick', 'raft', 'grid'], 'the bespoke previews');
});

test('a panel with no preview falls through rather than failing', () => {
    assert.equal(anatomyPreviewFor('trunk'), null, 'trunk uses the generic renderer');
    assert.equal(hasOwnAnatomyPreview('trunk'), false);
});

test('no type is reported as drawing a preview it did not register', () => {
    // `drawsOwnPreview` is derived, so a type cannot claim one in the registry
    // and forget to register the component -- and vice versa.
    for (const descriptor of SUPPORT_TYPES) {
        assert.equal(
            typePanelFacts(descriptor.id).drawsOwnPreview,
            hasOwnAnatomyPreview(descriptor.id),
            `${descriptor.id} disagrees about its own preview`,
        );
    }
});

test('every type answers panel facts, including ones with no panel yet', () => {
    // A type the sidebar does not offer still answers, so offering it later is a
    // UI change rather than a data gap.
    for (const descriptor of SUPPORT_TYPES) {
        const facts = typePanelFacts(descriptor.id);
        assert.ok(facts.settingsGroups, `${descriptor.id} has no settings groups`);
        assert.equal(typeof facts.settingsGroups.tip, 'boolean');
        assert.equal(typeof facts.settingsGroups.shaft, 'boolean');
        assert.equal(typeof facts.settingsGroups.roots, 'boolean');
        assert.ok(facts.tab, `${descriptor.id} has no tab`);
    }
});
