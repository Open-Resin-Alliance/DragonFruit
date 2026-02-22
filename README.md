# DragonFruit

**DragonFruit is a 3D Printing slicer prototype**

## STL Slicer POC — Project Documentation

### Tech Stack

- Frontend framework: Next.js (App Router), TypeScript
- UI/styling: TailwindCSS + custom CSS in `globals.css`
- 3D rendering: three.js via react-three-fiber (Canvas) and drei (OrbitControls)
- STL loading: three/examples STLLoader
- State/logic: React client components and custom hooks

## Coordinate System

The application uses a **Z-up coordinate system** throughout:

- **Z-axis**: Vertical (height) - points upward
- **Y-axis**: Forward/backward (depth)
- **X-axis**: Side-to-side (width)

### Implementation Details

- **Camera**: Configured with `up` vector set to `[0, 0, 1]` to make Z globally vertical
- **Mesh positioning**: Models load in native orientation with bottom at Z=0, centered in X and Y
- **Grid helper**: Rotated 90° around X-axis to lie on the XY plane (horizontal ground)
- **Axes helper**: X=red, Y=green, Z=blue (pointing up)
- **Clipping planes**: Operate in world space along the Z-axis
- **Cross-section slicing**: Slices geometry at Z heights, creates horizontal XY plane shapes
- **Layer calculations**: All layer heights and positions use Z-axis coordinates

This ensures consistent vertical orientation across all visualization, slicing, and measurement operations.

## Programming Ideology

- Build features as small, focused modules.
- Co-locate all code with its parent component or system (no scattered `hooks/` or `utils/` folders).
- Prefer composition over large monolithic components.
- Keep files short, readable, and single-purpose to enable testing and refactoring.
- Split large files into multiple smaller files with clear responsibilities.

## Code Organization (Important)

This project is organized by **component/feature**, not by shared technical categories. Avoid generic folders like `hooks/`, `utils/`, or `helpers/` at the root level. Instead, co-locate all code with the component or system it belongs to.

### Core Principle: Component-First Organization

Each system or feature gets its own folder containing ALL of its logic:

- Types and interfaces
- State management
- Hooks (specific to that system)
- Utilities (specific to that system)
- Rendering components
- Tests

**Example structure for a new system (GPUPicking):**

```
src/components/picking/
├── PickingContext.tsx      # React context providing pointerHit
├── PickingRenderer.tsx     # Offscreen render pass
├── PickingProvider.tsx     # Provider component wrapping the scene
├── pickingUtils.ts         # ID encoding, majority vote logic
├── types.ts                # Pickable types, hit result interface
├── constants.ts            # Update rates, buffer sizes
└── hooks/
    └── usePickingSubscription.ts  # Hook for components to subscribe
```

### File Size Guidelines

- **Avoid large monolithic files.** Split code into logical sections across multiple files.
- Each file should have a single, clear responsibility.
- If a file exceeds ~200-500 lines, consider splitting it.

### Domain Structure

Major feature domains live under `src/` with their own namespace:

- `src/supports/` — Support generation (trunks, branches, leaves, joints, rafts)
- `src/components/` — Shared UI and scene components, each in its own subfolder
- `src/modules/` — Standalone systems (e.g., island detection)

Within each domain, organize by feature:

```
src/supports/
├── BranchSupports/
│   ├── placement/
│   ├── snapping/
│   ├── constraints/
│   └── rendering/
├── Joints/
│   ├── types.ts
│   ├── raycasting.ts
│   └── ...
└── Rafts/
    └── Crenelated/
        ├── rendering/
        └── ...
```

### What Goes Where

- **Domain-specific code** → Inside the domain folder (e.g., `src/supports/hooks/`)
- **Shared scene components** → `src/components/<ComponentName>/` (each component gets a folder)
- **Truly generic utilities** → Only if used by 3+ unrelated systems; otherwise keep co-located
- **Global hooks** → `src/hooks/` only for app-wide hooks not tied to any domain (rare)

### Modularity and Safety

- Build features as small focused files.
- Gate work-in-progress behind feature flags.
- Keep ownership clear—avoid placing domain code in generic directories.

Following this structure ensures clean boundaries, safer refactors, and easier collaboration as the codebase grows.

## What the app does

- Loads STL files (assumed millimeters), renders the model in a 3D scene with orbit controls.
- Provides transform controls for moving, rotating, and scaling the model in 3D space.
- Provides a vertical slider (track/rail with thumb/handle) to move a slicing plane from bottom to top.
- Visualizes the current cross-section as a filled white cap at the slice height that follows model transforms.
- Supports two display modes internally (currently using cumulative reveal by default):
  - Cumulative (active): shows the model from the bottom up to the current slice, hiding everything above.
  - Single-slice (band) capability is implemented in the scene and page logic (clipLower/clipUpper), ready to be toggled when exposed.
- Detects and visualizes unsupported regions (islands) in the model with configurable scanning parameters.
- Provides 3D volume visualization of detected islands with multiple color schemes.

## Island Definition (CRITICAL CONCEPT)

**An island is NOT just the unsupported pixels/polygons at a single layer.**

**An island IS the entire 3D volume of model material** that sits atop unsupported regions, extending vertically upward until it merges with another island or the scan completes.

### How Islands Work

1. **Detection trigger**: Unsupported pixels are detected at a layer when current layer geometry is not sufficiently covered by the dilated previous layer (support buffer).

2. **Volume propagation**: Once triggered, the island includes **all CONNECTED model geometry** vertically above those unsupported pixels, even if those upper layers would be "supported" by the island material below them. The geometry must be contiguous - physically connected through the layers.

3. **Vertical extent**: An island continues upward through layers, tracking its 3D volume as it grows, shrinks, or changes shape.

4. **Termination**: An island ends when it merges with another island (becoming a child of the larger parent island) or when the scan completes.

### Example

If a small unsupported base (e.g., a cone tip starting from a mathematical point) grows into a large cone above it:

- The **entire cone is the island**
- Not just the tiny unsupported base pixels
- The volume includes all layers from first detection through the full vertical extent

This distinction is critical for accurate volume calculations and visualization.

## How it works (high level)

- STL load and normalization
  - `useStlGeometry`: loads STL, computes normals, centers X and Y, and sets the model's bottom to Z=0 for a stable coordinate frame.
  - Bounding box and size are derived for layer and slider calculations.

- Slicing/clipping
  - The scene uses material clipping planes to hide geometry above the current slice height (cumulative reveal). Planes operate in world space along the Z-axis.
  - Clipping shows everything from Z=0 (bottom) up to the current layer height.

- Transform controls
  - `useModelTransform`: Custom hook managing position, rotation, and scale state with stable callbacks.
  - `TransformToolbar`: Vertical toolbar with mode selection (Select, Move, Rotate, Scale).
  - Mode-specific control cards provide precise numeric inputs and utility functions:
    - **Move**: XYZ position inputs, Center, On Platform, Arrange All, Auto-lift on import with configurable distance.
    - **Rotate**: XYZ rotation inputs (degrees), Reset Rotation.
    - **Scale**: XYZ scale inputs (mm/%), Uniform Scaling toggle, Reset Scale.
  - **Custom Transform Gizmo**: Modular 3D viewport gizmo with visual polish and advanced features:
    - **Screen-space sizing**: Gizmo maintains constant visual size regardless of camera zoom.
    - **Gradient color system**: Pure colors (Red #ff0000, Green #0ce300, Blue #0000ff) at center transitioning to secondary colors (Orange #ff9900, Yellow #ffcc00, Bright Blue #1596ff) at ends.
    - **Move arrows**: Gradient cylinders (0.02 radius) with pure color for first 1/3, fade over remaining 2/3, camera-relative flipping.
    - **Center disc**: Flat XY-plane circle with 50% transparency when idle, white border ring, XY-only movement restriction.
    - **Rotation rings**: Tube geometry arcs (0.02 radius) with gradient, double-cone handles, camera-facing billboarding.
    - **Scale cubes**: Dynamic camera-facing edge rendering (only front edges visible), edges use 30% darker color for contrast.
    - **Rendering**: All elements use `toneMapped={false}` for vibrant colors, `depthTest={false}` to render on top of scene.
  - Geometry centering: Original geometry preserved, mesh offset in group for proper gizmo pivot at center of mass.
  - All features (cross-sections, island scans, clipping) work correctly with transformed geometry.

- Cross-section cap (filled surface)
  - `CrossSectionCap` intersects mesh triangles with plane Z = current slice height in **world space**.
  - Applies transform matrix to geometry vertices before slicing to handle rotated/scaled models.
  - Builds 2D segments in XY plane, assembles closed loops, converts to ShapeGeometry, positions at the correct XYZ coordinates.
  - Renders with proper depth testing (FrontSide only) so it's only visible from above and respects 3D occlusion.
  - Updates in real-time as model is transformed.

- Slider and UI
  - Custom vertical slider (not the native `<input type="range">`) with editable input field for direct layer entry.
  - Thumb stays centered on the track; input field allows typing layer numbers with live updates and max value enforcement.
  - Track and label use neutral grey accents for a clean dark UI.
  - Left sidebar contains collapsible control cards (Island Scan, Island Overlay, Island Volumes) with eye icon toggles.
  - Model info overlay card in lower-left of canvas shows real-time stats (height, layer count, islands, etc.).

## Current implementation details

- Files of note
  - `src/hooks/useStlGeometry.ts`: STL load, normalization (center X/Y, set bottom to Z=0), bounding box and size.
  - `src/hooks/useModelTransform.ts`: Transform state management with position, rotation, scale, and utility functions (center, reset, platform placement).
  - `src/components/scene/SceneCanvas.tsx`: R3F Canvas with Z-up camera, lighting, helpers, Z-axis clipping planes, group-based mesh structure for transforms, transform matrix calculation.
  - `src/components/gizmo/TransformGizmo.tsx`: Custom modular transform gizmo with move/rotate/scale operations, screen-space sizing, camera-relative flipping, and gradient color system.
  - `src/components/gizmo/move/GizmoAxis.tsx`: Move arrows with gradient cylinders (pure color at center → secondary at tip), camera-facing orientation, and color-matched outlines.
  - `src/components/gizmo/move/GizmoCenter.tsx`: XY-plane movement disc with transparency states and white border ring.
  - `src/components/gizmo/rotate/GizmoRotationRing.tsx`: Rotation rings with gradient tube arcs, double-cone handles, camera-facing billboarding.
  - `src/components/gizmo/scale/GizmoScaleHexagon.tsx`: Scale cubes with dynamic camera-facing edge rendering and color-matched darker edges.
  - `src/components/gizmo/constants.ts`: Centralized gizmo sizing, colors (pure + secondary gradients), and lighting configuration.
  - `src/components/scene/CrossSectionCap.tsx`: Cross-section polygon extraction at Z heights with transform matrix support, creates horizontal XY plane shapes with proper positioning and depth testing.
  - `src/components/controls/TransformToolbar.tsx`: Vertical toolbar overlay with Select, Move, Rotate, Scale mode buttons.
  - `src/components/controls/MoveControls.tsx`: Move mode settings card with XYZ inputs, positioning utilities, auto-lift configuration.
  - `src/components/controls/RotateControls.tsx`: Rotate mode settings card with XYZ rotation inputs (degrees) and reset.
  - `src/components/controls/ScaleControls.tsx`: Scale mode settings card with XYZ scale inputs (mm/%), uniform scaling toggle, reset.
  - `src/components/controls/LayerSlider.tsx`: Custom vertical slider with thumb + attached label; keyboard and mouse wheel nudging; track click/drag; live input editing.
  - `src/components/controls/IslandOverlayControls.tsx`: Collapsible card for island overlay visualization with eye icon toggle and feature controls.
  - `src/components/controls/IslandVolumeControls.tsx`: Collapsible card for 3D island volume visualization with selection, filtering, and color scheme options.
  - `src/utils/scanPositioning.ts`: Centralized helper for scan-based visualization positioning (world-space scan Z + X/Y-only group translation for voxels/overlays).
  - `src/app/page.tsx`: UI composition, file input, layer height input, layer index state, transform state integration, mapping from index to Z-height, scene wiring, and model info overlay.
  - `src/app/globals.css`: Dark theme defaults and custom slider styles (track dimensions, thumb size, etc.).

- Units and layers
  - Model units are treated as millimeters.
  - Layer height is entered in microns; converted to millimeters for calculations.
  - Number of layers is `ceil(model_height_mm / layer_height_mm)`.
  - Layer index 0 = Home (full model). 1..N = increasing slice height.

- Visual defaults
  - Dark UI (neutral greys), grid on XY plane, Z-up axes (X=red, Y=green, Z=blue), orbit controls.
  - White cross-section cap positioned at slice Z-height with proper depth testing.
  - Collapsible control cards with eye icon indicators (blue when enabled, grey when disabled).

## What has been done so far

- Scaffolded Next.js + Tailwind + R3F/drei project and set default dark theme.
- **Established Z-up coordinate system** throughout the application with proper camera configuration, mesh positioning, and helper alignment.
- Implemented STL load and geometry normalization (center X/Y, bottom at Z=0).
- Built 3D viewer with Z-up orientation, lighting, horizontal grid on XY plane, and orbit controls.
- **Implemented complete transform system**:
  - Mode-based toolbar (Select, Move, Rotate, Scale) with visual feedback.
  - Mode-specific control cards with numeric inputs and utility functions.
  - **Custom modular transform gizmo** with gradient color system, screen-space sizing, and camera-relative behaviors.
  - Gradient vertex colors using `THREE.BufferAttribute` for smooth pure→secondary color transitions.
  - Dynamic camera-facing features: axis flipping, edge visibility, handle billboarding.
  - Group-based mesh structure preserving vertex colors while centering pivot at center of mass.
  - Auto-lift functionality with persistent settings (localStorage).
  - Transform matrix integration for all downstream features.
- Implemented cumulative slicing with Z-axis clipping planes operating in world space.
- Added cross-section cap computation at Z heights with **transform-aware world-space slicing**.
- Built custom vertical slider with editable input field, live updates, max value enforcement, and error indicators.
- Created collapsible control cards (Island Scan, Island Overlay, Island Volumes) with eye icon toggles for expand/collapse.
- Added model info overlay card in canvas lower-left corner showing real-time statistics.
- Integrated island detection system with pixel-based scanning, cross-layer tracking, and 3D volume visualization.
- Fixed island volume calculations with proper parent-child relationship handling.
- Refactored into modular components with clear separation of concerns.
