# Support Settings Anatomy Preview (Mini-Viewport) Development Plan

## Overview
This feature improves the Support Settings panel by adding a small “support anatomy” 3D preview on the left side of the settings card. The preview is meant to help end users understand what each setting affects (tip/contact, cone, shaft/trunk, joints, roots/base).

The preview should look identical to supports in the main scene. To accomplish that, the preview will be rendered in a **separate, dedicated WebGL canvas** (Separate Canvas approach). This guarantees perfect 1:1 layout alignment with the UI without complex viewport mathematics.

### Layout Requirement (must match)
- The end result is a single consolidated Support Settings card.
- Left side: the preview window.
- Right side: one unified settings area (the “green box”) that contains all settings in one place.
- Internally, individual setting sections (Tip/Shaft/Roots/Base/Etc.) can remain in separate files/components for maintainability, but they must render as sections inside the single card (not separate stacked cards).

### Exact Visual Structure (must match)
- The card has a single outer border/background.
- The card body is split into two columns:
  - Left column: the preview window.
  - Right column: the unified settings area (“green box”).
- The unified settings area is one continuous vertical stack (no inner scrolling in the settings box).
- Each “section” inside the unified settings area is a simple section header + rows, not its own separate card container.
- All input rows use a consistent compact pattern:
  - Label above the input.
  - Inputs are full-width within the settings column.
  - Special case: Cone Control Angle uses a dropdown, and when Adaptive is selected it shows an inline Offset input to the right.

### Right Column: Exact Settings Order (must match)
This list must match the UX you specified earlier. The right-side settings column contains ONLY these rows, in this exact top-to-bottom order:

1) Contact Diameter
- Setting: `tip.contactDiameterMm`

2) Contact Cone Length
- Setting: `tip.lengthMm`

3) Cone Control Angle
- Setting(s): `tip.coneAngleMode`
- If mode requires a numeric control (e.g. adaptive), that numeric value is: `tip.adaptiveConeAngleOffsetDeg`

4) Trunk Diameter
- Setting: `shaft.diameterMm`

5) Number of Default Joints
- Setting: `joint.defaultJointCount`

6) Roots Settings
- Settings (as a group):
  - `roots.diameterMm`
  - `roots.diskHeightMm`
  - `roots.coneHeightMm`

#### Out of Scope (must NOT appear in this card)
The supports codebase contains additional settings fields. They must not be added to this card unless you explicitly approve a future plan update.
Examples of out-of-scope fields include:
- Tip: `tip.bodyDiameterMm`, `tip.penetrationMm`, `tip.coneAngleDeg`, `tip.breakpointMm`, `tip.type`, and disk/sphere specialty fields.
- Shaft: `shaft.shape`, `shaft.secondaryDiameterMm`, `shaft.isStraight`, `shaft.maxAngleDeg`.
- Joints: `joint.ballDiameterMm`, `joint.maxRotationDeg`, `joint.maxSlideMm`.
- Roots: `roots.shape`, `roots.neckDiameterMm`, `roots.neckBlend`.
- Base flare, grid, mesh-to-mesh, raft settings.

### User Experience (non-technical)
- The Support Settings UI is one single card.
- The left side of the card contains a small preview window.
- The right side of the card contains all settings fields in one unified area (top-to-bottom).
- When the user focuses a specific setting field:
  - The preview camera smoothly zooms to the relevant part of the support.
  - The preview highlights the relevant part.
  - As the user changes the value, the preview updates live.
  - When focus ends, the camera returns to its default pose.
- The preview is “quiet” by default (no idle animation). It only renders/animates during the focus routine and while values change.

### Preview Behavior (must match)
This defines exactly how the camera/preview reacts to user interaction.

- Trigger: preview focus is driven by input focus (not hover).
- On focus of a setting row:
  - Start rendering (only while animating and while values are changing).
  - Camera transitions from Rest Pose to the focused anchor pose.
  - The relevant support part is visually highlighted.
- While the setting value changes:
  - The preview support updates live so the user sees the effect immediately.
  - The camera remains locked on the same anchor pose.
- On blur (leaving that setting row):
  - Camera transitions back to Rest Pose.
  - Highlight is removed.
  - Rendering stops once the camera returns to Rest Pose.

#### Timing (must match)
- Focus-in animation: 200ms ease-in-out.
- Focus-out animation: 250ms ease-in-out.
- No idle loop when not animating/changing.

#### Zoom framing rule (must match)
- Each focus anchor defines a target point and a target bounding sphere.
- The camera must frame the sphere with a fixed padding factor (20% padding).
- This avoids “guessing zoom strength” and makes the result deterministic.

### Why Separate Canvas (Nuclear Option)
- **Robustness**: Layout is handled entirely by the browser's CSS engine. No manual pixel math, no fighting scrollbars or zoom levels.
- **Simplicity**: Eliminated the entire class of bugs related to "unstable DOM reference rects".
- **Isolation**: Preview lighting and camera are isolated from the main scene, preventing side-effects.

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [x] **Phase 1: UX + Layout Foundation**
  - [x] Restructure the Support Settings UI into one consolidated card with a two-column layout (left preview window + right unified settings area).
  - [x] Add a dedicated “Preview Window” area on the left side of that single card that visually frames the preview.
  - [x] Ensure all settings render inside one unified area on the right side of the same card (not as separate stacked cards).
  - [x] Implement the exact top-to-bottom settings order listed in “Right Column: Exact Settings Order (must match)”.
  - [x] Decide interaction rules for that area (whether it should block clicks or pass clicks through to the canvas).
    - Decision: preview window is fully non-interactive (no orbit/spin/click behaviors) and blocks pointer events (no click-through to the main canvas).
  - [x] Define the list of settings that will drive preview focus routines (initial MVP list) (must match the exact order list).

- [x] **Phase 1: UX + Layout Foundation**
  - [x] Restructure the Support Settings UI into one consolidated card.
  - [x] Add a dedicated “Preview Window” area.

- [x] **Phase 2: Preview Rendering Architecture (Separate Canvas)**
  - [x] Create `SupportAnatomyPreviewCanvas` component (dedicated R3F Canvas).
  - [x] Mount it directly inside the `SupportAnatomyPreviewSlot`.
  - [x] Remove the old `SupportAnatomyPreviewPass` and scissor logic.

- [x] **Phase 3: Preview Content (Support Model + Camera)**
  - [x] Create a minimal “preview support” model that uses the same support rendering pipeline.
  - [x] Add a dedicated preview camera with a default “rest” pose.
  - [x] Define focus anchors and map settings.

- [x] **Phase 4: Focus Routines + Live Updates**
  - [x] Implement focus-driven behavior.
  - [x] Trigger preview camera focus routine on setting focus.
  - [x] Update preview geometry/materials live.
  - [x] Animate camera back to rest pose on blur.
  - [x] **Dynamic Zoom**: Implemented smart zoom for Tip Contact (zooms in/out based on diameter) and Cone Length.

- [x] **Phase 5: Refinement & Visuals (Anatomy Highlights)**
  - [x] **Granular Highlighting**:
    - **Tip Contact**: Pink when editing contact settings.
    - **Cone Body**: Pink when editing cone settings.
    - **Roots**: Pink when editing base/roots.
    - **Shaft/Joints**: Pink when editing shaft/joints.
  - [x] **Context Dimming**: Non-active parts fade to Light Grey.
  - [x] **Unified Configuration**: All colors/camera settings moved to `AnatomyPreviewConfig.ts`.
  - [x] **Preview Tuner**: Added "Preview Tuner" overlay (toggleable in config) for live tweaking.

## Technical Details

### Architecture (Separate Canvas)
We chose the **Separate Canvas** approach for robustness. The preview runs in its own `Canvas` (via `@react-three/fiber`) completely isolated from the main scene. This eliminates all viewport/scissor alignment bugs.

### Relevant Files
- **Canvas/Logic**:
  - `src/supports/Settings/AnatomyPreview/SupportAnatomyPreviewCanvas.tsx` (Main Entry)
  - `src/supports/Settings/AnatomyPreview/AnatomyPreviewCameraLogic.ts` (Focus/Zoom Math)
  - `src/supports/Settings/AnatomyPreview/AnatomyPreviewConfig.ts` (Configuration/Colors)
- **State**:
  - `src/supports/Settings/AnatomyPreview/previewState.ts` (Shares focus state)
- **UI Slot**:
  - `src/supports/Settings/AnatomyPreview/SupportAnatomyPreviewSlot.tsx` (DOM Mount point)

### Key Features Implemented
1.  **Smart Camera**:
    - Uses `AnatomyPreviewCameraLogic` to determine target position and zoom level.
    - Interpolates smoothly (physics-based lerp) between targets.
    - reacts to value changes (e.g. growing cone) by shifting the camera to keep the subject centered.

2.  **Anatomy Highlight System**:
    - `SupportBuilder` accepts `anatomyOverrides`.
    - `SupportAnatomyPreviewCanvas` maps the active setting key to specific override colors.
    - Colors are centralized in `AnatomyPreviewConfig.ts`.

3.  **Preview Tuner**:
    - A built-in debug overlay (toggle `showPreviewTuner` in config) allows realtime adjustment of camera angles, lighting, and dummy support parameters.
    - "Copy Config" button allows easy persistence of tuned values to the code.

4.  **Reactivity**:
    - Uses `useSyncExternalStore` for instant updates.
    - Input keys (Up/Down arrow, Typing) trigger immediate visual updates without react render lag.

### Future Improvements
- [ ] Add "Ghost" mode toggle in config to switch between Opaque and Transparent preview styles (supported in code, just needs UI/Config exposure if desired).

