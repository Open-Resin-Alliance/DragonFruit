/**
 * The one download button a build row carries: a link to the release page in the
 * built markup, pointed at the visitor's platform once the page has one.
 *
 * The rows themselves say which platform each asset belongs to, as
 * `data-download-<platform>` on the anchor, so the same code narrows the home
 * page button, the developer build and every branch preview without knowing how
 * the row was produced.
 */
import { type PlatformKey } from './releases';

/**
 * `navigator.userAgentData.platform` is the modern spelling; TypeScript's DOM
 * library does not know it, and every browser that lacks it has `userAgent`.
 */
export function platformHint(): string {
  const data = (navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } }).userAgentData;
  return data?.platform || '';
}

export function detectPlatform(): PlatformKey | null {
  const source = `${platformHint()} ${navigator.userAgent || ''}`.toLowerCase();
  if (source.includes('win')) return 'windows';
  if (source.includes('mac') || source.includes('darwin')) return 'macos';
  if (source.includes('linux') || source.includes('x11')) return 'linux';
  return null;
}

/**
 * Points every `[data-download]` under `root` at the asset for the visitor's
 * platform. A row with no asset for that platform keeps its release-page href,
 * which is where the other platforms and the sources are.
 */
export function applyDownload(root: ParentNode): void {
  const platform = detectPlatform();
  if (!platform) return;

  for (const link of root.querySelectorAll<HTMLAnchorElement>('[data-download]')) {
    const url = link.getAttribute(`data-download-${platform}`);
    if (!url) continue;

    link.href = url;
    link.title = decodeURIComponent(url.split('/').pop() ?? '');
  }
}
