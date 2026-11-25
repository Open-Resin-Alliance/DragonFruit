# Live Printability Analysis & Coupled FEA Plan

**Status:** Internal handoff plan (uncommitted working roadmap on branch `aaron/island-scanner-fixes-nov26`).
**Scope:** Honest audit of the current support-frame stress solver and model heatmap, followed by a phased plan to deliver both **live model printability evaluation** ("is every part of this model actually supported well enough to print?") and **full coupled part + support solid FEA** for vat photopolymerization (MSLA/SLA).

---

## 1. Quick-Start Reading List for Incoming Models

Read these before changing code:

1. `AGENTS.md` — hard repo rules (standalone Rust crate version bumps, Lingui i18n, `npm run check:docs`, `npm run check:lint`, `npm run check:i18n-literals`, never bump main app version unprompted).
2. `CONTEXT.md` — domain glossary (`trunk`, `branch`, `leaf`, `brace`, `stump`, `kickstand`, `knot`, `contactCone`, `roots`).
3. `docs/dev/auto-supports.md` — current auto-support pipeline, Screened Stefan traction model, 3D support-graph beam solver, and reactive stress UI/shader contracts.
4. `src/supports/autoSupport/supportGraphStress.ts` — `buildSupportGraph`, `distributeRigidBodyPeelLoads`, `solveSupportFrameStress`, `reinforceOverloadedFrameMembers`.
5. `src/supports/autoSupport/tractionOptimization.ts` — `extractRepresentativeLayers`, `solveStefanFieldFromSegments`, Screened Stefan PDE `(∇² - κ²)p̃ = -1`.
6. `src/supports/autoSupport/coverage.ts` & `src/supports/autoSupport/loadBudget.ts` — `computeRegionCoverage`, `collectSupportTips`, `findUncoveredClusters`, `computeLoadBudget`.
7. `src/features/shaders/mesh/stressForceHeatmap.tsx` — `StressForceHeatmapMaterial` (1D Z-layer texture, peak/hover Z contour rings, pinpoint overload spots).
8. `src/components/scene/SupportStressOverlay.tsx` — line-only `LineSegments2` stress vector rendering.
9. `src/components/controls/autoSupport/SupportStressPanel.tsx` & `src/supports/autoSupport/frameStressState.ts` — interactive panel, debounced live refresh on structural edits, cached layer profile.
10. `rust/dragonfruit-tetgen/src/lib.rs` & `docs/internal/tetrahedral-surfacing.md` — vendored TetGen wrapper (`TetMesh`) for unconstrained Delaunay tetrahedralization.

---

## 2. Honest Audit: What Today's Graph & Heatmap Actually Represent

### What IS genuine physics today

- **Real 3D support-frame FEA (`solveSupportFrameStress`)**:
  - Builds a full nodal/member structural graph (`buildSupportGraph`) from plate-fixed `roots` up through segmented `trunk`, `stump`, `kickstand`, `branch`, `leaf`, and `brace` members, splitting host shafts accurately at every hosted `knot`.
  - Solves `K u = f` via Block-Jacobi Preconditioned Conjugate Gradient with full 6-DOF per-node 3D Euler-Bernoulli beam elements (`3 translations + 3 rotations`), computing tip deflection magnitude, combined axial + bending stress vs `DEFAULT_SUPPORT_BREAK_STRENGTH_MPA`, and Euler column buckling utilization.
- **Real 2D peel-pressure PDE (`tractionOptimization.ts`)**:
  - Evaluates cross-sectional contours across representative Z clusters and solves the 2D Screened Stefan squeeze-film flow PDE to obtain spatial peel suction pressure and Center of Pressure per layer.

### Six critical limitations (why today is support-frame-only, NOT full printability or coupled FEA)

1. **It only tests whether placed supports survive — not whether the model is supported enough**:
   - If the user deletes half the supports or leaves a flat overhang or long arm completely unsupported, those missing tips carry zero graph edges, so the beam solver quietly sees less load or ignores the unsupported region instead of flagging that the *model itself* will pancake, warp, or tear.
   - `computeRegionCoverage` and `computeLoadBudget` exist inside `autoPlace.ts`, but are not surfaced live during manual support editing in `SupportStressPanel` or painted onto the model mesh.
2. **Infinitely rigid part body**:
   - The printed model itself has zero finite elements or compliance. Flexing overhangs, thin capes/wings, tall unbraced spires, and internal part delamination stresses are invisible.
3. **Uncoupled support tips during the beam solve**:
   - `distributeRigidBodyPeelLoads` first splits vertical layer peel force across active tips via rigid-body vertical + moment equilibrium, then applies individual point loads to free 6-DOF tip nodes during the CG solve.
   - Without cured-part diaphragm coupling across shared slice components, angled `leaf` tips sitting beside stiff braced `trunk` towers absorb standalone tip shear and over-report bending stress.
4. **1D Z-only model heatmap (not 2D XY peel pressure, coverage deficit, or solid von Mises stress)**:
   - `StressForceHeatmapMaterial` samples a 1D `128×1` `DataTexture` along world Z (`layerProfile`) plus pinpoint spots around overloaded tips. Two points at the same height (center of a wide suction plateau vs edge spear) show nearly identical Z-band color rather than true spatial peel pressure, local support shortage, or solid stress.
5. **Global 3-layer heuristic & synchronous uniform peel**:
   - Only 3 global critical layers are evaluated, missing disconnected sub-components (hanging limbs/weapons) before they merge into the torso.
   - Vat separation is modeled as synchronous uniform peel plus constant `0.08` lateral drag rather than a progressive FEP/ACF peel wave or vat-tilt sweep, and hollow cavities do not yet add negative hydrostatic suction-cup pressure.
6. **Uncalibrated green-resin material parameters**:
   - Uses `GREEN_RESIN_MODULUS_MPA` and `DEFAULT_SUPPORT_BREAK_STRENGTH_MPA` (the profile's datasheet tensile derated by 0.2), so strength is profile-calibrated while green modulus and film peel stiffness still have no per-material field.

### Can we build proper FEA and live printability from this foundation?

**Yes — directly.** Everything already built stays valuable:
- `buildSupportGraph` + 6-DOF Euler-Bernoulli element assembly gives us the **exact beam sub-system** needed to couple with solid part finite elements.
- `extractRepresentativeLayers` gives us cached slice contours and spatial 2D Stefan peel fields (`stefanField`).
- `coverage.ts` + `loadBudget.ts` + island scan results already measure geometric overhang demand vs placed tip capacity.
- `frameStressState.ts`, `SupportStressPanel`, `SupportStressOverlay`, and `StressForceHeatmapMaterial` already provide the live debounced edit-refresh loop, viewport vector lines, hover-contour synchronization, and custom GPU shader hooks.

---

## 3. Target Architecture: Live Printability Engine + Two-Tier Hybrid FEA

A resin slicer needs to answer **"Will this model print cleanly right now?"** instantaneously while the user adds/deletes/drags supports, AND offer deep solid physics when needed. That splits naturally into two coordinated tiers:

| Tier | Runtime Target | Runs Where | Scope & Questions Answered | Trigger |
|---|---|---|---|---|
| **Tier 1: Live Printability & Coupled Frame** | **< 50 ms** | TS / Web Worker (`supportGraphStress.ts`, `coverage.ts`, `loadBudget.ts`) | **1. Is it supported enough?** (unsupported minima/overhangs, tip spacing & peel-load deficit, local cantilever lever span vs support distance). **2. Do supports hold?** (part-coupled diaphragm beam frame + per-component peel stages). **3. Where is peel & shortage?** (2D XY peel + printability sufficiency shader on model mesh). | Live on generate + every debounced manual support edit |
| **Tier 2: Full Coupled Part + Support Solid FEA** | **0.5 – 5 s** | Native Rust crate (`dragonfruit-fea`) via Tauri IPC (background async) | **Does the cured green part itself flex, tear, delaminate, or wobble?** Progressive Z-stage 3D elasticity coupling solid voxels + contact cones + 3D beam frame + progressive peel sweep + hollow suction pressure. | Explicit Deep Analysis / Verify trigger or closed-loop FEA repair |

---

## 4. Live Model Printability Architecture (Answering: "Is It Supported Enough?")

Rather than showing only a peel curve vs Z and beam stress percentages, the live inspector must evaluate five concrete printability checks together after every support edit:

1. **Support Sufficiency & Undetected/Uncovered Overhangs (Surface Red/Amber Zones)**:
   - Compare every detected overhang/voxel/minima region (`DetectedIsland` / `collectSupportTips` / `computeRegionCoverage`) against currently placed tips in `Snapshot` (`getSnapshot()`).
   - Compute per-region:
     - **Geometric coverage ratio** (fraction of overhang area within effective support reach, flags bare minima peaks and uncovered perimeter corners that will pancake).
     - **Peel-load sufficiency (`computeLoadBudget` + 2D `stefanField`)**: compare integrated Screened Stefan peel traction over each region against the sum of holding capacity of attached tips (`min(tipPullLimit, memberLimit)`). Flag regions where peel demand exceeds nearby tip capacity even if nominal spacing looks okay.
   - Paint deficient regions directly on the model underside in the **Printability** overlay mode so adding a single manual support turns an amber/red patch green in real time.
2. **Model Cantilever & Unsupported-Span Leverage Risk**:
   - Even with zero isolated islands (a `35°–42°` sloping wing, extended cape, or horizontal spear attached at one end), long unbraced overhangs accumulate bending moment and tip droop during peel.
   - **Tier 1 live proxy (< 20 ms)**: across cured slice layers (`z <= Z_k`), measure geodesic/2D-in-slice Euclidean distance from every active cross-section pixel/vertex to the nearest grounded path (either build plate via `z ≈ 0` or an active support tip below/at `Z_k`), divided by local cross-section thickness (`span² / thickness` thin-cantilever index). Long thin extensions far from any support light up visibly on the model surface.
   - **Tier 2 exact check**: full coupled solid voxel-hex8 FEA reports exact tip peel deflection `δ (mm)` and max principal tensile stress `σ_1 (MPa)`.
3. **Coupled Support-Frame Integrity**:
   - Part-coupled 6-DOF beam frame (`solveSupportFrameStress`) checking tip pull-off, shaft combined axial+bending yield, and Euler column buckling across all *per-component* critical layers.
4. **Hollow Suction-Cup & Area-Jump Peel Shock Detection**:
   - Detect enclosed or semi-enclosed slice loops with zero drainage path down toward the plate across representative layers and estimate negative pressure surcharge plus sudden expansion shocks (`areaJumpRatio`).
5. **Unified Live Printability Panel & Overlay Lens**:
   - Evolve `SupportStressPanel` (`src/components/controls/autoSupport/SupportStressPanel.tsx`) from a stress-only widget into a compact **Printability & Stress** panel:
     - Compact traffic-light summary strip + status checklist: **Coverage / Sufficiency**, **Model Flex / Spans**, **Frame Stress**, **Peak Peel**.
     - Overlay mode switcher inside the panel: **Printability** (unsupported islands, load deficits, high-leverage spans + beam vectors) vs **Peel Profile** (Z-layer peel bands + live hover slice contour) vs **Solid FEA** (when Tier 2 results are present).
     - Clickable hotspots/deficits that select/focus the support or jump the camera/slice preview to the offending model region.
     - Two clear action buttons: **Reinforce** (thicken overloaded existing members) and **Fix Weak Spots** (place new supports/braces at uncovered, under-budgeted, or high-leverage model spots).

---

## 5. Phased Implementation Plan (Hand-Off Spec)

### Phase 0 — Live Printability & Coupled Tier 1 Fidelity (3–5 days, pure TS + Shader)

Deliver immediate live model printability value on top of today's code before writing Rust FEA:

1. **Live Support-Sufficiency & Overhang Deficit Evaluator**:
   - Add a fast evaluator reading active `DetectedIsland`s + `collectSupportTips` + `computeRegionCoverage` + `computeLoadBudget` + cached `RepresentativeLayerProfile`, outputting:
     - Uncovered islands & deficit regions (centroid, normal, uncovered area mm², peel demand vs support capacity deficit, suggested contact diameter).
     - Slice-distance cantilever leverage hotspots along disconnected/extending cross-sections.
     - Overall printability verdict (`Ready`, `Under-Supported`, `Overloaded`, `Critical`).
2. **Part-Coupled Tip Diaphragm Constraints in `solveSupportFrameStress`**:
   - Group active tips at each layer by 2D connected cross-section component rather than assuming all tips on a layer hang independently in space.
   - Couple co-component tips via stiff-elastic master-slave rigid links (penalty diaphragm beams connecting each component's tips through a virtual rigid-body hub node) so the global matrix remains strictly SPD for Block-Jacobi PCG while transferring lateral drag accurately from flexible `leaf` tips into braced `trunk` towers.
   - **Implemented as `distributeRigidBodyDragLoads`**: the layer's lateral total is distributed through the exact 3-DOF rigid-body equilibrium (weighted by `d²`) inside each connected component of the Stefan mask, instead of penalty beams. Same rigid-diaphragm assumption, no new DOF, and the CG matrix is untouched (still SPD).
3. **Per-Component Critical Stage Selection**:
   - Extend critical layer selection to include peak peel/leverage layers of disconnected sub-assemblies before they merge into the main torso, instead of only 3 global layers.
4. **Upgrade Model Shader (`StressForceHeatmapMaterial`) for Printability + 2D Peel**:
   - Add a second heatmap channel or mode combining:
     - **Support Sufficiency / Printability mask**: paint uncovered overhang / load-deficit / high-leverage cantilever zones directly onto underside/part faces using spatial Gaussian/grid projection so unsupported areas glow unmistakably and clear as soon as supports are placed.
     - **True 2D XY Stefan pressure texture** (interpolated from `stefanField` on representative layers) instead of 1D Z-only bands.
5. **Interactive Hotspot Navigation in `SupportStressPanel`**:
   - Clicking a member hotspot calls `setSelectedId` (`src/supports/state.ts`) and highlights it; clicking an under-supported model hotspot jumps to/highlights that coordinate (and optionally triggers targeted placement).

**Phase 0 Verification:**
- Unit tests proving:
  - Removing supports from a flat overhang flips live sufficiency from pass to under-supported with accurate deficit regions.
  - Co-component rigid-diaphragm coupling transfers lateral shear between a thin angled leaf and an adjacent braced trunk without blowing up SPD CG convergence.
- Run `npm run bench:auto-supports` and verify `supportGraphStress.test.ts` passes cleanly.

---

### Phase 1 — Scaffold Native `dragonfruit-fea` Rust Crate & Solid Mesher (1–2 weeks)

**Discretization Strategy — Structured Matrix-Free Voxel-Hex8 (Primary) vs TetGen (`dragonfruit-tetgen`)**:
- **Primary engine: Structured Matrix-Free Voxel-Hex8**:
  - Immune to dirty/non-manifold STL soups using inside-outside winding/parity voxelization.
  - Every cube shares one identical `24×24` element stiffness matrix `K_hex(E, ν)` (using incompatible modes / EAS or reduced integration with hourglass stabilization to avoid bending shear locking), enabling fast matrix-free `rayon` PCG / Geometric Multigrid (`100k–300k` elements without massive sparse CSR memory).
  - Progressive print height `Z_k` simply activates voxel layers `z <= Z_k` in O(1) without remeshing per layer.
- **Secondary precision path (later): `rust/dragonfruit-tetgen` (`TetMesh`)**:
  - Reserved for ultra-thin hollow shells (`< 1.5 mm` walls) where uniform voxels are too coarse.
- **Workspace hygiene note**: `rust/dragonfruit-fea` currently contains only a leftover empty build `target/` directory (`no Cargo.toml`, `no src/`). Remove that stale `target/` folder before creating the crate, follow `AGENTS.md` standalone crate versioning + `npm run check:cargo-locks:fix`, and add dev documentation in `docs/dev/` registered in `website/src/data/docs-nav.json`.

**Phase 1 Deliverables:**
1. New crate in `rust/dragonfruit-fea` (`Cargo.toml`, voxelizer from indexed triangles, Hex8 matrix-free operator, Geometric Multigrid / Block-Jacobi PCG solver).
2. Tauri async IPC command (cancelable via generation ID so moving a support mid-solve aborts stale solves cleanly) + TypeScript bridge.
3. Analytical benchmark suite (`cargo test`):
   - Uniform tension patch test (`< 1e-5` error).
   - 3D cantilever beam tip deflection & bending stress vs Timoshenko analytical solution (`< 5%` error across grid refinement).
   - Pure bending check confirming zero locking.

---

### Phase 2 — Coupled Part + Support Progressive Z-Stage FEA (2–3 weeks)

Couple active solid part voxels (`z <= Z_k`) with active beam elements from `buildSupportGraph`:

1. **Progressive Stage Selection**: 8–16 key Z heights capturing isolated island emergence, peak Stefan force, peak `areaJumpRatio`, and pre-bridge cantilever maxima.
2. **Part–Support Interface Coupling**:
   - Map each active contact tip position onto its enclosing solid voxel via trilinear Hex8 shape functions.
   - Insert an elastic neck element representing the tapered `contactCone` (`contactDiameterMm` → `bodyDiameterMm`) connecting solid DOFs directly to the beam tip node inside a unified symmetric linear operator `[K_solid, C^T; C, K_beams]`.
3. **Physical Boundary Loads on Active Slice `Z = Z_k`**:
   - Clamp plate-touching model voxels (`z ≈ 0`) and support `roots`.
   - Distribute 2D Stefan peel suction pressure field across active slice faces at `Z = Z_k`, plus enclosed cavity hydrostatic suction surcharge where sealed pockets exist.
4. **Outputs**:
   - Per-vertex surface envelope across all stages: max principal tensile stress (MPa), von Mises stress (MPa), 3D peel displacement vector (mm), worst critical stage height `Z`, plus exact coupled beam/tip utilizations fed into `SupportFrameStressReport`.

**Phase 2 Verification:**
- Bench test comparing a thin (`0.8 mm`) unsupported horizontal wing vs the same wing with one edge support: verify coupled FEA detects severe root stress & tip deflection unsupported and confirms load transfer + reduced part stress when supported.

---

### Phase 3 — Progressive Peel Sweep & Photopolymer Failure Criteria (1–2 weeks)

1. **Progressive FEP / Tilt-Vat Peel Sweep**:
   - Evaluate 2–4 asymmetric release-front load cases per critical layer (perimeter-inward peel wave and tilt-hinge sweep) to capture outer-support tearing moments that synchronous vertical peel misses.
2. **Four Explicit Failure Modes**:
   - **Tip pull-off**: contact neck tensile stress exceeding green UTS.
   - **Shaft yield / Euler buckling**: combined axial + bending stress or compressive buckling exceeding member limits.
   - **Brittle green-part tear / delamination**: surface max principal stress or inter-layer normal tension exceeding cured green UTS.
   - **Dimensional layer shift / wobble**: cured-plane XY displacement `> 0.15 mm` during peel (prints fail dimensionally / show layer lines even below fracture).

---

### Phase 4 — GPU Solid Stress/Deformation Overlay, Closed-Loop Synthesis & Calibration (2+ weeks)

1. **Per-Vertex FEA Mesh Shader & Deformed Preview**:
   - Bind per-vertex stress/displacement attributes onto `StlMesh` via `StressForceHeatmapMaterial` (or dedicated FEA shader branch) with view switches (**Printability / Sufficiency** · **Von Mises / Principal Stress** · **Deflection**), stage scrubber matching `Peel Profile`, and an optional exaggerated **Deformed Preview (`5×–20×`)** slider in the vertex shader.
2. **Closed-Loop FEA Support Placement (`Fix Weak Spots`)**:
   - Feed unsupported high-deflection or high-principal-stress part zones and load-budget deficit clusters back into `autoPlace.ts` as high-priority placement candidates to **add missing `trunk` / `branch` / `leaf` supports or cross-`brace`s**, then automatically re-verify (`reinforceOverloadedFrameMembers` stays focused on thickening existing shafts).
   - **Implemented**: `planStressActions` (`stressActions.ts`) orders `brace-rocking` (from the new `rockingPair`; emitted only when a tip or member is also over — the known-good print's 3 mm sway at 32 % contact load is elastic), `brace-member` (overloaded leaf/branch, or a trunk over 200 %), and `thicken-member` (trunk/stump/kickstand/brace below that); the printability text report prints them. `addTargetedStressBraces` (`autoBrace.ts`) executes the brace actions in the stress feedback loop (horizontal tie first, 45° fallback, knots, clearance, one per pair, capped 4/pass), `promoteOverloadedLeaf` replaces an overloaded leaf with a branch on its host knot (capped 2/pass), and the frame is re-solved. Member braces attach at the member's own midpoint. Knot nodes within 0.5 mm weld into a single node (`KNOT_MERGE_TOL_MM`), so a brace knot cannot split a 0.2 mm "member" whose stress is joint geometry. **Member stress now compares to the bulk tensile** (`memberStrengthMpa`), not the 4.8 MPa 0.5 mm contact coupon: the 21-member/301 % alarm on the known-good print becomes 60 % and no overloads; the tip check keeps the coupon strength. **Column buckling uses the fixed-fixed effective length 0.5 L**, not 1.1 L (pinned-pinned + imperfection): a support is fixed into its root disk and cured into the part. **Coverage**: a critical region needs both ≥8 mm² uncovered and a ≥4 mm free span; 13.3 mm² at 3.9 mm is a warning, and an `underSupported` verdict is Needs Attention, not Action Needed.
3. **Material & Film Calibration Profiles**:
   - Move green-state mechanical constants (green modulus, green UTS, interlayer UTS, FEP screening length, peel pressure, lateral drag ratio) onto resin/printer settings instead of hardcoded constants in `supportGraphStress.ts` / `treeSynthesis.ts`.
   - Calibrate against simple test prints (cantilever deflection bars + suction-puck pull-off grid across Standard, Tough/ABS-like, and Detail resins).

---

## 6. Verification Gates & Agent Handoff Checklist

Every PR along this roadmap must satisfy:

- **Determinism**: identical inputs yield bit-identical reports/buffers across worker, main thread, and Rust runs (sorted voxel/DOF/entity ordering).
- **Non-blocking UX**: Tier 1 stays `< 50 ms` on interactive edits; Tier 2 runs asynchronously with cancellation if supports change mid-solve.
- **Repository rules (`AGENTS.md`)**:
  - Any change under `rust/*` bumps that crate's `version` once per branch and runs `npm run check:cargo-locks:fix` + `cargo check` / `cargo test`. **Never** bump main app version (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`) unprompted.
  - Wrap all UI strings in Lingui (`_(msg\`...\`)` / `<Trans>`), keep interpolating `msg` helpers at module scope, format all numbers/units via `useLocaleFormat()`, and run `npm run i18n:extract`.
  - Document new public Rust/IPC/TS contracts in `docs/dev/` (no pinned line numbers).
  - Pass all repo checks (PowerShell `;`, never `&&`):
    - `npx tsc --noEmit`
    - `node --import tsx --import ./scripts/test-unit/register.mjs --test "src/supports/__tests__/*.test.ts" "src/supports/autoBracing/__tests__/*.test.ts"`
    - `npm run check:lint ; npm run check:docs ; npm run check:i18n-literals`
    - `npm run bench:auto-supports`

### Open Decisions to Align With the User Before Phase 1

1. Confirm **Structured Matrix-Free Voxel-Hex8** as the primary solid FEA kernel (with optional TetGen refinement later for thin shells).
2. Decide default **UI overlay default**: whether toggling **Overlay ON** should default to **Printability (Under-Supported + Cantilevers + Beam Vectors)** and offer a pill to flip to **Peel Force / Solid FEA**, or keep separate toggles.
3. Choose the initial 2–3 resin calibration presets (e.g., Standard Miniatures, Tough/ABS-Like, Engineering Rigid) for empirically calibrated thresholds.
