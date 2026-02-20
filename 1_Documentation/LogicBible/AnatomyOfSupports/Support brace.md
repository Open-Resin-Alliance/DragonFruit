# Support brace (Element) — Source of Truth

## Plain Language Overview
*   **What it is**: A grounded support type that starts on the plate/raft with [[Roots]] and ends on another support via a [[Knot]].
*   **Purpose**: To add structural reinforcement from the ground to an existing support shaft.
*   **Key Characteristics**:
    *   Separate element from [[Brace]] (does not replace Brace behavior).
    *   Uses trunk-like grounded anatomy (roots, shafts, joints).
    *   Top connection is a support-to-support knot (no [[Contact cone]]).

## Anatomy & Geometry
*   **Visual Description**: A rooted multi-segment support column with an angled terminal segment that ends in a host-snapped knot.
*   **Parts**:
    *   **[[Roots]]**: Grounded base on plate/raft.
    *   **Lower shaft chain**: `[[Joint]] -> [[Shaft]] -> [[Joint]] -> [[Shaft]] -> [[Joint]]` (segment count may vary by edit flow).
    *   **Terminal transition shaft**: Angled end segment that transitions diameter to the host side.
    *   **End [[Knot]]**: Snaps to a host support shaft.
*   **Dimensions**:
    *   Base/support-brace diameter uses the active trunk diameter from current support settings.
    *   End knot size follows normal knot sizing rules against the host shaft diameter (standard knot offset policy).
    *   Terminal transition shaft tapers from support-brace diameter to host-side diameter.

## Placement & Creation
*   **Creation Method**: Place as a grounded support, then connect the top end knot to a valid host shaft.
*   **Input Flow**:
    1.  Place the grounded base ([[Roots]]) on plate/raft.
    2.  Build/position the shaft-and-joint chain.
    3.  Snap the terminal knot to a host shaft and commit.
*   **Initial State**: Grounded with a valid host connection.

## Connections & Relationships
*   **Parent**: Grounded through [[Roots]].
*   **Host Target (Top Knot)**: Only [[Trunk]] or [[Branch]] shafts are valid.
*   **Children**: Can participate in normal downstream support relationships where applicable.
*   **Connection Logic**: `Roots -> shaft/joint chain -> terminal transition shaft -> host-snapped knot`.
*   **Never**:
    *   No model contact tip element.
    *   No [[Contact cone]] endpoint.
    *   No attachment to [[Twig]], [[Stick]], or [[Brace]] shafts.

## Behavior & Rules
*   **Knot Sliding**: End knot slides on the host shaft like a normal knot.
*   **Lower Bound Clamp**: End knot must not slide below the host joint that starts the host shaft segment it is attached to.
*   **Diameter Behavior**:
    *   Main support-brace body follows active trunk diameter settings.
    *   Host-side knot follows host-diameter-based knot sizing.
    *   Terminal transition shaft continuously adapts between body diameter and host-side diameter.

## Technical Appendix
*   **Parameters**:
    *   Body diameter source: current trunk diameter setting.
    *   Knot sizing source: standard knot sizing rules based on host shaft diameter.
    *   Transition profile: tapered/conical terminal shaft.
*   **Validation**:
    *   Top knot host type must be Trunk or Branch.
    *   Top knot may not cross below the host-joint lower bound.
    *   Support brace remains grounded through Roots.

## Notes & Terminology
*   **Terminology**: "Support brace" is a distinct type from [[Brace]].
