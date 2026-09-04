# Experiments Framework

DragonFruit ships unfinished or early-access features behind an **Experiments**
gate. A feature gated behind a disabled experiment is hidden from the UI and
runtime behavior until the user opts in via **Settings → Experiments**.

> **About the examples.** Throughout this document the examples use an imaginary
> plugin, `df-solarlunar-import`, which lets DragonFruit import `.solarlunar`
> files as scenes. It is an example only — it does not exist in the codebase —
> used so the documented patterns don't get conflated with the real plugins they
> describe. Wherever an example is clearly marked as such, the id, plugin name,
> and file extension are illustrative.

The gate is general-purpose. It covers:

- **Regular in-app features** (e.g. a future native auto-support engine), which
  check `isExperimentEnabled(id)` at their own decision points.
- **Plugin-gated features** (e.g. the `df-solarlunar-import` plugin), which
  declare their plugin ids in the manifest's `gatedPlugins` field and are
  filtered out of the plugin registries automatically.

## Declaring an experiment

Every experiment is declared in `src/config/experiments.json`, which is bundled
into the build at compile time. Fields:

| Field            | Type       | Description                                                    |
| ---------------- | ---------- | -------------------------------------------------------------- |
| `id`             | `string`   | Stable machine id that gating code references.                 |
| `name`           | `string`   | Human-readable name shown in the Settings tab.                 |
| `description`    | `string`   | What the feature does, including experimental caveats.         |
| `defaultEnabled` | `boolean`  | Whether the experiment starts enabled for new users. Usually `false`. |
| `gatedPlugins`   | `string[]` | Optional. Plugin ids hidden while this experiment is disabled. |

```json
{
  "version": 1,
  "experiments": [
    {
      "id": "df-solarlunar-import",
      "name": "Solarlunar File Import",
      "description": "Enable importing .solarlunar scene files. Lacks comprehensive testing and may not work with all files.",
      "defaultEnabled": false,
      "gatedPlugins": ["df-solarlunar-import"]
    }
  ]
}
```

Adding an entry is all that is needed to surface a new experiment in the
Settings tab and the registry — the tab renders from the manifest, so no UI
change is required per experiment.

## Runtime registry

`src/features/experiments/experimentsRegistry.ts` is the runtime API. It is a
**leaf module**: it imports only the manifest JSON and browser APIs, so any
feature can depend on it without creating import cycles. Keep it that way —
never import from `@/features/plugins/...` or other features into it.

| Function                                            | Purpose                                                  |
| --------------------------------------------------- | -------------------------------------------------------- |
| `getExperimentDefinitions()`                        | All declared experiments (frozen, validated).            |
| `getExperimentDefinition(id)`                       | A single experiment, or `undefined`.                     |
| `isExperimentEnabled(id)`                           | Whether the experiment is on (saved override, else `defaultEnabled`). |
| `setExperimentEnabled(id, enabled)`                 | Persist the user's toggle and notify subscribers.        |
| `subscribeToExperiments(listener)`                  | Subscribe to toggle changes; returns an unsubscribe fn.  |
| `getEnabledExperimentIds()`                         | Ids of all currently enabled experiments.                 |
| `getExperimentOverrides()`                          | The user's explicit toggles — ids whose saved state differs from `defaultEnabled`. The minimal delta pushed to Rust (see *Gating Rust code*). |
| `getGatedPluginIdsForDisabledExperiments()`         | Plugin ids currently hidden by a disabled experiment.    |
| `isPluginGatedByDisabledExperiment(pluginId)`       | Whether a plugin is hidden by a disabled experiment.     |

User toggles persist to `localStorage` under `dragonfruit-experiments-enabled`.

## Promotion semantics

Experiments progress through a `defaultEnabled: false` → `true` → released
lifecycle. A release that flips an experiment to default-on must reach users who
previously opted out, so the saved override is interpreted *relative to the
manifest default*:

| Manifest `defaultEnabled` | Saved value            | Effective state |
| ------------------------- | ---------------------- | --------------- |
| `false`                   | (none)                 | disabled        |
| `false`                   | `true`                 | enabled (explicit opt-in) |
| `true`                    | (none)                 | enabled         |
| `true`                    | `false` (stale)        | enabled         |
| `true`                    | `"off-when-default-on"` | disabled (explicit opt-out) |

`setExperimentEnabled` never stores a value that matches the default — it
removes the entry instead — so a promotion re-enables everyone except users who
explicitly opted out of the *promoted* experiment (saved
`"off-when-default-on"`). Stale `false` values from before the promotion behave
like "no saved value" and follow the new default. Only ids whose effective state
deviates from the default are pushed to Rust as overrides.

## Gating a regular in-app feature (TS code)

At the feature's decision point, check `isExperimentEnabled(id)` and
short-circuit when it returns `false`:

```ts
import { isExperimentEnabled } from '@/features/experiments/experimentsRegistry';

export function isNativeAutoSupportsAvailable(): boolean {
  return isExperimentEnabled('native-auto-supports');
}
```

For a one-shot action the check is the whole gate — when the experiment is off,
fall through to the released behavior (or return early):

```ts
export function handleApplyAutoSupports() {
  if (!isExperimentEnabled('native-auto-supports')) {
    // released fallback path
    return;
  }
  runExperimentalAutoSupports();
}
```

For a UI element that should disappear when the experiment is off, check at
mount and resubscribe so a toggle made elsewhere is reflected:

```ts
export function ExperimentalAutoSupportsPanel() {
  const [enabled, setEnabled] = React.useState(() => isExperimentEnabled('native-auto-supports'));

  React.useEffect(() => subscribeToExperiments(() => {
    setEnabled(isExperimentEnabled('native-auto-supports'));
  }), []);

  if (!enabled) return null;
  return <Panel />;
}
```

`subscribeToExperiments` returns an unsubscribe function — return it from the
effect so the subscription is torn down on unmount (the Experiments Settings
tab follows this same pattern).

## Gating Rust code

The manifest is the shared source of truth both sides read: `experiments.json`
is embedded into Rust at compile time (`include_str!` in
`src-tauri/src/experiments.rs`, the same pattern as the complex-plugin
allowlist), so Rust natively knows every experiment and its `defaultEnabled`.
Only the user's *overrides* (toggles that differ from the default) live in the
webview's `localStorage`, which **Rust can't read directly** — the frontend
pushes that minimal delta into Rust. Three patterns gate Rust behavior:

**1. Don't call the gated command.** The simplest gate is a TS `isExperimentEnabled`
check before the `invoke` — when the experiment is off, the Rust command is never
reached and its work never runs.

**2. Pass experiment-dependent state into the command as arguments.** When a
command must *adapt* to the experiment state rather than be skipped, pass the
relevant state or allowed-set from the frontend. This is how the native open
dialog hides gated file types: the frontend passes `getNativeSceneDialogExtensions()`
(which excludes `.solarlunar` while the example experiment is off) to
`pick_open_files`, and Rust uses that list for the "Scene Files" filter instead
of its compiled-in const.

```ts
// frontend — only the enabled scene extensions reach Rust
await pickOpenFilesWithNativeDialog('scene', true, getNativeSceneDialogExtensions());
```

```rust
// Rust honors the frontend-provided allow-list (falls back to the compiled const)
fn build_open_dialog_with_filters(category: &str, scene_extensions: Option<&[String]>) { ... }
```

**3. Rust-side enforcement (defense in depth).** When a command must guard
itself (e.g. it is reachable without a TS check), it checks the effective
experiment state. The defaults come from the embedded manifest; the user's
overrides arrive automatically: `ExperimentsNativeSync` (mounted at the app
root in `src/app/layout.tsx`) pushes `getExperimentOverrides()` — only ids whose
toggled state differs from the manifest default — to Rust on startup and
whenever an experiment is toggled, via the `set_experiment_overrides` command.
Rust merges those overrides over the manifest defaults in managed
`ExperimentsState` (`src-tauri/src/experiments.rs`); `is_experiment_enabled`
returns the override when present, else the manifest default. A gated command
takes the state and checks it at the top:

```rust
use tauri::State;
use crate::experiments::{self, ExperimentsState};

#[tauri::command]
async fn gated_command(state: State<'_, ExperimentsState>, ...) -> Result<(), String> {
    if !experiments::is_experiment_enabled(&state, "native-auto-supports") {
        return Err("this feature is experimental and not enabled".to_string());
    }
    // ...
}
```

To add a new gated Rust command: add it to the `generate_handler!` list in
`src-tauri/src/main.rs` (the `ExperimentsState` is already managed) and take a
`State<ExperimentsState>` argument to check.

## Gating a plugin

Declare the plugin id(s) in the experiment's `gatedPlugins`. The plugin registry
getters then filter them automatically:

- `getBuiltinComplexPluginDefinitions()` — `src/features/plugins/builtinComplexPlugins.ts`
- `getBuiltinComplexPluginFileTypeHandlers()` — `src/features/plugins/builtinComplexPluginFileTypeHandlers.ts`

Consumers must read through these getters, not the raw
`GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS` const, or the gate is bypassed.
The example `df-solarlunar-import` gate also keeps `.solarlunar` out of the
import surfaces that list extensions: the native open dialog (frontend-passed
`sceneExtensions`) and the browser scene picker (`getWebSceneAcceptString()`,
which reflects enabled experiments). The native-dialog side is *Gating Rust
code* below.

## Constraints

- **Reload semantics.** Gating is evaluated at module load / first render.
  Toggling an experiment requires a reload to take effect; the Settings tab
  says so.
- **Leaf registry.** `experimentsRegistry.ts` must stay a leaf module (no
  imports from the plugins feature or other features).
- **Read the manifest through the getters.** Module-level extension lists in
  `pluginFileTypeExtensions.ts` and `fileHandling.ts` derive from the filtered
  getter so they stay in lockstep with the gate.

## Settings UI

Settings → Experiments renders one card per experiment with an ON/OFF toggle.
The first time the tab is entered in a launch, an ORA no-warranty / no-liability
disclaimer modal (rendered via a portal) gates the content; after the user
acknowledges it is not shown again for that launch. Closing the Settings modal
after toggling an experiment shows a restart prompt (experiment changes apply on
reload) with an unsaved-changes warning. The Settings modal always reopens on the
General tab, not the last-active tab.

## Verification

- `npm run test` — registry tests live at `src/features/experiments/__tests__/experimentsRegistry.test.ts`
- `npx tsc --noEmit`
- `cargo check --manifest-path src-tauri/Cargo.toml` — when touching the native dialog override

## Related pages

- `dev/plugins-framework.md`
