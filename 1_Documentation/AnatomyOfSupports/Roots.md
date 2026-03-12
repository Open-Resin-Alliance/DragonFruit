# Roots (Element) — Source of Truth

## Plain Language Overview
*   **What it is**: The bottom piece of a trunk support.
*   **Purpose**: Forms the footprint on the build plate or raft and provides a strong connection to the trunk.
*   **Key Characteristics**:
    *   Truncated cone shape.
    *   Always sits on plate or raft.

## Anatomy & Geometry
*   **Visual Description**: Truncated cone (cylinder with different top/bottom diameters) with an integrated spherical top.
*   **Parts**:
    *   **Body**: Truncated cone.
    *   **Spherical Top**: Integrated sphere at the top face, centered.
*   **Dimensions**:
    *   Bottom diameter (footprint).
    *   Top diameter (meets trunk).
    *   Height.
    *   Sphere diameter = Top diameter.

## Placement & Creation
*   **Creation Method**: Automatically created as the base of every [[Trunk]].
*   **Input Flow**: Placed when a Trunk is created.
*   **Initial State**: Sits on plate or raft.

## Connections & Relationships
*   **Parent**: Sits on Build Plate or Raft.
*   **Children**: Connects to a [[Trunk]] shaft.
*   **Connection Logic**: Trunk shaft aligns to center of spherical top and embeds into it.
*   **Constraints**: Minimum footprint = 3.0mm. Top diameter matches trunk shaft.

## Behavior & Rules
*   **Movement**: Dragging Roots moves the trunk base on XY plane.
*   **Editing**: Can be resized (diameters, height). "Flat" style possible by equalizing diameters.
*   **Interaction**:
    *   **Raft**: If raft exists, Roots sit on raft and embed slightly. If raft removed, Roots sit on plate.
    *   **Snapping**: Does not snap to models/supports.

## Technical Appendix
*   **Parameters**:
    *   `bottomDiameterMm` (default 3.0).
    *   `topDiameterMm` (matches trunk).
    *   `heightMm` (default 1.5).
    *   `raftEmbedMm` (default 0.05).
*   **Validation**:
    *   Watertight interface with trunk shaft.

## Notes & Terminology
*   **Terminology**: "Root" and "Roots" are interchangeable.
