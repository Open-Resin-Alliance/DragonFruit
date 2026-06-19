/**
 * Global event for opening the Settings modal to the About/Updates tab.
 * Follows the same pattern as profileModalEvents.ts.
 */

export const OPEN_SETTINGS_ABOUT_EVENT = 'dragonfruit:open-settings-about';

export function dispatchOpenSettingsAbout(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_ABOUT_EVENT));
}
