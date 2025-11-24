# Twig (Element, Mono-shaft) — Source of Truth

## Plain Language Overview
*   **What it is**: A two-ended contact element connecting model → model using a single continuous body.
*   **Purpose**: To stabilize nearby surfaces or islands without attaching to existing supports.
*   **Key Characteristics**:
    *   Single continuous body.
    *   Connects model to model.

## Anatomy & Geometry
*   **Visual Description**: A single cylinder between two tips.
*   **Parts**:
    *   **Tip A & Tip B**: Model contacts (follow [[Contact cone]] rules).
    *   **Twig Body**: Continuous cylindrical body.
    *   **Joints**: Optional spherical [[Joint]]s along body.
*   **Dimensions**: Per-segment diameters.

## Placement & Creation
*   **Creation Method**: Hold `Ctrl+Alt` (unified placement).
*   **Input Flow**:
    1.  **First Click**: Set Tip A.
    2.  **Move Pointer**: Preview Tip B. Auto-chooses [[Stick]] vs Twig based on distance.
    3.  **Second Click**: Commit.
*   **Initial State**: Connected model-to-model.

## Connections & Relationships
*   **Parent**: Both ends contact Model only.
*   **Children**: None.
*   **Connection Logic**: Model -> Tip -> Body -> Tip -> Model.
*   **Constraints**: Does not use [[Knot]]s. Does not attach to supports.

## Behavior & Rules
*   **Movement**: Drag tips to reproject.
*   **Editing**: Insert/move joints.
*   **Interaction**:
    *   **Switching**: Previews as Twig if distance <= (L_A + L_B + 1.0mm). Otherwise [[Stick]].

## Technical Appendix
*   **Parameters**:
    *   Tips: Same as [[Contact cone]].
    *   Constraints: `minLengthMm`, `maxLengthMm`.
*   **Validation**:
    *   Equal diameters across joints.

## Notes & Terminology
*   **Terminology**: None.
