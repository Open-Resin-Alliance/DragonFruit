export const SITE = {
  /**
   * The name the site calls itself, in the header, in every `<title>` and in the
   * structured data. Google Search only picks a site name when the home page is
   * consistent about it: while the title and headings said "DragonFruit" and the
   * structured data said "DragonFruit Resin Slicer", it fell back to the hostname.
   */
  name: 'DragonFruit Slicer',
  /** The name Google Search should use for the site. Must match `name`. */
  siteName: 'DragonFruit Slicer',
  /** What the project says about itself, in the hero and again in the footer. */
  motto:
    'From the community, for the community. Free to use, open to contribute, and shaped by the people who print with it.',
  description:
    'DragonFruit is an open-source resin slicer and support-authoring environment: a modern ' +
    'workspace for hollowing, island analysis, supports and slicing, built by the Open Resin Alliance.',
  org: 'Open Resin Alliance',
} as const;

export const LINKS = {
  org: 'https://openresin.org',
  github: 'https://github.com/Open-Resin-Alliance/DragonFruit',
  releases: 'https://github.com/Open-Resin-Alliance/DragonFruit/releases',
  issues: 'https://github.com/Open-Resin-Alliance/DragonFruit/issues',
  license: 'https://github.com/Open-Resin-Alliance/DragonFruit/blob/main/LICENSE',
  plugins: 'https://github.com/Open-Resin-Alliance/DragonFruit/tree/main/plugins',
  discord: 'https://discord.com/invite/beFeTaPH6v',
  collective: 'https://opencollective.com/openresinalliance',
  translate: 'https://translate.dragonfruit-slicer.com',
} as const;

/**
 * The documentation is rendered by this Astro site under `/docs/`, so every link
 * to it is written through `docs()` and moves with that one constant.
 */
export const DOCS_BASE = '/docs';

export const docs = (path = '') => `${DOCS_BASE}/${path.replace(/^\/+/, '')}`;

export interface NavItem {
  label: string;
  href: string;
  /** Off this site, so the header opens it in a new tab. */
  external?: boolean;
}

export const NAV: readonly NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Machines', href: '/machines/' },
  { label: 'Documentation', href: docs() },
  { label: 'Translations', href: LINKS.translate, external: true },
];
