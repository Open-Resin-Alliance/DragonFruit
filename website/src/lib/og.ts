import { createHash } from 'node:crypto';

/**
 * Social cards are 1200x630, the size every crawler assumes when the image is
 * declared as a large summary. `src/og/` renders them at build time.
 */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/**
 * Where a page's card lives: `/blog/foo/` is `/og/blog/foo.png`, the root is
 * `/og/home.png`.
 *
 * The build writes the file at the same rule, from the same paths, so the markup
 * and the artifact cannot drift apart - if they did, the card would simply 404 and
 * nothing would say so. The verification steps in the README check that they do not.
 */
export function ogImagePath(pathname: string): string {
  const slug = pathname.replace(/^\/+|\/+$/g, '');
  return `/og/${slug === '' ? 'home' : slug}.png`;
}

/**
 * A digest of everything a card is made of, for the `?v=` on its URL.
 *
 * Crawlers cache an image by its address, so a card whose text changes keeps its old
 * preview until that cache expires. Facebook wants a new URL for a new image and also
 * wants the old one left in place; a digest in the query satisfies both, because the
 * path a share already points at keeps resolving while the URL a crawler is asked for
 * is one it has never seen.
 *
 * The digest is taken over what the card is made of rather than over the build, so it
 * moves only when the card does: a statistics refresh that changes nothing visible does
 * not hand every crawler 32 new URLs to fetch. It is short because it is a cache key,
 * not a security boundary.
 */
export function cardFingerprint(card: {
  pathname: string;
  title: string;
  summary: string;
  meta?: string;
}): string {
  const material = [card.pathname, card.title, card.summary, card.meta ?? ''].join('\u0000');
  return createHash('sha256').update(material).digest('hex').slice(0, 8);
}

/**
 * The first thing a description says.
 *
 * A search result will take the whole sentence, but a card and a link preview show
 * their text at a glance, and two lines of prose there reads as a wall. Long
 * descriptions are therefore cut at the first boundary that leaves a usable line -
 * very often the colon a specification or a project introduces itself with - and
 * only fall back to cutting on a word and an ellipsis when there is no boundary to
 * use. A description that already fits is left exactly as written.
 *
 * Shared by the card and by the `og:`/`twitter:` description, so the two say the
 * same thing, and neither says as much as the page's own meta description.
 */
export function shortSummary(text: string, limit = 96): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;

  /* A boundary is only worth taking if it leaves a line worth reading. */
  const floor = 32;

  for (const [separator, keep] of [
    ['. ', '.'],
    [': ', ''],
    [' \u2014 ', ''],
    ['; ', ''],
    [', ', ''],
  ] as const) {
    let longest = '';
    for (let at = flat.indexOf(separator); at !== -1; at = flat.indexOf(separator, at + 1)) {
      const cut = flat.slice(0, at) + keep;
      if (cut.length >= floor && cut.length <= limit && cut.length > longest.length) longest = cut;
    }
    if (longest) return longest;
  }

  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.]$/, '')}…`;
}
