# AGENTS.md

Instructions for coding agents working in this repo. `CLAUDE.md` points here.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (external PRs are not a triage surface). See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo — one `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.

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
