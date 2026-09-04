# Internal docs

**Not published.** `mkdocs.yml` excludes this directory (`exclude_docs`), so
nothing here reaches <https://dragonfruit-slicer.com>. It is still versioned in
git and still reviewed in PRs — "internal" means unpublished, not unowned.

## What belongs here

- **Working inboxes** — `backlog.md`, the low-friction capture list for incidental
  findings. Short-lived by design: entries are deleted when closed or promoted.
- **Agent operating instructions** — `agents/`, how coding agents should use the
  issue tracker, the triage labels, and the domain glossary.
- **Point-in-time research** — surveys and reports written to inform a decision,
  kept because the analysis was expensive. `release-strategies-report.md` is one:
  it fed the release model, but `dev/releases.md` is the contract that resulted.

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
