#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TriangleBudget {
    /// Target triangle count for query-first decimation (e.g. 4,000,000).
    pub budget_tris: usize,
    /// Absolute geometric error bound in mm (e.g. 0.005 mm to 0.05 mm).
    /// Decimation stops immediately if error reaches this bound, even if triangle count is above budget.
    pub target_error: f64,
    /// Soft ceiling limit (e.g. 6,000,000 triangles).
    /// Allows error-bounded outputs to remain above budget rather than destroying thin supports.
    pub soft_ceiling_tris: usize,
    /// Whether the input triangle count exceeds target budget.
    pub is_decimated: bool,
    /// Model bounding box diagonal in mm.
    pub bbox_diagonal_mm: f64,
    /// Whether to process Section 0 and Section 1 separately targeting the same triangle budget using lockstep error tiers.
    pub enable_per_section_decimation: bool,
}

pub fn compute_triangle_budget(
    triangle_count: usize,
    bbox_diagonal_mm: f64,
    available_ram_bytes: Option<u64>,
) -> TriangleBudget {
    let _ = available_ram_bytes;

    let target_budget_triangles = crate::decimation_config::TARGET_BUDGET_TRIANGLES;
    let soft_ceiling_triangles = crate::decimation_config::SOFT_CEILING_TRIANGLES;

    // Bounding-Box Scaled Epsilon:
    // Scale error bound relative to bounding box diagonal, strictly constrained
    // between 0.003 (0.3% max relative geometric error bound) and 0.050 (5.0%).
    let epsilon = (bbox_diagonal_mm * crate::decimation_config::EPSILON_BBOX_SCALE)
        .clamp(crate::decimation_config::EPSILON_MIN_CLAMP, crate::decimation_config::EPSILON_MAX_CLAMP);

    if triangle_count <= target_budget_triangles {
        TriangleBudget {
            budget_tris: target_budget_triangles,
            target_error: epsilon,
            soft_ceiling_tris: soft_ceiling_triangles,
            is_decimated: false,
            bbox_diagonal_mm,
            enable_per_section_decimation: true,
        }
    } else {
        TriangleBudget {
            budget_tris: target_budget_triangles,
            target_error: epsilon,
            soft_ceiling_tris: soft_ceiling_triangles,
            is_decimated: true,
            bbox_diagonal_mm,
            enable_per_section_decimation: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_triangle_budget_1_5m() {
        let budget = compute_triangle_budget(1_500_000, 150.0, None);
        assert_eq!(budget.is_decimated, false);
        assert_eq!(budget.budget_tris, 4_000_000);
        assert!((budget.target_error - 0.0375).abs() < 1e-6);
        assert_eq!(budget.bbox_diagonal_mm, 150.0);
        assert_eq!(budget.enable_per_section_decimation, true);
    }

    #[test]
    fn test_compute_triangle_budget_6m() {
        let budget = compute_triangle_budget(6_000_000, 250.0, None);
        assert_eq!(budget.is_decimated, true);
        assert_eq!(budget.budget_tris, 4_000_000);
        assert!((budget.target_error - 0.050).abs() < 1e-6); // Clamped to 0.050 mm
    }

    #[test]
    fn test_compute_triangle_budget_12m() {
        let budget = compute_triangle_budget(12_000_000, 100.0, None);
        assert_eq!(budget.is_decimated, true);
        assert_eq!(budget.budget_tris, 4_000_000);
        assert!((budget.target_error - 0.025).abs() < 1e-6);
    }

    #[test]
    fn test_compute_triangle_budget_small_model_clamp() {
        let budget = compute_triangle_budget(5_000_000, 5.0, None);
        assert_eq!(budget.is_decimated, true);
        assert!((budget.target_error - 0.003).abs() < 1e-6); // Clamped to 0.003 minimum
    }
}
