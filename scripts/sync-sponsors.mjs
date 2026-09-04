#!/usr/bin/env node
/**
 * Syncs sponsors.json with live Open Collective backer data.
 *
 * - Fetches both:
 *   - https://opencollective.com/openresinalliance/members/all.json
 *   - https://opencollective.com/dragonfruit-slicer/members/all.json
 *   (the latter is the project behind https://opencollective.com/openresinalliance/projects/dragonfruit-slicer)
 * - Filters to BACKER role only (sponsors), merges, dedupes, and sorts
 * - Project pages: https://opencollective.com/openresinalliance and
 *   https://opencollective.com/openresinalliance/projects/dragonfruit-slicer
 * - Skips on fetch failure (offline / rate-limited) so it never blocks releases
 *
 * Usage: node scripts/sync-sponsors.mjs
 *   or:  npm run sync:sponsors
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPONSORS_PATH = resolve(__dirname, '..', 'src', 'components', 'settings', 'sponsors.json');
const MEMBERS_URLS = [
  'https://opencollective.com/openresinalliance/members/all.json',
  'https://opencollective.com/dragonfruit-slicer/members/all.json',
];

function mapMember(entry) {
  if (entry.role !== 'BACKER') return null;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!name) return null;
  return {
    name,
    profile: typeof entry.profile === 'string' ? entry.profile : null,
    image: typeof entry.image === 'string' ? entry.image : null,
    website: typeof entry.website === 'string' ? entry.website : null,
    role: typeof entry.role === 'string' ? entry.role : undefined,
    tier: typeof entry.tier === 'string' ? entry.tier : null,
    totalAmountDonated: typeof entry.totalAmountDonated === 'number' ? entry.totalAmountDonated : undefined,
  };
}

async function fetchMembers(url) {
  console.log(`[sync:sponsors] Fetching ${url} ...`);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`[sync:sponsors] HTTP ${res.status} for ${url} — skipping.`);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      console.warn(`[sync:sponsors] Unexpected payload shape for ${url} — skipping.`);
      return null;
    }
    return data.map(mapMember).filter(Boolean);
  } catch (err) {
    console.warn(`[sync:sponsors] fetch failed for ${url} (offline?): ${err.message} — skipping.`);
    return null;
  }
}

async function main() {
  const results = await Promise.all(MEMBERS_URLS.map(fetchMembers));
  const successful = results.filter((x) => x !== null);
  if (successful.length === 0) {
    console.warn('[sync:sponsors] All fetches failed — leaving sponsors.json untouched.');
    return;
  }
  const sponsors = successful.flat();
  // Dedupe by profile or name
  const seen = new Set();
  const deduped = sponsors.filter((s) => {
    const key = (s.profile ?? s.name).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Sort by total donated desc, then name
  deduped.sort((a, b) => {
    const da = a.totalAmountDonated ?? 0;
    const db = b.totalAmountDonated ?? 0;
    if (db !== da) return db - da;
    return a.name.localeCompare(b.name);
  });

  writeFileSync(SPONSORS_PATH, JSON.stringify(deduped, null, 2) + '\n', 'utf8');
  console.log(`[sync:sponsors] Wrote ${deduped.length} sponsor(s) to src/components/settings/sponsors.json`);
}

main().catch((err) => {
  console.warn('[sync:sponsors] Unexpected error — leaving file untouched:', err);
});
