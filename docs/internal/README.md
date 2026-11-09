# Internal docs

**Not published.** `website/src/data/docs-nav.json` excludes this directory (the
`exclude` list), so nothing here reaches <https://dragonfruit-slicer.com>. It is still versioned in
git and still reviewed in PRs — "internal" means unpublished, not unowned.

## What belongs here

- **Working inboxes** — `backlog.md`, the low-friction capture list for incidental
  findings. Short-lived by design: entries are deleted when closed or promoted.
- **Agent operating instructions** — `agents/`, how coding agents should use the
  issue tracker, the triage labels, and the domain glossary.
- **Point-in-time research** — surveys and reports written to inform a decision,
  kept because the analysis was expensive. `release-strategies-report.md` is one:
  it fed the release model, but `dev/releases.md` is the contract that resulted.
- **Plans and checklists** — work that has not landed, or the record of how it
  was planned: `cli/` (coverage gaps, new formats, what the CLI will not do),
  `slicing-engine-v3.2-roadmap.md`, `flathub-submission.md`, and
  `support-golden-masters.md` for the local-only refactor harness. They cite code
  as it was when written, so names in them may since have moved.

## What does not belong here

- **Contracts and invariants** other contributors need → `docs/dev/`.
- **Decisions and their reasoning** → `docs/adr/`.
- **Anything a user reads** → the published sections of `docs/`.

The test: if someone outside this repo's regulars would be worse off for not
seeing it, it is not internal.

## Related

- `../../AGENTS.md` — agent behavioural guidelines and hard rules
- `../../CONTEXT.md` — domain glossary
- `../dev/index.md` — the published developer guide
