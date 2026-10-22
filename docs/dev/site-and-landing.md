# The site and the documentation viewer

`dragonfruit-slicer.com` is one Astro build in `website/`, published as one GitHub
Pages artifact: the landing page at the root and the documentation under `/docs/`.
Both are the same project, so one `npm run build` produces the whole site and a
`/docs/` link is a normal link rather than a link between two builds.

This page is for anyone changing the site or the documentation. It says where each
piece lives, how the Markdown becomes pages, and what to run before pushing.

## What is where

| Path | What it is |
|---|---|
| `website/` | The Astro site. Builds to `website/dist/`. |
| `website/src/pages/index.astro` | The landing page. |
| `website/src/pages/builds.astro` | The developer build and branch previews. |
| `website/src/pages/docs/[...slug].astro` | One route for every documentation page. |
| `website/src/pages/docs/search-index.json.ts` | The search index the dialog fetches. |
| `website/src/layouts/DocsLayout.astro` | The viewer: sidebar, breadcrumbs, TOC, pager, search dialog. |
| `website/src/lib/docs.ts` | Reads `docs/`, renders Markdown, rewrites and validates links, builds the index. |
| `website/src/data/docs-nav.json` | The documentation nav — the one list of published pages. |
| `website/src/integrations/docs.mjs` | Serves `docs/assets` in dev and copies it into the build; watches `docs/` for edits. |
| `website/src/styles/docs.css` | The viewer's own styles; the landing page does not load it. |
| `website/src/styles/ora.css` | The design language — tokens, layout shell, buttons, surfaces. |
| `website/src/assets/wordmark.svg` | The wordmark, inlined by `Wordmark.astro` so the part of it drawn in white can follow the theme. |
| `website/public/brand/` | The emblem (`simple_icon.svg`) and the social card. |
| `website/public/media/` | The four screenshots in the landing page grid, re-encoded from the marketing renders. |
| `website/src/og/` | The social cards: a build hook, the renderer, the fonts and the emblem PNG. |
| `website/src/lib/og.ts` | Where a card lives, and the digest its URL carries. |
| `docs/` | The documentation source: one Markdown file per page. |
| `docs/assets/` | Screenshots and diagrams linked from the Markdown beside them. |
| `website/astro.config.mjs` | Site URL, integrations, and the legacy document redirects. |
| `scripts/check-docs-accuracy.mjs` | The docs gate: cited paths and symbols, dead links, nav coverage. |
| `scripts/materialize-doc-placeholder-assets.mjs` | Creates the not-yet-supplied screenshot placeholders. |
| `.github/workflows/docs-pages.yml` | Builds the site, injects the updater feeds, deploys. |

`docs/internal/` is versioned but not published: `docs-nav.json` lists `internal`
under `exclude`, and both the viewer and the accuracy check skip it.

## Building it locally

```bash
cd website
npm install
npm run dev        # http://localhost:4321 — landing page and /docs/
npm run check      # astro check: types and template diagnostics, must be 0 errors
npm run build      # website/dist/
npm run preview    # serves the built artifact, redirects included
```

There is no test suite. `npm run check` plus a real build and a look at the page
is the gate. A layout change wants the page opened at 1600 / 1280 / 1024 / 820 /
480 / 360 px with no horizontal overflow.

The documentation links screenshots that are not committed yet. The loader checks
every image and internal link while it renders, so a missing placeholder fails the
build with the page and the target named. Create the placeholders first when the
repository is fresh:

```bash
node scripts/materialize-doc-placeholder-assets.mjs
(cd website && npm run build)
```

`astro dev` serves the docs assets straight from `docs/assets/`, so editing a
screenshot needs no copy step. `docs/` is watched: saving a Markdown file reloads
the page and re-reads it.

## The viewer

The route is `website/src/pages/docs/[...slug].astro`; `getStaticPaths` asks
`website/src/lib/docs.ts` for every page and prunes `/index` from the URL, so
`docs/getting-started/installation.md` becomes `/docs/getting-started/installation/`
and `docs/reference/support-anatomy/index.md` becomes
`/docs/reference/support-anatomy/`.

Rendering uses Astro's Sätteri processor pieces, not a second Markdown stack:
GFM tables, Shiki-highlighted fences, heading ids and a table scroll wrapper all
come from the same pipeline a normal Astro Markdown page uses. On top of that,
the loader:

- rewrites relative `.md` links to `/docs/…/` and validates that the target exists;
- rewrites relative images to `/docs/assets/…` and validates that the file exists;
- turns MkDocs admonitions (`!!! note "Title"` plus an indented body) into HTML
  blocks with their body still parsed as Markdown;
- adds heading permalinks (`#`) and the `On this page` TOC;
- extracts the title from the first H1 and a description from the first paragraph
  for the page's metadata and its social card.

A page is not reachable by accident. The loader fails the build if a Markdown file
is missing from `docs-nav.json`, or if the nav names a file that is not there. Add
a page by creating the Markdown and a nav entry at the same time; `npm run
check:docs` checks the same invariant.

`docs/assets/` is copied to `/docs/assets/` by the build integration, so a new
image is referenced relatively from the Markdown and needs no second copy under
`website/public`.

### Search

`website/src/pages/docs/search-index.json.ts` renders every page and emits one
JSON entry per page: URL, title, plain text and headings. The dialog in
`DocsLayout.astro` fetches it on first use and scores title, heading and body
matches; the index is a build artifact, not a service. It is around 1 MB raw on
the current docs and compresses well — if it becomes a problem, trim code blocks
from `stripHtml` before reaching for a search service.

### Legacy URLs

The documentation used to live at the site root (`/getting-started/installation/`)
before it moved under `/docs/`. Those URLs are in Discord threads, issue comments
and search results, so `astro.config.mjs` builds a redirect for each page in
`docs-nav.json`: a `<meta http-equiv="refresh">` page with `noindex` and a
canonical link to the new URL. They need no separate script and no post-build step,
and once the old URLs are gone from the wild the `redirects` map can be deleted.

## The design language

`website/src/styles/ora.css` is openresin.org's own stylesheet — the
[`global.css` in `Open-Resin-Alliance/website`](https://github.com/Open-Resin-Alliance/website/blob/main/src/styles/global.css) —
copied: the same type scale, `.shell` layout, glass surfaces and buttons. The
header, footer, theme toggle and back-to-top control are ports of that site's
components with DragonFruit's links in them, and the theme preference is stored
under the same `ora-theme` key so the two sites agree about a visitor's choice.

The two repositories share no package, and a package for two files would be more
machinery than the problem deserves, so the copy is kept in step by hand. When you
change a token or a primitive here, check the other repository; when you change it
there, check here. What is *not* copied is the part of that stylesheet which is
about that site: its rail navigation and its `.prose` block.

The documentation adds `website/src/styles/docs.css` on top of those tokens. It is
where the reading column, sidebar, TOC, admonitions, code blocks and search dialog
are defined; the landing page never loads it.

## Open Graph cards

Every page gets one, generated at build time by `website/src/og/`. A build hook
(`integration.mjs`) walks the pages that were just written, reads the `card:title`,
`card:summary` and `card:meta` metas that `Base.astro` puts in their head, and
renders `/og/<page>.png` with satori and resvg (`render.mjs`). Nothing registers a
page: a page has a card the moment it has a URL. Documentation pages are no
exception and carry `cardMeta="Documentation"`. The URL in the markup comes from
`ogImagePath()` plus a digest of the card's own words (`cardFingerprint()`), so a
crawler fetches a new image when the text changes while the URL a share already
points at keeps resolving.

- The home page's card carries the project tagline (`SITE.motto`) rather than its
  title. That is the `cardSummary` prop in `Base.astro`; a page can override the
  summary and add a corner label (`cardMeta`).
- The background is computed in floating point and dithered by hand (`diffuseBase`),
  because the wash spans about sixteen levels across the card and an 8-bit
  rasteriser would show every step of it. The rule, the type and the emblem are
  drawn over that by satori.
- `src/og/fonts/` holds static TTFs of the two families the site uses: satori reads
  neither woff2 nor a variable font's `fvar` table. `website/src/og/brand/mark.png`
  is the emblem rasterised from `public/brand/simple_icon.svg`; regenerate it at
  256 px with `sharp` if the emblem changes.

## The screenshots

`website/public/media/*.webp` are re-encoded from the marketing renders supplied for
the 0.2.0 release. The grid is read two by two; the captions are not in it — a tile
is the image and nothing else, and its caption is shown under the enlarged image
when it is opened:

| Image | Source | What it is there to show |
|---|---|---|
| `ui.webp` | `general_view.png` | the workspace itself — a clean window with nothing in the way |
| `support-studio.webp` | `supports.png` | Support Studio with island scanning on |
| `multi-plate.webp` | `multi-plate.png` | four plates in one scene |
| `3daa.webp` | `3daa.png` | 3D anti-aliasing (3DAA in the code) — grey levels in the layer mask, which is what removes stair-stepping |

The sources are 2560×1392 PNGs of about a megabyte each; the WebPs are 1600 px wide
at quality 80, which is 169 KB for all four. Re-encode the same way when they
change, and keep the order and the captions in `ScreenshotGrid.astro` in step with
the images: every caption describes what is on screen, so a replaced image means a
rewritten caption. The captions are the dialog's text and nothing else.

## Pages, and what the network is for

The landing project has two pages and one grid:

| Page | Source | Data |
|---|---|---|
| `/` | `website/src/pages/index.astro` | none at build time; `website/src/lib/release-feed.ts` narrows the download button to the visitor's platform in the browser. |
| `/builds/` | `website/src/pages/builds.astro` | two lists, both read **at build time**: the developer build from the updater's own `latest-dev.json` at the site root, and the branch previews from the GitHub releases API. Each section degrades on its own. |
| the screenshot grid, below *What it does* | `website/src/components/ScreenshotGrid.astro` | none — four images, one per view, laid out two by two with none of them paged. A click opens one full size in a `<dialog>`, with its caption and arrows under it: the arrows (and Left/Right) step to the next image without closing, and wrap at either end. That lightbox is the only script on the landing page, and without JavaScript the grid is still a grid. |

The split is deliberate and worth keeping:

- **The developer build comes from the feed, not from GitHub.** `latest-dev.json`
  is what an install on the dev channel updates to, and it is the only source that
  answers "what is the developer build". Asking the releases API for the newest
  prerelease answers a different question and gets it wrong.
- **Anything that has to be right without JavaScript is built, not fetched.** The
  previews list is rendered at build time and degrades to a note plus a link to
  GitHub if the API was unreachable — an empty list would read as "there are no
  builds". `releases.ts` takes an optional token for that build request (the deploy
  workflow passes `GITHUB_TOKEN`); the browser never sees it.
- **The download button is an enhancement.** The built markup already carries a
  working link to the latest release and a line saying where the number came from,
  and every failure path leaves the built page exactly as it is.

### The updater feeds are not part of the build

`latest.json` and `latest-dev.json` — the feeds an installed app polls — are copied
out of release assets into the artifact root by the deploy workflow, which validates
them first (HTTPS, this repository's releases path, a signature per platform) and
keeps the copy already on Pages if no release carries one. They are deliberately
not built by Astro; see [Release Process](releases.md) for the release side of that
loop.
