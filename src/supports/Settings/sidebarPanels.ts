import {
    getSupportTypeDescriptor,
    SIDEBAR_PANEL_TYPE_IDS,
    SUPPORT_TYPES,
    type SidebarTab,
    type SupportTypeId,
} from '../supportTypeRegistry';
import { hasOwnAnatomyPreview } from './anatomyPreviewRegistry';

/**
 * The support sidebar's panels: a subset of the settings plus an anatomy
 * preview. Support types and tools (raft, grid, auto) are both panels. A type's
 * facts are derived from the registry; only the tool panels are declared here.
 */

/** Re-exported so a panel consumer has one import site for the sidebar's vocab. */
export type { SidebarTab };

/** Panels that are not support types, so nothing else can answer for them. */
const TOOL_PANELS = {
    raft: {
        tab: 'raft',
        settingsGroups: { tip: false, shaft: false, roots: false },
    },
    grid: {
        tab: 'grid',
        settingsGroups: { tip: false, shaft: false, roots: false },
    },
    auto: {
        tab: 'auto',
        settingsGroups: { tip: false, shaft: false, roots: false },
    },
} as const;

/** The support settings groups a panel can offer fields for. */
export interface PanelSettingsGroups {
    /** The contact tip profile: length and cone angle. */
    tip: boolean;
    /** The shaft diameter. */
    shaft: boolean;
    /** The plate root diameter. */
    roots: boolean;
}

/** Everything the sidebar needs to know about one panel. */
export interface PanelFacts {
    tab: SidebarTab | 'auto';
    settingsGroups: PanelSettingsGroups;
    /** Whether the panel draws its own anatomy preview. Derived: see the registry. */
    drawsOwnPreview: boolean;
}

/**
 * A type's panel facts, answered for every type. `tip` needs cone contacts,
 * `shaft` a directly editable (untapered) shaft, `roots` a plate root; all
 * three are gated on `hasEditableSettings`.
 */
export function typePanelFacts(typeId: SupportTypeId): PanelFacts {
    const d = getSupportTypeDescriptor(typeId);
    return {
        tab: d.sidebarTab,
        settingsGroups: {
            tip: d.hasEditableSettings && d.contactFields.some((field) => field.startsWith('contactCone')),
            shaft: d.hasEditableSettings && d.hasSegments && !d.shaftTaper,
            roots: d.lower.kind === 'plateRoot',
        },
        drawsOwnPreview: hasOwnAnatomyPreview(typeId),
    };
}

/**
 * The types the sidebar offers a panel for, from `offersSidebarPanel`, in the
 * order the sidebar shows them. The order is observable: `panelForTab` opens
 * the first panel declaring a tab.
 */
const TYPE_PANELS: readonly SupportTypeId[] = SIDEBAR_PANEL_TYPE_IDS;

/** Every panel the sidebar offers, in tab order. */
export const SIDEBAR_PANELS: readonly SidebarPanel[] = [
    ...TYPE_PANELS,
    ...(Object.keys(TOOL_PANELS) as ToolPanel[]),
];


export type ToolPanel = keyof typeof TOOL_PANELS;
export type SidebarPanel = SupportTypeId | ToolPanel;

/** Whether `value` names a panel. */
export function isSidebarPanel(value: string): value is SidebarPanel {
    return (SIDEBAR_PANELS as readonly string[]).includes(value);
}

/** The facts for any panel, whichever kind it is. */
export function panelFacts(panel: SidebarPanel): PanelFacts {
    // A tool panel declares only its tab and groups; `drawsOwnPreview` is derived.
    if (panel in TOOL_PANELS) {
        return {
            ...TOOL_PANELS[panel as ToolPanel],
            drawsOwnPreview: hasOwnAnatomyPreview(panel),
        };
    }
    return typePanelFacts(panel as SupportTypeId);
}

/**
 * The tab a panel is edited under. Tool panels answer for themselves; every
 * type answers from its descriptor.
 */
export function tabPanelFor(panel: SidebarPanel): SidebarTab | 'auto' {
    return panelFacts(panel).tab;
}

/** The panel a tab opens: the first that declares it. */
export function panelForTab(tab: SidebarTab): SidebarPanel {
    const panel = SIDEBAR_PANELS.find((candidate) => panelFacts(candidate).tab === tab);
    if (!panel) throw new Error(`no panel declares the "${tab}" tab`);
    return panel;
}

/** Whether the panel offers the given settings group. */
export function panelHas(
    panel: SidebarPanel | null | undefined,
    group: keyof PanelSettingsGroups,
): boolean {
    return !!panel && panelFacts(panel).settingsGroups[group];
}

/** Whether the anatomy preview draws this panel itself, rather than falling through. */
export function panelDrawsOwnPreview(panel: SidebarPanel): boolean {
    return panelFacts(panel).drawsOwnPreview;
}

/** The panel the sidebar returns to when an edit session ends. */
export const DEFAULT_SIDEBAR_PANEL: SidebarPanel = panelForTab('supportInfo');

/** Tabs other than the generic one: each opens a panel drawing its own preview. */
export const TOOL_PANEL_TABS: readonly SidebarTab[] = [
    ...new Set(
        SIDEBAR_PANELS
            .map((panel) => panelFacts(panel).tab)
            .filter((tab): tab is SidebarTab =>
                tab !== 'auto' && tab !== panelFacts(DEFAULT_SIDEBAR_PANEL).tab),
    ),
];

type SidebarPanelState = {
    panel: SidebarPanel;
};

let currentState: SidebarPanelState = {
    panel: DEFAULT_SIDEBAR_PANEL,
};

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
    listeners.forEach((listener) => listener());
}

export function getSidebarPanelState(): SidebarPanelState {
    return currentState;
}

export function getActiveSidebarPanel(): SidebarPanel {
    return currentState.panel;
}

export function subscribeToSidebarPanel(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function setActiveSidebarPanel(panel: SidebarPanel): void {
    if (currentState.panel === panel) return;
    currentState = { panel };
    notify();
}

export function getSidebarPanelSnapshot(): SidebarPanelState {
    return currentState;
}

/** Every type, for a caller that needs to know one could become a panel. */
export const ALL_TYPE_PANEL_FACTS: readonly { id: SupportTypeId; facts: PanelFacts }[] =
    SUPPORT_TYPES.map((descriptor) => ({ id: descriptor.id, facts: typePanelFacts(descriptor.id) }));
