# Baked Support Reconstruction Plan

This is the living design and implementation plan for converting baked support
geometry into editable DragonFruit-native supports. Update the status, decision
log, fixture inventory, and experiment log as the work evolves.

Last updated: 2026-06-23 (`0.6.0-floor-fastpath` with model-BVH pruning and inferred support floor roots).

## Goal

Recover the structural intent of supports embedded in an imported mesh and
represent the high-confidence portion as DragonFruit roots, trunks, branches,
leaves, braces, knots, segments, and contacts.

The first release targets the Tauri desktop application. It favors an editable
structural approximation over a mesh-identical copy, omits uncertain geometry
with diagnostics, and retains the baked source mesh hidden so conversion is
recoverable and undoable.

## Current status

- [x] Mixed model/support meshes can be classified and reordered model-first.
- [x] Classified geometry can be split into independent model and support meshes.
- [x] DragonFruit has an import format and normalization path for native support graphs.
- [x] Versioned Rust reconstruction contract and deterministic component diagnostics.
- [x] Research CLI for separate model/support meshes.
- [x] Initial PCA axial fit with robust radius estimation and synthetic tests.
- [x] BVH model projection and plate/model/open endpoint classification.
- [x] Tauri staged IPC, context-menu trigger, diagnostics modal, and JSON export.
- [x] Shaft attachment matching and preliminary trunk/branch/brace labels.
- [x] Axial radius profiles with shaft-only spans and transition dimensions.
- [x] Pure TypeScript native-support adapter for trunks, branches, braces, roots, knots, and contact cones.
- [x] Diagnostics modal reports native payload counts and rejected topology reasons.
- [x] Native payload reference/geometry validation before import merge.
- [x] First guarded Accept flow merges reconstructed native supports into the support store with undo history.
- [x] First fused-shell segmentation pass splits multi-axis connected support components before axial fitting.
- [x] Endpoint classification skips model BVH projection when outside the expanded model bounds.
- [x] Inferred support-floor fallback can seed roots when rafted supports sit above nominal plate Z.
- [ ] Research harness and representative fixture corpus.
- [ ] Rust primitive inference and confidence scoring.
- [x] Inferred-graph to native-support adapter.
- [ ] Non-destructive 3D preview and diagnostic overlays.
- [x] First support-store accept/cancel/undo path for generated native payloads.
- [ ] Hidden-source linkage, scene-level atomicity, and VOXL persistence.
- [ ] Performance tuning and malformed-input hardening.

## Product contract

### Eligible inputs

Offer **Reconstruct Native Supports** when the desktop runtime has either:

1. A mixed mesh with a valid `model_triangle_count` classifier boundary.
2. A support-only mesh explicitly linked to its corresponding model.

For a mixed mesh, derive the two triangle sections in memory. Do not require the
user to permanently run **Split Supports** first. Arbitrary manual model/support
pairing is outside v1.

### Preview and acceptance

Analysis is non-mutating. The preview shows:

- Reconstructed native supports using normal support colors.
- The baked source as a translucent ghost.
- Omitted source regions with a distinct warning color.
- Counts for contacts, roots, trunks, branches, leaves, braces, and omissions.
- Overall confidence, source-surface coverage, and warnings.

The available actions are **Accept**, **Cancel**, and **Export Diagnostics**.
Accept merges the validated graph, hides but retains the baked source, selects
the target model, and records one scene-history transaction. Cancel changes
nothing. Browser builds explain that reconstruction currently requires desktop.

## Architecture

### Ownership boundaries

- The existing mesh classifier remains responsible only for separating probable
  model and support triangles.
- `dragonfruit-mesh-repair` owns geometric inference and emits a versioned,
  frontend-independent intermediate graph.
- The Tauri layer owns staged binary transport and cancellation.
- A TypeScript adapter validates and converts the intermediate graph into
  `DragonfruitImportFormat` with fresh IDs.
- The scene manager owns preview lifecycle, source visibility, persistence,
  selection, and atomic history.

Keep reconstruction separate from `MeshHealthReport`; classification and mesh
repair must continue to work without the experimental reconstruction contract.

### IPC request

Add a versioned `SupportReconstructionRequest` containing:

- Model and support non-indexed triangle soups in world-space millimeters.
- The build-plane Z coordinate.
- `SupportReconstructionOptions` and its schema version.
- Optional cancellation/progress identifiers used by the Tauri command.

Upload large input buffers through staged binary IPC. Do not JSON-encode triangle
data. The command returns graph metadata as JSON and exposes unmatched triangle
labels or geometry through a binary read command.

### Intermediate result

`InferredSupportGraph` must include:

- Schema version and analyzer/options versions.
- Candidate roots, axial runs, joints, contacts, and support attachments.
- Directed graph nodes and edges with stable analysis-local identifiers.
- Per-candidate dimensions, source component IDs, fit residuals, confidence
  components, final confidence, and acceptance/rejection state.
- Coverage totals and an unmatched-source representation.
- Structured warnings and rejection codes, not only display strings.
- Timing and input-size diagnostics.

All coordinates must be finite world-space millimeters. Output ordering must be
deterministic for identical input and options.

## Geometry inference pipeline

### 1. Preprocess

- Reject empty, non-finite, or structurally invalid triangle buffers.
- Weld near-identical vertices with a scale-aware epsilon.
- Build triangle adjacency, connected components, normals, bounds, and BVHs.
- Preserve mappings from processed triangles to source triangles for diagnostics.

### 2. Segment and fit primitives

- Start with disconnected shells where available.
- Within fused shells, segment by normal continuity, curvature, and geometric
  proximity before fitting.
- Use PCA for candidate axes, followed by robust cylinder/frustum fitting.
- Record axial endpoints, radii, taper, fit residual, sample support, and source
  triangle membership for every accepted or rejected fit.
- Treat sphere-like bulbs and intersecting fitted axes as joint evidence, not as
  mandatory standalone primitives.

### 3. Classify endpoints

- **Plate:** broad radial geometry or an axial endpoint reaches the build-plane
  tolerance band.
- **Model:** the endpoint projects to the model BVH and has compatible distance,
  direction, and surface normal.
- **Support:** the endpoint terminates on another fitted shaft within attachment
  tolerance.
- **Open:** no endpoint hypothesis is sufficiently confident.

Use independent confidence terms for primitive fit, endpoint classification,
attachment fit, and topology. Centralize all tolerances in the versioned options
structure; do not distribute numeric thresholds through the analyzer.

### 4. Construct the support graph

- A plate-to-model path becomes a trunk with roots and a contact.
- A shaft-to-model path becomes a branch, or a leaf when no meaningful shaft
  length remains.
- A shaft-to-shaft connection with no model or plate endpoint becomes a brace.
- Collinear axial runs are merged; meaningful direction changes become joints.
- Cycles, dangling references, zero-length runs, upward-invalid paths, and
  incompatible crossings are rejected or left unmatched.
- Uncertain pieces are never forced into the nearest native type merely to
  increase coverage.

### 5. Measure coverage

Sample the baked support surface and measure distance to the reconstructed native
geometry. Report covered area/sample ratio, unmatched components, maximum and
percentile error, and per-entity coverage. Coverage is diagnostic and must not
override structural validation.

## Native conversion

Map the inferred graph directly into native entities. Do not invoke normal
placement or pathfinding builders because they may reroute recovered geometry.

Before calling `mergeFromImportFormat`, validate that:

- Every referenced root, segment, knot, contact, and support entity exists.
- Every knot lies on its declared host shaft within tolerance.
- Every contact projects to the intended model surface.
- Every root terminates on the build plane.
- Entity ownership uses the target model ID consistently.
- The parent graph is acyclic and all generated coordinates and dimensions are valid.

Reuse import normalization after validation. Generate fresh IDs only in the
TypeScript adapter so Rust results remain deterministic and frontend-independent.

## Scene persistence and history

Add optional loaded-model and VOXL metadata linking a baked support source to:

- Its target model ID.
- The reconstruction schema/analyzer version.
- The accepted diagnostic summary.

The field is optional so existing VOXL files remain compatible. Acceptance must
capture model visibility/linkage and complete support state in one before/after
scene snapshot. Undo restores the source visibility and removes the reconstructed
graph; redo reapplies both.

## Delivery milestones

### 1. Research harness

- [x] Add a Rust CLI/debug output mode for reconstruction JSON.
- [ ] Export unmatched geometry as a separate binary diagnostic payload.
- [x] Generate initial synthetic box and cylinder fixtures in Rust tests.
- [ ] Generate synthetic meshes from complete DragonFruit support graphs.
- [ ] Establish a legally shareable corpus of real slicer exports and expected outcomes.

### 2. Primitive inference

- [x] Validate and re-weld input meshes with versioned options.
- [x] Extract deterministic edge-connected components with source-triangle provenance.
- [x] Emit component bounds, centroid, area, plate contact, and PCA axial fits.
- [x] Project axial endpoints to the model BVH and emit plate/model/open
  classifications, root/contact candidates, and deterministic graph edges.
- [x] Match open endpoints to other finite shafts and classify simple endpoint
  patterns as trunks, branches, braces, or unresolved.
- [x] Recover the longest modal-radius shaft span, transition lengths, and
  endpoint radii from connected axial root/shaft/contact geometry.
- [x] Add a first fused-shell segmentation pass that groups long side faces by
  dominant axis, absorbs caps/transitions by adjacency, and fits each segment
  independently.
- [x] Add model-bounds fast rejection before closest-point BVH projection and
  support-floor root fallback for rafted or offset support-only geometry.
- [ ] Add robust cylinder/frustum fitting, support
  graph validation, complete confidence scoring, and coverage.

Current analyzer version: `0.6.0-floor-fastpath`. Axial, endpoint, root, contact,
attachment, and simple topology candidates now feed a pure TypeScript native
preview payload for high-confidence trunk, branch, and brace cases. Scene
mutation, source hiding, overlays, and matched coverage remain absent until the
preview/accept stages land.

Run the harness with:

```powershell
cargo run --manifest-path rust/dragonfruit-mesh-repair/Cargo.toml --bin dragonfruit-mesh-repair -- reconstruct-supports model.stl supports.stl --plate-z 0 --pretty
```

### 3. Native adapter

- [x] Normalize the IPC response and reject unsupported schemas/non-finite values.
- [x] Allocate fresh frontend IDs and build `DragonfruitImportFormat` for trunks,
  branches, braces, roots, knots, shaft segments, and contact cones.
- [x] Validate generated references, model ownership, finite geometry, and
  positive dimensions before the payload is allowed near import merge.
- [ ] Validate contact projection and root build-plane termination against the
  live scene before accept.

### 4. Preview workflow

- [x] Add classified-mesh eligibility and desktop capability checks.
- [x] Stage transformed world-space model/support soups and invoke Rust without mutation.
- [x] Show loading/error states, diagnostic counts, timings, confidence, warnings,
  and raw JSON export from the model context menu.
- [x] Add a guarded Accept button that blocks validation errors and empty native
  payloads, merges supports, selects the target model, and records support undo history.
- [ ] Add cancellation, 3D source/native/unmatched overlays, hidden-source
  linkage, and scene-level atomic history.

### 5. Hardening

- Tune using the fixture corpus, establish time/memory limits, fuzz malformed
  meshes, and document unsupported topology.

### 6. Future work

- WASM execution, manual pairing, user-assisted graph correction, curved support
  fitting, raft reconstruction, and mesh-silhouette optimization.

## Test and acceptance plan

### Rust tests

- Unit tests for welding, component mapping, cylinder/frustum fitting, plate roots,
  model contacts, support attachments, shaft intersections, confidence, and graph
  classification.
- Synthetic round trips for trunks, branches, leaves, braces, bends, mixed
  diameters, and multiple disconnected trees.
- Negative fixtures for ordinary multi-shell models, debris, raft-only geometry,
  fused model/support meshes, malformed triangles, and ambiguous crossings.
- Property tests for non-finite input rejection, deterministic ordering, and graphs
  without dangling references.

### Frontend tests

- [x] Contract normalization, schema rejection, non-finite rejection, and
  local-to-world triangle-soup transformation.
- [x] ID rewiring, native payload creation, and dangling-reference rejection.
- Preview does not mutate scene or support state.
- [x] First Accept attempt merges support state and records undo history.
- Cancel is clean; full scene-level accept atomicity and visibility/source undo
  remain pending.
- VOXL round trips preserve reconstructed supports and optional source linkage.
- Desktop/browser capability behavior and diagnostic export are covered.

### Initial synthetic targets

- No dangling references or invalid support graphs.
- At least 95% of known contacts and roots recovered within 0.3 mm.
- Shaft axes within 2 degrees and diameters within 10% on clean fixtures.
- Deterministic output for identical input and options.
- Uncertain geometry is omitted and reported rather than silently converted.

Benchmark small, medium, and support-heavy fixtures. Record wall time, peak memory,
candidate count, accepted count, and coverage. Set release budgets only after the
corpus provides representative baselines.

## Diagnostics example

```json
{
  "schemaVersion": 1,
  "analyzerVersion": "0.1",
  "summary": {
    "roots": 0,
    "trunks": 0,
    "branches": 0,
    "leaves": 0,
    "braces": 0,
    "omittedCandidates": 0,
    "surfaceCoverage": 0.0
  },
  "warnings": [],
  "rejections": []
}
```

The real schema may add fields, but existing fields require a schema-versioned
migration or compatibility path once fixtures depend on them.

## Fixture inventory

| Fixture | Source | Expected result | Status |
| --- | --- | --- | --- |
| Single straight trunk | Synthetic DragonFruit | One root, trunk, and contact | Planned |
| Trunk with branch | Synthetic DragonFruit | One trunk and one branch | Planned |
| Two trunks with brace | Synthetic DragonFruit | Two trunks and one brace | Planned |
| Bent support | Synthetic DragonFruit | One support with preserved joint | Planned |
| Multi-shell model only | Synthetic negative | Reconstruction unavailable/rejected | Planned |
| Fused support tree | Synthetic stress | High-confidence subset plus omissions | Planned |
| Capped straight cylinder | Synthetic Rust test | Axis under 2 degrees; radius within 10% | Passing |
| Plate-to-model cylinder | Synthetic Rust test | One root, one model contact, and two graph edges | Passing |
| Floating cylinder | Synthetic negative | Two open endpoints and no coerced graph entities | Passing |
| Contact shaft on host | Synthetic Rust test | One host attachment and branch topology | Passing |
| Shaft between two hosts | Synthetic Rust test | Two host attachments and brace topology | Passing |
| Profiled root/shaft/contact body | Synthetic Rust test | Shaft span and both transitions recovered | Passing |
| Profiled native trunk payload | Synthetic TypeScript test | Root, segment, socket joint, and measured contact cone | Passing |
| Native branch and brace payload | Synthetic TypeScript test | Attachments become preserved host knots with valid references | Passing |
| Zero contact transition | Synthetic TypeScript negative | Topology rejected instead of creating a zero-length cone | Passing |
| Dangling native reference | Synthetic TypeScript negative | Validator reports broken references before import merge | Passing |
| Guarded Accept flow | Manual desktop UI path | Valid native payload can merge into support store; validation errors/empty payloads block | Implemented, needs interactive mesh fixture |
| Mixed-axis support component | Synthetic Rust test | One component can split into multiple axial face groups before fitting | Passing |
| Offset support floor | Synthetic Rust test | Lowest support plane above nominal plate can seed a root | Passing |

Do not commit third-party production meshes unless their redistribution terms are
known. Store corpus provenance and expected analyzer version beside each fixture.

## Decision log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-06-23 | V1 is Tauri desktop only | Native Rust is the appropriate first home for heavy geometry analysis. |
| 2026-06-23 | Optimize for editable approximation | Structural intent is more valuable than reproducing every source triangle. |
| 2026-06-23 | Omit low-confidence candidates | Invalid native graphs are worse than explicit coverage gaps. |
| 2026-06-23 | Hide and retain baked geometry | Conversion remains recoverable and can be compared or undone. |
| 2026-06-23 | Support classified mixed and linked split inputs | Avoid unnecessary user steps without adding arbitrary pairing UI. |
| 2026-06-23 | Components use shared-edge connectivity | Vertex-only contact should not silently merge otherwise independent shells. |
| 2026-06-23 | Axial radius uses median/MAD statistics | Cap-center vertices are expected outliers and must not spoil cylinder fits. |
| 2026-06-23 | Model projection uses BVH branch-and-bound nearest-point queries | Endpoint analysis must scale without scanning every model triangle. |
| 2026-06-23 | Plate and model hypotheses compete by confidence | An endpoint near both must resolve deterministically instead of creating two owners. |
| 2026-06-23 | Initial UI is preview-only and stages world-space soups | Real meshes can exercise native inference without mutating scene/support state or confusing local model transforms with analyzer coordinates. |
| 2026-06-23 | Only open endpoints may become support attachments | Plate/model evidence must not be overwritten by a nearby shaft hypothesis. |
| 2026-06-23 | Initial topology uses explicit endpoint patterns | Simple trunk, branch, and brace labels can be tested while unsupported patterns remain visible and unresolved. |
| 2026-06-23 | Native conversion waits for shaft/contact separation | DragonFruit contact cones require a real socket endpoint; converting whole-component axes would create overlapping or zero-length cones. |
| 2026-06-23 | Shaft span is the longest modal-radius cross-section run | It is deterministic, preserves broad root/tip transitions, and remains inspectable before more advanced segmentation. |
| 2026-06-23 | Grounded shafts without model contacts may be trunks | Host-only support columns are needed for recovered branches and braces even when the column itself never touches the model. |
| 2026-06-23 | Native generation is a pure preview adapter before scene mutation | It lets us validate IDs, references, transitions, and rejection behavior before adding Accept/history/source-hiding semantics. |
| 2026-06-23 | Native conversion rejects missing transitions rather than inventing anatomy | Root cones and contact cones need real measured spans; zero-length inferred transitions stay diagnostic-only. |
| 2026-06-23 | Adapter validation errors are separate from topology rejections | A rejection is expected omission; a validation error means generated native topology violates the import contract and must block accept. |
| 2026-06-23 | First Accept mutates only support state | It proves reconstructed native entities can be imported and undone before adding hidden baked-source linkage and scene-level history. |
| 2026-06-23 | Fused-shell segmentation starts with long side-face axes | It avoids forcing an entire connected support tree through one PCA axis while letting caps and tapered transitions inherit the nearest shaft label. |
| 2026-06-23 | Endpoint model projection must be gated by model bounds | Real files can contain hundreds of candidate endpoints; querying the model BVH for points far outside contact range made desktop reconstruction unusably slow. |
| 2026-06-23 | Lowest support Z may act as an inferred root plane | Some baked/combined exports include rafted support geometry above nominal plate Z; strict plate-Z matching yielded zero roots and no importable trunks. |

## Experiment log

Append experiments rather than rewriting their outcome. Each entry should record
the fixture set, analyzer/options version, hypothesis, quantitative result,
failure modes, and resulting decision.

| Date | Experiment | Result | Follow-up |
| --- | --- | --- | --- |
| 2026-06-23 | PCA axial fit on a capped 24-sided cylinder, radius 1 mm and length 10 mm | Deterministic candidate passed the 2-degree axis, 10% radius, and 0.01 mm length checks. All source triangles remain unmatched because endpoint/graph inference is pending. | Add model-BVH contact projection and endpoint confidence. |
| 2026-06-23 | Endpoint classification on grounded and floating capped cylinders | Grounded fixture emitted one plate root, one zero-distance model contact with underside normal, and deterministic edges. Floating fixture emitted two open endpoints and no root/contact. | Add shaft-to-shaft attachment inference and resolve graph topology. |
| 2026-06-23 | Desktop diagnostic bridge contract | Tauri compiled with the staged reconstruction command; frontend tests accepted schema v1, rejected unknown/non-finite results, and verified non-uniform-scale plus translation of triangle soup. | Exercise representative classified STL files and capture exported JSON in the fixture inventory. |
| 2026-06-23 | Shaft attachment and topology fixtures | A perpendicular contact shaft resolved to its host and labeled branch; a shaft between two hosts produced two deterministic attachments and labeled brace; the grounded contact fixture labeled trunk. | Validate noisy gaps, competing hosts, and fused-shell inputs before native conversion. |
| 2026-06-23 | Axial profile on one connected four-ring body | Recovered an 8 mm shaft from Z=1 to Z=9, two 1 mm transitions, 2 mm root radius, and 1 mm contact-end radius. Root/contact candidate diameters now use endpoint measurements instead of shaft diameter. | Add multi-run segmentation and socket-oriented native preview conversion. |
| 2026-06-23 | Pure native topology adapter fixtures | Profiled trunk conversion generated a DragonFruit import payload with measured root transition, shaft segment, socket joint, and disk contact cone. Branch and brace fixtures generated preserved host knots and valid references. A zero contact transition was rejected with diagnostics. | Wire the payload into an actual non-mutating visual preview, then add Accept/Cancel scene transactions. |
| 2026-06-23 | Native payload validation pass | The adapter now reports dangling roots, knots, host segments, socket joints, model mismatches, non-finite positions, and invalid dimensions separately from expected topology omissions. A synthetic dangling-knot payload fails validation before import merge. | Use validation errors as an Accept blocker when the preview workflow becomes mutating. |
| 2026-06-23 | Guarded Accept flow | The diagnostics modal can now merge a clean native preview payload through `mergeFromImportFormat`, select the target model, close the modal, and push support-edit history. Empty payloads and validation errors block before mutation. | Exercise on real classified STLs, then add baked-source hiding/linkage and a scene-level transaction. |
| 2026-06-23 | First fused-shell segmentation | Components with multiple dominant long-face axes can now emit separate axial segments; single-axis tapered profiles stay intact because short/cap/transition faces no longer seed their own axes. | Replace the heuristic with curvature/PCA region growing and validate on real slicer exports. |
| 2026-06-23 | Real file smoke result: `STL_MU_Stone_Shaper_1_Combined_Supported.stl` | Initial `0.5.0-segmentation` run reported 2,779 components, 213 accepted shafts, 0 roots, 2 contacts, 51 braces, 0 native entities, and 188,566 ms runtime. | Add BVH fast rejection, inferred support-floor roots, then re-test this file interactively. |

## Known limitations and research questions

- Existing classification is heuristic and depends on disconnected-component
  density and height patterns; it is not a universal support detector.
- Unioned supports may require surface segmentation before primitive fitting.
- Spheres, cones, and overlapping cylinders can make the intended axis graph
  locally ambiguous.
- Baked rafts are not reconstructed in v1.
- Curved supports are approximated with straight runs and joints in v1.
- Contact geometry may be partially embedded in the model and therefore invisible.
- Model-contact direction confidence currently depends on imported triangle winding;
  add an orientation-tolerant fallback for meshes whose normals are unreliable.
- Determine whether robust fitting needs an additional math/spatial dependency or
  should remain implemented on the crate's existing mesh/BVH structures.
- Determine confidence defaults from fixtures; do not treat initial tolerances as
  stable public behavior.

## Assumptions

- V1 is experimental and desktop-native.
- Reconstructed supports are editable approximations, not mesh-identical copies.
- Only high-confidence geometry is generated.
- Accepted conversions retain the hidden baked support source.
- Rafts, arbitrary manual pairing, web/WASM execution, forced full coverage, and
  exact silhouette matching remain out of scope.
