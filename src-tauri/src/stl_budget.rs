//! Import-time triangle-budget governor for native STL preview decimation
//! (STL-import decimation remediation, Phase 2a — plan §"Preview honesty +
//! bounded viewport decimation", decimation-policy redesign).
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
//! for a total heap residency of **72 + 48 + 36 = 156 B/tri**. (The GPU vertex
//! buffer upload — another ~72 B/tri — lives in GPU / native memory, NOT the JS
//! heap `jsHeapSizeLimit` bounds, so it is deliberately excluded from the
//! heap-term cost; it is bounded indirectly by the same budget.)
//!
//! Reconciliation vs the P0 datum: this model predicts 6.22M × 72 B = 448 MB
//! for the raw geometry buffers — matching the ~450 MB measurement to 0.4 %.
//! The additional 84 B/tri (BVH + one snapshot) is real heap the P0
//! geometry-only snapshot did not include; it makes the budget deliberately
//! conservative (a smaller, safer budget), not "wildly" off — total predicted
//! residency for 6.22M is ~970 MB, ~2× the geometry-only figure, which is the
//! expected gap between "geometry buffers" and "everything the import keeps
//! resident". This comment discipline mirrors the in-repo precedent
//! `src/components/scene/hollowVoxelPreviewLimits.ts`.

use sysinfo::System;

/// Per-triangle WebView JS-heap residency for a non-indexed native preview.
/// DERIVED (see module docs): 72 (position+normal buffers, anchored to the P0
/// 450 MB / 6.22M datum) + 48 (three-mesh-bvh) + 36 (one undo snapshot).
pub const BYTES_PER_TRIANGLE_HEAP: f64 = 156.0;

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

    let raw = (budget_bytes / BYTES_PER_TRIANGLE_HEAP).floor().max(0.0) as u64;
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
        // 64 MB heap → 0.20 × 64 MB / 156 ≈ 86k tris, below the 1M floor.
        let budget = compute_triangle_budget(&inputs(64 * 1024 * 1024, 16 * GB));
        assert_eq!(budget.budget_tris, FLOOR_TRIANGLES);
        assert_eq!(budget.reason, BudgetReason::Floor);
    }

    /// Higher-power machines get larger budgets — up to the safety ceiling.
    #[test]
    fn larger_heap_yields_larger_budget() {
        let small = compute_triangle_budget(&inputs(2 * GB, 64 * GB)).budget_tris;
        let large = compute_triangle_budget(&inputs(4 * GB, 64 * GB)).budget_tris;
        assert!(large > small, "4 GB heap ({large}) must exceed 2 GB heap ({small})");
        // 2 GB heap: 0.20 × 2 GB / 156 ≈ 2.75M, below the ceiling.
        assert!(
            (2_500_000..=3_000_000).contains(&small),
            "2 GB-heap budget {small} should be ~2.75M (0.20 × 2 GB / 156)"
        );
        // 4 GB heap computes ~5.5M but is capped at the absolute ceiling.
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
        };
        let budget = compute_triangle_budget(&inp);
        assert_eq!(budget.budget_tris, MAX_BUDGET_TRIANGLES);
        assert_eq!(budget.reason, BudgetReason::Ceiling);
        assert!(
            budget.budget_tris < inp.source_triangles,
            "budget {} must be below the 11.24M source so it decimates \
             (the un-capped governor gave 12,679,703 and kept it verbatim → OOM)",
            budget.budget_tris
        );
    }

    /// The available-RAM cap binds when the heap term would exceed it.
    #[test]
    fn ram_cap_binds_when_heap_is_huge() {
        // Huge reported heap, small available RAM → RAM caps the budget.
        let budget = compute_triangle_budget(&inputs(64 * GB, 4 * GB));
        assert_eq!(budget.reason, BudgetReason::RamBound);
    }

    /// The plate-count divisor shrinks the budget deterministically. Uses a
    /// 2 GB heap so neither divisor case hits the ceiling (which would break
    /// the b2 ≈ b1/2 relationship — that is exercised by the ceiling tests).
    #[test]
    fn plate_divisor_shares_the_budget() {
        let mut one = inputs(2 * GB, 64 * GB);
        one.concurrent_model_count = 1;
        let mut two = inputs(2 * GB, 64 * GB);
        two.concurrent_model_count = 2;
        let b1 = compute_triangle_budget(&one).budget_tris;
        let b2 = compute_triangle_budget(&two).budget_tris;
        assert!(b1 < MAX_BUDGET_TRIANGLES, "test premise: uncapped");
        assert!(b2 < b1 && b2 >= b1 / 2 - 1 && b2 <= b1 / 2 + 1);
    }

    /// sysinfo must return a real figure on this build target (not 0/0).
    #[test]
    fn sysinfo_reports_real_memory() {
        let (total, available) = query_system_memory();
        assert!(total > 0, "sysinfo total_memory must be non-zero on this OS");
        assert!(available > 0, "sysinfo available_memory must be non-zero");
    }
}
