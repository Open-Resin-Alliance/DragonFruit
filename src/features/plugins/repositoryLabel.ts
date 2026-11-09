/**
 * `https://github.com/Open-Resin-Alliance/DragonFruit/tree/dev` reads as
 * `Open-Resin-Alliance/DragonFruit` — the part a person recognises. Anything that
 * is not a GitHub repository path keeps its host and path, minus the scheme.
 */
export function repositoryLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname === 'github.com' && segments.length >= 2) {
      return `${segments[0]}/${segments[1].replace(/\.git$/, '')}`;
    }
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '');
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}
