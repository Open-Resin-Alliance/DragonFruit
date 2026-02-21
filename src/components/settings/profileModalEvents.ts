export const OPEN_PROFILE_SETTINGS_MODAL_EVENT = 'dragonfruit:open-profile-settings-modal';

export type ProfileSettingsTab = 'printer' | 'material';

export type OpenProfileSettingsModalOptions = {
  openPrinterLibrary?: boolean;
};

export function openProfileSettingsModal(tab: ProfileSettingsTab, options?: OpenProfileSettingsModalOptions): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ tab: ProfileSettingsTab; openPrinterLibrary?: boolean }>(OPEN_PROFILE_SETTINGS_MODAL_EVENT, {
    detail: {
      tab,
      openPrinterLibrary: options?.openPrinterLibrary === true,
    },
  }));
}
