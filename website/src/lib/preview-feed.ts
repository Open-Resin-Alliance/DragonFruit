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
  toPreviewBuild,
  type PreviewBuild,
  type Release,
} from './releases';

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
    empty.textContent = 'No branch has built a preview in the last two weeks.';
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

    if (build.assets.length === 0) {
      const none = document.createElement('span');
      none.className = 'muted';
      none.textContent = 'No installer attached';
      assets.append(none);
    } else {
      for (const asset of build.assets) {
        const link = document.createElement('a');
        link.className = 'build__asset';
        link.href = asset.url;
        link.textContent = asset.label;
        assets.append(link);
      }
    }

    right.append(date, assets);
    item.append(tag, right);
    list.append(item);
  }

  body.replaceChildren(list);
}

export function initPreviewFeed(): void {
  const body = document.querySelector<HTMLElement>('[data-preview-body]');
  if (!body) return;

  const cached = readCache();
  if (cached) {
    render(body, cached);
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
    })
    .catch(() => {
      /* Keep the built snapshot, which is still better than an empty list. */
    });
}
