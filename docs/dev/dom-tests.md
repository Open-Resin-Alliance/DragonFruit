# DOM Tests

`npm test` runs the unit tests in plain Node: no DOM, and app code transpiled
by tsx alone. That is enough for logic, but not for anything that has to mount:
components, hooks, effects, or the page itself. `npm run test:dom` runs a
second group of tests on the same runner (`node:test`) with a DOM (happy-dom)
and with app code compiled the way Next compiles it.

Reach for it when the behaviour under test only exists once React renders: an
effect that should run once, a hotkey handled by two components, a hook that
two managers share, or a characterization test before moving code out of
`src/app/page.tsx`. Keep pure logic in ordinary unit tests; they are faster and
need none of this.

## Writing a DOM test

DOM tests live in a `__tests__/` directory and are named `*.dom-test.tsx`. The
suffix keeps them out of `npm test`, whose glob is `*.test.{ts,tsx}`, because
they cannot run without the preload described below.

```tsx
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { SomePanel } from '../SomePanel';

test('the panel opens its menu', async () => {
    const tree = await renderWithProviders(<SomePanel />);
    try {
        await settle(50);
        assert.ok(tree.container.querySelector('button[aria-label="Open menu"]'));
    } finally {
        await tree.unmount();
    }
});
```

`src/utils/__tests__/helpers/renderDom.tsx` provides:

- `renderWithProviders(ui)` — mounts `ui` inside `act`, wrapped the way
  `src/app/layout.tsx` wraps the page (`I18nClientProvider`, `HotkeyProvider`)
  and in `StrictMode`, as `next dev` runs it. Returns the container and an
  `unmount`.
- `withProviders(ui)` — the same wrapping, for a test that drives `createRoot`
  itself.
- `settle(ms)` — lets timers and effects run for `ms` inside `act`.

`src/app/__tests__/page.dom-test.tsx` is the smoke test for the whole page and
the example to copy for a test that must observe a render loop rather than hang
on one: it mounts without `act`, because `act` drains a loop synchronously and
the test would never get control back.

Prefer mounting the piece under test over mounting the page. A cached page
mount costs about 2 s; a hook's import graph is a fraction of that, and the
test does not break whenever `page.tsx` moves something around.

### Tauri and the native side

The DOM is happy-dom's `window`; there is no `__TAURI_INTERNALS__` on it, so
the app takes its web paths. A test that needs the native bridge sets
`window.__TAURI_INTERNALS__` itself, or uses `mockIPC` from
`@tauri-apps/api/mocks`, and removes it afterwards.

Do not call `installFakeWindow` (`src/utils/__tests__/helpers/fakeWindow.ts`)
in a DOM test. It replaces `window` with a minimal object, which pulls the
real DOM out from under React for the rest of the test. It belongs to the
plain unit tests, where there is no DOM to replace.

WebGL is not available: the React Three Fiber `<Canvas>` mounts but draws
nothing. Scene rendering stays out of reach of these tests; what they can
cover is the state, effects and handlers around it.

## The preload

`scripts/test-dom/register.mjs` is loaded after tsx (`node --import tsx
--import ./scripts/test-dom/register.mjs --test …`). It:

1. Registers happy-dom on `globalThis` before any test module loads, sets
   `IS_REACT_ACT_ENVIRONMENT`, and aborts happy-dom's timers after the file's
   tests, so the process can exit.
2. Compiles every `.ts`/`.tsx` under `src/` and `plugins/` in three steps: the
   React Compiler (`babel-plugin-react-compiler`), then the Lingui macro
   (`@lingui/babel-plugin-lingui-macro`), then esbuild to strip types and
   emit CommonJS. Source maps are chained, so stack traces point at the
   original lines.
3. Resolves CSS imports to nothing.

### Why the React Compiler is required

The app is built with `reactCompiler: true` (`next.config.ts`), and some of its
effects depend on values that only the compiler keeps stable between renders.
Mounted without it, the page re-renders continuously and React logs "Maximum
update depth exceeded". The smoke test fails in that case, by design. Never
switch the compiler off in the preload to make a test pass: the test would be
running code that the app does not ship.

The two Babel passes run in that order because that is Next's order (the
compiler rewrites component bodies first; see the comment on the duration
label formatters in `src/app/page.tsx` for a production bug that order
causes). In a single pass the macro trips over bindings the compiler has
already rewritten and throws "Unsupported macro usage".

### The compile cache

Compiling is the expensive part: a cold mount of the page compiles about 800
files and takes about 20 s; cached, the same test takes about 2 s. Output is
cached in `node_modules/.cache/dragonfruit-dom-tests`, one file per compiled
module, keyed by the module's path and content, the preload's own source,
`lingui.config.ts`, and the versions of Babel, the compiler, the macro and
esbuild. A change to any of those misses the cache by itself; nothing has to be
cleared by hand.

Each hit refreshes the entry's mtime, and entries unused for 14 days are
deleted when a test process starts, so the directory holds roughly what the
current tests use. To start cold, delete the directory.

CI restores the directory with `actions/cache` before `npm run test:dom`
(`.github/workflows/test.yml`), under one rolling key, and saves it again
afterwards.

## Constraints

- **Separate script.** DOM tests do not run under `npm test`, and ordinary
  tests do not run under the preload. Keep it that way: the compile step would
  slow every unit test down, and several unit tests deliberately install their
  own `window` (see `fakeWindow.ts`) or none at all.
- **One process per file.** `node --test` runs each file in its own process,
  so the DOM, module-level stores and the timers are per file. Tests inside one
  file share them; unmount what you mount.
- **Lingui runs for real.** Strings render through the macro and the English
  catalog, so a test can look for the English text. Prefer `aria-label`s and
  roles where they exist; copy changes more often than labels.
- **The Lingui macro version follows `@lingui/core`.** Keep
  `@lingui/babel-plugin-lingui-macro` on the same version as `@lingui/core` and
  bump them together, or the macro may emit calls the runtime does not have.

## Verification

```bash
npm run test:dom
```

The first run is cold (about 20 s for the page smoke test); later runs reuse
the cache.

## Related pages

- [Contributing](contributing.md)
- [page.tsx Refactor Handoff](page-tsx-refactor-handoff.md)
- [Localization (i18n)](localization.md)
- [Tauri IPC and Native Bridge](tauri-ipc-bridge.md)
