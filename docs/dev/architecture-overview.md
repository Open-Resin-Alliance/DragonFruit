# Architecture Overview

DragonFruit follows a domain-driven structure, especially in support-related code.

## Core principles

1. Group by domain/feature, not by generic file type.
2. Keep state logic, rendering, and interaction pipelines explicitly separated.
3. Use shared interaction infrastructure for cross-feature consistency.

## High-level areas

- `src/`: frontend app, scene/workflow features, support system.
- `src-tauri/`: desktop host and native runtime integration.
- `rust/`: native crates (slicing engine, relay, tooling).
- `plugins/`: plugin ecosystem and profile extension points.
- `profiles/`: printer/material presets.

## Support architecture split

- **Primitives**: roots, shaft, knot, joint, contact cone.
- **Types**: trunk, branch, brace, kickstand, leaf, twig, stick.
- **Shared logic**: snapping, highlighting, interaction guards.

## Interaction layering contract

1. Explicit gizmos
2. Placement tools
3. Support hover/selection
4. Canvas/model fallback

Cross-component suppression must use shared lock/guard patterns to avoid race conditions.
