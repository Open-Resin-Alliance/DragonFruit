import type { SidebarPanel } from '../Settings/sidebarPanels';
import { getSupportTypeBySelectionCategory } from '../supportTypeRegistry';

type AutoBracingHotkeyContext = {
    active: boolean;
    wasActive: boolean;
    sidebarExpanded: boolean;
    activeSupportKind: SidebarPanel;
    curvePageVisible: boolean;
    modalOpen: boolean;
};

export function shouldRunAutoBracingHotkey({
    active,
    wasActive,
    sidebarExpanded,
    activeSupportKind,
    curvePageVisible,
    modalOpen,
}: AutoBracingHotkeyContext): boolean {
    return active
        && !wasActive
        && sidebarExpanded
        && !!getSupportTypeBySelectionCategory(activeSupportKind)?.hasAutoBracingHotkey
        && !curvePageVisible
        && !modalOpen;
}
