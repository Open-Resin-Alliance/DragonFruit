# Support Settings Anatomy Preview

This page explains the Support Settings “Anatomy Preview” panel: what it’s for in Dragonfruit, the UX contract it supports, and how it’s wired internally so you can safely extend or refactor it.

## Context (what this preview is actually for)

Dragonfruit generates and edits **3D printing supports**: small pieces of geometry that connect the model to a base/raft so it can print successfully.

The **Support Settings** panel is where you tune the parameters that control the shape and behavior of those supports. Examples include:

- Tip/contact sizing (how big the contact is where the support touches the model)
- Tip cone length/angle (how the support transitions down into the shaft)
- Shaft/trunk diameter and joint count (the main body of the support)
- Roots/base dimensions (how the support meets the build plate / raft)
- Raft parameters (when the active “kind” is a raft)

These values are usually just numbers (millimeters, counts, etc.). Without a visual reference it’s easy to misunderstand what a field affects, or to waste time doing “change a number → rebuild → inspect in the main scene” loops.

The **Anatomy Preview** solves that by rendering a small, canonical “preview support” next to the settings, and by making that preview react to which control you’re currently editing.

## Purpose

- **Explain what each setting controls in concrete geometry terms**
  - When you focus a specific Support Settings input, the preview highlights the *support part* that input controls (tip/contact vs. cone vs. shaft/joints vs. roots/base vs. raft wall/base).
- **Make tuning faster and less error-prone**
  - While you type/change a value, the preview updates immediately so you can see the effect without having to hunt for a real support in the main scene.
- **Make the settings panel self-explanatory**
  - The preview is meant to teach “support anatomy” (what the parts are and where they are) so that the names in the settings UI map to something visible.

## UX contract (what users should experience)

- **Single card layout**
  - Preview window on the left.
  - Support Settings controls on the right.
- **Focus-driven behavior (not hover-driven)**
  - Entering a control (focusing the input) drives the preview.
  - Merely hovering should not cause camera motion or highlights.
- **Camera + highlight guidance**
  - The preview camera moves to frame the relevant region for the focused setting.
  - The relevant part is highlighted and the rest is visually de-emphasized.
- **Live updates while editing**
  - Changing a value updates the preview immediately.
- **Return to rest on blur**
  - When focus leaves that setting row, the preview returns to a neutral “home” view and clears the highlight.

## Quick-start (how to work on it safely)

- **If you add a new setting row** and want it to drive the preview:
  - Add focus handlers to that row using a consistent key string.
  - Map that key to a camera focus state.
  - (Optional) Update highlight logic to light up the correct anatomy part.
- **If you refactor**:
  - Keep “focus key → camera focus + highlight” as the core invariant.
  - Avoid pulling preview logic into generic “utils”; this is a feature-level component.

## Where it lives

- `src/supports/Settings/AnatomyPreview/SupportAnatomyPreviewSlot.tsx`
  - The visual “window” container for the preview.
- `src/supports/Settings/AnatomyPreview/SupportAnatomyPreviewCanvas.tsx`
  - The actual preview renderer (dedicated R3F canvas) and most preview logic.
- `src/supports/Settings/AnatomyPreview/AnatomyPreviewCameraLogic.ts`
  - Camera focus dispatcher (routes to the current preview type).
- `src/supports/Settings/AnatomyPreview/AnatomyPreviewConfig.ts`
  - Tuning values (camera defaults, lighting, highlight colors, preview tuner toggle).
- `src/supports/Settings/AnatomyPreview/previewState.ts`
  - Tiny shared state store for “active setting key”.

### Per-preview-type folders (this is the isolation boundary)

Each preview type owns its own logic inside a single folder. If you are changing behavior for one preview type, you should normally be editing files only inside that type’s folder.

- `src/supports/Settings/AnatomyPreview/PreviewTypes/Trunk/`
  - Trunk preview logic (currently the “support-style” preview).
  - `camera.ts` = trunk preview camera poses + key mapping.
- `src/supports/Settings/AnatomyPreview/PreviewTypes/Raft/`
  - Raft preview logic.
  - `camera.ts` = raft preview camera poses + key mapping.

## High-level architecture

### Separate Canvas (design choice)

The preview is rendered in its own `@react-three/fiber` `Canvas`. This avoids scissor/viewport alignment problems and keeps the preview camera + lighting isolated from the main scene.

### Core idea: “active setting key”

The preview does not “know” about UI components directly. Instead:

- The Settings UI sets an **active setting key** when a row gains focus.
- The preview subscribes to that key.
- That key drives:
  - camera target/zoom (focus routines)
  - anatomy highlighting (what turns pink vs. what dims)

## Data flow (end-to-end)

### 1) Settings UI publishes focus

- Settings rows attach focus/blur handlers that call:
  - `setAnatomyPreviewActiveSettingKey(key)` on focus
  - `setAnatomyPreviewActiveSettingKey(null)` when focus leaves the row

This wiring currently happens in:

- `src/supports/Settings/SupportSidebar.tsx` (main settings)
- `src/supports/Settings/components/RaftSettingsCard.tsx` (raft settings)

Important behavior detail:

- Blur handling ignores “internal blur” (tabbing between controls inside the same row) by checking whether the next focused element is still within the row.

### 2) Preview subscribes to state

`SupportAnatomyPreviewCanvas.tsx` reads:

- global support settings (via `useSyncExternalStore(subscribeToSettings, ...)`)
- anatomy preview state (via `useSyncExternalStore(subscribeToAnatomyPreviewState, ...)`)
- the current “support kind” (trunk/branch/leaf/stick/twig/raft)
- raft settings (for raft-only preview meshes)

### 3) Camera focus state is selected

Camera focus is selected in two steps:

1) `AnatomyPreviewCameraLogic.ts` selects the correct preview type based on the active kind (example: `trunk` vs `raft`).

2) The selected preview type’s `camera.ts` returns the focus state for the active setting key.

- When `activeSettingKey` changes, the preview begins animating camera values toward the selected pose.
- When there is no focused key, it uses the kind’s HOME pose (`getTargetFocusState(activeKind, null)`).
- The raft preview has its own HOME pose, which is defined only in the raft preview folder.
- The preview’s initial framing and the tuner’s “Reset to Home” also use the kind’s HOME pose (to avoid hard-coding the same camera values in multiple places).

### 4) Camera animation runs

`SupportAnatomyPreviewCanvas.tsx` runs a small interpolation loop (position, target, zoom) while `isAnimating` is true.

Notes:

- The animator can be interrupted if the user is interacting with the preview camera (when interaction is enabled).
- The code includes *dynamic zoom behavior* for specific keys:
  - `tip.contactDiameterMm` dynamically changes zoom based on the current diameter.
    - If cone-angle control shifts the preview tip horizontally, contact diameter focus also adjusts X framing so the tip stays in view.
  - `tip.lengthMm` dynamically adjusts zoom and target to keep the cone framed as length changes.

### 5) The preview model is rebuilt

The preview “support” is not the main scene support. It is a small, deterministic model built specifically for preview:

- For trunk (and raft) it uses the trunk builder with overrides.
- For branch/leaf it builds a minimal parent knot and builds the child support.
- For stick/twig it uses their builders and shows the segment + contacts.

The goal is a stable, easy-to-read model that still uses the same rendering pipeline, so it looks like the real thing.

Important preview-only behavior detail:

- When the cone-angle control changes under Adaptive/Locked modes, the preview keeps the trunk centered and moves the tip instead.

### 6) Highlighting is applied

Highlight behavior is driven by the active key:

- The preview computes `anatomyOverrides` (colors per anatomy part) so the “active” region is highlighted while others are dimmed.
- For raft mode, the preview builds dedicated preview meshes and changes their materials based on which raft key is focused.

## Configuration knobs

Centralized in `AnatomyPreviewConfig.ts`:

- **Camera**: type (ortho vs perspective), initial pose, zoom.
- **Lighting**: ambient + key + fill.
- **Rendering mode**:
  - “ghost preview” style vs “real support” style
  - preview tuner overlay toggle
- **Colors**:
  - highlight color
  - dim color
  - normal color

## Preview Tuner (debug overlay)

The preview tuner is a developer-facing overlay intended for rapid iteration:

- Lets you adjust camera pose + zoom live.
- Can copy tuned values out for persistence.
- Camera-only controls are intended to be copied back into the per-preview-type `camera.ts` files.
- Includes an **Auto Camera** toggle:
  - **On**: focusing a setting row moves the camera to that setting’s focus pose.
  - **Off**: camera is locked 1:1 for tuning/copying values.

It is controlled by a single config toggle:

- `ANATOMY_CONFIG.rendering.showPreviewTuner`

## Known mismatches / cleanup opportunities

These are not necessarily “bugs”, but they matter when refactoring.

- **Interactivity**:
  - Original intent: preview window should be non-interactive.
  - Current behavior: interaction is toggleable and currently enabled via config.
  - If you want strict non-interactive behavior, ensure interaction is disabled and that pointer events do not leak through.

- **“Quiet” rendering**:
  - Original intent: no idle render loop when not animating/changing.
  - Current behavior: the camera animator stops, but the R3F canvas still runs under the default render loop unless it is explicitly switched to demand-based rendering.
  - If performance becomes a concern, this is a primary place to improve.

- **`domRect` in `previewState.ts`**:
  - The state store still includes `domRect`, but the Separate Canvas approach removed the need for DOM-based scissor math.
  - This field may now be legacy and a candidate for removal during cleanup.

## How to extend it (common tasks)

### Add preview focus for a new setting

- Choose a stable key string (consistent with how other settings are keyed).
- In the Settings UI row:
  - publish that key on focus
  - clear it on blur (with the “internal blur” guard)
- In the correct preview type folder:
  - If the setting is for **trunk/support preview**, update:
    - `src/supports/Settings/AnatomyPreview/PreviewTypes/Trunk/camera.ts`
  - If the setting is for **raft preview**, update:
    - `src/supports/Settings/AnatomyPreview/PreviewTypes/Raft/camera.ts`
- In `SupportAnatomyPreviewCanvas.tsx`:
  - if the key should highlight a new/different anatomy region, update the highlight mapping logic

### Add a new support kind to preview

- Ensure the preview can build a minimal deterministic version of that support kind.
- Prefer reusing the same builder/rendering pipeline so the preview matches main-scene visuals.
- Create a new preview type folder only when you actually need it (no placeholders).
  - Example shape:
    - `src/supports/Settings/AnatomyPreview/PreviewTypes/<NewType>/camera.ts`
    - (later) add `<NewType>` render/model/highlight files only if that type diverges.
- Wire it into the dispatcher:
  - Update `src/supports/Settings/AnatomyPreview/AnatomyPreviewCameraLogic.ts` to route that kind to the new preview type’s `camera.ts`.

## Development rules (keep it organized)

- **One preview type = one folder**
  - If you’re changing raft preview behavior, keep changes inside `PreviewTypes/Raft/`.
  - If you’re changing trunk preview behavior, keep changes inside `PreviewTypes/Trunk/`.
- **Keep top-level files “thin”**
  - `SupportAnatomyPreviewCanvas.tsx` should primarily orchestrate the canvas and delegate to preview-type modules.
  - `AnatomyPreviewCameraLogic.ts` should stay a small router/dispatcher.
- **Avoid cross-type coupling**
  - Don’t put raft-only logic into the trunk folder.
  - Don’t put trunk-only logic into the raft folder.
  - If something is truly shared across multiple preview types, keep it at the AnatomyPreview root (not inside a type folder).

## Design invariants (do not break casually)

- **The preview is driven by settings focus**, not scene selection.
- **The preview uses a dedicated canvas** (no scissor/viewport coupling to the main scene).
- **Camera focus is deterministic** (key → pose mapping; no “guessy” behavior).
- **Highlighting explains intent** (what the user is editing) more than it aims for perfect physical realism.
