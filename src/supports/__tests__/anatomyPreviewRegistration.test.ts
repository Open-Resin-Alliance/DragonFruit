import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { hasOwnAnatomyPreview } from '../Settings/anatomyPreviewRegistry';
import {
    panelForTab, SIDEBAR_PANELS, panelDrawsOwnPreview, panelFacts,
    TOOL_PANEL_TABS, DEFAULT_SIDEBAR_PANEL,
} from '../Settings/sidebarPanels';
// Loading the barrel is what runs the registrations.
import '../Settings/AnatomyPreview/registerBuiltinAnatomyPreviews';

/**
 * Every sidebar tab mounts the preview it is supposed to.
 *
 * A preview registers itself from its own module, so a module nothing imports
 * never registers and its panel silently falls through to the generic support
 * diagram. That shipped: the raft, grid and bracing tabs all drew a trunk.
 */

test('every non-generic tab opens a panel that draws its own preview', () => {
    // Derived from the tabs, not listed: a hardcoded {raft, grid, stick} map
    // would reintroduce a type literal for the bracing panel.
    assert.ok(TOOL_PANEL_TABS.length > 0, 'no tool tabs declared');
    for (const tab of TOOL_PANEL_TABS) {
        const panel = panelForTab(tab);
        assert.ok(
            hasOwnAnatomyPreview(panel),
            `the ${tab} tab falls through to the generic preview; `
            + `${panel}'s module is not imported anywhere`,
        );
    }
});

test('the default panel uses the generic preview', () => {
    // The fallback is deliberately not registered; named through the default
    // panel rather than as a type literal.
    assert.equal(hasOwnAnatomyPreview(DEFAULT_SIDEBAR_PANEL), false);
    assert.ok(
        !TOOL_PANEL_TABS.includes(panelFacts(DEFAULT_SIDEBAR_PANEL).tab as never),
        'the default panel must not be one of the tabs that draw themselves',
    );
});

test('panelFacts agrees with the registry for every panel', () => {
    // A tool panel declares no `drawsOwnPreview`, so the fact must come from
    // whether it registered a preview rather than from the object.
    for (const panel of SIDEBAR_PANELS) {
        assert.equal(
            panelDrawsOwnPreview(panel),
            hasOwnAnatomyPreview(panel),
            `${panel} reports a drawsOwnPreview that disagrees with the registry`,
        );
        assert.equal(typeof panelDrawsOwnPreview(panel), 'boolean', `${panel} is not a boolean`);
    }
});

test('the canvas loads the registration barrel', () => {
    // The registrations must run wherever the preview is mounted, not only in
    // this test. Without this import the suite passes and the app does not.
    const source = readFileSync(
        new URL('../Settings/AnatomyPreview/SupportAnatomyPreviewCanvas.tsx', import.meta.url),
        'utf8',
    );
    assert.match(
        source,
        /import '\.\/registerBuiltinAnatomyPreviews'/,
        'the preview canvas no longer loads the registrations',
    );
});
