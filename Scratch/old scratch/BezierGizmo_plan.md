# Bezier Gizmo Development Plan

## Overview
The Bezier Gizmo is a 3D interactive tool that allows users to manipulate the shape of support curves directly in the viewport. It provides intuitive control over **Tangent Direction** (Rotation) and **Curve Strength** (Handle Length/Tension) by dragging handles attached to joints, mimicking standard vector design tools (Illustrator/Blender).

## Architecture

### Directory Structure
All new components will reside in the `src/supports/Curves/BezierGizmo` directory.

```
src/supports/Curves/BezierGizmo/
├── BezierGizmoManager.tsx    # Main container, handles logic/state subscription
├── BezierHandle.tsx          # Individual handle visual (Line + Sphere)
├── types.ts                  # Gizmo-specific types
└── utils.ts                  # Math helpers for screen-space projection & inverse kinematics
```

### Components

#### 1. `BezierGizmoManager`
*   **Role**: The Controller.
*   **Responsibility**:
    *   Subscribes to the global state to find the `selectedId` (Joint or Segment).
    *   Determines which handles to show (Start, End, or Both).
    *   Calculates the world positions of the Control Points based on the current `BezierSegment` data.
    *   Passes these positions to `BezierHandle` components.
    *   Handles the `onDrag` events from children and dispatches updates to the global store (`updateTrunk`).

#### 2. `BezierHandle`
*   **Role**: The View/Interaction layer.
*   **Responsibility**:
    *   Renders the visual handle: A thin LineMesh connecting the Joint to the Control Point, and a SphereMesh at the Control Point (The "Ball").
    *   Handles Raycasting/Pointer events for dragging.
    *   **Visual Style**:
        *   Line: Thin, distinct color (Cyan/Yellow).
        *   Ball: Small, hover effect (scale up), active effect (color change).
    *   **Input**: Receives `jointPosition` and `controlPointPosition`.
    *   **Output**: Emits `onDrag(newPosition)` events.

## Interaction Logic

### 1. "Seesaw" Behavior (Continuity)
*   When a handle is rotated, its "opposite" handle (on the other side of the joint) must rotate equally to maintain 180-degree alignment (C1 continuity).
*   **Manager Logic**:
    *   When Handle A is dragged, calculate its new Direction vector (`dir = normalize(NewPos - Joint)`).
    *   Update Handle A's segment with `startTangent = dir`.
    *   Find the connected segment for Handle B.
    *   Update Handle B's segment with `endTangent = dir` (or `-dir`).

### 2. Dragging Mechanics
We need to distinguish between **Lengthening** (Tension) and **Rotating** (Direction).

#### A. Tangent Rotation (The "Swing")
*   **Goal**: Change the angle of launch.
*   **Method**: 
    *   Project the mouse movement onto a plane perpendicular to the camera view (Screen Space Rotation).
    *   This ensures the user feels like they are "pushing" the line on the screen.
    *   The new handle position is constrained to the plane defined by the View Direction and the Handle, or simply unconstrained rotation around the Joint pivot.

#### B. Handle Lengthening (The "Pull")
*   **Goal**: Change the Tension (Tightness).
*   **Method**:
    *   Project the mouse delta onto the existing Handle Vector.
    *   Move the Control Point closer/further from the Joint along that vector.
    *   **Inverse Math**: Convert the new `HandleLength` back into the normalized `tension` value (0.1 - 2.0) used by our data model, or update the `scale` factor directly if we refactor the model to support explicit lengths.
    *   *Note*: Currently `tension` is an abstract scalar. We may need to map `Length / SegmentLength` -> `Tension`.

## Data Flow

1.  **User Drags Handle** -> `BezierHandle` calls `onDrag(newWorldPos)`.
2.  **Manager Calculates**:
    *   `NewVector = newWorldPos - JointPos`.
    *   `NewTangent = normalize(NewVector)`.
    *   `NewLength = length(NewVector)`.
3.  **Manager Updates State**:
    *   Calls `updateCurvesAtJoint` with new Tangent.
    *   Calls `updateSegmentTension` (derived from NewLength).
4.  **React Re-renders**:
    *   Scene updates, curve geometry regenerates.

## Implementation Steps

1.  **Scaffold Files**: Create the directory and basic component files.
2.  **Visuals First**: Implement `BezierGizmoManager` and `BezierHandle` to just *render* the current handles (read-only). Verify they appear correctly on selected curves.
3.  **Drag Interaction**: Implement `useDrag` (from `@use-gesture/react` or standard Three.js raycasting) on the Sphere.
4.  **Rotation Logic**: Implement the math to update the `tangent` based on the drag position.
5.  **Length Logic**: Implement the math to update the `tension` based on drag distance.
6.  **Seesaw Logic**: Connect incoming/outgoing segments so they update together.