//! Import-time triangle-budget governor for native STL preview decimation
//! (STL-import decimation remediation, Phase 2a — plan §"Preview honesty +
//! bounded viewport decimation", decimation-policy redesign).
//!
//! ## This is not the app's only RAM arbiter — and must not be merged with the other
//! `rust/dragonfruit-slicing-engine/src/engine.rs` (`PostTaskGate`, issue #386/#405)
//! also reads available RAM. It is an *in-flight throttle*: it bounds the count of
//! outstanding 3DAA post/z-blur tasks in the **native slicer process**, continuously
//! **during a slice job**, retuning against machine state at dispatch time (so it is
//! non-deterministic by design). This module is an *admission gate*: it bounds the
//! triangle count entering the **WebView renderer heap**, exactly once, **before an
//! import**, as a pure function of its inputs. Different resource, different process,
//! different phase, different quantity — the apparent duplication is not duplication,
//! and collapsing them would cost either determinism here or adaptivity there.
//!
//! ## Why a governor instead of a constant
//! The legacy loader replaced any binary STL over a fixed 6,000,000-triangle
//! gate with a fixed ~2,000,000-triangle preview. That is a 3× fidelity
//! discontinuity at an invisible boundary (a 5.99M mesh renders verbatim; a
//! 6.01M mesh loses two-thirds of its triangles). This governor replaces both
//! constants with a single, deterministic, machine-scaled budget so the
//! decimation ratio grows smoothly from ~1.0 at the boundary: a mesh at or
//! under budget is kept verbatim, a mesh over budget is decimated *to* budget.
//!
//! Deterministic by construction: [`compute_triangle_budget`] is a pure
//! function of its inputs. The only impure part, [`query_system_memory`], is
//! isolated so it can be substituted in tests and so the budget is a stable
//! function of (machine RAM, WebView heap limit, model size). Higher-power
//! systems get genuinely larger budgets — up to [`MAX_BUDGET_TRIANGLES`], an
//! absolute safety ceiling the memory signals may only reduce below, never
//! exceed (see that constant for why `jsHeapSizeLimit` alone is not safe).
//!
//! ## The per-triangle cost model is DERIVED, not guessed
//! The budget converts a memory allowance into a triangle count via
//! [`BYTES_PER_TRIANGLE_HEAP`]. That constant is anchored to the Phase-0
//! MEASURED FACT: the off-origin 12M lattice floors at ~6.22M triangles, and
//! that preview occupies ~450 MB WebView-side. 450e6 / 6.22e6 ≈ 72.3 bytes/tri
//! — which is *exactly* the geometry the DFST loader hands the WebView:
//!
//! ```text
//!   non-indexed triangle soup (see mesh_repair::encode_stl_response):
//!     position: 3 verts × 3 f32 = 36 B/tri
//!     normal:   3 verts × 3 f32 = 36 B/tri
//!                               = 72 B/tri   ← matches the 450 MB / 6.22M datum
//! ```
//!
//! So the P0 "~450 MB" figure is the CPU geometry buffers alone. Those are the
//! dominant heap cost but not the only one: a rendered import also keeps, in
//! the WebView JS heap the `jsHeapSizeLimit` governs,
//!
//! ```text
//!     three-mesh-bvh (raycast / support picking):  ~48 B/tri
//!       (bounds nodes + the index buffer three-mesh-bvh materializes for a
//!        non-indexed BufferGeometry)
//!     one undo / history snapshot of positions:    ~36 B/tri
//! ```
//!
//! for a subtotal of **72 + 48 + 36 = 156 B/tri**. (The GPU vertex buffer
//! upload — another ~72 B/tri — lives in GPU / native memory, NOT the JS heap
//! `jsHeapSizeLimit` bounds, so it is deliberately excluded from the heap-term
//! cost; it is bounded indirectly by the same budget.)
//!
//! Reconciliation vs the P0 datum: this model predicts 6.22M × 72 B = 448 MB
//! for the raw geometry buffers — matching the ~450 MB measurement to 0.4 %.
//! The additional 84 B/tri (BVH + one snapshot) is real heap the P0
//! geometry-only snapshot did not include; it makes the budget deliberately
//! conservative (a smaller, safer budget), not "wildly" off. This comment
//! discipline mirrors the in-repo precedent
//! `src/components/scene/hollowVoxelPreviewLimits.ts`.
//!
//! ## Ph1 correction — the 156 B/tri subtotal UNDER-COUNTED the classified path
//!
//! `156` predates two costs that are now real:
//!
//! **(1) The per-section geometries.** When a repair/classify pass reports a
//! `model_triangle_count`, `processGeometry` builds two additional
//! `BufferGeometry`s off the same soup (`src/hooks/useStlGeometry.ts`, the
//! `report.model_triangle_count != null` branch) and stores BOTH on
//! `meshDefects` for the lifetime of the model:
//!
//! ```text
//!   modelSectionGeometry   = allPos.slice(0, modelFloatEnd)
//!                            position only            → 36 B/tri  (model section)
//!   supportSectionGeometry = allPos.slice(modelFloatEnd)
//!                            + computeVertexNormals()
//!                            position + normal        → 72 B/tri  (support section)
//! ```
//!
//! The two sections partition the mesh, so per TOTAL triangle the added cost is
//! `36·(1−s) + 72·s` for a support fraction `s` — **+36 B/tri** for an
//! all-model split through **+72 B/tri** for an all-support one. Against a 156
//! subtotal that is a **23 %–46 % under-count**.
//!
//! Why the worst case is the right one to bank: these geometries exist ONLY on
//! the classified path, and Ph1 makes classification run on the full-res mesh
//! at import — so "classified" stops being the exception and becomes the normal
//! case for exactly the pre-supported plate files this arc targets. On those
//! files the support section DOMINATES (the classifier's own gates require
//! ≥2 000 support triangles across ≥4 components averaging <⅓ the model's
//! density, and `likely_support_geometry` additionally wants support ≥ model),
//! so `s → 1` and the added cost is the full 72. The governor's stated doctrine
//! is that the memory signals may only ever reduce the budget, and the
//! regression it exists to prevent is a hard renderer OOM kill — so it banks
//! the worst case rather than a blend.
//!
//! ```text
//!   72 (soup) + 48 (bvh) + 36 (snapshot) + 36 (section copy) + 36 (section normals)
//!     = 228 B/tri
//! ```
//!
//! Consequence, stated plainly: the budget on a 2 GB-heap machine falls from
//! ~2.75M to ~1.88M triangles, and the heap needed to reach the 4M ceiling
//! rises from ~3.1 GB to ~4.6 GB. That is a real PREVIEW fidelity reduction —
//! and only a preview one: since P1 the full-resolution source is what slicing,
//! export, hollowing and repair actually consume, so print output is unaffected.
//! A smaller preview on a small-heap machine is the correct trade against
//! reviving the import OOM.
//!
//! **(2) D8 — retained multi-body copies.** A multi-body 3MF import keeps the
//! merged geometry AND an independently-processed copy of every body
//! (`load3mfGeometryMergedWithSplitData` → `splitBodies`, stored on the model
//! and never released), so the geometry term is paid TWICE for the whole
//! session whether or not the user ever splits. Verified scope correction to
//! the plan's phrasing: the BVH is **not** doubled — it is built lazily per
//! rendered geometry (`accelerateGeometry` via `deferAccelerateGeometry`), so
//! the split bodies acquire one only once they become models, at which point
//! the merged geometry is dropped. The cost is therefore a geometry-copy
//! multiplier, not a flat doubling of everything.
//!
//! 3MF does not reach this governor today (it loads entirely in the WebView),
//! so [`BudgetInputs::retained_geometry_copies`] defaults to `1` and the term
//! is a no-op on the live path. It exists now so Ph8 declares the cost when it
//! routes 3MF through here, instead of rediscovering it as an OOM.

use sysinfo::System;

/// Non-indexed triangle soup handed to the WebView by the DFST loader:
/// position (3×3 f32) + normal (3×3 f32). Anchored to the P0 450 MB / 6.22M
/// measurement (see module docs).
pub const SOUP_BYTES_PER_TRIANGLE: f64 = 72.0;

/// three-mesh-bvh bounds nodes + the index buffer it materializes for a
/// non-indexed `BufferGeometry`.
pub const BVH_BYTES_PER_TRIANGLE: f64 = 48.0;

/// One retained undo / history snapshot of the position buffer.
pub const SNAPSHOT_BYTES_PER_TRIANGLE: f64 = 36.0;

/// Position copy held by `modelSectionGeometry` + `supportSectionGeometry`
/// together. The two sections partition the mesh, so this is paid once per
/// triangle on any classified import.
pub const SECTION_COPY_BYTES_PER_TRIANGLE: f64 = 36.0;

/// Normals `computeVertexNormals()` builds on `supportSectionGeometry`. Paid on
/// the SUPPORT section only; banked at the full rate because the pre-supported
/// plate class this governs is support-dominant (see module docs).
pub const SECTION_NORMAL_BYTES_PER_TRIANGLE: f64 = 36.0;

/// Per-triangle WebView JS-heap residency for a non-indexed native preview.
/// DERIVED, never guessed — see the module docs for the full derivation and
/// for why the section terms are banked at their worst case.
///
/// `72 (soup) + 48 (bvh) + 36 (snapshot) + 36 (section copy) + 36 (section
/// normals) = 228`.
///
/// Was `156.0` before Ph1, which omitted both section terms and therefore
/// under-counted the classified path — the normal case from Ph1 onward — by
/// 23–46 %.
pub const BYTES_PER_TRIANGLE_HEAP: f64 = SOUP_BYTES_PER_TRIANGLE
    + BVH_BYTES_PER_TRIANGLE
    + SNAPSHOT_BYTES_PER_TRIANGLE
    + SECTION_COPY_BYTES_PER_TRIANGLE
    + SECTION_NORMAL_BYTES_PER_TRIANGLE;

/// Per-triangle cost once D8's retained-copy multiplier is applied. Only the
/// GEOMETRY terms scale with retained copies: an extra retained body copy is a
/// `processGeometry` output (position + normal), not another BVH, another undo
/// snapshot, or another pair of section geometries.
pub fn effective_bytes_per_triangle(retained_geometry_copies: u32) -> f64 {
    let extra_copies = retained_geometry_copies.max(1).saturating_sub(1) as f64;
    BYTES_PER_TRIANGLE_HEAP + extra_copies * SOUP_BYTES_PER_TRIANGLE
}

/// Fraction of the WebView JS heap (`jsHeapSizeLimit`) budgeted for one
/// model's geometry + ancillaries. **Lowered to 0.20 (from an initial 0.45
/// that caused import OOMs, 2026-07-20):** `jsHeapSizeLimit` overstates the
/// usable ceiling (V8 heap-object limit ≫ the renderer-process memory that
/// actually OOM-kills on a big mesh), and the binding cost is the IMPORT PEAK
/// (decode transfer buffer + rebuilt BufferGeometry + BVH build ≈ 2–2.5× the
/// 156 B/tri steady residency), so the steady-state budget must leave that
/// headroom. 0.20 × 2 GB / 156 ≈ 2.75M tris steady (~430 MB), whose ~1 GB
/// import peak fits. Larger heaps scale up but are hard-capped by
/// [`MAX_BUDGET_TRIANGLES`]. Precedent: `hollowVoxelPreviewLimits.ts` spends
/// 0.12 on a secondary subsystem. TUNABLE.
const HEAP_FRACTION: f64 = 0.20;

/// Fraction of AVAILABLE system RAM allowed as a secondary cap, so we never
/// budget more geometry than the physical machine can hold even if the WebView
/// reports a large `jsHeapSizeLimit`. Also the primary signal when the heap
/// limit is not forwarded (older WebViews / non-Chromium). Kept small (0.10):
/// system RAM must serve the whole app, the OS, and other processes, unlike
/// the WebView's private heap.
const RAM_FRACTION: f64 = 0.10;

/// Conservative floor budget — a usable, non-zero minimum so weak machines and
/// failed memory queries still get a workable preview (never a zero-triangle
/// budget). ~1M tris ≈ 72 MB of geometry, fitting even a constrained heap. The
/// legacy fixed target was 2M; 1M is a safe lower bound for the fallback path.
const FLOOR_TRIANGLES: u64 = 1_000_000;

/// Absolute upper ceiling — the maximum triangles any preview keeps, on ANY
/// machine, REGARDLESS of the heap/RAM signals (they may only reduce the budget
/// below this, never exceed it). Restores the safety the legacy fixed 2M cap
/// provided, which P2a removed. **Why an absolute cap and not just trust the
/// signals:** `jsHeapSizeLimit` overstates the real limit — the WebView
/// RENDERER process is OOM-killed by a large mesh's import PEAK (decode
/// transfer buffer + rebuilt BufferGeometry + three-mesh-bvh build) well before
/// V8's nominal heap limit. Empirical (2026-07-20): an 11.24M-tri preview
/// hard-crashed the renderer on a 4.4 GB-heap / 256 GB-RAM workstation because
/// the un-capped governor computed a 12.68M budget (> source) and kept the mesh
/// verbatim. 4M is a conservative always-fits cap — ~2× the legacy 2M (a real
/// fidelity win) yet decimating that 11.24M model to a size that loads. TUNABLE
/// upward once the indexed-geometry rework (follow-up) roughly halves
/// per-triangle memory.
pub const MAX_BUDGET_TRIANGLES: u64 = 4_000_000;

/// Which constraint set the budget — logged with the budget for diagnosis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetReason {
    /// The WebView JS-heap term (`jsHeapSizeLimit`) was the binding constraint.
    HeapBound,
    /// The available-system-RAM term was the binding constraint.
    RamBound,
    /// A computed budget fell below [`FLOOR_TRIANGLES`] and was clamped up.
    Floor,
    /// A computed budget exceeded [`MAX_BUDGET_TRIANGLES`] and was clamped down
    /// to the absolute safety ceiling (the common case on high-RAM machines).
    Ceiling,
    /// Neither a heap limit nor a RAM figure was available → floor budget.
    NoMemorySignal,
}

impl BudgetReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            BudgetReason::HeapBound => "heap-bound",
            BudgetReason::RamBound => "ram-bound",
            BudgetReason::Floor => "floor (computed budget below floor)",
            BudgetReason::Ceiling => "ceiling (computed budget above safety cap)",
            BudgetReason::NoMemorySignal => "floor (no memory signal)",
        }
    }
}

/// Machine + job facts the budget is derived from. All memory fields are in
/// BYTES; `0` means "unknown / query failed" and drops that term (never
/// silently forces a zero budget).
#[derive(Debug, Clone, Copy)]
pub struct BudgetInputs {
    /// Total physical RAM (sysinfo). Logged for diagnosis; not a term itself.
    pub ram_total_bytes: u64,
    /// Available physical RAM (sysinfo). Secondary cap / heap-unknown fallback.
    pub ram_available_bytes: u64,
    /// WebView `performance.memory.jsHeapSizeLimit`, forwarded by the frontend.
    /// `0` when unavailable (non-Chromium WebView, or not forwarded).
    pub heap_limit_bytes: u64,
    /// The source mesh's triangle count (from the STL header / parse).
    pub source_triangles: u64,
    /// Plate-count divisor hook: how many models the budget is shared across.
    /// `1` today (imports are per-file; the frontend forwards no plate count
    /// yet). True plate-level largest-first rebalancing is a documented
    /// follow-up; this divisor is the seam it will use.
    pub concurrent_model_count: u32,
    /// D8: how many copies of this mesh's geometry the import keeps resident.
    /// `1` for every caller today. A multi-body 3MF is `2` — the merged
    /// geometry plus the retained per-body `splitBodies` copies, which together
    /// re-cover every triangle and are never released. 3MF does not reach this
    /// governor until Ph8; the field exists so that phase declares the cost
    /// rather than discovering it as an OOM.
    pub retained_geometry_copies: u32,
}

/// The governor's output: a triangle budget and the reason it was chosen.
#[derive(Debug, Clone, Copy)]
pub struct TriangleBudget {
    pub budget_tris: u64,
    pub reason: BudgetReason,
}

/// Deterministic budget: `clamp(min(heap_term, ram_term) / bytes_per_tri,
/// floor, ∞)`, where each term already folds in its own fraction (the WebView
/// heap and system RAM have materially different safe-spend ratios — a
/// documented refinement of the plan's single-`fraction` shorthand). Pure:
/// identical inputs always yield an identical budget.
pub fn compute_triangle_budget(inputs: &BudgetInputs) -> TriangleBudget {
    let divisor = inputs.concurrent_model_count.max(1) as f64;

    let heap_term = if inputs.heap_limit_bytes > 0 {
        Some(HEAP_FRACTION * inputs.heap_limit_bytes as f64 / divisor)
    } else {
        None
    };
    let ram_term = if inputs.ram_available_bytes > 0 {
        Some(RAM_FRACTION * inputs.ram_available_bytes as f64 / divisor)
    } else {
        None
    };

    let (budget_bytes, reason) = match (heap_term, ram_term) {
        (Some(h), Some(r)) => {
            if h <= r {
                (h, BudgetReason::HeapBound)
            } else {
                (r, BudgetReason::RamBound)
            }
        }
        (Some(h), None) => (h, BudgetReason::HeapBound),
        (None, Some(r)) => (r, BudgetReason::RamBound),
        (None, None) => {
            // No heap limit and no RAM figure — never emit a zero budget.
            return TriangleBudget {
                budget_tris: FLOOR_TRIANGLES,
                reason: BudgetReason::NoMemorySignal,
            };
        }
    };

    let bytes_per_tri = effective_bytes_per_triangle(inputs.retained_geometry_copies);
    let raw = (budget_bytes / bytes_per_tri).floor().max(0.0) as u64;
    // Clamp to [FLOOR, MAX]. The ceiling is the safety cap that prevents the
    // import-OOM regression: the memory signals may reduce the budget below
    // MAX but never above it (see MAX_BUDGET_TRIANGLES).
    if raw > MAX_BUDGET_TRIANGLES {
        TriangleBudget {
            budget_tris: MAX_BUDGET_TRIANGLES,
            reason: BudgetReason::Ceiling,
        }
    } else if raw < FLOOR_TRIANGLES {
        TriangleBudget {
            budget_tris: FLOOR_TRIANGLES,
            reason: BudgetReason::Floor,
        }
    } else {
        TriangleBudget {
            budget_tris: raw,
            reason,
        }
    }
}

/// Impure companion: query the machine's memory via sysinfo (memory surface
/// ONLY — no process, disk, network, or component refresh, per §D4). Returns
/// `(total, available)` bytes; `(0, 0)` if the query yields nothing, which the
/// governor treats as "unknown" and falls back from (never a zero budget).
/// sysinfo is std-cross-platform; built/verified on Windows here — macOS and
/// Linux are compile-path-only-verifiable in this environment.
pub fn query_system_memory() -> (u64, u64) {
    let mut system = System::new();
    system.refresh_memory();
    (system.total_memory(), system.available_memory())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(heap: u64, ram_avail: u64) -> BudgetInputs {
        BudgetInputs {
            ram_total_bytes: ram_avail.saturating_mul(2),
            ram_available_bytes: ram_avail,
            heap_limit_bytes: heap,
            source_triangles: 12_000_000,
            concurrent_model_count: 1,
            retained_geometry_copies: 1,
        }
    }

    const GB: u64 = 1024 * 1024 * 1024;

    /// Determinism: identical inputs → byte-identical budget (no runtime
    /// feedback, no wall-clock, no RNG).
    #[test]
    fn budget_is_deterministic() {
        let inp = inputs(2 * GB, 16 * GB);
        let a = compute_triangle_budget(&inp);
        let b = compute_triangle_budget(&inp);
        assert_eq!(a.budget_tris, b.budget_tris);
        assert_eq!(a.reason, b.reason);
    }

    /// Failed RAM query AND no heap limit → the conservative floor, NEVER 0.
    #[test]
    fn no_memory_signal_falls_back_to_nonzero_floor() {
        let budget = compute_triangle_budget(&inputs(0, 0));
        assert_eq!(budget.budget_tris, FLOOR_TRIANGLES);
        assert!(budget.budget_tris > 0, "floor budget must never be zero");
        assert_eq!(budget.reason, BudgetReason::NoMemorySignal);
    }

    /// A failed RAM query alone still yields a real heap-derived budget.
    #[test]
    fn heap_only_when_ram_query_fails() {
        let budget = compute_triangle_budget(&inputs(2 * GB, 0));
        assert_eq!(budget.reason, BudgetReason::HeapBound);
        assert!(budget.budget_tris > FLOOR_TRIANGLES);
    }

    /// A tiny heap clamps up to the floor and is labelled as such.
    #[test]
    fn tiny_heap_clamps_to_floor() {
        // 64 MB heap → 0.20 × 64 MB / 228 ≈ 59k tris, below the 1M floor.
        let budget = compute_triangle_budget(&inputs(64 * 1024 * 1024, 16 * GB));
        assert_eq!(budget.budget_tris, FLOOR_TRIANGLES);
        assert_eq!(budget.reason, BudgetReason::Floor);
    }

    /// Higher-power machines get larger budgets — up to the safety ceiling.
    #[test]
    fn larger_heap_yields_larger_budget() {
        let small = compute_triangle_budget(&inputs(2 * GB, 64 * GB)).budget_tris;
        let large = compute_triangle_budget(&inputs(8 * GB, 64 * GB)).budget_tris;
        assert!(large > small, "8 GB heap ({large}) must exceed 2 GB heap ({small})");
        // Ph1 governor correction: 0.20 × 2 GB / 228 ≈ 1.88M (was ~2.75M at the
        // pre-Ph1 156 B/tri, which under-counted the classified path's two
        // per-section geometries — see the module docs).
        assert!(
            (1_750_000..=2_000_000).contains(&small),
            "2 GB-heap budget {small} should be ~1.88M (0.20 × 2 GB / 228)"
        );
        // 8 GB heap computes ~7.5M but is capped at the absolute ceiling.
        assert_eq!(large, MAX_BUDGET_TRIANGLES);
    }

    /// Regression (2026-07-20 import OOM): the exact high-end machine that
    /// hard-crashed the WebView renderer — 4.4 GB reported heap, 256 GB RAM,
    /// 11.24M-tri source. The un-capped governor produced a 12,679,703 budget
    /// (> source) and kept the mesh VERBATIM, OOM-killing the renderer. The
    /// ceiling MUST cap the budget below the source so the model is decimated.
    #[test]
    fn high_end_machine_caps_below_source_at_ceiling() {
        let inp = BudgetInputs {
            ram_total_bytes: 272_252_653_568,
            ram_available_bytes: 216_499_220_480,
            heap_limit_bytes: 4_395_630_592,
            source_triangles: 11_239_430,
            concurrent_model_count: 1,
            retained_geometry_copies: 1,
        };
        let budget = compute_triangle_budget(&inp);
        // THE load-bearing assertion, unchanged: the budget must land below the
        // source so the mesh is decimated instead of kept verbatim.
        assert!(
            budget.budget_tris < inp.source_triangles,
            "budget {} must be below the 11.24M source so it decimates \
             (the un-capped governor gave 12,679,703 and kept it verbatim → OOM)",
            budget.budget_tris
        );
        assert!(budget.budget_tris <= MAX_BUDGET_TRIANGLES);
        // Ph1 governor correction moved WHICH constraint binds on this exact
        // machine, and in the safe direction: at 228 B/tri the 4.4 GB heap term
        // now yields ~3.86M and binds BEFORE the 4M ceiling, so this machine is
        // held one step further from the OOM than the ceiling alone held it.
        assert_eq!(budget.reason, BudgetReason::HeapBound);
        assert!(
            (3_800_000..MAX_BUDGET_TRIANGLES).contains(&budget.budget_tris),
            "expected ~3.86M (0.20 × 4.4 GB / 228), got {}",
            budget.budget_tris
        );
    }

    /// The absolute ceiling still binds — it just takes a bigger heap now that
    /// the per-triangle cost is honest. Companion to the test above, which no
    /// longer reaches it.
    #[test]
    fn ceiling_still_caps_very_large_heaps() {
        let budget = compute_triangle_budget(&inputs(16 * GB, 256 * GB));
        assert_eq!(budget.budget_tris, MAX_BUDGET_TRIANGLES);
        assert_eq!(budget.reason, BudgetReason::Ceiling);
    }

    /// The available-RAM cap binds when the heap term would exceed it.
    #[test]
    fn ram_cap_binds_when_heap_is_huge() {
        // Huge reported heap, small available RAM → RAM caps the budget.
        let budget = compute_triangle_budget(&inputs(64 * GB, 4 * GB));
        assert_eq!(budget.reason, BudgetReason::RamBound);
    }

    /// The plate-count divisor shrinks the budget deterministically. Uses a
    /// 3 GB heap so neither divisor case hits the ceiling OR the floor (either
    /// clamp would break the b2 ≈ b1/2 relationship — both are exercised by
    /// their own tests). Ph1 raised the heap needed here from 2 GB to 3 GB
    /// because the corrected 228 B/tri cost pushed the halved 2 GB budget
    /// (~942k) under the 1M floor.
    #[test]
    fn plate_divisor_shares_the_budget() {
        let mut one = inputs(3 * GB, 64 * GB);
        one.concurrent_model_count = 1;
        let mut two = inputs(3 * GB, 64 * GB);
        two.concurrent_model_count = 2;
        let b1 = compute_triangle_budget(&one).budget_tris;
        let b2 = compute_triangle_budget(&two).budget_tris;
        assert!(b1 < MAX_BUDGET_TRIANGLES, "test premise: uncapped");
        assert!(b2 < b1 && b2 >= b1 / 2 - 1 && b2 <= b1 / 2 + 1);
    }

    /// Ph1 governor correction. The cost model must account for the per-section
    /// geometries the classified path allocates, and for the retained-copy
    /// multiplier a multi-body import pays. Written against the DERIVATION, not
    /// against a magic number, so a future re-derivation has to move the terms
    /// rather than the assertion.
    #[test]
    fn cost_model_accounts_for_section_geometries() {
        // Base residency, unchanged: soup (position+normal) + BVH + one undo
        // snapshot. This is what the constant used to be, in full.
        let base = SOUP_BYTES_PER_TRIANGLE + BVH_BYTES_PER_TRIANGLE + SNAPSHOT_BYTES_PER_TRIANGLE;
        assert_eq!(base, 156.0, "the pre-Ph1 constant must still be reproducible");

        // The classified path additionally holds a position copy of the model
        // section and a position+normal copy of the support section. Per total
        // triangle that is 36·(1−s) + 72·s for a support fraction s — i.e.
        // +36 B/tri at worst-case-model through +72 B/tri at all-support.
        assert_eq!(SECTION_COPY_BYTES_PER_TRIANGLE, 36.0);
        assert_eq!(
            SECTION_COPY_BYTES_PER_TRIANGLE + SECTION_NORMAL_BYTES_PER_TRIANGLE,
            72.0
        );

        assert!(
            BYTES_PER_TRIANGLE_HEAP >= base + 36.0,
            "the cost model still under-counts the section geometries by at \
             least the 23 % floor (constant {BYTES_PER_TRIANGLE_HEAP}, base {base})"
        );
        assert!(
            BYTES_PER_TRIANGLE_HEAP <= base + 72.0,
            "the cost model over-counts past the all-support worst case \
             (constant {BYTES_PER_TRIANGLE_HEAP}, base {base})"
        );
        assert_eq!(
            BYTES_PER_TRIANGLE_HEAP,
            base + SECTION_COPY_BYTES_PER_TRIANGLE + SECTION_NORMAL_BYTES_PER_TRIANGLE,
            "the constant must equal its own derivation"
        );
    }

    /// D8: a multi-body import keeps the merged geometry AND a per-body copy of
    /// every triangle, for the whole session. The divisor exists so Ph8 can
    /// declare that cost instead of discovering it as an OOM.
    #[test]
    fn retained_copies_shrink_the_budget_proportionally() {
        let mut single = inputs(2 * GB, 64 * GB);
        single.retained_geometry_copies = 1;
        let mut multi = inputs(2 * GB, 64 * GB);
        multi.retained_geometry_copies = 2;

        let b1 = compute_triangle_budget(&single).budget_tris;
        let b2 = compute_triangle_budget(&multi).budget_tris;
        assert!(b1 < MAX_BUDGET_TRIANGLES, "test premise: uncapped");
        assert!(
            b2 < b1,
            "a second retained copy of every triangle must reduce the budget \
             ({b2} vs {b1})"
        );
    }

    /// Behaviour fence: today every caller retains exactly one copy, so the new
    /// term must be a no-op on the live import path.
    #[test]
    fn retained_copies_defaults_to_one_and_is_a_no_op() {
        let inp = inputs(2 * GB, 64 * GB);
        assert_eq!(inp.retained_geometry_copies, 1);
        assert_eq!(
            effective_bytes_per_triangle(inp.retained_geometry_copies),
            BYTES_PER_TRIANGLE_HEAP
        );
    }

    /// sysinfo must return a real figure on this build target (not 0/0).
    #[test]
    fn sysinfo_reports_real_memory() {
        let (total, available) = query_system_memory();
        assert!(total > 0, "sysinfo total_memory must be non-zero on this OS");
        assert!(available > 0, "sysinfo available_memory must be non-zero");
    }
}
