# AGENTS.md

Instructions for coding agents working in this repo. `CLAUDE.md` points here.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (external PRs are not a triage surface). See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo — one `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.

## Reporting work — evidence, not attestation

An AAR that says a check was performed is worth nothing; the reader cannot tell a real check
from a remembered one. **Report outcomes by pasting what the tooling printed.** These are
requirements, not style preferences — a phase missing them is incomplete.

- **Red-first means the failure output, verbatim.** Paste the message with its `actual` and
  `expected`. If the only achievable red was a compile error (new API, no prior behaviour to
  break), **say that plainly** rather than describing it as behavioural. If a test is green
  at the base tree by construction, it is a **lock, not a red** — call it one, and if you want
  to show it isn't vacuous, break the thing it guards, record the failure, and revert.
- **Verification numbers are counts you ran**, per suite, against the stated baseline. Any
  delta is accounted for unit by unit — "green" is not a number. A count *below* baseline is a
  regression to explain, never to gloss.
- **Separate what you verified from what you inferred.** Both are legitimate; conflating them
  is not. Flag what you did not examine rather than clearing it by omission.
- **A prior AAR, plan, or dump is a claim under test, never evidence.** Re-derive load-bearing
  premises from source and cite `file:line`. See the `derive-dont-cite` skill.
- **Report what you did not do**, and what you found but did not fix.

Why this is a rule: in 2026-07 a four-phase chain on `aaron/dev-0718-stl-import` passed every
gate at every step — 454 tests, clean `tsc`, unmoved Rust suites — while being wrong, because
the tests and the code encoded the same false premise. Gates confirm internal consistency.
Only evidence from outside the change confirms correctness. See the `fixture-provenance` and
`contract-change-evidence` skills.

## Scope discipline

- **A defect that predates your branch gets its own branch and PR.** Do not ride it along.
  Absorbing unrelated fixes makes a feature branch un-reviewable and un-revertable — you cannot
  back out an approach without also backing out other people's dependencies.
- **Producer completeness.** Before writing a consumer that derives a value, check whether the
  producer already had it and discarded it. Ship it from the producer instead.
- **Search before adding a helper.** The same temp-path uniqueness fix was written three times
  on one branch, twice 450 lines apart in the same file.
- **Do not merge upstream back into a working branch mid-flight.** Net-new work inside a
  150-file merge is invisible to per-commit review.
- **Comment-to-code ratio is a review signal.** A module that is mostly prose arguing for its
  own existence usually should not exist.

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
