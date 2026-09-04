//! Rust-side view of the Experiments manifest plus user overrides.
//!
//! The manifest (`src/config/experiments.json`) is embedded into this crate at
//! compile time (the same `include_str!` pattern as the complex-plugin
//! allowlist in `plugin_registry.rs`), so Rust natively knows every experiment
//! and its `defaultEnabled` — it does not depend on the frontend to tell it
//! what experiments exist.
//!
//! User *overrides* (toggles that differ from the manifest default) live in the
//! webview's `localStorage`, which Rust cannot read. The frontend pushes only
//! that delta here via `set_experiment_overrides`; Rust computes the effective
//! enabled state as `default ⊕ override`. For users who never open
//! Settings → Experiments the override map is empty and the manifest defaults
//! rule.
//!
//! Gated Rust commands enforce an experiment gate themselves (defense in depth)
//! with `is_experiment_enabled`, rather than relying solely on the frontend
//! choosing not to call them.
//!
//! See `docs/dev/experiments-framework.md` ("Gating Rust code").

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use tauri::State;

const EXPERIMENTS_MANIFEST_JSON: &str = include_str!("../../src/config/experiments.json");

/// Compile-time experiment declarations (`experiments.json`), reduced to what
/// gating needs: the set of known experiment ids and which are default-enabled.
struct ExperimentManifest {
    known_ids: HashSet<String>,
    default_enabled: HashSet<String>,
}

static MANIFEST: OnceLock<ExperimentManifest> = OnceLock::new();

fn manifest() -> &'static ExperimentManifest {
    MANIFEST.get_or_init(|| {
        let parsed: RawManifest = match serde_json::from_str(EXPERIMENTS_MANIFEST_JSON) {
            Ok(parsed) => parsed,
            Err(error) => {
                // The manifest is embedded at compile time, so a parse failure
                // means `experiments.json` was hand-edited into an invalid
                // state. Log it and degrade to an empty manifest rather than
                // panicking: every gate closes and only released behavior runs.
                log::error!(
                    "[experiments] failed to parse embedded experiments.json ({error}); treating all experiments as disabled"
                );
                return ExperimentManifest {
                    known_ids: HashSet::new(),
                    default_enabled: HashSet::new(),
                };
            }
        };
        let mut known_ids = HashSet::new();
        let mut default_enabled = HashSet::new();
        for entry in parsed.experiments {
            known_ids.insert(entry.id.clone());
            if entry.default_enabled {
                default_enabled.insert(entry.id);
            }
        }
        ExperimentManifest {
            known_ids,
            default_enabled,
        }
    })
}

#[derive(Deserialize)]
struct RawManifest {
    #[allow(dead_code)]
    version: u32,
    experiments: Vec<RawExperiment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawExperiment {
    id: String,
    #[serde(default)]
    default_enabled: bool,
}

/// User overrides pushed from the frontend: experiment id → explicit enabled
/// state. Only experiments whose toggled state differs from the manifest
/// default appear here; empty for users who never touch Settings → Experiments.
#[derive(Default)]
pub struct ExperimentsState(Mutex<HashMap<String, bool>>);

/// Replaces the user-override map. Called by the frontend on startup and
/// whenever the user toggles an experiment (see
/// `src/features/experiments/syncExperimentsToNative.ts`).
#[tauri::command]
pub fn set_experiment_overrides(
    state: State<'_, ExperimentsState>,
    overrides: HashMap<String, bool>,
) {
    set_overrides(&state, overrides);
}

fn set_overrides(state: &ExperimentsState, overrides: HashMap<String, bool>) {
    if let Ok(mut guard) = state.0.lock() {
        *guard = overrides;
    }
}

/// Returns true when the given experiment id is effectively enabled: a user
/// override wins, otherwise the manifest's `defaultEnabled`. Unknown ids are
/// never enabled. Gated commands call this at the top and return an error when
/// it is false.
///
/// Currently unused by built-in commands (the chitubox gate is enforced in the
/// frontend), but it is the public seam a future gated Rust command reaches for.
#[allow(dead_code)]
pub fn is_experiment_enabled(state: &ExperimentsState, id: &str) -> bool {
    let manifest = manifest();
    if !manifest.known_ids.contains(id) {
        return false;
    }
    if let Ok(guard) = state.0.lock() {
        if let Some(&enabled) = guard.get(id) {
            return enabled;
        }
    }
    manifest.default_enabled.contains(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gating mechanism must be driven entirely by the embedded manifest.
    /// No test here hardcodes an experiment id, so adding, renaming, or removing
    /// experiments in `experiments.json` never requires touching this file —
    /// expectations are derived from the manifest itself.
    #[test]
    fn defaults_follow_the_embedded_manifest() {
        let state = ExperimentsState::default();
        let manifest = manifest();
        for id in &manifest.known_ids {
            assert_eq!(
                is_experiment_enabled(&state, id),
                manifest.default_enabled.contains(id),
                "experiment \"{id}\" should default to its manifest defaultEnabled"
            );
        }
    }

    #[test]
    fn user_override_wins_over_manifest_default() {
        let manifest = manifest();
        let Some(id) = manifest.known_ids.iter().next() else {
            return; // manifest declares no experiments to override
        };
        let state = ExperimentsState::default();
        let default = is_experiment_enabled(&state, id);
        set_overrides(&state, HashMap::from([(id.clone(), !default)]));
        assert_eq!(is_experiment_enabled(&state, id), !default);
    }

    #[test]
    fn unknown_experiment_ids_are_never_enabled() {
        let state = ExperimentsState::default();
        set_overrides(
            &state,
            HashMap::from([("does-not-exist".to_string(), true)]),
        );
        assert!(!is_experiment_enabled(&state, "does-not-exist"));
    }

    #[test]
    fn replacing_clears_previous_overrides() {
        let manifest = manifest();
        let Some(id) = manifest.known_ids.iter().next() else {
            return; // manifest declares no experiments to override
        };
        let state = ExperimentsState::default();
        set_overrides(&state, HashMap::from([(id.clone(), true)]));
        assert!(is_experiment_enabled(&state, id));
        set_overrides(&state, HashMap::new());
        assert_eq!(
            is_experiment_enabled(&state, id),
            manifest.default_enabled.contains(id)
        );
    }
}
