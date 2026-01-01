# Docked Sidebar Settings Panel Development Plan

## Overview
Right now, Dragonfruit’s left-side UI uses “floating cards” that sit on top of the canvas. This works, but it wastes vertical space (because the cards don’t naturally fill the app height) and it makes spacing harder to manage across screen sizes.

This plan converts the app’s settings UI into a single, stationary docked sidebar that:

- Reserves the full vertical height of the app (below the top header) for settings and related panels.
- Eliminates the need for "floating panel" positioning offsets and shadow/spacing hacks.
- Creates a single, consistent place for settings UI rules (compact spacing, predictable width, scroll behavior) that apply across the whole app.

This layout should follow a Photoshop/Blender-style mental model:

- A thin tools area may exist on the far left (optional).
- The main work area (canvas) stays centered/primary.
- All adjustable settings and inspectors live in a stationary sidebar on the far right.
- The layer slider sits immediately to the left of the right settings sidebar.

User experience after the change:

- The right side becomes a full-height settings sidebar.
- The settings sidebar is always present across the whole app.
- When the user changes modes (Prepare / Analyze / Support / etc.), the visible settings inside the sidebar change to match the active mode.
- If content exceeds the available height, only the sidebar content area scrolls (not the whole page/canvas).
- The 3D/canvas work area always occupies the remaining width to the left of the settings sidebar.
- The layer slider is positioned just to the left of the settings sidebar.

Migration principle (critical):

- We must preserve the existing settings layout and preview behavior exactly.
- This migration must be done in small, manageable steps.
- For each migrated panel, we will directly reference the existing implementation and copy it over exactly (no redesign, no interpretation).
- Each migration step is “gated”: do not proceed to the next panel until the current one visually matches the original.

Compartmentalization principle (critical):

- Do not dump layout/sidebar logic into `src/app/page.tsx`.
- Prefer using/expanding existing layout primitives (example: `src/components/ui/Sidebar.tsx`) and/or introducing a dedicated layout component if needed.
- `page.tsx` should focus on composition/wiring, not UI layout implementation details.

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [x] **Phase 1: Layout Foundation (Docked Sidebar)**
    - [x] Identify the authoritative “app shell” layout boundary where the header and canvas are composed.
    - [x] Introduce a docked right settings sidebar region that is full-height under the header.
    - [x] Place the layer slider immediately to the left of the right settings sidebar.
    - [x] Ensure the canvas/work area fills remaining width and does not get covered by the slider/sidebar.

- [x] **Phase 2: Create a Mode → Sidebar Content Composition Layer**
    - [x] Identify the authoritative “mode” source-of-truth (the state that selects Prepare/Analyze/Support/etc.).
    - [x] Create a single sidebar “slot” that renders exactly one mode-specific settings panel at a time.
    - [x] Ensure switching modes replaces the sidebar content (no stacking/duplication).

- [ ] **Phase 3: Incremental Migration Protocol (One panel at a time)**
    - [ ] For each panel migration:
        - [ ] Open the existing floating implementation and identify the exact component(s) responsible for the UI.
        - [ ] Move/copy the existing component(s) into the new sidebar slot without changing structure/styling.
        - [ ] Verify the new sidebar version matches the old version visually (layout, spacing, preview behavior).
        - [ ] Only after visual match: remove/disable the old floating version for that panel.
    - [ ] Do not migrate multiple panels in one step.

- [ ] **Phase 4: Migrate Mode Panels into the Docked Sidebar (Gated)**
    - [x] Support Mode: migrate `SupportSidebar` first (highest priority; establishes the style baseline).
        - [x] New sidebar `SupportSidebar` matches existing layout/preview exactly.
        - [x] Old floating `SupportSidebar` rendering path removed/disabled.
    - [ ] Next mode panel (one at a time): migrate and gate with the same “match then remove old” rule.
    - [ ] Continue until all intended modes have a docked sidebar panel.

- [ ] **Phase 5: Scroll + Spacing Rules (No wasted space)**
    - [ ] Set clear rules for what scrolls:
        - [x] Sidebar content area scrolls
        - [x] Header remains fixed
        - [x] Canvas does not scroll due to sidebar
    - [x] Remove any remaining outer padding/insets that were only needed for floating cards.
    - [x] Confirm compact styling is preserved at 1080p.

- [x] **Phase 6: Regression Pass**
    - [x] Verify non-support modes (export/delete/conversion/etc.) still lay out correctly.
    - [x] Verify the sidebar does not overlap the top header at different window heights.
    - [x] Verify performance is unchanged (no excessive re-renders).

## Technical Details

### Relevant Files
- `src/app/page.tsx`
    - Currently composes the main mode panels and wraps them in `FloatingPanelStack`.
- `src/components/layout/FloatingPanelStack.tsx`
    - Current floating overlay positioning container.
- `src/components/ui/Sidebar.tsx`
    - Existing sidebar-like component (fixed, top=56px). May be adapted to support a right-anchored sidebar.
- `src/supports/Settings/SupportSidebar.tsx`
    - Support settings card UI.

### Existing Layout Reality (Current)
- Multiple settings panels are currently injected into the floating overlay stack via `FloatingPanelStack`.
- `FloatingPanelStack` uses absolute positioning and manual offsets to avoid the header, and each “panel” behaves like an independent floating card.

### Target Layout (Proposed)
A single “app shell” layout that structurally separates:

- Top header (fixed)
- Optional thin tools strip (left)
- Main work area (canvas) filling remaining width
- Layer slider column (to the left of settings)
- Settings sidebar (docked right, full-height under header)

#### Sidebar behavior rules
- Sidebar width is a fixed value for now (no collapse/resizer yet).
- Sidebar should be the only scrolling column for settings.
- Canvas should always remain fully visible to the left of the slider/sidebar.

### Proposed Implementation Approach

#### Step 1: Create/establish a docked sidebar slot
- Prefer using the existing `src/components/ui/Sidebar.tsx` if it matches the design intent.
- If it needs to become a domain-specific layout primitive (because we want non-fixed positioning or a different stacking model), define a new layout component in `src/components/layout/`.

#### Step 2: Update page composition
- Modify `src/app/page.tsx` so a single docked sidebar slot exists alongside the main work area.
- Add a mode → sidebar-content mapping so only the active mode’s settings render in the sidebar.
- Migrate `SupportSidebar` (Support mode) first, then migrate other modes’ settings panels.

#### Step 3: Decide what stays floating
- Keep `FloatingPanelStack` only for truly floating panels (if any remain).
- If the long-term direction is “everything docked”, plan a follow-up migration.

### Open Questions
- Should the docked sidebar include non-settings panels (Models, Debug Primitives), or should it be strictly “settings” only?
- Which modes must have sidebar content on day one (Prepare/Analyze/Support/etc.), and which are allowed to show an empty sidebar region?
- Does the layer slider become a dedicated docked column (recommended), or should it remain a floating overlay element?
- Is the header height always 56px, or does it vary by mode? If it varies, sidebar top offset should be derived from layout rather than hard-coded.
