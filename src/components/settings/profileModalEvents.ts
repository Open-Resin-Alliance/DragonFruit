export const OPEN_PROFILE_SETTINGS_MODAL_EVENT = 'dragonfruit:open-profile-settings-modal';
export const PROFILE_SETTINGS_MODAL_OPEN_CHANGE_EVENT = 'dragonfruit:profile-settings-modal-open-change';

export function dispatchProfileSettingsModalOpenChange(isOpen: boolean): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ isOpen: boolean }>(PROFILE_SETTINGS_MODAL_OPEN_CHANGE_EVENT, { detail: { isOpen } }));
}

export type ProfileSettingsTab = 'printer' | 'material';

export type OpenProfileSettingsModalOptions = {
  openPrinterLibrary?: boolean;
  openNetworkSettings?: boolean;
};

export function openProfileSettingsModal(tab: ProfileSettingsTab, options?: OpenProfileSettingsModalOptions): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ tab: ProfileSettingsTab; openPrinterLibrary?: boolean; openNetworkSettings?: boolean }>(OPEN_PROFILE_SETTINGS_MODAL_EVENT, {
    detail: {
      tab,
      openPrinterLibrary: options?.openPrinterLibrary === true,
      openNetworkSettings: options?.openNetworkSettings === true,
    },
  }));
}
