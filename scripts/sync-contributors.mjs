#!/usr/bin/env node

/**
 * Syncs contributors.json with live GitHub contributor data.
 *
 * - Fetches https://api.github.com/repos/Open-Resin-Alliance/DragonFruit/contributors
 * - Also walks the `dev` branch's commits (the contributors endpoint only reflects
 *   the default branch), so dev-line contributors appear before they're promoted
 * - Merges with existing contributors.json, preserving name / role / tone
 * - New contributors get default tone "secondary", role "Contributor",
 *   and their name defaults to their GitHub profile display name (falling back
 *   to their username when the profile has no name set)
 * - Removes anyone no longer in the GitHub list (bots excluded)
 * - Skips bots (type === "Bot")
 *
 * Runs from the `postversion` npm hook (via `npm run sync:contributors`), so the
 * committed list is refreshed as part of the release procedure — every
 * `npm version X --no-git-tag-version` picks up whoever the API knows, and the
 * update rides the same release commit as the version bump. A GitHub API failure
 * (offline / rate-limited) only warns and leaves the file untouched — it must
 * never block cutting a release.
 *
 * Usage: node scripts/sync-contributors.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRIBUTORS_PATH = resolve(__dirname, '..', 'src', 'components', 'settings', 'contributors.json');
const API_URL = 'https://api.github.com/repos/Open-Resin-Alliance/DragonFruit/contributors?per_page=100';
const DEV_COMMITS_URL = 'https://api.github.com/repos/Open-Resin-Alliance/DragonFruit/commits?sha=dev&per_page=100';

/**
 * Distinct GitHub logins of non-bot commit authors reachable from `dev`.
 *
 * The `contributors` endpoint only reflects the default branch (`main`), so
 * dev-line contributors wouldn't show until their work is promoted. The commits
 * endpoint accepts `sha=dev`, so walk it (paginated, 100/page) and aggregate
 * `author.login`. Fail-soft: if a page errors (rate limit / offline), warn and
 * return what we have — the default-branch list still syncs, and the dev cohort
 * catches up on a later bump.
 */
async function collectDevBranchLogins() {
  const logins = new Set();
  for (let page = 1; page <= 100; page++) {
    let batch;
    try {
      const res = await fetch(`${DEV_COMMITS_URL}&page=${page}`);
      if (!res.ok) {
        console.warn(
          `⚠️  dev-branch walk stopped at page ${page} (GitHub API ${res.status}: ${res.statusText}).`,
        );
        break;
      }
      batch = await res.json();
    } catch (err) {
      console.warn(`⚠️  dev-branch walk stopped at page ${page} (${err.message}).`);
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const commit of batch) {
      const author = commit.author;
      if (author && author.login && author.type !== 'Bot') {
        logins.add(author.login);
      }
    }
    if (batch.length < 100) break;
  }
  return [...logins];
}

/**
 * The GitHub profile display name for `login`, or null when the profile has no
 * name set or the lookup fails. Neither the contributors list nor the commit
 * walk carry it, so new contributors each cost one per-user request; the name
 * is a default the maintainer can still edit afterwards.
 */
async function displayNameFor(login) {
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`);
    if (!res.ok) return null;
    const user = await res.json();
    const name = typeof user.name === 'string' ? user.name.trim() : '';
    return name || null;
  } catch {
    return null;
  }
}

async function main() {
  // 1. Fetch live contributors from GitHub
  console.log('Fetching contributors from GitHub API…');
  let ghContributors;
  try {
    const res = await fetch(API_URL);
    if (!res.ok) {
      console.warn(
        `⚠️  GitHub API returned ${res.status}: ${res.statusText} — leaving contributors.json untouched.`,
      );
      return;
    }
    ghContributors = await res.json();
    if (!Array.isArray(ghContributors)) {
      console.warn('⚠️  Unexpected GitHub API response — leaving contributors.json untouched.');
      return;
    }
  } catch (err) {
    console.warn(
      `⚠️  Could not reach the GitHub API (${err.message}) — leaving contributors.json untouched.`,
    );
    return;
  }

  // 2. Filter bots
  const ghUsers = ghContributors.filter((c) => c.type !== 'Bot');
  const ghUserMap = new Map(ghUsers.map((c) => [c.login, c]));
  console.log(`Found ${ghUsers.length} contributors (${ghContributors.length - ghUsers.length} bots skipped)`);

  // 2b. The contributors endpoint only sees the default branch, so dev-line
  // contributors wouldn't appear until promoted. Union in dev's commit authors so
  // dev releases list their own people too.
  const devLogins = await collectDevBranchLogins();
  if (devLogins.length > 0) {
    console.log(`Found ${devLogins.length} contributors on dev (before promotion).`);
  }

  // 3. Read existing contributors
  let existing = [];
  try {
    existing = JSON.parse(readFileSync(CONTRIBUTORS_PATH, 'utf-8'));
    if (!Array.isArray(existing)) existing = [];
  } catch {
    console.log('No existing contributors.json found, creating new one.');
  }

  const existingMap = new Map(existing.map((c) => [c.affiliation.toLowerCase(), c]));

  // 4. Merge: start from existing, append any new GitHub contributors — from the
  // default branch AND the dev walk — preserving the existing name / role / tone.
  const merged = [...existing];
  const existingLookup = new Set(existing.map((c) => c.affiliation.toLowerCase()));
  const unionLogins = new Set(ghUsers.map((c) => c.login).filter(Boolean));
  for (const login of devLogins) unionLogins.add(login);
  let added = 0;

  for (const login of unionLogins) {
    if (!existingLookup.has(login.toLowerCase())) {
      merged.push({
        name: (await displayNameFor(login)) ?? login,
        affiliation: login,
        role: 'Contributor',
        tone: 'secondary',
      });
      console.log(`   ➕ ${login}`);
      added++;
    }
  }

  // 5. Report
  if (added > 0) {
    console.log(`\nAdded ${added} new contributor${added !== 1 ? 's' : ''}.`);
  } else {
    console.log('No new contributors found.');
  }

  // 6. Write
  writeFileSync(CONTRIBUTORS_PATH, JSON.stringify(merged, null, 2) + '\n');
  console.log(`\n✅ Wrote ${merged.length} contributors to contributors.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
