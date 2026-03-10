# Stick (Element, Dual-branch) — Source of Truth

## Plain Language Overview
*   **What it is**: A two-ended contact element connecting model → model via a central hub.
*   **Purpose**: To span larger gaps between surfaces where a mono-shaft [[Twig]] would be too long.
*   **Key Characteristics**:
    *   Two branches meeting at a central joint.
    *   Allows angled edits on each side.

## Anatomy & Geometry
*   **Visual Description**: Two shaft chains meeting at a central sphere.
*   **Parts**:
    *   **Tip A & Tip B**: Model contacts (follow [[Contact cone]] rules).
    *   **Branch A & Branch B**: Shaft segments from tips to center.
    *   **Central Joint (Hub)**: Spherical [[Joint]] connecting branches.
*   **Dimensions**: Per-segment diameters.

## Placement & Creation
*   **Creation Method**: Hold `alt` (unified placement).
*   **Input Flow**:
    1.  **First Click**: Set Tip A.
    2.  **Move Pointer**: Preview Tip B. Auto-chooses Stick vs [[Twig]] based on distance.
    3.  **Second Click**: Commit.
*   **Initial State**: Connected model-to-model with central joint.

## Connections & Relationships
*   **Parent**: Both ends contact Model only.
*   **Children**: None.
*   **Connection Logic**: Model -> Tip -> Branch -> Hub <- Branch <- Tip <- Model.
*   **Constraints**: Does not use [[Knot]]s. Does not attach to supports.

## Behavior & Rules
*   **Movement**: Drag tips to reproject. Move central joint to adjust balance.
*   **Editing**: Insert/move joints along branches.
*   **Interaction**:
    *   **Switching**: Previews as Stick if distance > (L_A + L_B + 1.0mm). Otherwise [[Twig]].

## Technical Appendix
*   **Parameters**:
    *   Tips: Same as [[Contact cone]].
    *   Constraints: `minLengthMm`, `maxLengthMm`.
*   **Validation**:
    *   Equal diameters across joints.

## Notes & Terminology
*   **Terminology**: None.
