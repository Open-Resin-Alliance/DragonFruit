# Shader Customization (Shader Type Dropdown + Preview + Per-Shader Settings) Development Plan

## Overview
We want to give users multiple ways to view the model so it’s easier to see details (especially supports and thin geometry) under different lighting/shading styles.

The goal is to add a **Shader Type** dropdown in **Settings → Mesh Settings**, plus:
- A **small preview** so users can quickly understand what each shader looks like.
- A **settings panel** that changes based on the selected shader type.

We also want the top of this UI to be a very clear “visual control center”:
- A **1:1 square Shader Preview canvas** (live preview)
- Next to it, a **1:1 square embedded color picker UI** (not the OS/browser color popup)
- Changing the shader type or color updates the preview immediately.

From a user experience perspective:
1. User opens **Settings → Mesh Settings**.
2. At the top of the Appearance/visual section, they select a **Shader Type** from a dropdown.
3. The UI immediately updates:
   - The model rendering changes.
   - A small preview shows what the chosen shader looks like.
   - A set of controls relevant to that shader appears (and unrelated controls hide).

Initial shader types to support:
- **Soft Clay (Lit)**: readability-first shaded look (diffuse, minimal glare)
- **Matcap**: sculpt/app-like “baked lighting texture” look
- **Flat / Unlit**: color-only look (max clarity, minimal lighting)
- **Toon**: stylized bands (readable edges/shape)
- **Normal (Debug)**: normal-direction coloring
- **Wireframe**: show mesh edges
- **X-ray**: semi-transparent look to see overlaps/inner structures

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [x] **Phase 1: Foundation (State + UI skeleton)**
    - [x] Define the set of supported shader types (final list + user-facing names).
    - [ ] Create a dedicated shader directory and one-file-per-shader structure (no “giant shader file”):
        - [ ] Create shader implementation modules under:
            - [x] `src/features/shaders/mesh/` (one file per shader)
        - [ ] Create shader settings panel components under:
            - [ ] `src/components/settings/meshSettings/shaders/` (one file per shader panel)
        - [ ] `MeshSettingsTab` will import the selected shader module/panel and render it.
    - [x] Add a new “Shader Type” dropdown to **`src/components/settings/MeshSettingsTab.tsx`** above Mesh Color.
    - [x] Add the “two squares” layout container in Mesh Settings:
        - [x] Left: 1:1 **Shader Preview** square
        - [x] Right: 1:1 **Embedded Color Picker** square
    - [x] Decide where shader settings live in app state:
        - [x] Add a `shaderType` state value to the scene manager (recommended: `useSceneCollectionManager` because it’s the active code path in `page.tsx`).
        - [x] Add initial per-shader settings fields in state (wireframe thickness, x-ray opacity).
    - [x] Decide how the embedded color picker is implemented:
        - [x] Confirm we are **not** using the OS/browser popup.
        - [x] Add a small React color picker dependency (the repo currently has none in `package.json`).
        - [x] Wire it so the preview updates live.
    - [x] Add Apply/Cancel draft workflow so main-canvas changes only commit on Apply.

- [x] **Phase 2: Rendering integration (material selection)**
    - [x] Identify the exact place materials are chosen:
        - Current model material is created inside **`StlMesh`** in `src/components/scene/SceneCanvas.tsx` as a `meshStandardMaterial`.
        - Lighting is defined in `Lights(...)` in the same file.
    - [x] Implement a material selection mechanism in `StlMesh` based on `shaderType`:
        - [x] Keep clipping plane support consistent.
        - [x] Keep selection tint behavior consistent (currently via emissive when selection highlight mode is `tint`).
        - [x] Preserve vertex colors (painted/analysis coloring) where it makes sense.
    - [x] Add minimal defaults for each shader type so each mode “works” before adding full settings.

- [x] **Phase 3: Shader preview + embedded color picker (UI-only)**
    - [x] Implement the shader preview using the **same mini-canvas pattern** used by the Support Settings preview:
        - [ ] Support reference components:
            - [ ] `src/supports/Settings/AnatomyPreview/SupportAnatomyPreviewSlot.tsx`
            - [ ] `src/supports/Settings/AnatomyPreview/SupportAnatomyPreviewCanvas.tsx`
            - [ ] `src/supports/Settings/AnatomyPreview/AnatomyPreviewConfig.ts`
        - [ ] Create an equivalent pair for shaders (names TBD) that renders a small preview scene.
    - [x] Preview content should be stable and always available:
        - [x] Use a simple primitive (sphere/torus/knot) so preview works even if no STL is loaded.
        - [x] Apply `shaderType` + initial per-shader settings + `meshColor` to the preview.
    - [x] Layout requirement:
        - [x] The preview is a **true 1:1 square**.
        - [x] The embedded color picker is a **true 1:1 square** next to it.
        - [x] Preview changes update live; main-canvas changes commit on Apply.

- [x] **Phase 4: Per-shader settings panels**
    - [x] Implement a settings area that changes depending on shader type.
    - [x] For each shader type, add only the settings that actually affect that shader.

    - [x] **Soft Clay (Lit) settings**
        - [x] Lightness
        - [x] Contrast
        - [x] Surface Roughness
        - [ ] Optional: none (not needed)

    - [ ] **Matcap settings**
        - [ ] Matcap selection (a small list of built-in matcaps)
        - [ ] Optional: intensity/tint (if we choose to support tinting)

    - [ ] **Flat / Unlit settings**
        - [ ] Mesh Color (still useful)
        - [ ] Optional: “Use vertex colors” toggle (for painted/analysis overlays)

    - [ ] **Toon settings**
        - [ ] Band count or “toon steps” (if supported by implementation)
        - [ ] Optional: outline thickness (if/when outline rendering is added)

    - [ ] **Normal (Debug) settings**
        - [ ] Usually none (keep it simple)

    - [x] **Wireframe settings**
        - [x] Wireframe thickness
        - [ ] Wireframe opacity
        - [ ] Optional: “overlay wireframe on top of shaded” (nice-to-have; may require two-pass rendering)

    - [x] **X-ray settings**
        - [x] Opacity
        - [ ] Optional: depth-write toggle (controls whether back faces show through)

- [ ] **Phase 5: Persistence + defaults**
    - [ ] Decide what should persist in `localStorage`:
        - [ ] `shaderType`
        - [ ] per-shader settings
        - [ ] common mesh appearance settings (Lightness/Contrast/Roughness + Mesh Color)
    - [ ] Add safe default fallbacks when stored values are missing or invalid.
    - [ ] Add a clear “Restore Defaults” action to reset persisted values back to app defaults.

- [ ] **Phase 6: Polish + QA**
    - [ ] Make sure the UI never shows irrelevant controls (hide/show based on shader type).
    - [ ] Validate that the preview and main scene always match.
    - [ ] Confirm performance is acceptable (especially for wireframe and toon).
    - [ ] Confirm analysis overlays/vertex colors still behave correctly.

## Technical Details

### Relevant Files (Current Integration Points)
- `src/components/scene/SceneCanvas.tsx`
  - `Lights(...)` currently defines ambient + directional + hemisphere lighting.
  - `StlMesh(...)` currently uses `meshStandardMaterial` with:
    - `vertexColors`
    - `roughness={materialRoughness}`
    - clipping planes
    - selection tint via emissive
- `src/features/scene/useSceneCollectionManager.ts`
  - Holds the active rendering-related settings today:
    - `ambientIntensity`, `directionalIntensity`, `materialRoughness`
    - `meshColor` (per active model)
- `src/app/page.tsx`
  - Wires scene state into `TopBar` and `SceneCanvas`.
- `src/components/settings/SettingsModal.tsx`
  - Hosts tabs and passes appearance settings into `UISettingsTab`.
- `src/components/settings/MeshSettingsTab.tsx`
  - Current UI control surface for mesh color + lighting + roughness (and where Shader Type + preview will live).

### Proposed Shader Directory Structure (One File Per Shader)
We expect shader implementations to grow large. To keep the project maintainable, each shader will live in its own file.

- **Shader implementations (rendering logic):** `src/features/shaders/mesh/`
  - `softClay.ts`
  - `matcap.ts`
  - `flatUnlit.ts`
  - `toon.ts`
  - `normalDebug.ts`
  - `wireframe.ts`
  - `xray.ts`

- **Shader settings UI panels (settings + preview wiring):** `src/components/settings/meshSettings/shaders/`
  - `SoftClaySettingsPanel.tsx`
  - `MatcapSettingsPanel.tsx`
  - `FlatUnlitSettingsPanel.tsx`
  - `ToonSettingsPanel.tsx`
  - `NormalDebugSettingsPanel.tsx`
  - `WireframeSettingsPanel.tsx`
  - `XraySettingsPanel.tsx`

`MeshSettingsTab` will:
- Render the Shader Type dropdown
- Render the two-square (preview + embedded color picker) layout
- Render the settings panel component for the currently selected shader

### Support Preview Pattern (Reference Implementation)
We will mirror this approach for the shader preview so we’re consistent with the app’s existing “mini renderer” pattern:
- `src/supports/Settings/SupportSidebar.tsx` (shows how the preview is embedded in a small slot)
- `src/supports/Settings/AnatomyPreview/SupportAnatomyPreviewSlot.tsx` (the small bordered container)
- `src/supports/Settings/AnatomyPreview/SupportAnatomyPreviewCanvas.tsx` (the dedicated preview renderer using `@react-three/fiber`)
- `src/supports/Settings/AnatomyPreview/AnatomyPreviewConfig.ts` (how camera + lighting are configured for the preview)

### Proposed State Additions
We need to add shader selection + settings into the “scene settings” layer (recommended: `useSceneCollectionManager`).

- **New state fields** (conceptually):
  - Shader Type: one of [Soft Clay, Matcap, Flat, Toon, Normal, Wireframe, X-ray]
  - Shader Settings: a per-type configuration object

This is important so:
- The UI can update the scene.
- The scene can pass the selected shader to `SceneCanvas`.
- The preview can share the same settings.

### Proposed UI/Component Structure
- Keep UI code in `src/components/settings/`.
- Consider splitting shader UI into small subcomponents for readability:
  - `src/components/settings/meshSettings/ShaderSelector.tsx`
  - `src/components/settings/meshSettings/ShaderPreview.tsx`
  - etc.

(We can keep it in `UISettingsTab.tsx` initially, then split once it grows.)

### Rendering Strategy Notes (Important)
- **Current material is `meshStandardMaterial`**. That’s a “lit” look and is why lighting can feel harsh.
- **Vertex colors** appear to be important for painting/analysis overlays (see `clearPaintToBase` usage in scene managers). We should preserve `vertexColors` where possible.
- **Clipping planes** are used for cross-section slicing; each shader material must support clipping planes or be compatible with the existing clipping approach.
- **Selection highlighting** currently depends on emissive values in the standard material; for materials that don’t support emissive, we will need a fallback (e.g., outline or tinting via color).

### Shader/Material Mapping (Implementation Target)
This is the mapping we will implement in `SceneCanvas` / `StlMesh`:
- **Soft Clay (Lit):** Standard material but tuned for readability (metalness=0, higher roughness, softer lighting defaults)
- **Matcap:** Matcap material using a chosen matcap texture
- **Flat / Unlit:** Basic material (no lighting)
- **Toon:** Toon material (optionally with a gradient map)
- **Normal:** Normal material
- **Wireframe:** Basic/standard material with wireframe enabled
- **X-ray:** Transparent material with depth settings tuned for see-through

### Preview Strategy
Recommended: a small preview canvas in the settings UI showing a simple shape, implemented using the same embedded-mini-canvas approach as the Support Settings preview. This avoids edge cases where no model is loaded and still gives the user a reliable “what will it look like” preview.
