export const OPEN_PROFILE_SETTINGS_MODAL_EVENT = 'dragonfruit:open-profile-settings-modal';

export type ProfileSettingsTab = 'printer' | 'material';

export function openProfileSettingsModal(tab: ProfileSettingsTab): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ tab: ProfileSettingsTab }>(OPEN_PROFILE_SETTINGS_MODAL_EVENT, {
    detail: { tab },
  }));
}
