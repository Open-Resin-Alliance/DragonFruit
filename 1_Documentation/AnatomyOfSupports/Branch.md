# Branch (Element) — Source of Truth

## Plain Language Overview
*   **What it is**: A Branch is a normal support like a [[Trunk]], but it does not have [[Roots]]. Its base is a [[Knot]] (Anchor).
*   **Purpose**: To extend support coverage from an existing support (trunk or branch) without touching the build plate or raft.
*   **Key Characteristics**:
    *   Base attaches to another support's shaft.
    *   Same anatomy as a trunk, only the attachment point differs.

## Anatomy & Geometry
*   **Visual Description**: A chain of cylindrical shafts connected by spherical joints, ending in a cone at the model and a sphere at the base.
*   **Parts**:
    *   **Base Knot (Anchor)**: The Branch’s bottom element; connects to another support’s shaft (no [[Roots]]).
    *   **Shaft(s)**: One or more straight cylindrical segments.
    *   **Joints**: Spherical joints between shaft segments.
    *   **Contact cone**: The terminal element at the model interface.
*   **Dimensions**: All sizes/diameters derive from the active support settings/preset or custom values.

## Placement & Creation
*   **Creation Method**: Hold `Alt` to enter Branch placement mode. (If `Ctrl+Alt` is held, [[Leaf]] mode takes precedence).
*   **Input Flow**:
    1.  **First Click**: Sets the Branch tip (contact point and normal) on the model and enters base-follow.
    2.  **Move Pointer**: The base [[Knot]] snaps to a parent shaft (trunk or branch) using universal [[Snapping]] (Path). Preview follows the snapped point.
    3.  **Second Click**: Finalizes the Branch only if snapped to a support; the Branch is created connected at that location.
*   **Initial State**: Created connected at the snapped location.

## Connections & Relationships
*   **Parent**: Must connect to a shaft of either a [[Trunk]] or another Branch.
*   **Children**: Can support other Branches or [[Leaf]]s.
*   **Connection Logic**: Base [[Knot]] snaps to parent shaft.
*   **Constraints**: Never connects to the model, plate, or raft.

## Behavior & Rules
*   **Movement**: Inherits transforms from its parent support.
*   **Editing**: Angle and length can be edited via [[Joint]]s like a Trunk.
*   **Interaction**: If the parent is removed, the Branch must be reassigned or removed.

## Technical Appendix
*   **Parameters**:
    *   Shafts: Per-segment diameters from settings.
    *   Tip: Uses the same tip profile as [[Contact cone]] unless a branch-specific profile is defined later.
*   **Validation**:
    *   Joints enforce equal diameters on both sides (no taper across a joint).

## Notes & Terminology
*   **Terminology**: "Anchor" is an alias for [[Knot]].
