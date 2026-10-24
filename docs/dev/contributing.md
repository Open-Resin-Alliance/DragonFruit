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

### Unit and DOM tests

Use the pinned Node version from `package.json`, then run:

```bash
npm test
npm run test:dom
npm run test:watch
```

These commands use `scripts/run-tests.mjs` to discover files through Node's
filesystem glob API, avoiding shell-dependent quoting on Windows. Unit tests
match `src/**/*.test.{ts,tsx}` and `plugins/**/*.test.{ts,tsx}`; DOM tests match
`src/**/*.dom-test.tsx`. Discovery fails with a nonzero exit code if the
selected suite contains no files. The launcher keeps the existing tsx and
suite-specific preloads and returns the child runner's exit status.

Run the commands from the repository root. Extra Node test-runner options are
forwarded before the discovered files, for example
`npm test -- --test-concurrency=4` or
`npm run test:dom -- --test-concurrency=1`. Watch mode uses the same discovery
and Node's built-in `--watch` option. No extra test framework is involved.

### Documentation

Run `npm run check:docs`. It is the same check CI runs, and it covers:

- every repo path a document cites exists
- every code symbol a document cites exists in the codebase
- no page pins a line number — they drift within a week; name the symbol instead
- relative links between pages resolve
- the site nav (`website/src/data/docs-nav.json`) lists every published page, and every nav entry has a file

Symbol verification needs the plugin submodules (`git submodule update --init`);
without them the check says so and skips that part rather than reporting false
failures.

Deliberate exceptions go in `scripts/docs-accuracy-allowlist.json`, each with a
reason. An unexplained entry is how a checker quietly stops catching things.

Building the site locally (`cd website && npm run build`) is still worth doing
before merging a large documentation change. It renders every page through the
same viewer production uses, and fails on a missing image or a dead relative
link.
