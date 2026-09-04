# Release strategies: how other open-source projects do it

A survey of common patterns for shipping **nightly / dev / RC / stable** channels,
written against where DragonFruit's own release pipeline stands today
(`.github/workflows/release.yml` and `build-nightly.yml`, branch `fix/updater`).

## 1. Where DragonFruit is right now

- **`release.yml`** — one workflow triggered on push to `main` *or* `dev`. It diffs
  `package.json`'s `version` field against the previous commit to decide
  `should_release`. `dev` pushes produce tag `dev_X.Y.Z` (GitHub prerelease,
  `latest-dev.json` updater feed); `main` pushes produce tag `vX.Y.Z` (GitHub
  release, `latest.json` updater feed). This used to be two near-duplicate
  workflows (`dev-prerelease.yml` + `main-release.yml`) that were just merged —
  a good move, that duplication was the main structural smell.
- **`build-nightly.yml`** — a separate, manually triggered (or `/nightly` PR-comment
  triggered) build from *any* branch, publishing a rolling `nightly_{branch}` tag
  that gets deleted and recreated on every run. Not wired into the updater feed.
- There is no RC concept, no changelog automation, and no maintenance/LTS branch —
  "release" always means "the tip of `main` or `dev`, whatever it currently is."
  The only thing that gates a release is a human remembering to bump
  `package.json` before pushing.

That last point — a diff-based "did the version change?" check as the sole
release trigger — is the part most OSS projects have moved away from, and it's
worth flagging before the rest of this report, because it's orthogonal to the
channel question: whatever channel model you pick, it still needs *something*
more durable than "did someone remember to edit a version string" to decide
when to cut a release.

## 2. The recurring patterns across OSS projects

### a) Channel as metadata, not as a second pipeline

Mature projects treat the channel (nightly/beta/stable) as a label attached to
one build pipeline, not as N copy-pasted workflows. Two common ways to encode
the label:

- **Tag/branch name convention** — what DragonFruit already does
  (`dev_0.1.9` vs `v0.1.9`). Simple, GitHub-Releases-native, easy to filter in
  CI with a single `if:`.
- **SemVer prerelease identifiers** — Electron, Kubernetes, and most of the npm
  ecosystem bake the channel into the version itself: `1.2.0-alpha.1`,
  `1.2.0-beta.3`, `1.2.0-rc.1`, `1.2.0`. One version bump, one tag scheme, and
  tools (npm dist-tags, semver ranges) already understand the ordering
  alpha < beta < rc < stable. This also gives you RC "for free" — it's just
  another prerelease identifier — where DragonFruit's `dev_`/`v` split has no
  slot for "release candidate" without inventing a third prefix.

### b) The "train" / promotion model (Rust, Chrome, Firefox)

One trunk, continuously shipping to the nightly channel from every merge.
Every N weeks, trunk is **branched** into a release line; that branch becomes
beta, then stable, while trunk keeps moving. Fixes needed for the stabilizing
branch are cherry-picked backward, not merged forward. This is what gives Rust
its predictable 6-week cadence and Firefox its Nightly → Beta → Release → ESR
ladder. The key property: nightly is never "held back" waiting for a release —
it's just CI on trunk tip, always fresh, and it's the *branch* (not a status
flag on the same branch) that stabilizes.

DragonFruit's `dev` branch is closer to this than `main` is: pushes to `dev`
are the closest thing to a nightly/train head today. But there's no branch cut
step — `dev` prereleases and `main` releases both just watch for a version
bump, so there's no window where a specific commit set is "frozen" for
stabilization before promotion. Put more sharply: `dev_x.y.z` isn't a distinct
release evolving on its own timeline — it's a relabeled copy of whatever `main`
is about to become next. There's no artifact that gets to stabilize
independently of `dev` continuing to move; the "branch cut" step that makes
the train model work (Rust, Chrome, Firefox) is the piece missing, not just a
soak period bolted onto the existing tags.

### c) Scheduled nightly, rolling tag (Blender, LLVM, Firefox Nightly)

"Nightly" in most projects means a **cron-triggered** build of the integration
branch (once a day), not an on-demand build of an arbitrary feature branch.
It's aimed at users who want to run "whatever trunk looks like today," and it
usually keeps a single rolling tag/release (today's build replaces
yesterday's), sometimes retaining a short window of dated builds for bisection.

DragonFruit's `build-nightly.yml` is doing something different despite the
name: it's a **PR/feature-branch preview build**, triggered on demand or by a
`/nightly` comment, useful for "let a reviewer download this exact branch and
try it." That's a legitimate and common pattern too (GitHub itself calls these
"PR build artifacts," and projects like Deno and Prettier post download links
on PRs), but it's solving a different problem than a scheduled trunk nightly.
Worth being explicit internally about which one "nightly" is supposed to mean,
since right now the name is borrowed from the other pattern.

**Schedule-words vs. audience-words.** Naming for these builds splits into two
families, and the split tracks cadence pretty cleanly:

- *Schedule-literal* names — **Nightly** (Firefox, Rust), **Daily Build**
  (Ubuntu/Debian installer images) — are used when the cadence is genuinely
  fixed and fast enough to matter. Firefox and Rust both really do cut a build
  every ~24h off a high-velocity trunk, so the name matches reality.
- *Audience/trust-tier* names, decoupled from any schedule — **Insiders**
  (VS Code), **Canary** (Chrome), **EAP** (JetBrains), **Edge**, **HEAD**
  (Homebrew) — are used when cadence is irregular, on-demand, or just not the
  point. None of these promise "built every night"; they promise "this is the
  bleeding-edge tier," whenever a build happens to land.

No mainstream project keeps a schedule-word name for a build that isn't
actually on that schedule — a "Nightly" that visibly skips days erodes trust
fast, so projects either make the cadence match the word or drop schedule
language entirely. DragonFruit's nightly workflow isn't scheduled at all today
(it's dispatch/comment-triggered per branch), which puts it squarely in the
second camp: **`preview`** or **`branch-preview`** is the honest name here,
independent of whether a real cron gets added later.

### d) RC as a time-boxed stabilization phase, not a boolean flag

In Kubernetes, Node.js, and most Linux distros, "RC" isn't just a prerelease
flag — it's a phase with entry/exit criteria: feature freeze → branch cut →
`vX.Y.Z-rc.1` tagged → only regressions/blockers get cherry-picked → `rc.2`,
`rc.3`... → final tag once no blocking bug has surfaced for some soak period
(often a fixed number of days). The RC branch is what real users/downstream
packagers test against before the branch is declared stable.

DragonFruit has no equivalent today: `dev` prereleases are continuous
snapshots, not a specific candidate being soaked before promotion to `main`.

### e) Maintenance branches for old stable lines (Kubernetes, Node LTS, Blender LTS)

Once a version ships, projects that support more than "latest" keep a
`release-X.Y` branch alive to backport security/critical fixes as `X.Y.Z+1`,
decoupled from trunk churn. This is very much a "do you need to support more
than one version at a time" question — for a small team shipping one active
line, it's usually not worth the overhead until users start asking "can I stay
on the old version." Flagging it as an option, not a recommendation, given
DragonFruit's size.

### f) Distro-native beta channels (Flathub)

Since DragonFruit already ships a Flatpak, it's worth knowing Flathub supports
a `//beta` branch per app (`org.dragonfruit.App//beta`) that installs side by
side with stable and gets its own update stream — the same "channel" concept
DragonFruit's `latest.json`/`latest-dev.json` split implements for the Tauri
updater, but native to the Flatpak/Flathub tooling instead of bolted on.

### g) Automated version bump + changelog (release-please, semantic-release, changesets, cargo-release)

Almost every large JS/TS or Rust OSS project uses one of these bots instead of
a human editing a version field by hand:

- Commits follow **Conventional Commits** (`fix:`, `feat:`, `feat!:` etc.).
- A bot (release-please is the most common in the GitHub Actions ecosystem)
  opens a standing "Release PR" that accumulates the version bump and a
  generated changelog as commits land; merging that PR *is* the release
  trigger.
- The changelog is generated from commit messages, not hand-written in a
  `release_body` output.

This replaces DragonFruit's current mechanism — diffing `package.json` across
commits to infer "did a human remember to bump the version" — with an
explicit, auditable trigger (merging the release PR), and gets a changelog for
free. It composes with any of the channel models above; it's about *how a
release gets triggered*, independent of *how channels are labeled*.

## 3. Summary table

| Pattern | Example projects | What it solves |
|---|---|---|
| Channel via tag/branch naming | DragonFruit today, many small projects | Simple, no tooling needed |
| Channel via SemVer prerelease id | Electron, Kubernetes, npm ecosystem | One version scheme covers alpha/beta/rc/stable, ordering understood by tools |
| Train model (branch cut + backport) | Rust, Chrome, Firefox | Nightly never blocked on stabilization; predictable cadence |
| Scheduled rolling nightly | Blender, LLVM, Firefox Nightly | "Latest trunk, always fresh" for early adopters |
| On-demand PR/branch preview build | GitHub Actions artifacts, Deno, Prettier | Reviewer/tester downloads an exact branch build |
| Time-boxed RC phase | Kubernetes, Node.js, distros | Explicit stabilization window with entry/exit criteria |
| Maintenance branches | Kubernetes, Node LTS, Blender LTS | Support older lines without blocking trunk |
| Distro-native beta channel | Flathub `//beta` | Beta channel using packaging ecosystem's own primitives |
| Bot-driven version bump + changelog | release-please, semantic-release, changesets | Removes "did someone remember to bump the version" as a manual step |

## 4. If it's useful: what would most directly address "I don't like this"

Not a rewrite, just the two changes that show up in nearly every project above
and that DragonFruit doesn't have any version of yet:

1. **Give releases an actual stabilization step**, rather than `dev` and
   `main` mirroring the same version-bump trigger under different tag
   prefixes: cut a branch at feature-freeze, let it take `-rc.N` tags, only
   backport fixes onto it, and promote the same commit to stable once it's
   soaked — instead of `dev_x.y.z` and `vx.y.z` being two labels for what is
   effectively one continuously-moving line.
2. **Rename `build-nightly.yml` to `build-preview.yml`** (tag prefix
   `preview_` or `branch-preview_`) — it's an on-demand, per-branch build
   today, not a scheduled trunk build, so a schedule-word name doesn't fit.
   This is a pure rename with no behavior change, and removes the recurring
   "why is this called nightly" confusion for free.
