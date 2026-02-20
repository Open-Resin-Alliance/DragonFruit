# Contributing Complex Plugins (Custom Tooling)

This guide is for contributors who want to add a **built-in complex plugin** to Dragonfruit (similar to Athena), including custom logic/tooling beyond data-only manifests.

> External GitHub plugin installs currently support data-only content (manifest, presets, templates). Complex runtime code is contributed via PR to this repository.

---

## 1) When to use this path

Use this PR path when your plugin needs one or more of:

- custom protocol/network behavior
- custom validation or field semantics
- workflow-specific logic beyond static preset/template data
- tooling that must run in Dragonfruit runtime (client/server)

If your plugin only adds printer/material data, prefer the external GitHub manifest route.

---

## 2) Expected folder layout

Create your plugin in `plugins/<vendor>/`:

- `plugins/<vendor>/pluginManifest.ts` (required)
- `plugins/<vendor>/...` plugin-owned code (tooling/logic)
- `plugins/<vendor>/printers/...` optional preset/data/assets
- `plugins/<vendor>/README.md` (recommended)

Keep vendor-specific logic inside the plugin folder and avoid scattering it across unrelated core components.

---

## 3) Registration and integration points

Wire your plugin through the existing registries used by Dragonfruit:

- Profile/plugin manifest registration
  - `src/features/plugins/pluginRegistry.ts`
- Network handler registration (if needed)
  - `src/features/plugins/networkPluginRegistry.ts`
- Static network route dispatcher (already present)
  - `src/app/api/network/plugin/route.ts`

For networked plugins:

- Keep protocol logic plugin-owned (e.g., `plugins/<vendor>/network/*`)
- Register handlers through plugin registration/lifecycle code
- Avoid hardcoded vendor routes under `src/app/api/network/<vendor>/...`

---

## 4) Safety expectations

Complex plugin PRs must preserve Dragonfruit safety guarantees:

- no remote code execution from third-party GitHub repos
- no dynamic runtime code download/eval
- sanitize and validate external inputs
- keep API timeouts and error handling explicit

---

## 5) Implementation checklist

Before opening a PR:

- [ ] Plugin has a clear `pluginManifest.ts`
- [ ] Vendor logic is isolated to `plugins/<vendor>/...`
- [ ] Registry wiring is complete (profile and/or network as needed)
- [ ] No hardcoded vendor endpoints in generic API folders
- [ ] UI only references generic plugin surfaces where possible
- [ ] Added/updated docs in `plugins/README.md` and plugin-local README
- [ ] Added tests or validation coverage for new behavior
- [ ] Confirmed existing tests pass (`npm test -- --runInBand`)

---

## 6) PR content recommendations

Include in your PR description:

1. **Problem statement** — what vendor capability is being added
2. **Architecture summary** — where logic is registered and why
3. **Safety model** — how input validation and boundaries are handled
4. **User-facing changes** — settings/workflow behavior impacts
5. **Test evidence** — unit/integration/manual validation results

---

## 7) Review criteria

Reviewers will typically check for:

- plugin isolation and maintainability
- consistency with existing plugin architecture
- safety and failure handling
- clear docs and migration notes
- no regressions to existing plugin flows

---

## 8) Helpful references

- Root plugin overview: `plugins/README.md`
- Athena example plugin: `plugins/athena/`
- GitHub manifest fetch route: `src/app/api/plugins/github-manifest/route.ts`
- Plugin settings UI: `src/components/settings/PluginsSettingsTab.tsx`

---

If you want, open your PR early as draft and tag maintainers with your planned plugin boundaries first — it helps avoid architecture churn later.
