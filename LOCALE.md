# Localization (i18n)

DragonFruit uses [LinguiJS](https://lingui.dev/) (a `gettext`-style workflow) for
UI translations. Strings are marked in the source with the Lingui macros
(`` t`…` ``, `` msg`…` `` resolved via `useLingui()`, or `<Trans>`), and the SWC
plugin transforms them at build time.

**Supported locales:** English (source), Spanish, German, French.

## Catalogs

Each locale is a pair of files directly under `src/locales/`:

- `<locale>.po` — the editable catalog (one per locale). This is the source of
  truth that translators edit. There is **no `.pot` template**: with Lingui's PO
  format the per-locale `.po` files are written directly.
- `<locale>.js` — the **compiled** catalog, generated from the `.po` and imported
  by the runtime (`loadLocale()`). It is a build artifact derived from the `.po`.

## Local workflow

| Command                | Runs                 | What it (re)generates                                                                                                                                                        |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run i18n:extract` | `lingui extract`     | Scans the source and **updates every `.po`** (en/es/de/fr). New strings are added with an empty `msgstr`, existing translations are **preserved**, obsolete ones are pruned. |
| `npm run i18n:compile` | `lingui compile`     | Reads the `.po` files and **regenerates the `.js`** catalogs consumed at runtime. Does not touch the `.po`.                                                                  |
| `npm run i18n:update`  | `extract && compile` | Both steps in sequence.                                                                                                                                                      |

Typical loop: mark new strings → `npm run i18n:extract` → fill in the empty
`msgstr` values in the `.po` files → `npm run i18n:compile` (or just
`npm run i18n:update` once the translations are in place).

> The Lingui CLI requires Node >= 22.19 (it uses `node:fs` `globSync`), which is
> newer than the project's pinned Node (`.nvmrc`). The compiled `.js` catalogs
> are committed precisely so the app build does not run the CLI, keeping builds
> green on the project's Node version. Run `extract`/`compile` locally on Node
> 22+ and commit the regenerated catalogs.

## Crowdin

Translations are managed on **[translate.dragonfruit-slicer.com](https://translate.dragonfruit-slicer.com/)**
via the Crowdin GitHub Integration, which natively understands the gettext PO
format used by Lingui. The integration watches the `dev` branch and handles
everything automatically — no local tokens or CLI needed.

### How it works

When `en.po` changes on `dev`, Crowdin picks up the new source strings. When
translators finish, Crowdin opens a PR with the updated `.po` files into `dev`.
Merge it, run `npm run i18n:compile`, and the new translations are live.

**Local devs never need a token.** The only local step:

```bash
npm run i18n:extract   # after adding new strings
npm run i18n:compile   # verify the JS catalogs
# commit both .po and .js files
git push               # Crowdin picks up the source changes
```

### Help translate

Head to **[translate.dragonfruit-slicer.com](https://translate.dragonfruit-slicer.com/)**
to contribute translations for Spanish, German, French, or request a new
locale.

### Promoting a language to the app

Crowdin can host many target languages for translators, but a language only
ships in the app once it is deliberately promoted. Two independent gates keep
half-finished locales out of both the repo and the UI:

1. **Crowdin to repo.** Configure the Crowdin project to export only languages
   above a completeness threshold (for example 90%). Translators can still work
   on any language, but only sufficiently complete ones land in the repo as
   `.po` files, instead of dozens of near-empty catalogs.
2. **Repo to app.** A language is only usable once its code is added to
   `locales` in `lingui.config.ts` and to `SUPPORTED_LOCALES` / `LOCALE_LABELS`
   in `src/i18n.ts`. A `.po` file for a locale that is not listed there is
   harmless dead weight: it is never compiled and never appears in the switcher.

To promote a language: confirm its `.po` is reasonably complete and merged, add
its code to the three places above, run `npm run i18n:compile` (Node 22+), and
commit the regenerated `<locale>.js` catalog.

## Choosing the language at runtime

The UI language is resolved on startup by `detectInitialLocale()`, in this order
of precedence:

1. An explicit user choice persisted in `localStorage` (set via the language
   switcher under Settings > General).
2. A build-time override via the `NEXT_PUBLIC_DF_LOCALE` env var — handy for
   forcing a language in demos or CI, e.g.:
   ```bash
   NEXT_PUBLIC_DF_LOCALE=es npm run dev
   ```
   (Next.js inlines `NEXT_PUBLIC_*` at build/start, so restart the dev server
   after changing it.)
3. The browser/OS preferred language (`navigator.language`).
4. The English default.

The language switcher under Settings > General changes the locale live via
`loadLocale()` and persists the choice, so it overrides the env var and
detection on subsequent loads.
