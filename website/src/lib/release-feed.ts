/**
 * The download button: a link to the latest release in the built markup, narrowed
 * to the visitor's platform once GitHub answers.
 *
 * It is an enhancement and nothing more. A failed request, a rate limit or a
 * blocked `api.github.com` leaves the built page exactly as it is, which is what
 * makes the page correct with JavaScript disabled.
 */

import { LATEST_API_URL, PLATFORMS, RELEASES_URL, fetchJson, formatDate, pickAsset, type PlatformKey, type Release } from './releases';

const REPO_URL = 'https://github.com/Open-Resin-Alliance/DragonFruit';

/**
 * `navigator.userAgentData.platform` is the modern spelling; TypeScript's DOM
 * library does not know it, and every browser that lacks it has `userAgent`.
 */
function platformHint(): string {
  const data = (navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } }).userAgentData;
  return data?.platform || '';
}

function detectPlatform(): PlatformKey | null {
  const source = `${platformHint()} ${navigator.userAgent || ''}`.toLowerCase();
  if (source.includes('win')) return 'windows';
  if (source.includes('mac') || source.includes('darwin')) return 'macos';
  if (source.includes('linux') || source.includes('x11')) return 'linux';
  return null;
}

function isMobile(): boolean {
  const source = `${platformHint()} ${navigator.userAgent || ''}`.toLowerCase();
  if (/android|iphone|ipad|ipod|mobile/.test(source)) return true;
  // An iPad reports itself as a Mac; a Mac has no touch points.
  return source.includes('mac') && navigator.maxTouchPoints > 1;
}

export function initReleaseFeed(): void {
  const button = document.querySelector<HTMLAnchorElement>('[data-download-primary]');
  const version = document.querySelector<HTMLAnchorElement>('[data-download-version]');
  if (!button || !version) return;

  if (isMobile()) {
    button.href = REPO_URL;
    button.textContent = 'View on GitHub';
    version.href = RELEASES_URL;
    version.textContent = 'Desktop installers for Windows, macOS and Linux.';
    return;
  }

  const platform = detectPlatform();

  fetchJson<Release>(LATEST_API_URL)
    .then((release) => {
      const asset = platform ? pickAsset(release.assets ?? [], platform) : null;
      const tag = release.tag_name || release.name || 'the latest release';

      button.href = asset?.browser_download_url ?? release.html_url ?? RELEASES_URL;
      if (asset && platform) button.textContent = `Download for ${PLATFORMS[platform].label}`;

      version.href = release.html_url ?? RELEASES_URL;
      version.textContent = `${tag} · released ${formatDate(release.published_at)}`;
    })
    .catch(() => {
      /* Nothing to say: the built line already says the link goes to GitHub, and a
         sentence about a failed request in the middle of the hero is worse than
         the version number simply not being there. */
    });
}
