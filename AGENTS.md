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
