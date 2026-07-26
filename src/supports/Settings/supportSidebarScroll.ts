import type { SupportKind } from './supportKindState';

type ScrollViewport = {
    scrollTo(options?: ScrollToOptions): void;
};

export function resetSupportSettingsScrollForTabChange(
    viewport: ScrollViewport | null,
    currentTab: SupportKind,
    nextTab: SupportKind,
): boolean {
    if (!viewport || currentTab === nextTab) return false;

    viewport.scrollTo({ top: 0 });
    return true;
}
