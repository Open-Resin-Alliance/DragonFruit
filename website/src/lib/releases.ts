/**
 * The DragonFruit releases API, as the site reads it.
 *
 * Shared by the build (the previews page lists what GitHub has) and the browser
 * (the download button narrows itself to the visitor's platform), so the two
 * agree on what counts as a build for a platform.
 */

export const OWNER = 'Open-Resin-Alliance';
export const REPO = 'DragonFruit';
export const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;
export const RELEASES_API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=30`;
export const LATEST_API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

/**
 * The updater's own feeds, published at the site root by the deploy workflow from
 * release assets. `latest-dev.json` is what an install on the dev channel updates
 * to, which is the only honest answer to "what is the developer build" - a
 * prerelease list on GitHub cannot tell you that, and picking the newest
 * prerelease gets it wrong (it finds a build the dev channel has moved past).
 */
export const DEV_FEED_URL = 'https://dragonfruit-slicer.com/latest-dev.json';

export interface UpdaterFeed {
  version?: string;
  pub_date?: string;
  platforms?: Record<string, { url?: string; signature?: string }>;
}

/** The feed's target names are Rust target triples; readers want platform names. */
const TARGET_LABELS: Record<string, string> = {
  'windows-x86_64': 'Windows',
  'windows-aarch64': 'Windows on ARM',
  'darwin-universal': 'macOS',
  'darwin-x86_64': 'macOS on Intel',
  'darwin-aarch64': 'macOS on Apple silicon',
  'linux-x86_64': 'Linux',
  'linux-aarch64': 'Linux on ARM',
};

/** One entry per platform the feed offers, named as the reader's platform. */
export function devFeedTargets(feed: UpdaterFeed): { label: string; url: string; file: string }[] {
  return Object.entries(feed.platforms ?? {})
    .filter(([, target]) => typeof target?.url === 'string' && target.url !== '')
    .map(([key, target]) => {
      const url = target.url as string;
      return { label: TARGET_LABELS[key] ?? key, url, file: decodeURIComponent(url.split('/').pop() ?? '') };
    });
}

/** Where everything else for that build lives: its release page. */
export function releaseUrlFor(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

/** Previews are cut per branch, so only the last fortnight is worth offering. */
const PREVIEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type PlatformKey = 'windows' | 'macos' | 'linux';

/** Order is preference: the first pattern that matches an asset wins for that platform. */
export const PLATFORMS: Record<PlatformKey, { label: string; patterns: RegExp[] }> = {
  windows: { label: 'Windows', patterns: [/\.exe$/i, /\.msi$/i] },
  macos: { label: 'macOS', patterns: [/\.dmg$/i, /\.pkg$/i] },
  linux: { label: 'Linux', patterns: [/\.flatpak$/i, /\.AppImage$/i, /\.deb$/i, /\.rpm$/i, /\.tar\.gz$/i] },
};

export const PLATFORM_KEYS = Object.keys(PLATFORMS) as PlatformKey[];

export interface Asset {
  name: string;
  browser_download_url: string;
  download_count?: number;
}

export interface Release {
  tag_name?: string;
  name?: string;
  prerelease?: boolean;
  published_at?: string;
  html_url?: string;
  assets?: Asset[];
}

/** The build for one platform, preferring the first pattern that matches. */
export function pickAsset(assets: Asset[], platform: PlatformKey): Asset | null {
  const { patterns } = PLATFORMS[platform];
  let best: { asset: Asset; rank: number } | null = null;

  for (const asset of assets) {
    const rank = patterns.findIndex((pattern) => pattern.test(asset.name));
    if (rank === -1) continue;
    if (!best || rank < best.rank || (rank === best.rank && (asset.download_count ?? 0) > (best.asset.download_count ?? 0))) {
      best = { asset, rank };
    }
  }

  return best?.asset ?? null;
}

/** A preview release as the builds page paints it. */
export interface PreviewBuild {
  tag: string;
  url: string;
  date: string;
  assets: { label: string; url: string }[];
}

export function toPreviewBuild(release: Release): PreviewBuild {
  return {
    tag: release.tag_name ?? 'build',
    url: release.html_url ?? RELEASES_URL,
    date: formatDate(release.published_at),
    assets: PLATFORM_KEYS.map((key) => {
      const asset = pickAsset(release.assets ?? [], key);
      return asset ? { label: PLATFORMS[key].label, url: asset.browser_download_url } : null;
    }).filter((asset): asset is { label: string; url: string } => asset !== null),
  };
}

/** The branch previews of the last fortnight, newest first. */
export function recentPreviews(releases: Release[]): Release[] {
  const cutoff = Date.now() - PREVIEW_WINDOW_MS;
  return releases
    .filter((release) => release.tag_name?.startsWith('preview_') && Date.parse(release.published_at ?? '') > cutoff)
    .sort((a, b) => Date.parse(b.published_at ?? '') - Date.parse(a.published_at ?? ''))
    .slice(0, 20);
}

export function formatDate(value?: string): string {
  if (!value) return 'date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'date unavailable';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Both callers treat the network as optional: the build falls back to a page that
 * sends the reader to GitHub, and the browser leaves the markup it was served.
 *
 * `token` is for the build only - an unauthenticated request is limited to 60 an
 * hour per IP, and the build is not the only thing on that IP. It is never passed
 * from a page that ships to a browser.
 */
export async function fetchJson<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}
