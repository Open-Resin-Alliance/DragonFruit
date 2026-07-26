import type { SupportKind } from '../Settings/supportKindState';

type AutoBracingHotkeyContext = {
    active: boolean;
    wasActive: boolean;
    sidebarExpanded: boolean;
    activeSupportKind: SupportKind;
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
        && activeSupportKind === 'stick'
        && !curvePageVisible
        && !modalOpen;
}
