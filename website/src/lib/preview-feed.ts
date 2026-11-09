/**
 * Branch previews are the one list on this site that cannot honestly be a build
 * artifact: a preview release is deleted and recreated on every push, so a page
 * built an hour ago can name a release, and asset URLs, that no longer exist.
 *
 * The built list stays as the fallback (and as the no-JavaScript page). When this
 * script runs it refreshes the list from the public releases API, with a short
 * cache so a reader refreshing the page does not spend the unauthenticated rate
 * limit. A failed fetch leaves the built snapshot alone.
 */
import {
  RELEASES_API_URL,
  fetchJson,
  recentPreviews,
  sourcesUrlFor,
  toPreviewBuild,
  type PreviewBuild,
  type Release,
} from './releases';
import { applyDownload } from './build-downloads';

const CACHE_KEY = 'dragonfruit-preview-builds-v1';
const CACHE_TTL_MS = 2 * 60 * 1000;

function readCache(): PreviewBuild[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    const cached = JSON.parse(raw) as { at?: unknown; builds?: unknown };
    if (typeof cached.at !== 'number' || Date.now() - cached.at > CACHE_TTL_MS) return null;
    if (!Array.isArray(cached.builds)) return null;
    return cached.builds as PreviewBuild[];
  } catch {
    return null;
  }
}

function render(body: HTMLElement, builds: PreviewBuild[]): void {
  if (builds.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No previews available at this time.';
    body.replaceChildren(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'builds';

  for (const build of builds) {
    const item = document.createElement('li');
    item.className = 'build';

    const tag = document.createElement('a');
    tag.className = 'build__tag mono';
    tag.href = build.url;
    tag.target = '_blank';
    tag.rel = 'noopener noreferrer';
    tag.textContent = build.tag;

    const right = document.createElement('div');
    right.className = 'build__right';

    const date = document.createElement('span');
    date.className = 'build__date';
    date.textContent = build.date;

    const assets = document.createElement('div');
    assets.className = 'build__assets';

    const download = document.createElement('a');
    download.className = 'build__asset';
    download.dataset.download = '';
    download.href = build.url;
    download.textContent = 'Download';
    for (const asset of build.assets) download.setAttribute(`data-download-${asset.platform}`, asset.url);

    const sources = document.createElement('a');
    sources.className = 'build__more';
    sources.href = sourcesUrlFor(build.tag);
    sources.target = '_blank';
    sources.rel = 'noopener noreferrer';
    sources.textContent = 'Show sources';

    assets.append(download, sources);

    right.append(date, assets);
    item.append(tag, right);
    list.append(item);
  }

  body.replaceChildren(list);
  applyDownload(list);
}

export function initPreviewFeed(): void {
  const body = document.querySelector<HTMLElement>('[data-preview-body]');
  if (!body) return;

  /* The notice says the build could not reach the API. Any answer here disproves it. */
  const notice = document.querySelector<HTMLElement>('[data-preview-notice]');

  const cached = readCache();
  if (cached) {
    render(body, cached);
    if (notice) notice.hidden = true;
    return;
  }

  fetchJson<Release[]>(RELEASES_API_URL)
    .then((releases) => {
      const builds = recentPreviews(releases).map(toPreviewBuild);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), builds }));
      } catch {
        /* storage unavailable: the refresh still happened */
      }
      render(body, builds);
      if (notice) notice.hidden = true;
    })
    .catch(() => {
      /* Keep the built snapshot, which is still better than an empty list. */
    });
}
