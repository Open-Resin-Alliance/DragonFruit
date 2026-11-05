/**
 * The developer build is whatever `latest-dev.json` says it is, and that file is
 * published at the site root by the deploy workflow.
 *
 * The page bakes a snapshot of it at build time - but the deploy that builds the
 * page runs *before* the same deploy copies the new feed into the artifact, so
 * the snapshot is the feed from the previous deploy: one dev release behind
 * whenever a release is what triggered the build. Refreshing it from the same
 * origin costs one request, has no CORS, no rate limit and no token, and leaves
 * the built row alone when it fails.
 */
import { devFeedTargets, formatDate, releaseUrlFor, sourcesUrlFor, PLATFORM_KEYS, type UpdaterFeed } from './releases';
import { applyDownload } from './build-downloads';

const FEED_PATH = '/latest-dev.json';

function fill(row: HTMLElement, feed: UpdaterFeed): void {
  const version = feed.version as string;
  const releaseUrl = releaseUrlFor(version);

  const tag = row.querySelector<HTMLAnchorElement>('[data-developer-tag]');
  const date = row.querySelector<HTMLElement>('[data-developer-date]');
  const download = row.querySelector<HTMLAnchorElement>('[data-download]');
  const sources = row.querySelector<HTMLAnchorElement>('[data-sources]');
  if (!tag || !date || !download || !sources) return;

  tag.textContent = `v${version}`;
  tag.href = releaseUrl;
  date.textContent = formatDate(feed.pub_date);

  for (const platform of PLATFORM_KEYS) download.removeAttribute(`data-download-${platform}`);
  for (const target of devFeedTargets(feed)) {
    if (target.platform) download.setAttribute(`data-download-${target.platform}`, target.url);
  }
  download.href = releaseUrl;
  download.textContent = 'Download';
  download.removeAttribute('title');

  sources.href = sourcesUrlFor(`v${version}`);

  applyDownload(row);
}

export function initDeveloperFeed(): void {
  const row = document.querySelector<HTMLElement>('[data-developer]');
  if (!row) return;

  const notice = document.querySelector<HTMLElement>('[data-developer-notice]');
  const empty = document.querySelector<HTMLElement>('[data-developer-empty]');

  fetch(FEED_PATH, { cache: 'no-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`${FEED_PATH} answered ${response.status}`);
      return response.json() as Promise<UpdaterFeed>;
    })
    .then((feed) => {
      const hasVersion = typeof feed?.version === 'string' && feed.version !== '';
      if (hasVersion) fill(row, feed);

      row.hidden = !hasVersion;
      if (notice) notice.hidden = true;
      if (empty) empty.hidden = hasVersion;
    })
    .catch(() => {
      /* The built row stands: it is a snapshot of the same feed. */
    });
}
