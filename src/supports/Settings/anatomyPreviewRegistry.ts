import type { ComponentType } from 'react';

import type { SidebarPanel } from './sidebarPanels';

/**
 * Which component draws a sidebar panel's anatomy preview, registered from
 * wherever that preview lives. A panel registering none falls through to
 * `TrunkPreview`.
 */
export interface AnatomyPreviewProps {
    settings: unknown;
    liveConfig: unknown;
    previewState: unknown;
    /** The panel being previewed, so one component could serve several. */
    activePanel: SidebarPanel;
    anatomyOverrides: unknown;
    raftSettings: unknown;
}

type AnatomyPreview = ComponentType<AnatomyPreviewProps>;

const ANATOMY_PREVIEWS = new Map<SidebarPanel, AnatomyPreview>();

/** Registers a panel's own anatomy preview, at module load. */
export function registerAnatomyPreview(panel: SidebarPanel, preview: AnatomyPreview): void {
    ANATOMY_PREVIEWS.set(panel, preview);
}

/** The preview registered for `panel`, or null to use the generic fallback. */
export function anatomyPreviewFor(panel: SidebarPanel): AnatomyPreview | null {
    return ANATOMY_PREVIEWS.get(panel) ?? null;
}

/** Whether `panel` draws its own preview rather than falling through. */
export function hasOwnAnatomyPreview(panel: SidebarPanel): boolean {
    return ANATOMY_PREVIEWS.has(panel);
}
