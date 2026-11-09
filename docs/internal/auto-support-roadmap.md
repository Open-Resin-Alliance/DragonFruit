# Auto-support research roadmap

Status: plan (2026-09-08). Sources: three deep-dives (ResinPapers, GeometryPapers, PrusaIslands — transcripts in agent history) plus the earlier four-track sweep, which looked at behaviour across several third-party slicers. One of those is explicitly deferred until the papers are digested.

## Where we stand

Placement machinery ahead of the market (post-placement load resize, chunk consolidation, segment-hosted knots, Forest Report); contact science behind (one global tip band, no island typing, no force model). Full competitive map in the 2026-09-08 sweep summary (chat history).

## Tier 1 — days each, isolated, build first

### 1. Per-point tip diameters (Prusa §g)
Prusa's SupportPoint carries a per-point head radius; thin + thick tips coexist. Add `tipDiameterMm` to our `CandidatePoint` (default = active band); let small-island candidates drop below the 30%-of-shaft floor without dragging the shaft. Consumers: `parameterSizing.ts:sizeParameters`, `gridPlacement.ts:emitPoint`. ~2 days. Highest leverage: fixes over-supported detail AND under-supported flats.

### 2. Z-growing coverage radii (Prusa §e)
Prusa's support curve grows influence 3.2→6mm over 40mm height; ours is born at 3.0 (`TIP_COVERAGE_RADIUS_MM`) and never grows, and spacing has no height term. Make coverage/dedup radii Z-dependent (piecewise-linear interp of the curve shape) in `coverage.ts` + `candidateGeneration.ts:deduplicateCandidates`. ~2–3 days. Note: our angle-awareness here already exceeds Prusa's (their SLA path has no normal-angle term in placement).

### 3. Area-indexed coverage density (Cao 2025)
Cao DOI 10.1080/17452759.2025.2466189: traction ∝ layer cross-section. Zeroth-order take without the simulator: per-region cover radius from footprint area (large flat islands pack tighter) in `coverage.ts`. 1–2 days. Full Cao (peel sim + GP surrogate + CVT) stays a research project — no calibrated traction model; uncalibrated physics is worse than honest empiricism.


### 4. Island-typed placement, phase 1 (Prusa §§a–b)
BB-center tips for sub-head specks; symmetric two-point rule for the middle band; medial-length gates replacing flat `minIslandAreaMm2`. Approximate skeletons via distance-transform ridge of footprint masks (no CGAL). Copy structure (area-derived ladder + width hysteresis), never their 2.9/1.3/3.9 constants (Prusa-internal peel fits). 2–4 days.

## Tier 2 — ~1 week each

### 5. Cone-gated + gain-ranked merging (Vanek 2014 + Dumas 2014)
Vanek PDF: https://www.cs.purdue.edu/homes/bbenes/papers/Vanek14SGP.pdf. Replace flat 4/5mm merge radii with support-cone intersection (branch at highest feasible point); rank hosts by Dumas gain (saved shaft − added branch) instead of nearest-first. Skip: FDM buckling constants, horizontal bridge members (unprintable under peel), CoM toppling (wrong failure mode).

### 6. Orientation advisor (Curvy, arXiv:2102.10013)
SA over 2 angles, quality-weighted cost — ship as suggestion with predicted contact delta, never auto-rotate; add suction-cup/drainage penalty Curvy lacks.

### 7. Hex lattice + Lloyd relax (Prusa §c)
Triangular seeding + a few Lloyd iterations on grid/gap-fill points. Skip restriction-typed sliding.

## Tier 3 — later or never

- Free-floating model-rooted sub-trees (Jang–Moon–Lee 2020, CAD 128): behind collision/drift gates only.
- Calibrated empiricism (Zhao 2015, DETC2015-47902): fit tail/height constants against a printed peel matrix; never FEA/PSO in the hot loop.
- Thin-spine vs thick-field + peninsula flags (Prusa §d): weeks; peninsulas last or never.
- Template trees (Springer 2025): only if tree gen becomes the bottleneck.

## Build order

Per-point tips → Z-growing radii → area-indexed density → island typing → merge scoring → orientation advisor. Each independently shippable, each testable against Forest Report tallies.

## Open research gap (ours to own)

ML-assisted support *placement* is absent from literature (only part-design TO + orientation ranking exist). Corroborated bands: DTU scarless-VPP converged on 0.23mm tips — our detail 0.22 sits on it.

## v2.0 addition: importable/exportable auto-support profiles

Presets for model classes (tiny minis vs large engineering parts), shippable as versioned JSON, user-tradable like ChituBox profiles / Lychee J3D cards.

- **Schema:** one profile = sizing band ladder (tip/shaft/root per detail/structure/anchor + tip length/penetration), island-class tip overrides (pairs with per-point tips, Tier 1 §1), density (`areaPerSupportMm2`, coverage target), overhang gates (self-support angle, min island area), fan/merge radii + leaf-span threshold, brace toggles. Version field; unknown fields ignored on import (forward-compat).
- **Factory profiles:** Miniature (detail band default, tighter density, small-island tips shrunk), Standard (today's structure defaults = current behavior, the migration baseline), Engineering (anchor band, denser large-area packing, bracing on).
- **Plumbing:** profiles resolve through the existing `normalizeAutoSupportSettings` / `applyAutoSupportSettingsPatch` path (`settings.ts`) so the pipeline never branches on profile identity — a profile is just a settings snapshot with a name. Export/import buttons in the Auto Supports panel; file IO beside the existing settings persistence.
- **Tests:** round-trip (export→import→identical snapshot), unknown-field tolerance, factory profiles snapshot-pinned (Standard must equal today's defaults exactly — the no-regression proof for existing users).
- **Effort:** ~1 week (schema + panel UI + validation + tests). Docs: profile JSON spec lives next to this plan when it lands.
