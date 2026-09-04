# Config Schemas

Compile-time config lives in `src/config/*.json`. Each file has a different
validation story — some are checked at runtime, some by CI scripts, and one is
not validated at all. When you add a config file or extend an existing one, keep
the validation story consistent.

| File | Purpose | Validated where |
| ---- | ------- | --------------- |
| `experiments.json` | Declares Experiments (see `dev/experiments-framework.md`) | **Runtime** — `experimentsRegistry.ts` validates version + shape and throws at module load |
| `complex-plugin-allowlist.json` | Allowlists built-in complex plugins | **CI script** `scripts/check-complex-plugin-allowlist.mjs` (version integer, `^[a-z0-9][a-z0-9-]*$` id regex, sorted, unique) + **runtime hash** — Rust `verify_generated_allowlist_integrity()` compares a SHA-256 of the raw JSON against the generated constant (hard error in release, warning in debug) |
| `builtin-simple-plugin-allowlist.json` | Allowlists built-in simple plugins | **Generator only** — `scripts/generate-builtin-simple-plugins.mjs` throws if an entry lacks `id`, `folder` or `manifestPath`. No id-format, sorting or uniqueness check, and no integrity hash: weaker than the complex allowlist above |
| `window-layouts.json` | Default floating-panel layouts | **None** — imported by `src/components/layout/FloatingPanelStack.tsx` and cast (`as unknown as LayoutConfig`) |

## Notes

- Editing an allowlist **requires regenerating** the generated registry files
  (`npm run generate:plugin-registry`) so the embedded SHA-256 and generated
  constants stay in sync — otherwise release startup fails.
- `window-layouts.json` is the widest gap: it is type-cast with no validation.
  If you extend it, add a `normalize`/validate step rather than relying on the
  cast.
- The plugin-registry guardrails are enforced in CI:
  `.github/workflows/plugin-registry-guardrails.yml` (runs the generator,
  allowlist checks, and verifies the generated registry).

## Related pages

- `dev/experiments-framework.md`
- `dev/plugins-framework.md`
- `dev/state-and-stores.md`
