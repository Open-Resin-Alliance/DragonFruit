# Developer Guide

This section documents DragonFruit internals for contributors and maintainers.

## What you will find here

- Architectural conventions and domain boundaries
- Support system contracts and interaction precedence
- Handoff guidance for domain-owned documentation
- Grid, branching, and trunk replacement behavior
- Raft geometry and generation pipeline
- Scan coordinate/positioning policy
- Data storage contracts
- File format contracts (VOXL, LYS extraction)
- Plugin framework contracts (simple vs complex)
- Complex plugin contribution workflow
- RTSP relay reclaim API behavior

## Source-of-truth intent

These docs are written to be actionable and stable for engineering handoff.
When behavior changes, update these pages alongside implementation.
