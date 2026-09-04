# Contributing Documentation

This section defines documentation maintenance expectations.

## Documentation standards

- Keep user docs task-oriented and concise.
- Keep developer docs contract-driven and implementation-aware.
- Prefer stable terminology for support primitives/types.
- Include screenshot placeholders where visuals are expected.

## When to update docs

Update docs when changing:

- user-visible workflows or controls
- hotkey rules and interaction precedence
- file/storage contracts
- support placement/replacement behaviors
- export/runtime API contracts

## Validation

Run `npm run check:docs`. It is the same check CI runs, and it covers:

- every repo path a document cites exists
- every code symbol a document cites exists in the codebase
- no page pins a line number — they drift within a week; name the symbol instead
- relative links between pages resolve
- the MkDocs nav lists every published page, and every nav entry has a file

Symbol verification needs the plugin submodules (`git submodule update --init`);
without them the check says so and skips that part rather than reporting false
failures.

Deliberate exceptions go in `scripts/docs-accuracy-allowlist.json`, each with a
reason. An unexplained entry is how a checker quietly stops catching things.

Building the site locally (`mkdocs build --strict`) is still worth doing before
merging a large documentation change.
