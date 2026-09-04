# AGENTS.md

Instructions for coding agents working in this repo. `CLAUDE.md` points here.

## Main behavioral guidelines

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-driven execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## New interfaces require dev documentation

Any feature that ships **new developer-facing interfaces** — a framework,
contract, registry, public module API, IPC command, or config schema — MUST
also ship fleshed-out dev documentation explaining how to use it. The feature
is not done until the docs are.

Docs live under `docs/dev/` (framework/contract docs) or `docs/reference/`
(user-facing contracts), are registered in `mkdocs.yml` under **Developer
Guide**, and are updated alongside behavior changes (see `docs/dev/index.md`).

What "fleshed out" means — cover at least:

- What the interface is for and when to reach for it
- The files/functions/types that form the public surface
- A minimal usage example
- Any constraints (leaf-module rules, reload semantics, boundaries)
- Related pages

Reference example: `docs/dev/experiments-framework.md`.

Run `npm run check:docs` before you push. It verifies that every path and code
symbol a document cites still exists, that no page pins a line number (they
drift within a week), and that the MkDocs nav matches what is on disk. It runs
in CI. Deliberate exceptions — schematic names, external APIs, symbols named
precisely because they were removed — go in
`scripts/docs-accuracy-allowlist.json` **with a reason**.

## Lint

The repo still carries thousands of pre-existing ESLint problems, so
`npm run lint` (full repo) is not a gate and will stay red for a long while.
What gates CI is `npm run check:lint`: it lints only the directories listed in
`scripts/lint-clean-dirs.json` and fails on any error **or** warning there.

Coverage grows one directory at a time. To put a directory under lint control,
clean it until `npx eslint <dir> --max-warnings 0` passes, then add it to the
list. Never take a directory off the list to turn a build green, and when a
listed directory is renamed, follow the rename in the list — the check fails on
missing entries precisely so coverage cannot be lost silently.

## Consult the developer docs first

Before reverse-engineering how a system works from the source, check the
developer docs — `docs/dev/` (frameworks, contracts, invariants) and
`docs/reference/` (hotkeys, file formats, support anatomy). `docs/dev/index.md`
is the index and the `mkdocs.yml` nav is the map.

Most cross-cutting systems are documented: history/undo-redo, registration
seams, state stores, config schemas, the Tauri IPC bridge, hotkeys, plugins,
experiments, and the support system. Read the relevant page before grepping the
codebase — it names the exact files and invariants you would otherwise spend
time re-deriving. Only fall back to source reading when the docs don't answer
the question.

## Where documentation lives

| Location | Holds | Published |
| --- | --- | --- |
| `AGENTS.md` | Agent guidelines and hard rules | no |
| `CONTEXT.md` | Domain glossary — use its terms, not synonyms | no |
| `docs/dev/`, `docs/reference/` | Contracts, invariants, frameworks | yes |
| `docs/adr/` | Decisions and the reasoning behind them | yes |
| `docs/internal/` | Working inboxes, agent instructions, research | **no** |

`docs/internal/` is excluded from the MkDocs build (`exclude_docs`) but is
versioned and reviewed like everything else — see `docs/internal/README.md`.

Two files named `backlog.md` exist and they are different things:
`docs/dev/backlog.md` is the published record of known gotchas, temporary rules,
and desired architectural directions; `docs/internal/backlog.md` is the
unpublished capture inbox for incidental findings, whose entries are deleted
when closed. Read the header of either before adding to it.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (external PRs are not a triage surface). See `docs/internal/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/internal/agents/triage-labels.md`.

### Domain docs

Single-context repo — one `CONTEXT.md` at the root plus `docs/adr/`. See
`docs/internal/agents/domain.md`.

## i18n / Lingui — interpolation gotcha

Do not add interpolating `msg` translations (`` msg`${x} …` ``) inline inside a React
component or hook. React Compiler renames the interpolated locals in production builds
(`minutes` → `minutes_2`), which desyncs the message id from the compiled catalog, so
production renders the placeholders raw (`{minutes_2}`). Dev looks fine and hides it.

Rule (temporary, until Lingui moves to the Babel macro ordered before React Compiler):
translations that interpolate values live in **module-scope helper functions** (e.g. the
duration formatters in `src/app/page.tsx`), which React Compiler leaves untouched. See
`docs/dev/backlog.md`.

## Undo/redo — history handlers

Register and push through the typed façade (`createTypedHistory<Map>()` per domain), not
the raw `pushHistory`/`registerHistoryHandler`. The map binds each action type to its
payload, so a push can't drift from the handler that inverts it. Copy an existing domain
(`src/supports/history/`, `src/features/mesh-smoothing/history/`) for the shape.

Two invariants that mimicry won't teach — get either wrong and undo breaks **silently**:

- **Register at an app-root / always-mounted lifetime**, never gated on a render component.
  Handlers gated on a mesh being on screen mean Ctrl+Z stops working depending on the render
  tree (the bug this seam fixed). Supports register via `useSupportHistoryHandlers()` at the
  app root; scene/mesh-smoothing register in always-mounted hooks.
- **Everything pushed to the stack needs a handler** — even a marker with no undo behaviour
  needs a pass-through (`() => true`), or an unhandled entry strands the stack (see
  `SCENE_SLICED`). A handler returning `false` means "unrecoverable"; the entry is discarded.

## Rust crate version bumps

The native crates under `rust/` (`dragonfruit-islands`, `dragonfruit-sdf`,
`dragonfruit-mesh-core`, …) are **standalone crates** — there is no workspace
root — consumed by the Tauri shell via path dependencies in
`src-tauri/Cargo.toml`. Because path deps always resolve, a stale `version` is
invisible locally but breaks the lock file, caches, and any versioned consumer.

Whenever you change one of these crates, **bump its `version`** in that crate's
`Cargo.toml`:

- `patch` for bug fixes, `minor` for new features (semver).
- If another crate or the shell pins it by version, update that requirement to
  match.
- Run `cargo check` (or `cargo build`) afterwards so `Cargo.lock` picks up the bump before committing.

## App version — do not bump unprompted

NEVER bump the DragonFruit main app version unprompted — `package.json` `version`, `src-tauri/tauri.conf.json` `version`, and `src-tauri/Cargo.toml` `[package] version` must stay on the current release (currently `0.1.15`) unless the user explicitly asks for a release/version bump. The `rust/*` crate bumps above are allowed; the main app version is release-driven and user-controlled.
