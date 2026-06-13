# Localization (i18n)

DragonFruit uses [LinguiJS](https://lingui.dev/) (a `gettext`-style workflow) for
UI translations. Strings are marked in the source with the Lingui macros
(`` t`…` ``, `` msg`…` `` resolved via `useLingui()`, or `<Trans>`), and the SWC
plugin transforms them at build time.

**Supported locales:** English (source), Spanish, German, French.

## Catalogs

Each locale lives in `src/locales/<locale>/`:

- `messages.po` — the editable catalog (one per locale). This is the source of
  truth that translators edit. There is **no `.pot` template**: with Lingui's PO
  format the per-locale `.po` files are written directly.
- `messages.js` — the **compiled** catalog, generated from the `.po` and imported
  by the runtime (`loadLocale()`). It is a build artifact derived from the `.po`.

## Workflow

| Command                | Runs                 | What it (re)generates                                                                                                                                                        |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run i18n:extract` | `lingui extract`     | Scans the source and **updates every `.po`** (en/es/de/fr). New strings are added with an empty `msgstr`, existing translations are **preserved**, obsolete ones are pruned. |
| `npm run i18n:compile` | `lingui compile`     | Reads the `.po` files and **regenerates the `.js`** catalogs consumed at runtime. Does not touch the `.po`.                                                                  |
| `npm run i18n:update`  | `extract && compile` | Both steps in sequence.                                                                                                                                                      |

Typical loop: mark new strings → `npm run i18n:extract` → fill in the empty
`msgstr` values in the `.po` files → `npm run i18n:compile` (or just
`npm run i18n:update` once the translations are in place).

## Choosing the language at runtime

The UI language is resolved on startup by `detectInitialLocale()`, in this order
of precedence:

1. An explicit user choice persisted in `localStorage` (set via the language
   switcher in the top bar).
2. A build-time override via the `NEXT_PUBLIC_DF_LOCALE` env var — handy for
   forcing a language in demos or CI, e.g.:
   ```bash
   NEXT_PUBLIC_DF_LOCALE=es npm run dev
   ```
   (Next.js inlines `NEXT_PUBLIC_*` at build/start, so restart the dev server
   after changing it.)
3. The browser/OS preferred language (`navigator.language`).
4. The English default.

The language switcher in the top bar changes the locale live via `loadLocale()`
and persists the choice, so it overrides the env var and detection on subsequent
loads.
