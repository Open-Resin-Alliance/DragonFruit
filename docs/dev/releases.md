# Release process

How DragonFruit versions, branches, and ships builds. This is the
source-of-truth for anyone cutting a release or touching
[`.github/workflows/release.yml`](https://github.com/Open-Resin-Alliance/DragonFruit/blob/main/.github/workflows/release.yml)
or [`src-tauri/src/updater_channel.rs`](https://github.com/Open-Resin-Alliance/DragonFruit/blob/main/src-tauri/src/updater_channel.rs).

## The model

We will be using semantic versioning, i.e. vMAJOR.MINOR.PATCH-prerelease.

Two branches, two channels, classic odd/even MINOR convention:

- **`dev`** — the development line. **Odd MINOR** (`0.1.x`, `0.3.x`, `0.5.x`, ...).
  Features land here continuously. Every version bump on `dev` is a real,
  shippable devel release — there's no RC ceremony for it. Bump the version,
  push, done.
- **`main`** — the stable line. **Even MINOR** (`0.2.x`, `0.4.x`, ...). Only
  reachable by promoting a `dev` commit when the odd line is feature-complete.
  Once on `main`, only bugfixes land — no new features.

There is currently no dedicated `release-X.Y` maintenance branch: `main`
*is* the stable maintenance branch. We will revisit this only if DragonFruit
ever needs to support two stable lines concurrently; until then, a separate
branch per stable release would be pure ceremony.

## Versioning: real SemVer, prerelease identifiers included

The channel is **not** a tag prefix anymore. It's encoded directly in the
version string, following [SemVer 2.0](https://semver.org)'s
`MAJOR.MINOR.PATCH-prerelease` grammar — because `tauri-plugin-updater`
parses the updater feed's `version` field as a real `semver::Version` and
compares it with plain `>`, which already implements full SemVer precedence
(including "a prerelease has lower precedence than the same version without
one"). Nothing needs to be taught to compare `1.3.0-rc.1 < 1.3.0` — the
`semver` crate already does that. What has to be correct is what you put in
the version field.

Set the version in **`package.json`, `src-tauri/tauri.conf.json`, and
`src-tauri/Cargo.toml`** together — all three must agree, since Tauri reads
its own version from the bundle config and that's what ends up baked into the
running binary as `current_version`.

Rules:

- Use dot-separated numeric identifiers for RC/beta counters:
  `-rc.1`, `-rc.2`, `-rc.10`, not `-rc1`/`-rc2`/`-rc10`. SemVer compares
  numeric fields numerically, but only if they're their own dot-separated
  field — `"rc1"` is a single alphanumeric identifier and sorts as a string
  (`rc1 < rc10 < rc2`), which silently breaks ordering once you pass RC 9.
- `alpha < beta < rc` is not something SemVer understands semantically — it's
  ASCII lexical order on whatever word you chose. It works here because
  English happens to alphabetize that way. Don't rename these words casually.

## What "prerelease" means on GitHub

GitHub's `prerelease` flag has exactly one practical effect: a non-prerelease,
non-draft release is eligible to be the repo's "Latest release" (and what
`GET /releases/latest` returns). It has no concept of channels. So the flag
is assigned by **"is this the stable/production channel"**, not by "is this a
finished version number".  The release number is stored in one JSON per channel
in the GitHub pages for the project, under the URLs
https://open-resin-alliance.github.io/DragonFruit/latest{,-dev}.json, and these
will be the rules that the release workflows are following:

| Version example | Branch | `is_prerelease` | Updater feed |
|---|---|---|---|
| `0.1.10` | `dev` | `true` | `latest-dev.json` |
| `0.1.11-rc.1` | `dev` | `true` | *none* |
| `0.2.0-rc.1` | `main` | `true` | *none* — downloadable, not auto-installed |
| `0.2.0-rc.2` | `main` | `true` | *none* |
| `0.2.0` | `main` | `false` | `latest.json` |
| `0.2.1` | `main` | `false` | `latest.json` |
| `0.3.0` | `dev` | `true` | `latest-dev.json` |

A dev-line build is *never* eligible to be "Latest release" and never touches
the stable updater feed, no matter how "final" its own version number is.
Only a final (no prerelease identifier) version pushed on `main` is stable.

An RC on `main` still builds and publishes installers — testers can grab it
from the Releases page — it's just never wired into `latest.json`, so nobody
on the stable auto-update channel can land on it by accident.

This logic lives entirely in the `detect-version-bump` job of `release.yml`;
nothing else needs to change if you're just cutting releases.

## Tags

Always `v{version}` — `v0.1.10`, `v0.2.0-rc.1`, `v0.2.0`. No more `dev_`
prefix; the branch/channel is already implied by the version's MINOR parity
and prerelease identifier, so the tag doesn't need to encode it separately.

## How to cut a release

### Regular dev release

```
# on dev, MINOR version already odd (e.g. currently 0.1.9)
# Thanks to scripts/sync-app-version.mjs, this bumps the version in:
#  package-lock.json, package.json, src-tauri/Cargo.lock,
#  src-tauri/Cargo.toml and src-tauri/tauri.conf.json
npm version 0.1.10 --no-git-tag-version
# Generate the bitmap for the NSIS installer.
./scripts/gen_nsis_images.py

git commit -a -m "chore: release 0.1.10"
git push origin dev
```

That's it — `release.yml` tags `v0.1.10`, builds, publishes a GitHub
prerelease, and points `latest-dev.json` at it. Repeat for `0.1.11`,
`0.1.12`, etc. No RC step required for dev releases.

### Promoting dev → main (odd → even transition)

This is the one point where a branch cut is doing real work — `dev` needs to
keep absorbing new (0.3.x) work the moment this happens, while `main`
stabilizes what's already there.

```
git checkout main
git merge --ff-only v0.1.11        # or whatever the last dev tag was
# bump version → 0.2.0-rc.1
npm version 0.2.0-rc.1 --no-git-tag-version
git commit -a -m "chore: release 0.2.0-rc.1"
git push origin main
```

Fix anything that comes up with normal commits on `main` (cherry-picked from
`dev` or written directly against `main` — either is fine at this scale).
When ready to cut another candidate, bump to `0.2.0-rc.2` and push again.
When satisfied:

```
# bump version → 0.2.0 (drop the -rc suffix)
npm version 0.2.0 --no-git-tag-version
git commit -a -m "chore: release 0.2.0"
git push origin main
```

`release.yml` will look for a prior GitHub release tagged `v0.2.0-rc.*` and
carry its notes forward automatically if you don't override `release_body`.

### Stable patch release

Same as above, entirely on `main`: bump to `0.2.1`, commit, push. No branch
needed — `main` already is the maintenance line for the current stable
series.

### Reopening dev for the next cycle

There is nothing to do here until you're actually ready to ship the first
release of the new odd line. `dev`'s version field can sit at whatever it was
before the promotion (e.g. still reading `0.1.11`) indefinitely — nothing in
the pipeline reacts to anything except a version bump being pushed. The
"0.3.x" line has no existence anywhere in the repo — no tag, no branch, no
marker — until the commit that bumps the version to `0.3.0` (or whatever the
first real 0.3.x version is). That commit is both the only record of the
reopening and the release trigger itself.

If you bump the version as its own empty commit right after the promotion,
that alone will cut a `0.3.0` devel release with no new content — harmless,
but worth knowing. Folding the bump into the first real feature commit of the
new cycle avoids the empty release, at the cost of a less clean "here's where
0.3.x began" marker in history.

## Issue tracking across the "train" (`label-dev-fixes` in `release.yml`)

GitHub only auto-closes an issue for a commit's closing keyword (`Closes #X`,
`Fixes #X`, `Resolves #X`, ...) when that commit lands on the repo's
**default branch**. `dev` isn't the default branch (`main` is), so those
commits would otherwise never mark anything as done — the issue would sit
open even after the fix has shipped in a dev build.

To compensate, every time a **final** version (no `-rc`/`-beta`/etc. suffix)
is pushed on `dev`, the `label-dev-fixes` job in `release.yml`:

1. Finds the previous `v*` tag reachable in `dev`'s history (i.e. the last
   dev release, of any kind).
2. Scans every commit message in that range for GitHub's closing-keyword
   grammar (`close(s/d)`, `fix(es/ed)`, `resolve(s/d)` followed by one or
   more `#NNN`, comma/`and`-separated).
3. Applies the `fixed in dev` label to each referenced issue — it does
   **not** close it, since the fix hasn't reached the stable line yet — and
   posts a comment pointing at the dev build (with the usual "no guarantees"
   caveat) and naming the tentative next stable version (current dev MINOR
   + 1, patch `.0`; a guess, not a promise, since promotion timing isn't
   fixed). If the issue is already labeled, the job skips it — no repeat
   comments across multiple final dev releases.

This mirrors the Mozilla-style "train" model: an issue accumulates the
`fixed in dev` label as soon as its fix rides a dev release, and stays open
(for tracking "is this in `main` yet") until whoever promotes `dev` → `main`
closes it as part of that release, or closes it by hand. RC builds on `dev`
or `main` don't trigger this job — only a final version bump does, so labels
land once per train stop rather than once per commit.

## Branch preview builds (`build-nightly.yml`)

We are dropping the `nightly` codeword in favor of `preview` or
`branch-preview`, as the former has a very specific meaning in software.

Until we drop the term, the reality is this: Separate from all of the above:
`build-nightly.yml` builds an arbitrary branch on demand (`workflow_dispatch`
or a `/nightly` PR comment) and publishes a rolling `nightly_{branch}`
prerelease so a reviewer can download and try an exact commit. It is **not**
a scheduled build of `dev`, doesn't participate in the versioning/channel
model above, and isn't wired to the auto-updater at all. The name is
inherited from an older convention and is somewhat misleading given it isn't
on any schedule — treat it as a branch/PR preview mechanism, not a "nightly
channel."

## Updater implementation notes

- `src-tauri/tauri.conf.json`'s `plugins.updater.endpoints` points at the
  stable feed by default; `src-tauri/src/updater_channel.rs` overrides the
  endpoint at runtime based on the user's saved channel preference
  (`STABLE_ENDPOINT` / `DEV_ENDPOINT`), independent of the static config.
- The plugin's default version comparator is a plain `release.version >
  current_version` using `semver::Version::Ord` — no custom comparator is
  registered. This means there's no downgrade support: a user who updates to
  a higher-MINOR prerelease and then switches their channel preference back
  to stable will not be offered the (numerically lower) stable version until
  stable catches back up. This is expected given the current setup, not a
  bug — if channel-switch-triggered downgrades are ever wanted, that
  requires registering a custom `version_comparator` in
  `updater_channel.rs`.
