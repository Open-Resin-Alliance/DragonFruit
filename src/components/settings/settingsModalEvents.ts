export const OPEN_SETTINGS_MODAL_EVENT = 'dragonfruit:open-settings-modal';

export function openSettingsModal(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_MODAL_EVENT));
}
