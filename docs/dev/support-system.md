# Support System

This page summarizes the core engineering contracts of the support subsystem.

## Key domains

- `SupportPrimitives/`: reusable geometry primitives.
- `SupportTypes/`: composed support entities and placement hooks.
- `interaction/`: snapping, highlight state, selection behaviors.
- `PlacementLogic/`: policy and solver modules.
- `Settings/`: persisted support/raft settings and preview integration.

## Placement and rendering parity

When changing interaction behavior, maintain parity between:

- batched/instanced rendering path
- detailed rendering path

Both paths must emit consistent hover/click semantics and suppression behavior.

## Knots and attachment invariants

Shaft-attached knots must persist enough information to remain attached through edits:

- host shaft identity
- normalized parameter along shaft
- world position derived from host geometry

Any shaft topology change must route through authoritative update paths that recompute knot placement.

## History and undo/redo

Mutations should produce atomic, domain-meaningful history actions.
For complex cascades (e.g., trunk deletion/promotions), before/after snapshots must preserve graph consistency during undo/redo.
