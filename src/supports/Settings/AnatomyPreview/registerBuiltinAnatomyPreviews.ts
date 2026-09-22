import { hasOwnAnatomyPreview } from '../anatomyPreviewRegistry';
import { panelForTab, TOOL_PANEL_TABS } from '../sidebarPanels';

import './PreviewTypes/Raft/RaftPreview';
import './PreviewTypes/Grid/GridPreview';
import './PreviewTypes/Brace/BracePreview';

/**
 * Loads every panel that draws its own anatomy preview, so its registration runs.
 * `TrunkPreview` is absent: it is the fallback, mounted directly.
 */
// Every tab other than the generic one opens a panel that draws itself.
const missing = TOOL_PANEL_TABS
    .map((tab) => panelForTab(tab))
    .filter((panel) => !hasOwnAnatomyPreview(panel));

if (missing.length > 0) {
    throw new Error(
        `anatomy preview panels have no registered preview: ${missing.join(', ')}. `
        + 'Add an import above -- a module nothing imports never registers.',
    );
}

export {};
