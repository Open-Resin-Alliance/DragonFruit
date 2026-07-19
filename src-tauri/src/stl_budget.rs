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
//! systems get genuinely larger budgets — a 4 GB-heap WebView renders roughly
//! twice the triangles of a 2 GB-heap one, deterministically.
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
/// model's geometry + ancillaries. Chosen at 0.45 so a ~2 GB-heap WebView
/// lands near the legacy 6M gate for continuity (0.45 × 2 GB / 156 ≈ 5.8M)
/// while larger heaps scale up (0.45 × 4 GB / 156 ≈ 11.5M); kept below 0.5 to
/// leave heap headroom for the app shell, slicing/undo buffers, and a second
/// concurrently-loaded model. Precedent: `hollowVoxelPreviewLimits.ts` spends
/// 0.12 of the heap on a *secondary* subsystem; the model geometry is the
/// primary heap consumer, so a larger fraction is appropriate.
const HEAP_FRACTION: f64 = 0.45;

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

/// Which constraint set the budget — logged with the budget for diagnosis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetReason {
    /// The WebView JS-heap term (`jsHeapSizeLimit`) was the binding constraint.
    HeapBound,
    /// The available-system-RAM term was the binding constraint.
    RamBound,
    /// A computed budget fell below [`FLOOR_TRIANGLES`] and was clamped up.
    Floor,
    /// Neither a heap limit nor a RAM figure was available → floor budget.
    NoMemorySignal,
}

impl BudgetReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            BudgetReason::HeapBound => "heap-bound",
            BudgetReason::RamBound => "ram-bound",
            BudgetReason::Floor => "floor (computed budget below floor)",
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
    if raw < FLOOR_TRIANGLES {
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
        // 64 MB heap → 0.45 × 64 MB / 156 ≈ 193k tris, below the 1M floor.
        let budget = compute_triangle_budget(&inputs(64 * 1024 * 1024, 16 * GB));
        assert_eq!(budget.budget_tris, FLOOR_TRIANGLES);
        assert_eq!(budget.reason, BudgetReason::Floor);
    }

    /// Higher-power machines get strictly larger budgets by construction.
    #[test]
    fn larger_heap_yields_larger_budget() {
        let small = compute_triangle_budget(&inputs(2 * GB, 64 * GB)).budget_tris;
        let large = compute_triangle_budget(&inputs(4 * GB, 64 * GB)).budget_tris;
        assert!(large > small, "4 GB heap ({large}) must exceed 2 GB heap ({small})");
        // ~2 GB heap should land near the legacy 6M gate (continuity).
        assert!(
            (5_000_000..=6_500_000).contains(&small),
            "2 GB-heap budget {small} should sit near the legacy 6M gate"
        );
    }

    /// The available-RAM cap binds when the heap term would exceed it.
    #[test]
    fn ram_cap_binds_when_heap_is_huge() {
        // Huge reported heap, small available RAM → RAM caps the budget.
        let budget = compute_triangle_budget(&inputs(64 * GB, 4 * GB));
        assert_eq!(budget.reason, BudgetReason::RamBound);
    }

    /// The plate-count divisor shrinks the budget deterministically.
    #[test]
    fn plate_divisor_shares_the_budget() {
        let mut one = inputs(4 * GB, 64 * GB);
        one.concurrent_model_count = 1;
        let mut two = inputs(4 * GB, 64 * GB);
        two.concurrent_model_count = 2;
        let b1 = compute_triangle_budget(&one).budget_tris;
        let b2 = compute_triangle_budget(&two).budget_tris;
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
